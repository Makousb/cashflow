"""Cashflow analytics service.

Receives raw transaction/budget/goal data from the Node app and returns
computed insights: category breakdowns, monthly trends, spending forecasts,
and plain-English observations for the Reports page.

Run:  uvicorn app:app --port 8000 --reload
Docs: http://localhost:8000/docs
"""

import base64
import io
import os
import re
import shutil
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import date
from math import ceil
from statistics import median

from fastapi import FastAPI
from pydantic import BaseModel

try:
    import pytesseract
    from PIL import Image

    # winget's Tesseract install isn't on PATH in fresh shells; find it.
    if shutil.which("tesseract") is None:
        for candidate in (
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        ):
            if os.path.exists(candidate):
                pytesseract.pytesseract.tesseract_cmd = candidate
                break
    OCR_AVAILABLE = True
except ImportError:  # pragma: no cover - pillow/pytesseract not installed
    OCR_AVAILABLE = False

app = FastAPI(title="Cashflow Analytics", version="0.1.0")


class Transaction(BaseModel):
    kind: str  # "expense" | "income"
    amount: float
    category: str = "Uncategorized"
    icon: str = "🧾"
    occurred_on: str  # YYYY-MM-DD


class Budget(BaseModel):
    category: str
    icon: str = "💸"
    amount: float
    spent: float


class Goal(BaseModel):
    name: str
    target_amount: float
    saved_amount: float
    target_date: str | None = None


class ReceiptItem(BaseModel):
    name: str
    price: float | None = None


class ReceiptData(BaseModel):
    merchant: str = ""
    total: float | None = None
    purchased_on: str | None = None  # YYYY-MM-DD
    items: list[ReceiptItem] = []


class InsightsRequest(BaseModel):
    today: str  # YYYY-MM-DD
    currency: str = "USD"  # display currency
    rate: float = 1.0  # multiply stored (base) amounts by this to get display
    transactions: list[Transaction] = []
    budgets: list[Budget] = []
    goals: list[Goal] = []
    receipts: list[ReceiptData] = []


class AlertsRequest(BaseModel):
    today: str  # YYYY-MM-DD
    currency: str = "USD"  # display currency
    rate: float = 1.0  # multiply stored (base) amounts by this to get display
    budgets: list[Budget] = []
    goals: list[Goal] = []


class ReceiptParseRequest(BaseModel):
    image_base64: str
    today: str  # fallback purchase date


class LoanForPlan(BaseModel):
    name: str
    balance: float
    apr: float = 0.0
    min_payment: float = 0.0


class CategorySpend(BaseModel):
    name: str
    icon: str = "🧾"
    monthly_avg: float = 0.0
    budget: float | None = None


class LoanPlanRequest(BaseModel):
    today: str
    currency: str = "USD"
    rate: float = 1.0
    loans: list[LoanForPlan] = []
    categories: list[CategorySpend] = []
    extra_monthly: float = 0.0  # optional extra the user wants to add


# Symbol + decimal places per currency, mirroring utils/currencies.js so the
# analytics messages read the same as the rest of the app ("KSh 1,234.50").
CURRENCY_SYMBOLS = {
    "KES": ("KSh", 2), "UGX": ("USh", 0), "TZS": ("TSh", 2), "RWF": ("FRw", 0),
    "USD": ("$", 2), "EUR": ("€", 2), "GBP": ("£", 2), "NGN": ("₦", 2),
    "ZAR": ("R", 2), "INR": ("₹", 2), "AED": ("AED", 2), "CNY": ("CN¥", 2),
    "JPY": ("¥", 0), "CAD": ("C$", 2), "AUD": ("A$", 2),
}


def fmt(amount: float, currency: str) -> str:
    symbol, decimals = CURRENCY_SYMBOLS.get(currency, (currency, 2))
    separator = " " if symbol[-1:].isalpha() else ""
    return f"{symbol}{separator}{amount:,.{decimals}f}"


