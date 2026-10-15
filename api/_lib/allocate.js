// Pure payout math, kept separate so it can be tested without a database or blockchain.
// All amounts are integers in the token's smallest unit (BigInt).

// Split `amount` between clippers in proportion to their views.
// Rounds down for everyone; the few leftover units stay in the pool for the next run.
export function splitByViews(amount, rows) {
  const total = rows.reduce((s, r) => s + BigInt(r.views), 0n);
  if (amount <= 0n || total <= 0n) return { allocations: [], allocated: 0n, totalViews: total };
  const allocations = [];
  let allocated = 0n;
  for (const r of rows) {
    const v = BigInt(r.views);
    if (v <= 0n) continue;
    const share = (amount * v) / total;
    if (share > 0n) {
      allocations.push({ clipperId: r.clipperId, amount: share, views: v, shareBps: Number((v * 10000n) / total) });
      allocated += share;
    }
  }
  return { allocations, allocated, totalViews: total };
}

// Take a platform cut in basis points (0 = clippers get everything).
export function afterPlatformFee(amount, feeBps) {
  const bps = BigInt(Math.max(0, Math.min(10000, Math.floor(Number(feeBps) || 0))));
  return amount - (amount * bps) / 10000n;
}

// Choose which owed balances to pay this run.
// owed: [{ clipperId, wallet, amount }], already summed per clipper. maxTotal null = no cap.
export function pickPayouts(owed, minAmount, maxTotal) {
  const picked = [];
  let total = 0n;
  for (const o of [...owed].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
    if (o.amount < minAmount) continue;
    if (maxTotal !== null && total + o.amount > maxTotal) continue;
    picked.push(o);
    total += o.amount;
  }
  return { picked, total };
}

// "12.5" with 6 decimals -> 12500000n
export function toRaw(value, decimals) {
  const s = String(value ?? "0").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// Like toRaw, but refuses anything that is not a plain number (so "10,000" cannot silently become 0).
export function toRawStrict(value, decimals, name) {
  const s = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name} must be a plain number like 100 or 0.5 (got "${s}").`);
  return toRaw(s, decimals);
}

// numeric from the database (string, maybe with ".000") -> BigInt of the whole units
export function rawFromDb(v) {
  const s = String(v ?? "0").split(".")[0].trim();
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export function fromRaw(raw, decimals) {
  const neg = raw < 0n; let x = neg ? -raw : raw;
  const d = 10n ** BigInt(decimals);
  const i = x / d, f = (x % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + i.toString() + (f ? "." + f : "");
}
