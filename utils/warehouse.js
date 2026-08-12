// Where the stock actually is.
//
// A product carries one number for how many there are, and that number is the
// one every other part of the app trusts: a sale asks it whether it can sell,
// and it must never have to add up rows across a warehouse to find out. What
// this adds is the second question — of those forty bags of sugar, how many are
// in the back store and how many are on the stall.
//
// So placements sit alongside the total rather than replacing it, and the two
// are written together. The one thing that must never happen quietly is them
// disagreeing, which is why `unplaced` below is computed and reported rather
// than assumed to be zero.
//
// Pure. Rows in, plain objects out.

const round = (n) => Math.round(Number(n) * 100) / 100;

// Where one product's stock sits, and whether the placements add up to the
// total the product says it has.
//
// `unplaced` is the honest remainder. Positive means stock exists that nobody
// has said where it is — ordinary the day locations are switched on, and worth
// clearing. Negative means the opposite and is worse: more is recorded at
// locations than the business owns, which can only be a bug or a hand-edited
// row, and saying so plainly beats showing a tidy total that is wrong.
export function placement(product, rows = []) {
  const total = round(product.quantity);
  const byLocation = rows
    .map((r) => ({
      locationId: r.location_id,
      name: r.location_name,
      code: r.location_code,
      isDefault: Boolean(r.is_default),
      quantity: round(r.quantity)
    }))
    .filter((r) => r.quantity !== 0)
    .sort((a, b) => b.quantity - a.quantity);

  const placed = round(byLocation.reduce((sum, r) => sum + r.quantity, 0));
  const unplaced = round(total - placed);

  return {
    total,
    placed,
    unplaced,
    byLocation,
    // The two answers agree. Anything else is worth a person looking at.
    reconciled: unplaced === 0,
    overPlaced: unplaced < 0
  };
}

// The whole store, product by product, plus the totals a page leads with.
export function stockReport(products = [], stockRows = [], locations = []) {
  const byProduct = new Map();
  for (const row of stockRows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }

  const rows = products.map((product) => ({
    product,
    ...placement(product, byProduct.get(product.id) || [])
  }));

  const perLocation = locations.map((location) => {
    const held = stockRows.filter((r) => r.location_id === location.id);
    const value = held.reduce((sum, r) => {
      const product = products.find((p) => p.id === r.product_id);
      return sum + Number(r.quantity) * Number(product?.unit_cost || 0);
    }, 0);

    return {
      ...location,
      lines: held.filter((r) => Number(r.quantity) !== 0).length,
      units: round(held.reduce((sum, r) => sum + Number(r.quantity), 0)),
      value: round(value)
    };
  });

  return {
    rows,
    perLocation,
    unplacedCount: rows.filter((r) => r.unplaced > 0).length,
    overPlacedCount: rows.filter((r) => r.overPlaced).length,
    // Everything is where somebody said it is.
    reconciled: rows.every((r) => r.reconciled)
  };
}

// Whether stock can be moved from one place to another.
//
// Refused rather than clamped: a transfer of more than is there is somebody
// mistyping, and moving "as much as we can" silently would leave them believing
// a move happened that did not.
export function checkTransfer({ quantity, available, fromId, toId }) {
  const amount = Number(quantity);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "Enter how many to move." };
  }
  if (!fromId || !toId) {
    return { ok: false, reason: "Choose where the stock is moving from and to." };
  }
  if (String(fromId) === String(toId)) {
    return { ok: false, reason: "That is the same place — nothing would move." };
  }
  if (amount > round(available)) {
    return {
      ok: false,
      reason: `There ${available === 1 ? "is" : "are"} only ${round(available)} there to move.`
    };
  }
  return { ok: true, amount: round(amount) };
}

// Which locations are short of a product, given the reorder point the product
// carries. A shop with a full back store and an empty shelf is not out of
// stock — it has a moving problem, not a buying one, and the two want
// different actions.
export function restockSuggestions(report, { minPerLocation = 1 } = {}) {
  const suggestions = [];

  for (const row of report.rows) {
    const reorderPoint = Number(row.product.reorder_point || 0);
    if (reorderPoint <= 0) continue;

    // Only worth saying when the business HAS the stock somewhere else.
    const empty = report.perLocation.filter(
      (location) => !row.byLocation.some((b) => b.locationId === location.id && b.quantity >= minPerLocation)
    );
    const holding = row.byLocation.filter((b) => b.quantity > 0);

    if (empty.length > 0 && holding.length > 0 && row.total > 0) {
      suggestions.push({
        product: row.product,
        from: holding[0],
        empty: empty.map((l) => l.name),
        total: row.total
      });
    }
  }

  return suggestions;
}