def month_key(iso_date: str) -> str:
    """The YYYY-MM a calendar day falls in.

    Read rather than sliced. Taking the first seven characters answers for
    anything, including a date that has been through a JS Date and JSON on the
    way here and arrived as an instant: local midnight on the 1st of September
    in Nairobi leaves as 21:00 on the 31st of August, and the slice would file
    it under August without a word. Every other date in this module is read
    with fromisoformat, so this one is too, and a date that is not a day is
    refused here the same way it would be anywhere else.
    """
    day = date.fromisoformat(iso_date)
    return f"{day.year:04d}-{day.month:02d}"


def last_n_month_keys(today: date, n: int = 6) -> list[str]:
    """Chronological YYYY-MM keys ending with the current month."""
    year, month = today.year, today.month
    keys = []
    for _ in range(n):
        keys.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return list(reversed(keys))


# Maps receipt text to the app's built-in category names. First match wins,
# so more specific buckets sit above generic "Shopping".
CATEGORY_KEYWORDS = [
    ("Transport", ["fuel", "petrol", "diesel", "shell", "energies", "gas station",
                   "uber", "bolt", "taxi", "parking", "matatu", "bus fare"]),
    ("Health", ["pharmacy", "chemist", "hospital", "clinic", "medical", "dental"]),
    ("Utilities", ["electric", "kplc", "power", "water bill", "internet", "wifi",
                   "telkom", "airtime", "safaricom"]),
    ("Entertainment", ["cinema", "movie", "theatre", "arcade", "netflix", "spotify"]),
    ("Education", ["bookshop", "book store", "school", "stationery", "college", "tuition"]),
    ("Food & Dining", ["restaurant", "cafe", "coffee", "pizza", "burger", "grill",
                       "kitchen", "bakery", "butchery", "supermarket", "grocery",
                       "mart", "market", "foods", "deli", "hotel"]),
    ("Shopping", ["boutique", "electronics", "hardware", "store", "shop", "mall"]),
]

MONEY_RE = re.compile(r"(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})")
# Same shape but tolerant of a single decimal place: OCR frequently drops the
# trailing zero on the total ("1351.40" is read as "1351.4").
TOTAL_MONEY_RE = re.compile(r"(\d{1,3}(?:,\d{3})+\.\d{1,2}|\d+\.\d{1,2})")
ITEM_LINE_RE = re.compile(r"^(.{3,40}?)\s{1,}(\d{1,3}(?:,\d{3})*\.\d{2})\s*$")
NON_ITEM_WORDS = ("total", "subtotal", "sub-total", "tax", "vat", "cash",
                  "change", "balance", "tender", "amount", "paid", "card")
# Amounts on these lines are money tendered/returned, not the receipt total —
# and are often larger than it, so they must not win the fallback.
PAYMENT_WORDS = ("cash", "change", "tender", "balance", "card", "mpesa", "paid")

DATE_PATTERNS = [
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    # dd/mm/yyyy or dd-mm-yyyy (day-first, the local convention)
    (re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b"),
     lambda m: (int(m[3]), int(m[2]), int(m[1]))),
    (re.compile(r"\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})",
                re.IGNORECASE),
     lambda m: (int(m[3]),
                ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep",
                 "oct", "nov", "dec"].index(m[2].lower()[:3]) + 1,
                int(m[1]))),
]


def to_amount(text: str) -> float:
    return float(text.replace(",", ""))


def guess_category(text: str) -> str:
    lowered = text.lower()
    for category, keywords in CATEGORY_KEYWORDS:
        if any(k in lowered for k in keywords):
            return category
    return "Other"


