// The cards on offer, what holding one earns, and who may hold which.
//
// A card here is a tier rather than a separate product. The secured card at the
// bottom anyone can have, because their own deposit is the limit and there is
// nothing to judge. The three above it have to be earned, and they differ in the
// only three things a cardholder actually feels: the rate charged on a balance
// carried past the month, how big a limit comes with it, and how fast spending
// turns into points. That is what makes "you have earned a better card" a
// sentence with figures behind it rather than a compliment.
//
// Nothing here is an offer of credit by anybody, and there is no bureau behind
// any of it. The gates are this app's own records — what has been paid on time
// here, what is earned here — which is also why every refusal below can say
// which number stopped it.
//
// Pure. The catalogue is data and the rest is arithmetic over it, so what a card
// is worth can be read and tested without a database anywhere near it.

const round = (n) => Math.round(Number(n) * 100) / 100;

// One point per this much spent, before the card's multiplier. A share of the
// amount rather than a flat sum per purchase, so the same rule means the same
// thing in a currency where lunch costs 500 and in one where it costs 5.
export const POINTS_PER_UNIT = 100;
// And one point comes back off a balance as one unit of currency, which makes
// the base rate a straight 1% and every multiplier readable as a percentage.
export const POINT_VALUE = 1;
// Below this a redemption is not worth the arithmetic.
export const MIN_REDEEM = 500;

export const CARDS = {
  secured_card: {
    label: "Secured card",
    blurb: "A card with a limit equal to a deposit you put up yourself.",
    tier: 0,
    apr: 30,
    secured: true,
    // What it takes to be offered one. A secured card asks for nothing but the
    // deposit, so every gate is null and none of them is checked.
    minScore: null,
    minHistoryMonths: 0,
    maxMissed: null,
    // Months of income the limit is worth. The secured card's limit is its
    // deposit, so it earns nothing from this.
    limitMonths: 0,
    earn: { base: 1, bonus: {} }
  },
  rewards_card: {
    label: "Rewards card",
    blurb: "Your first unsecured card: no deposit, and eating out earns double.",
    tier: 1,
    apr: 24,
    secured: false,
    minScore: 55,
    minHistoryMonths: 3,
    maxMissed: 2,
    limitMonths: 0.5,
    earn: { base: 1, bonus: { "Food & Dining": 2 } }
  },
  gold_card: {
    label: "Gold card",
    blurb: "A lower rate, a month's income of limit, and triple points on food.",
    tier: 2,
    apr: 18,
    secured: false,
    minScore: 70,
    minHistoryMonths: 6,
    maxMissed: 1,
    limitMonths: 1,
    earn: { base: 1, bonus: { "Food & Dining": 3, Transport: 2, Utilities: 2 } }
  },
  platinum_card: {
    label: "Platinum card",
    blurb: "The best rate here, two months of limit, and double points on everything.",
    tier: 3,
    apr: 12,
    secured: false,
    minScore: 85,
    minHistoryMonths: 12,
    maxMissed: 0,
    limitMonths: 2,
    earn: {
      base: 2,
      bonus: { "Food & Dining": 4, Transport: 3, Shopping: 3, Entertainment: 3 }
    }
  }
};

// Worst first, so "the next one up" is a step forward through this list.
export const CARD_ORDER = Object.keys(CARDS).sort((a, b) => CARDS[a].tier - CARDS[b].tier);

export const isCard = (product) => Object.hasOwn(CARDS, product);

// --- Points ---

// What a card pays for spending in a category. A charge filed under nothing
// earns the base rate: the category is what buys the multiplier, so without one
// there is nothing to multiply by.
export function earnRate(product, category) {
  const card = CARDS[product];
  if (!card) return 0;
  if (!category) return card.earn.base;
  return card.earn.bonus[category] ?? card.earn.base;
}

// Points for one purchase. Floored per charge rather than on the total, because
// that is what the rate promises — a point per hundred spent, and the change
// left over buys nothing.
export function pointsFor(product, category, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / POINTS_PER_UNIT) * earnRate(product, category);
}

// What a card has earned, and what redeeming has taken back off it.
export function pointsStanding(product, charges = [], redemptions = []) {
  const earned = charges.reduce(
    (sum, c) => sum + pointsFor(product, c.category, c.amount),
    0
  );
  const redeemed = redemptions.reduce((sum, r) => sum + Number(r.points || 0), 0);
  const balance = Math.max(earned - redeemed, 0);

  return {
    earned,
    redeemed,
    balance,
    // What the balance is worth off the card, and whether it is yet worth taking.
    worth: round(balance * POINT_VALUE),
    redeemable: balance >= MIN_REDEEM
  };
}

// The most points a set of held cards can earn on a category, and which card
// does it. Only cards that can actually be used are considered — a closed card
// with a wonderful rate is not an answer to "which should I use".
export function bestCardFor(category, cards = []) {
  let best = null;
  for (const card of cards) {
    if (!isCard(card.product) || card.status !== "active") continue;
    const rate = earnRate(card.product, category);
    if (!best || rate > best.rate) best = { card, rate };
  }
  return best;
}