def parse_receipt_text(text: str, fallback_date: str) -> dict:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # Merchant: first line that isn't just numbers/punctuation.
    merchant = ""
    for ln in lines[:5]:
        if re.search(r"[A-Za-z]{3,}", ln):
            merchant = re.sub(r"\s{2,}", " ", ln).strip(" *-=")
            break

    # Total: prefer the last line mentioning "total" (but not "subtotal").
    # Fall back to the largest amount on the receipt, ignoring cash-tendered
    # and change lines, which are frequently larger than the actual total.
    total = None
    for ln in lines:
        lowered = ln.lower()
        if "total" in lowered and "sub" not in lowered:
            amounts = TOTAL_MONEY_RE.findall(ln)
            if amounts:
                total = to_amount(amounts[-1])
    if total is None:
        amounts = [
            to_amount(a)
            for ln in lines
            if not any(w in ln.lower() for w in PAYMENT_WORDS)
            for a in MONEY_RE.findall(ln)
        ]
        total = max(amounts) if amounts else None

    # Purchase date: first recognizable date, else the caller's fallback.
    purchased_on = None
    for ln in lines:
        for pattern, build in DATE_PATTERNS:
            m = pattern.search(ln)
            if m:
                try:
                    y, mo, d = build(m)
                    purchased_on = date(y, mo, d).isoformat()
                except ValueError:
                    continue
                break
        if purchased_on:
            break
    if not purchased_on:
        purchased_on = fallback_date

    # Line items: "NAME   12.34" rows that aren't totals/tax/payment lines.
    items = []
    for ln in lines:
        m = ITEM_LINE_RE.match(ln)
        if not m:
            continue
        name = re.sub(r"\s{2,}", " ", m[1]).strip(" .*-")
        price = to_amount(m[2])
        if not re.search(r"[A-Za-z]{2,}", name):
            continue
        if any(w in name.lower() for w in NON_ITEM_WORDS):
            continue
        if total is not None and price == total and len(items) > 0:
            continue
        items.append({"name": name.title(), "price": price})

    return {
        "merchant": merchant.title(),
        "total": total,
        "purchased_on": purchased_on,
        "items": items,
        "category": guess_category(text),
    }


def compute_budget_alerts(today: date, cur: str, budgets: list[Budget], goals: list[Goal]):
    """Burn-rate alerts per category, plus the knock-on effect on goals.

    A category alerts when its month-to-date daily rate projects past its
    budget. The combined projected overage is then expressed as goal impact:
    how much monthly goal funding it eats and how many months late each
    dated goal becomes if the overspending comes out of savings.
    """
    days_in_month = monthrange(today.year, today.month)[1]
    day = today.day

    alerts = []
    for b in budgets:
        if b.amount <= 0:
            continue
        projected = b.spent / day * days_in_month
        over_now = b.spent >= b.amount
        # A day-one splurge projects wildly; wait a few days unless already over.
        if projected <= b.amount or (day < 3 and not over_now):
            continue
        overage = round(projected - b.amount, 2)
        if over_now:
            message = (
                f"{b.icon} {b.category} is already {fmt(b.spent - b.amount, cur)} over its "
                f"{fmt(b.amount, cur)} budget — on pace for {fmt(projected, cur)} by month end."
            )
        else:
            message = (
                f"At your current pace, {b.icon} {b.category} will reach {fmt(projected, cur)} "
                f"this month — {fmt(overage, cur)} over its {fmt(b.amount, cur)} budget."
            )
        alerts.append(
            {
                "category": b.category,
                "icon": b.icon,
                "severity": "critical" if over_now else "warning",
                "budget": round(b.amount, 2),
                "spent": round(b.spent, 2),
                "projected": round(projected, 2),
                "overage": overage,
                "pct_used": round(b.spent / b.amount * 100),
                "days_left": days_in_month - day,
                "message": message,
            }
        )

    alerts.sort(key=lambda a: (a["severity"] != "critical", -a["overage"]))

    goal_impact = None
    if alerts:
        monthly_overage = round(sum(a["overage"] for a in alerts), 2)
        yearly_overage = round(monthly_overage * 12, 2)
        messages = [
            f"These categories are on pace to overshoot by {fmt(monthly_overage, cur)} this "
            f"month — {fmt(yearly_overage, cur)} if it continues all year."
        ]
        for g in goals:
            remaining = g.target_amount - g.saved_amount
            if remaining <= 0:
                continue
            if g.target_date:
                target = date.fromisoformat(g.target_date[:10])
                months_left = max(
                    (target.year - today.year) * 12 + (target.month - today.month), 1
                )
                needed = remaining / months_left
                if monthly_overage >= needed:
                    messages.append(
                        f"🎯 {g.name}: the overage swallows the entire {fmt(needed, cur)}/month "
                        f"needed to reach it by {target.strftime('%B %Y')} — at this pace the "
                        f"target date is out of reach."
                    )
                else:
                    slowed_months = remaining / (needed - monthly_overage)
                    delay = ceil(slowed_months - months_left)
                    if delay >= 1:
                        messages.append(
                            f"🎯 {g.name}: funding drops from {fmt(needed, cur)} to "
                            f"{fmt(needed - monthly_overage, cur)}/month, pushing the "
                            f"{target.strftime('%B %Y')} target roughly {delay} month(s) late."
                        )
            else:
                pct = yearly_overage / remaining * 100
                messages.append(
                    f"🎯 {g.name}: a year at this pace equals {pct:.0f}% of the "
                    f"{fmt(remaining, cur)} you still need to save."
                )
        goal_impact = {
            "monthly_overage": monthly_overage,
            "yearly_overage": yearly_overage,
            "messages": messages,
        }

    return {"alerts": alerts, "goal_impact": goal_impact}


def scale_amounts(req, rate: float) -> None:
    """Convert every stored (base-currency) amount on the request into the
    display currency in place, so all downstream math and formatting is in the
    currency the user is viewing."""
    if rate == 1.0:
        return
    for t in getattr(req, "transactions", []):
        t.amount *= rate
    for b in getattr(req, "budgets", []):
        b.amount *= rate
        b.spent *= rate
    for g in getattr(req, "goals", []):
        g.target_amount *= rate
        g.saved_amount *= rate
    for r in getattr(req, "receipts", []):
        if r.total is not None:
            r.total *= rate
        for item in r.items:
            if item.price is not None:
                item.price *= rate


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/alerts")
def alerts(req: AlertsRequest):
    scale_amounts(req, req.rate)
    return compute_budget_alerts(
        date.fromisoformat(req.today), req.currency, req.budgets, req.goals
    )


@app.post("/receipts/parse")
def receipts_parse(req: ReceiptParseRequest):
    if not OCR_AVAILABLE:
        return {"error": "OCR engine not installed on the analytics host."}

    try:
        image = Image.open(io.BytesIO(base64.b64decode(req.image_base64)))
        text = pytesseract.image_to_string(image)
    except Exception as error:  # noqa: BLE001 - surface any OCR failure to the app
        return {"error": f"Could not read the image: {error}"}

    parsed = parse_receipt_text(text, req.today)
    parsed["ocr_text"] = text.strip()
    return parsed