// Points that went uncollected: what each charge earned against what the best
// card open at the time would have earned it. Grouped by category, because the
// useful form of this is not "you lost 40 points" but "put food on the gold
// card and you would not".
//
// Charges on a card that is already the best for their category contribute
// nothing, so a wallet with one card — or with the right habits — comes back
// empty rather than nagging.
export function pointsMissed({ cards = [], charges = [] }) {
  const byCategory = new Map();
  let total = 0;

  for (const charge of charges) {
    const held = cards.find((c) => c.id === charge.facility_id);
    if (!held || !isCard(held.product)) continue;

    const best = bestCardFor(charge.category, cards);
    if (!best || best.card.id === held.id) continue;

    const earned = pointsFor(held.product, charge.category, charge.amount);
    const possible = pointsFor(best.card.product, charge.category, charge.amount);
    const lost = possible - earned;
    if (lost <= 0) continue;

    total += lost;
    const key = charge.category || "Uncategorized";
    const row = byCategory.get(key) || {
      category: key,
      lost: 0,
      spent: 0,
      use: best.card
    };
    row.lost += lost;
    row.spent = round(row.spent + Number(charge.amount));
    byCategory.set(key, row);
  }

  return {
    total,
    byCategory: [...byCategory.values()].sort((a, b) => b.lost - a.lost)
  };
}

// --- Limits ---

// What a card of this tier is worth to someone earning this much. A clean run of
// payments raises it: a fifth more for every six months without a missed one, up
// to twice the starting figure. Paying on time is the only thing that moves this,
// which is exactly the habit the limit is there to reward.
export function limitFor({ product, monthlyIncome = 0, cleanMonths = 0 }) {
  const card = CARDS[product];
  if (!card || card.secured) return 0;

  const base = Math.max(Number(monthlyIncome), 0) * card.limitMonths;
  const bonus = Math.min(Math.floor(Math.max(cleanMonths, 0) / 6) * 0.2, 1);
  return round(base * (1 + bonus));
}

// Whether a card held now is due a bigger limit, and by how much. A rise has to
// be worth having — a tenth of the limit, at least — or the offer is noise.
const MIN_RAISE_SHARE = 0.1;

export function limitIncrease({ facility, monthlyIncome = 0, cleanMonths = 0 }) {
  const current = Number(facility.credit_limit || 0);
  if (CARDS[facility.product]?.secured) {
    return {
      eligible: false,
      current,
      entitled: current,
      reason: "A secured card's limit is its deposit. Add to the deposit to raise it."
    };
  }

  const entitled = limitFor({ product: facility.product, monthlyIncome, cleanMonths });
  if (entitled < current + Math.max(current * MIN_RAISE_SHARE, 1)) {
    return {
      eligible: false,
      current,
      entitled,
      reason: cleanMonths < 6
        ? `Six clean months raises this limit by a fifth. You are ${6 - cleanMonths} away.`
        : "This limit already matches what you earn and how you have paid."
    };
  }

  return {
    eligible: true,
    current,
    entitled,
    raise: round(entitled - current),
    reason: `Your income and ${cleanMonths} clean month${cleanMonths === 1 ? "" : "s"} ` +
      `support a limit of ${entitled.toFixed(2)}.`
  };
}

// --- Who may hold what ---

// Whether a tier is within reach, and if not, which gate stopped it. Every
// answer names the figure, so "not yet" is something a person can act on.
export function eligibility(product, {
  score = null, historyMonths = 0, cleanMonths = 0, record = null, held = [], monthlyIncome = 0
}) {
  const card = CARDS[product];
  if (!card) return { eligible: false, reason: "There is no such card." };

  if (held.some((f) => f.product === product && f.status === "active")) {
    return { eligible: false, held: true, reason: `You already hold a ${card.label.toLowerCase()}.` };
  }

  if (card.secured) {
    return { eligible: true, reason: "Put up a deposit and the limit is the same." };
  }

  if (monthlyIncome <= 0) {
    return {
      eligible: false,
      reason: "There is no income recorded here yet, so there is nothing to set a limit against."
    };
  }
  if (score === null) {
    return {
      eligible: false,
      reason: "Nothing has been borrowed or repaid here yet, so there is nothing to go on. " +
        "A secured card is where a record starts."
    };
  }
  if (score < card.minScore) {
    return {
      eligible: false,
      reason: `This one needs a score of ${card.minScore}. Yours is ${score}.`
    };
  }
  if (historyMonths < card.minHistoryMonths) {
    return {
      eligible: false,
      reason: `This one needs ${card.minHistoryMonths} months of history here. You have ${historyMonths}.`
    };
  }
  if (record && card.maxMissed !== null && record.missed > card.maxMissed) {
    return {
      eligible: false,
      reason: card.maxMissed === 0
        ? `This one is for a record with nothing missed on it. Yours has ${record.missed}.`
        : `This one allows ${card.maxMissed} missed payment${card.maxMissed === 1 ? "" : "s"}. ` +
          `Yours has ${record.missed}.`
    };
  }

  return {
    eligible: true,
    limit: limitFor({ product, monthlyIncome, cleanMonths }),
    reason: `Approved on a score of ${score} and ${historyMonths} months of history.`
  };
}

// The best card not already held that could be had today, and the nearest one
// still out of reach with what is missing from it. Both are worth showing: one
// is an offer and the other is a target.
export function upgradePath(context) {
  const held = context.held || [];
  const bestHeld = held
    .filter((f) => isCard(f.product) && f.status === "active")
    .reduce((top, f) => (top === null || CARDS[f.product].tier > CARDS[top].tier ? f.product : top), null);
  const heldTier = bestHeld ? CARDS[bestHeld].tier : -1;

  const above = CARD_ORDER
    .filter((product) => CARDS[product].tier > heldTier)
    .map((product) => ({ product, ...CARDS[product], ...eligibility(product, context) }));

  // The offer is the best of what is within reach, so the highest that clears
  // every gate. The target is the nearest one that does not — the lowest, not
  // the grandest, since naming platinum to somebody who cannot yet have the
  // rewards card tells them nothing they can do this month.
  const offer = above.filter((c) => c.eligible).at(-1) || null;
  const next = above.find((c) => !c.eligible && !c.held) || null;

  return { held: bestHeld, offer, next };
}