def normalize_item(name: str) -> str:
    """Collapse sizes/counts so 'Milk 500ml' and 'Milk 1L' both read 'milk'."""
    cleaned = re.sub(r"\b\d+(\.\d+)?\s*(ml|l|kg|g|pcs|pc|x)\b", "", name.lower())
    cleaned = re.sub(r"[^a-z ]", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def compute_shopping_patterns(transactions: list[Transaction], receipts: list[ReceiptData]):
    """Frequent purchases, merchant habits, and spending-pattern findings."""
    # Recurring line items across receipts.
    item_counts: Counter = Counter()
    item_prices: defaultdict[str, list] = defaultdict(list)
    item_labels: dict[str, str] = {}
    for r in receipts:
        for item in r.items:
            key = normalize_item(item.name)
            if len(key) < 3:
                continue
            item_counts[key] += 1
            item_labels.setdefault(key, item.name)
            if item.price is not None:
                item_prices[key].append(item.price)
    frequent_items = [
        {
            "name": item_labels[key],
            "count": count,
            "avg_price": round(sum(item_prices[key]) / len(item_prices[key]), 2)
            if item_prices[key]
            else None,
        }
        for key, count in item_counts.most_common(5)
        if count >= 2
    ]

    # Repeat merchants: visit count, average spend, typical days between visits.
    by_merchant: defaultdict[str, list] = defaultdict(list)
    for r in receipts:
        if r.merchant and r.purchased_on:
            by_merchant[r.merchant.lower()].append(r)
    frequent_merchants = []
    for visits in by_merchant.values():
        if len(visits) < 2:
            continue
        days = sorted(date.fromisoformat(v.purchased_on) for v in visits)
        gaps = [(b - a).days for a, b in zip(days, days[1:]) if (b - a).days > 0]
        totals = [v.total for v in visits if v.total is not None]
        frequent_merchants.append(
            {
                "merchant": visits[0].merchant,
                "visits": len(visits),
                "avg_total": round(sum(totals) / len(totals), 2) if totals else None,
                "every_days": round(median(gaps)) if gaps else None,
            }
        )
    frequent_merchants.sort(key=lambda m: -m["visits"])

    # Spending patterns from the transaction history.
    patterns = []
    weekday_totals = [0.0] * 7
    weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                     "Saturday", "Sunday"]
    day_categories: defaultdict[str, set] = defaultdict(set)
    expense_total = 0.0
    for tx in transactions:
        if tx.kind != "expense":
            continue
        d = date.fromisoformat(tx.occurred_on)
        weekday_totals[d.weekday()] += tx.amount
        expense_total += tx.amount
        day_categories[tx.occurred_on].add(tx.category)

    if expense_total > 0:
        top_day = max(range(7), key=lambda i: weekday_totals[i])
        share = weekday_totals[top_day] / expense_total * 100
        if share >= 25:
            patterns.append(
                f"{weekday_names[top_day]}s are your most expensive day — "
                f"{share:.0f}% of your spending happens then."
            )
        weekend_share = (weekday_totals[5] + weekday_totals[6]) / expense_total * 100
        if weekend_share >= 40:
            patterns.append(
                f"Weekends account for {weekend_share:.0f}% of your spending."
            )

    # Same-day category correlations: "when A, also B".
    pair_counts: Counter = Counter()
    cat_days: Counter = Counter()
    for cats in day_categories.values():
        for c in cats:
            cat_days[c] += 1
        for a in cats:
            for b in cats:
                if a != b:
                    pair_counts[(a, b)] += 1
    seen_pairs = set()
    for (a, b), count in pair_counts.most_common():
        if count < 2 or (b, a) in seen_pairs:
            continue
        ratio = count / cat_days[a]
        if ratio >= 0.5:
            seen_pairs.add((a, b))
            patterns.append(
                f"When you spend on {a}, you also spend on {b} the same day "
                f"{ratio * 100:.0f}% of the time."
            )
        if len(seen_pairs) >= 2:
            break

    return {
        "frequent_items": frequent_items,
        "frequent_merchants": frequent_merchants,
        "patterns": patterns,
    }


@app.post("/insights")
def insights(req: InsightsRequest):
    scale_amounts(req, req.rate)
    today = date.fromisoformat(req.today)
    current = f"{today.year:04d}-{today.month:02d}"
    cur = req.currency

    # Income/expense totals per month over the last six months.
    keys = last_n_month_keys(today)
    trend = {k: {"month": k, "income": 0.0, "expenses": 0.0} for k in keys}
    for tx in req.transactions:
        k = month_key(tx.occurred_on)
        if k in trend:
            bucket = "income" if tx.kind == "income" else "expenses"
            trend[k][bucket] += tx.amount
    monthly_trend = [
        {
            "month": row["month"],
            "income": round(row["income"], 2),
            "expenses": round(row["expenses"], 2),
        }
        for row in trend.values()
    ]

    # Current-month expenses grouped by category, largest first.
    by_cat: defaultdict[str, float] = defaultdict(float)
    icons: dict[str, str] = {}
    for tx in req.transactions:
        if tx.kind == "expense" and month_key(tx.occurred_on) == current:
            by_cat[tx.category] += tx.amount
            icons.setdefault(tx.category, tx.icon)
    total_spent = sum(by_cat.values())
    by_category = sorted(
        (
            {
                "category": name,
                "icon": icons[name],
                "total": round(total, 2),
                "share": round(total / total_spent * 100, 1) if total_spent else 0.0,
            }
            for name, total in by_cat.items()
        ),
        key=lambda row: row["total"],
        reverse=True,
    )

    # Spending pace for the current month.
    days_in_month = monthrange(today.year, today.month)[1]
    daily_average = total_spent / today.day if today.day else 0.0
    projected = daily_average * days_in_month
    forecast = {
        "total_spent": round(total_spent, 2),
        "daily_average": round(daily_average, 2),
        "projected": round(projected, 2),
        "days_left": days_in_month - today.day,
    }

    observations: list[str] = []

    if by_category:
        top = by_category[0]
        observations.append(
            f"{top['icon']} {top['category']} is your biggest expense this month — "
            f"{fmt(top['total'], cur)} ({top['share']:.0f}% of spending)."
        )
        observations.append(
            f"You're averaging {fmt(daily_average, cur)} a day; at this pace you'll "
            f"spend about {fmt(projected, cur)} by month end."
        )
    else:
        observations.append("No expenses recorded this month yet — nothing to analyze.")

    for g in req.goals:
        pct = g.saved_amount / g.target_amount * 100 if g.target_amount else 0.0
        remaining = g.target_amount - g.saved_amount
        if remaining <= 0:
            observations.append(f"🎉 Goal reached: {g.name}!")
            continue
        if g.target_date:
            target = date.fromisoformat(g.target_date[:10])
            months_left = max(
                (target.year - today.year) * 12 + (target.month - today.month), 1
            )
            observations.append(
                f"🎯 {g.name} is {pct:.0f}% funded — set aside "
                f"{fmt(remaining / months_left, cur)} per month to reach it by "
                f"{target.strftime('%B %Y')}."
            )
        else:
            observations.append(
                f"🎯 {g.name} is {pct:.0f}% funded ({fmt(remaining, cur)} to go)."
            )

    budget_alerts = compute_budget_alerts(today, cur, req.budgets, req.goals)

    return {
        "month": current,
        "monthly_trend": monthly_trend,
        "by_category": by_category,
        "forecast": forecast,
        "observations": observations,
        "alerts": budget_alerts["alerts"],
        "goal_impact": budget_alerts["goal_impact"],
        "shopping": compute_shopping_patterns(req.transactions, req.receipts),
    }


# Categories treated as flexible enough to trim toward loan repayment.
DISCRETIONARY = {"Food & Dining", "Entertainment", "Shopping", "Other"}
DISCRETIONARY_TRIM = 0.25  # suggest cutting a quarter of discretionary spend
PAYOFF_CAP_MONTHS = 600


def compute_cuts(categories: list[CategorySpend], cur: str):
    """Find monthly savings by cutting over-budget and discretionary spend."""
    cuts = []
    for c in categories:
        avg = c.monthly_avg
        if avg <= 0:
            continue
        if c.budget is not None and avg > c.budget:
            cut = avg - c.budget
            reason = f"running {fmt(cut, cur)} over its {fmt(c.budget, cur)} budget"
        elif c.name in DISCRETIONARY:
            cut = avg * DISCRETIONARY_TRIM
            reason = "discretionary — trim about a quarter"
        else:
            continue
        if cut >= 1:
            cuts.append(
                {
                    "category": c.name,
                    "icon": c.icon,
                    "current": round(avg, 2),
                    "suggested_cut": round(cut, 2),
                    "reason": reason,
                }
            )
    cuts.sort(key=lambda x: -x["suggested_cut"])
    return cuts


def simulate_avalanche(loans: list[dict], available: float):
    """Pay minimums on all loans, throw every spare cent at the highest-APR
    loan first. Returns months to debt-free, total interest, and per-loan
    payoff month — or None if it never clears within the cap."""
    work = [dict(l) for l in sorted(loans, key=lambda l: -l["apr"])]
    months = 0
    total_interest = 0.0
    payoff_month = {}

    while any(l["balance"] > 0.005 for l in work) and months < PAYOFF_CAP_MONTHS:
        months += 1
        for l in work:
            if l["balance"] > 0:
                interest = l["balance"] * l["apr"] / 100 / 12
                l["balance"] += interest
                total_interest += interest
        pool = available
        for l in work:  # minimums first
            if l["balance"] > 0 and pool > 0:
                pay = min(l["min_payment"], l["balance"], pool)
                l["balance"] -= pay
                pool -= pay
        for l in work:  # avalanche: leftover to highest APR still owing
            if pool <= 0:
                break
            if l["balance"] > 0:
                pay = min(pool, l["balance"])
                l["balance"] -= pay
                pool -= pay
        for l in work:
            if l["balance"] <= 0.005 and l["name"] not in payoff_month:
                payoff_month[l["name"]] = months
                l["balance"] = 0

    if any(l["balance"] > 0.005 for l in work):
        return None
    return {"months": months, "total_interest": total_interest, "payoff_month": payoff_month}


@app.post("/loans/plan")
def loans_plan(req: LoanPlanRequest):
    cur = req.currency
    rate = req.rate
    today = date.fromisoformat(req.today)

    loans = [
        {
            "name": l.name,
            "balance": l.balance * rate,
            "apr": l.apr,
            "min_payment": l.min_payment * rate,
        }
        for l in req.loans
        if l.balance * rate > 0.005
    ]
    total_debt = sum(l["balance"] for l in loans)

    if not loans:
        return {"has_debt": False, "messages": ["No outstanding loans — you're debt-free! 🎉"]}

    categories = [
        CategorySpend(
            name=c.name,
            icon=c.icon,
            monthly_avg=c.monthly_avg * rate,
            budget=None if c.budget is None else c.budget * rate,
        )
        for c in req.categories
    ]

    cuts = compute_cuts(categories, cur)
    freed = sum(c["suggested_cut"] for c in cuts)
    extra = req.extra_monthly * rate
    total_minimums = sum(l["min_payment"] for l in loans)
    available = total_minimums + freed + extra

    plan = simulate_avalanche(loans, available)
    baseline = simulate_avalanche(loans, total_minimums) if total_minimums > 0 else None

    # Order loans by APR (avalanche priority) with their payoff month.
    ordered = []
    for l in sorted(loans, key=lambda l: -l["apr"]):
        month_no = plan["payoff_month"].get(l["name"]) if plan else None
        payoff_date = None
        if month_no:
            d = date(today.year, today.month, 1)
            m = today.month - 1 + month_no
            payoff_date = date(today.year + m // 12, m % 12 + 1, 1).strftime("%b %Y")
        ordered.append(
            {
                "name": l["name"],
                "balance": round(l["balance"], 2),
                "apr": l["apr"],
                "min_payment": round(l["min_payment"], 2),
                "payoff_order": len(ordered) + 1,
                "payoff_date": payoff_date,
            }
        )

    messages = [
        f"You owe {fmt(total_debt, cur)} across {len(loans)} "
        f"loan{'s' if len(loans) != 1 else ''}."
    ]
    if cuts:
        messages.append(
            f"Trimming the categories below frees {fmt(freed, cur)} a month "
            f"({fmt(freed * 12, cur)} a year) to put toward your debt."
        )
    if plan:
        messages.append(
            f"Putting {fmt(available, cur)} a month at your loans (highest interest "
            f"first) clears everything in {plan['months']} months — by "
            f"{ordered[-1]['payoff_date']}."
        )
        if baseline:
            saved = baseline["total_interest"] - plan["total_interest"]
            if saved > 1:
                messages.append(
                    f"That's {fmt(saved, cur)} less interest than paying only the "
                    f"minimums, and {baseline['months'] - plan['months']} months sooner."
                )
        else:
            messages.append(
                "Minimum payments alone would never clear this debt — the plan below does."
            )
    else:
        messages.append(
            "Even with these cuts the payments can't outrun the interest yet. "
            "Free up more each month or renegotiate the rate."
        )

    return {
        "has_debt": True,
        "total_debt": round(total_debt, 2),
        "cuts": cuts,
        "freed_monthly": round(freed, 2),
        "freed_yearly": round(freed * 12, 2),
        "total_minimums": round(total_minimums, 2),
        "available_monthly": round(available, 2),
        "loans_ordered": ordered,
        "debt_free_months": plan["months"] if plan else None,
        "debt_free_date": ordered[-1]["payoff_date"] if plan else None,
        "total_interest": round(plan["total_interest"], 2) if plan else None,
        "baseline_interest": round(baseline["total_interest"], 2) if baseline else None,
        "interest_saved": round(baseline["total_interest"] - plan["total_interest"], 2)
        if (plan and baseline)
        else None,
        "messages": messages,
    }
