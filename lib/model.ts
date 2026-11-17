// Token Radar v2 — the model, the mechanism-aware farm plans and their costs.
//
// Two claims, both computed from the sealed snapshot and nothing else:
//
// 1. An implied launch value for every protocol that records no token.
//    fitMultiples() prices each category by the median market-cap/TVL
//    multiple of its tokenized members, shrunk toward the global median in
//    log space (weight n/(n+4)); a category with fewer than three tokenized
//    members falls back to the global median, and the row says so — the
//    fallback is a label on the board, not a footnote. impliedValueOf() is
//    TVL x that multiple. checkOutOfSample() fits the same model on two
//    thirds of the tokenized set and scores it against the held-out third's
//    real market caps, next to two unfitted baselines.
//
// 2. A farm plan per protocol whose costs are added up, not waved at.
//    Each plan is built from the protocol's mechanism (lending loop, DEX
//    liquidity, perps volume, bridge crossings, ...), priced session by
//    session in integer cents under a fee schedule and fee formulas that
//    the dashboard prints in full, and closed by a verdict step: the plan's
//    total modeled cost against a reward under Scenario S — a stated,
//    labeled assumption set, never a prediction. The conservative bound
//    (the same pool shared pro-rata over all TVL) is printed beside it.
//
// Language rule, kept from the data: a protocol whose mcap_usd, gecko_id
// and symbol are all null "records no token" in this snapshot. The file
// cannot prove more, so the entry claims no more.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface CatFit {
  category: string;
  peers: number;
  median_multiple: number;
  used_multiple: number;
}

export interface Fit {
  global_multiple: number;
  fit_n: number;
  zero_mcap_seen: number;
  cats: CatFit[];
  byCat: Map<string, CatFit>;
}

export interface Validation {
  train_n: number;
  test_n: number;
  median_ape_pct: number;
  mape_pct: number;
  median_factor: number;
  spearman: number;
  flat_median_ape_pct: number;
  global_median_ape_pct: number;
}

export interface FeePart {
  label: string;
  cents: number;
  at: 'open' | 'window';
}

export interface StepCost {
  gas_cents: number;
  fees_cents: number;
}

export interface Plan {
  mechanism: string;
  mechanism_label: string;
  position_usd: number;
  band: string;
  weeks: number;
  sessions: number;
  gas_per_session_cents: number;
  fee_parts: FeePart[];
  step_costs: StepCost[];
  gas_total_cents: number;
  fees_total_cents: number;
  total_cost_cents: number;
  reward_scenario_cents: number;
  reward_pro_rata_cents: number;
  net_scenario_cents: number;
  net_pro_rata_cents: number;
  verdict: string;
}

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  multiple_used: number;
  category_peers: number;
  basis: 'category' | 'global';
  watchlist: boolean;
  plan: Plan;
}

export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  change_7d: number | null;
}

export interface Radar {
  board: Row[];
  live: LiveRow[];
  fit: Fit;
  validation: Validation;
  calibration: Calibration;
  decomposition: Decomposition;
  dq: DataQuality;
  live_total: number;
}

// ---------------------------------------------------------------------------
// The snapshot and the board's product-type line
// ---------------------------------------------------------------------------

const MIN_PEERS = 3;
const SHRINK_K = 4;
const NAME_VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const NAME_WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_HEADS = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
/** Categories the watchlist definition itself sets aside: products of a token that already trades. */
const SET_ASIDE = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

export function loadSnapshot(text: string): Snap {
  const raw = JSON.parse(text) as Snap;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** True when the snapshot records no token for the protocol: all three token fields null. */
export function recordsNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Rankable: records no token and passes the product-type line the watchlist
 * definition draws (no wrapped/staked/bridged products of trading tokens,
 * no exchange-fronted names, no version-suffixed names), applied without
 * the watchlist's $50M floor — the floor is a size line, this is a kind line.
 */
export function isRankable(p: Proto): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && SET_ASIDE.has(p.category)) return false;
  if (NAME_VERSIONED.test(p.name) || NAME_WRAPPED.test(p.name)) return false;
  return !EXCHANGE_HEADS.some((x) => p.name.startsWith(x));
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Multiples are carried at six decimals, the precision the board prints. */
function roundMult(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** The fit's raw material: tokenized protocols with a real, positive market cap and TVL. */
export function fitPool(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/**
 * Fit category multiples on the protocols given. The global median comes
 * from exactly those protocols, so a caller validating out-of-sample can
 * pass the training part only and no held-out figure can leak into a
 * category median or into the fallback.
 */
export function fitMultiples(protocols: Proto[]): Fit {
  const pool = fitPool(protocols);
  const globalRaw = medianOf(pool.map((p) => p.mcap_usd! / p.tvl_usd));
  const groups = new Map<string, number[]>();
  for (const p of pool) {
    const key = p.category ?? 'Uncategorized';
    const list = groups.get(key);
    if (list) list.push(p.mcap_usd! / p.tvl_usd);
    else groups.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  const cats: CatFit[] = [];
  const byCat = new Map<string, CatFit>();
  for (const [category, mults] of groups) {
    if (mults.length < MIN_PEERS) continue;
    const med = medianOf(mults);
    const w = mults.length / (mults.length + SHRINK_K);
    const blended = Math.exp(w * Math.log(med) + (1 - w) * Math.log(globalRaw));
    const entry: CatFit = {
      category,
      peers: mults.length,
      median_multiple: roundMult(med),
      used_multiple: roundMult(blended),
    };
    cats.push(entry);
    byCat.set(category, entry);
  }
  cats.sort((a, b) => b.used_multiple - a.used_multiple);
  return {
    global_multiple: roundMult(globalRaw),
    fit_n: pool.length,
    zero_mcap_seen: protocols.filter((p) => p.mcap_usd === 0).length,
    cats,
    byCat,
  };
}

/** Which multiple a protocol is priced with, and whether it is a fit or the fallback. */
export function multipleFor(p: Proto, fit: Fit): { multiple: number; peers: number; basis: 'category' | 'global' } {
  const cat = fit.byCat.get(p.category ?? 'Uncategorized');
  if (cat) return { multiple: cat.used_multiple, peers: cat.peers, basis: 'category' };
  return { multiple: fit.global_multiple, peers: 0, basis: 'global' };
}

/** The model's whole valuation claim: TVL times the fitted multiple. */
export function impliedValueOf(p: Proto, fit: Fit): number {
  return Math.max(1, Math.round(p.tvl_usd * multipleFor(p, fit).multiple));
}

// ---------------------------------------------------------------------------
// Out-of-sample validation: fit on two thirds, score on the held-out third
// ---------------------------------------------------------------------------

function errorStats(preds: number[], actuals: number[]): { medianApe: number; mape: number; medianFactor: number; spearman: number } {
  const apes = preds.map((pr, i) => Math.abs(pr - actuals[i]!) / actuals[i]!);
  const factors = preds.map((pr, i) => Math.exp(Math.abs(Math.log(pr / actuals[i]!))));
  const rankOf = (xs: number[]): number[] => {
    const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
    const ranks = new Array<number>(xs.length);
    order.forEach((idx, r) => {
      ranks[idx] = r;
    });
    return ranks;
  };
  const pr = rankOf(preds);
  const ar = rankOf(actuals);
  const n = preds.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (pr[i]! - ar[i]!) ** 2;
  return {
    medianApe: medianOf(apes) * 100,
    mape: (apes.reduce((a, b) => a + b, 0) / apes.length) * 100,
    medianFactor: medianOf(factors),
    spearman: 1 - (6 * d2) / (n * (n * n - 1)),
  };
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * The fit pool, sorted by slug, is split deterministically — every third
 * protocol is held out — the model is refitted on the training part alone
 * and scored against the held-out part's real market caps, beside a flat
 * 0.25x baseline and a global-median-only baseline scored the same way.
 */
export function checkOutOfSample(protocols: Proto[]): Validation {
  const pool = fitPool(protocols).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const train = pool.filter((_, i) => i % 3 !== 2);
  const test = pool.filter((_, i) => i % 3 === 2);
  const model = fitMultiples(train);
  const actuals = test.map((p) => p.mcap_usd!);
  const mine = errorStats(test.map((p) => impliedValueOf(p, model)), actuals);
  const flat = errorStats(test.map((p) => Math.round(p.tvl_usd * 0.25)), actuals);
  const glob = errorStats(test.map((p) => Math.round(p.tvl_usd * model.global_multiple)), actuals);
  return {
    train_n: train.length,
    test_n: test.length,
    median_ape_pct: round1(mine.medianApe),
    mape_pct: round1(mine.mape),
    median_factor: round2(mine.medianFactor),
    spearman: round2(mine.spearman),
    flat_median_ape_pct: round1(flat.medianApe),
    global_median_ape_pct: round1(glob.medianApe),
  };
}

// ---------------------------------------------------------------------------
// Calibration and error decomposition: the same held-out split, read harder
// ---------------------------------------------------------------------------

export interface CalDecile {
  decile: number;
  n: number;
  mean_pred: number;
  mean_real: number;
  ratio: number;
}

export interface Calibration {
  deciles: CalDecile[];
  /** Least-squares slope of log(realized) on log(predicted) over the held-out set; 1 is the diagonal. */
  slope: number;
  intercept: number;
  /** Deciles whose mean prediction lands below the mean realized cap (ratio < 1). */
  under_deciles: number;
}

interface ScoredTest {
  p: Proto;
  pred: number;
  actual: number;
  ape: number;
  peers: number;
  basis: 'category' | 'global';
}

/** The held-out third, scored by a model refitted on the training two-thirds alone. */
function scoredTestSet(protocols: Proto[]): ScoredTest[] {
  const pool = fitPool(protocols).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const train = pool.filter((_, i) => i % 3 !== 2);
  const test = pool.filter((_, i) => i % 3 === 2);
  const model = fitMultiples(train);
  return test.map((p) => {
    const pred = impliedValueOf(p, model);
    const m = multipleFor(p, model);
    return { p, pred, actual: p.mcap_usd!, ape: Math.abs(pred - p.mcap_usd!) / p.mcap_usd!, peers: m.peers, basis: m.basis };
  });
}

/**
 * Predicted against realized on the held-out set: the test rows bucketed
 * into deciles by predicted value, each decile's mean prediction set
 * against its mean realized market cap, plus the log-space slope.
 */
export function calibrationOf(protocols: Proto[]): Calibration {
  const rows = scoredTestSet(protocols).sort((a, b) => a.pred - b.pred || (a.p.slug < b.p.slug ? -1 : 1));
  const n = rows.length;
  const deciles: CalDecile[] = [];
  for (let d = 0; d < 10; d++) {
    const bucket = rows.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10));
    if (bucket.length === 0) continue;
    const meanPred = bucket.reduce((s, r) => s + r.pred, 0) / bucket.length;
    const meanReal = bucket.reduce((s, r) => s + r.actual, 0) / bucket.length;
    deciles.push({
      decile: d + 1,
      n: bucket.length,
      mean_pred: Math.round(meanPred),
      mean_real: Math.round(meanReal),
      ratio: round2(meanPred / meanReal),
    });
  }
  const xs = rows.map((r) => Math.log(r.pred));
  const ys = rows.map((r) => Math.log(r.actual));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxy / sxx;
  return {
    deciles,
    slope: round2(slope),
    intercept: round2(my - slope * mx),
    under_deciles: deciles.filter((d) => d.ratio < 1).length,
  };
}

export interface DecompRow {
  label: string;
  n: number;
  median_ape_pct: number;
}

export interface WorstRow {
  name: string;
  slug: string;
  category: string | null;
  tvl_usd: number;
  pred: number;
  actual: number;
  ape_pct: number;
  cause: 'bad peer set' | 'stale input' | 'genuine model miss';
  cause_detail: string;
}

export interface Decomposition {
  by_category: DecompRow[];
  by_tvl_band: DecompRow[];
  worst: WorstRow[];
  worst_k: number;
}

const TVL_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: 'Under $10M', lo: 0, hi: 10_000_000 },
  { label: '$10–50M', lo: 10_000_000, hi: 50_000_000 },
  { label: '$50–250M', lo: 50_000_000, hi: 250_000_000 },
  { label: 'Over $250M', lo: 250_000_000, hi: Number.POSITIVE_INFINITY },
];

/**
 * Where the held-out error lives: median APE by category and by TVL band,
 * and the worst decile of misses named, each classified under a stated
 * rule applied in order — priced on the global fallback (bad peer set),
 * TVL moved at least 25% inside the snapshot's own 7-day window (stale
 * input), otherwise a genuine model miss.
 */
export function decompositionOf(protocols: Proto[]): Decomposition {
  const rows = scoredTestSet(protocols);
  const medianApe = (rs: ScoredTest[]): number => round1(medianOf(rs.map((r) => r.ape)) * 100);
  const byCat = new Map<string, ScoredTest[]>();
  for (const r of rows) {
    const key = r.p.category ?? 'Uncategorized';
    const list = byCat.get(key);
    if (list) list.push(r);
    else byCat.set(key, [r]);
  }
  const by_category: DecompRow[] = [...byCat.entries()]
    .map(([label, rs]) => ({ label, n: rs.length, median_ape_pct: medianApe(rs) }))
    .sort((a, b) => b.median_ape_pct - a.median_ape_pct || (a.label < b.label ? -1 : 1));
  const by_tvl_band: DecompRow[] = TVL_BANDS.map((b) => {
    const rs = rows.filter((r) => r.p.tvl_usd >= b.lo && r.p.tvl_usd < b.hi);
    return { label: b.label, n: rs.length, median_ape_pct: rs.length ? medianApe(rs) : 0 };
  }).filter((b) => b.n > 0);
  const worst_k = Math.max(1, Math.round(rows.length / 10));
  const worst: WorstRow[] = [...rows]
    .sort((a, b) => b.ape - a.ape || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, worst_k)
    .map((r) => {
      let cause: WorstRow['cause'];
      let cause_detail: string;
      if (r.basis === 'global') {
        cause = 'bad peer set';
        cause_detail = `the training fit had no ${r.p.category ?? 'Uncategorized'} category (fewer than 3 training peers), so the global median priced it`;
      } else if (r.p.change_7d !== null && Math.abs(r.p.change_7d) >= 25) {
        cause = 'stale input';
        cause_detail = `its TVL moved ${r.p.change_7d.toFixed(1)}% inside the snapshot's own 7-day window — the input was in flux`;
      } else {
        cause = 'genuine model miss';
        cause_detail = `priced from a ${r.peers}-peer category fit; the market values this protocol far from its category's median multiple`;
      }
      return {
        name: r.p.name,
        slug: r.p.slug,
        category: r.p.category,
        tvl_usd: r.p.tvl_usd,
        pred: r.pred,
        actual: r.actual,
        ape_pct: round1(r.ape * 100),
        cause,
        cause_detail,
      };
    });
  return { by_category, by_tvl_band, worst, worst_k };
}

// ---------------------------------------------------------------------------
// Data quality: the snapshot audited before any fitting (defi-data-quality)
// ---------------------------------------------------------------------------

export interface BandViolation {
  name: string;
  slug: string;
  category: string | null;
  multiple: number;
  tvl_usd: number;
  mcap_usd: number;
  side: 'high' | 'low';
  cause: string;
}

export interface DataQuality {
  protocols: number;
  records_no_token: number;
  excl_set_aside: { category: string; n: number }[];
  excl_set_aside_total: number;
  excl_versioned: number;
  excl_wrapped: number;
  excl_exchange: number;
  board_rows: number;
  tokenized: number;
  zero_mcap: number;
  negative_mcap: { name: string; slug: string; mcap_usd: number }[];
  partial_token_records: number;
  fit_pool_n: number;
  fit_excl_zero: number;
  fit_excl_negative: number;
  fit_excl_nonpos_tvl: number;
  completeness: { field: string; nulls: number; pct: number }[];
  dup_slugs: number;
  dup_names: number;
  tvl_zero: number;
  tvl_negative: number;
  watchlist_total: number;
  watchlist_in_snapshot: number;
  watchlist_missing: string[];
  watchlist_on_board: number;
  band_lo: number;
  band_hi: number;
  band_violations: BandViolation[];
  band_effect: { global_with: number; global_without: number; board_multiples_changed: number };
  wrapper_protocols: number;
  wrapper_no_token: number;
  wrapper_in_fit: number;
}

const WRAPPER_CATS = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Linear-interpolation quantile over an ascending array — the sanity band's fence posts. */
function quantileOf(sortedAsc: number[], q: number): number {
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sortedAsc.length - 1);
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (i - lo);
}

/**
 * The snapshot-level audit, computed from the file itself: the board's
 * product-type exclusions by rule with counts, the fit pool's exclusions,
 * completeness and validity counts, watchlist verification, and a
 * log-space IQR sanity band over the fitted multiples whose violators
 * are named — never deleted — with the measured effect of dropping them.
 */
export function dataQualityOf(snapshot: Snap, fit: Fit, board: Row[]): DataQuality {
  const ps = snapshot.protocols;
  const noToken = ps.filter(recordsNoToken);
  const aside = new Map<string, number>();
  let versioned = 0;
  let wrapped = 0;
  let exchange = 0;
  for (const p of noToken) {
    if (p.category !== null && SET_ASIDE.has(p.category)) aside.set(p.category, (aside.get(p.category) ?? 0) + 1);
    else if (NAME_VERSIONED.test(p.name)) versioned++;
    else if (NAME_WRAPPED.test(p.name)) wrapped++;
    else if (EXCHANGE_HEADS.some((x) => p.name.startsWith(x))) exchange++;
  }
  const pool = fitPool(ps);
  const logs = pool.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd)).sort((a, b) => a - b);
  const q1 = quantileOf(logs, 0.25);
  const q3 = quantileOf(logs, 0.75);
  const iqr = q3 - q1;
  const bandLo = 10 ** (q1 - 1.5 * iqr);
  const bandHi = 10 ** (q3 + 1.5 * iqr);
  const violations: BandViolation[] = pool
    .map((p) => ({ p, m: p.mcap_usd! / p.tvl_usd }))
    .filter(({ m }) => m < bandLo || m > bandHi)
    .sort((a, b) => b.m - a.m)
    .map(({ p, m }) => ({
      name: p.name,
      slug: p.slug,
      category: p.category,
      multiple: roundMult(m),
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      side: m > bandHi ? ('high' as const) : ('low' as const),
      cause:
        m > bandHi
          ? "the token's market value sits far outside the TVL this snapshot records for it — the cap likely prices something the TVL does not capture, or is an FDV-like figure"
          : 'the recorded cap is a sliver of the recorded TVL — a stale or orphaned token price, or TVL the token does not capture',
    }));
  const violSlugs = new Set(violations.map((v) => v.slug));
  const fitWithout = fitMultiples(ps.filter((p) => !violSlugs.has(p.slug)));
  const protoBySlug = new Map(ps.map((p) => [p.slug, p]));
  let changed = 0;
  for (const row of board) {
    const p = protoBySlug.get(row.slug);
    if (p && multipleFor(p, fitWithout).multiple !== row.multiple_used) changed++;
  }
  const countNull = (f: (p: Proto) => boolean): number => ps.filter(f).length;
  const pct1 = (n: number): number => round1((n / ps.length) * 100);
  const slugCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const p of ps) {
    slugCounts.set(p.slug, (slugCounts.get(p.slug) ?? 0) + 1);
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  const snapSlugs = new Set(ps.map((p) => p.slug));
  return {
    protocols: ps.length,
    records_no_token: noToken.length,
    excl_set_aside: [...aside.entries()]
      .map(([category, n]) => ({ category, n }))
      .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1)),
    excl_set_aside_total: [...aside.values()].reduce((a, b) => a + b, 0),
    excl_versioned: versioned,
    excl_wrapped: wrapped,
    excl_exchange: exchange,
    board_rows: board.length,
    tokenized: ps.filter((p) => p.mcap_usd !== null).length,
    zero_mcap: ps.filter((p) => p.mcap_usd === 0).length,
    negative_mcap: ps
      .filter((p) => p.mcap_usd !== null && p.mcap_usd < 0)
      .map((p) => ({ name: p.name, slug: p.slug, mcap_usd: p.mcap_usd! })),
    partial_token_records: ps.filter((p) => p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null)).length,
    fit_pool_n: pool.length,
    fit_excl_zero: ps.filter((p) => p.mcap_usd === 0).length,
    fit_excl_negative: ps.filter((p) => p.mcap_usd !== null && p.mcap_usd < 0).length,
    fit_excl_nonpos_tvl: ps.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd <= 0).length,
    completeness: [
      { field: 'category', nulls: countNull((p) => p.category === null), pct: pct1(countNull((p) => p.category === null)) },
      { field: 'chains (empty)', nulls: countNull((p) => p.chains.length === 0), pct: pct1(countNull((p) => p.chains.length === 0)) },
      { field: 'change_7d', nulls: countNull((p) => p.change_7d === null), pct: pct1(countNull((p) => p.change_7d === null)) },
      { field: 'listed_at', nulls: countNull((p) => p.listed_at === null), pct: pct1(countNull((p) => p.listed_at === null)) },
    ],
    dup_slugs: [...slugCounts.values()].filter((n) => n > 1).length,
    dup_names: [...nameCounts.values()].filter((n) => n > 1).length,
    tvl_zero: countNull((p) => p.tvl_usd === 0),
    tvl_negative: countNull((p) => p.tvl_usd < 0),
    watchlist_total: snapshot.watchlist.length,
    watchlist_in_snapshot: snapshot.watchlist.filter((s) => snapSlugs.has(s)).length,
    watchlist_missing: snapshot.watchlist.filter((s) => !snapSlugs.has(s)),
    watchlist_on_board: board.filter((r) => r.watchlist).length,
    band_lo: roundMult(bandLo),
    band_hi: roundMult(bandHi),
    band_violations: violations,
    band_effect: { global_with: fit.global_multiple, global_without: fitWithout.global_multiple, board_multiples_changed: changed },
    wrapper_protocols: ps.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
    wrapper_no_token: noToken.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
    wrapper_in_fit: pool.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
  };
}

// ---------------------------------------------------------------------------
// Plan economics. All money below is integer cents until it is printed, so
// a plan's step costs sum to its stated total exactly — no rounding drift
// between the steps a reader sees and the verdict that closes the plan.
// ---------------------------------------------------------------------------

/** Scenario S, the reward assumption set — printed in full on the dashboard. */
export const SCENARIO = {
  /** Share of the implied value assumed to go to early users at a launch. */
  allocation_share: 0.05,
  /** The pool is shared over this assumed farmed fraction of TVL, not all of it. */
  farmed_fraction: 0.25,
};

interface Tier {
  min_tvl: number;
  band_lo: number;
  band_hi: number;
  weeks: number;
}

/** Working-capital bands by protocol scale; the modeled position is the band midpoint. */
const TIERS: Tier[] = [
  { min_tvl: 250_000_000, band_lo: 2_500, band_hi: 10_000, weeks: 10 },
  { min_tvl: 100_000_000, band_lo: 1_000, band_hi: 4_000, weeks: 10 },
  { min_tvl: 50_000_000, band_lo: 500, band_hi: 2_000, weeks: 8 },
  { min_tvl: 15_000_000, band_lo: 200, band_hi: 800, weeks: 7 },
  { min_tvl: 0, band_lo: 50, band_hi: 300, weeks: 5 },
];

function tierFor(tvl: number): Tier {
  for (const t of TIERS) if (tvl >= t.min_tvl) return t;
  return TIERS[TIERS.length - 1]!;
}

/** Sessions a week, the cadence every plan is costed at. */
const SESSIONS_PER_WEEK = 2;

/** Modeled gas per session, in cents, by chain — an assumption, printed on the dashboard. */
const GAS_CENTS: Record<string, number> = {
  Ethereum: 450,
  Solana: 6,
  'BNB Chain': 25,
  Tron: 30,
  Bitcoin: 60,
  Sui: 10,
  Aptos: 10,
  NEAR: 10,
  Cosmos: 15,
  Sei: 10,
  Injective: 10,
  Celestia: 10,
  Starknet: 20,
  Hyperliquid: 5,
};
const L2_CHAINS = new Set([
  'Arbitrum', 'Optimism', 'Base', 'Linea', 'Scroll', 'zkSync Era', 'Mantle',
  'Ink', 'Blast', 'Mode', 'Taiko', 'Unichain', 'World Chain', 'Zora', 'Boba',
  'Metis', 'Polygon', 'Avalanche', 'Sonic', 'Berachain', 'Monad', 'Flare',
]);
const GAS_DEFAULT_CENTS = 60;

function gasCentsFor(chain: string): number {
  const known = GAS_CENTS[chain];
  if (known !== undefined) return known;
  return L2_CHAINS.has(chain) ? 35 : GAS_DEFAULT_CENTS;
}

const GAS_TOKEN: Record<string, string> = {
  Ethereum: 'ETH', Base: 'ETH', Arbitrum: 'ETH', Optimism: 'ETH', Linea: 'ETH',
  Scroll: 'ETH', 'zkSync Era': 'ETH', Mantle: 'MNT', Solana: 'SOL',
  'BNB Chain': 'BNB', Polygon: 'POL', Avalanche: 'AVAX', Sui: 'SUI',
  Aptos: 'APT', Tron: 'TRX', Bitcoin: 'BTC', Cosmos: 'ATOM', NEAR: 'NEAR',
  Starknet: 'STRK', Hyperliquid: 'HYPE', Sei: 'SEI', Injective: 'INJ',
  Celestia: 'TIA', Berachain: 'BERA', Monad: 'MON', Sonic: 'S', Flare: 'FLR',
  TON: 'TON', Cardano: 'ADA', Ink: 'ETH', Stellar: 'XLM', Bittensor: 'TAO',
};

/** Print cents as dollars: whole dollars without decimals, otherwise two. */
export function fmtUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = abs % 100;
  const body = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

export function fmtSignedUsd(cents: number): string {
  return cents >= 0 ? `+${fmtUsd(cents)}` : fmtUsd(cents);
}

/** FNV-1a over the slug: picks plan phrasings deterministically per protocol. */
function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Mechanisms. A plan is keyed by what the protocol actually does: the steps
// name that mechanism's real actions and its fee parts come from that
// mechanism's formula. P is the modeled position in dollars, W the window
// in weeks, N the session count.
// ---------------------------------------------------------------------------

interface PlanCtx {
  name: string;
  chain: string;
  chains: string[];
  gasToken: string;
  band: string;
  position: number;
  weeks: number;
}

interface Mech {
  label: string;
  fees: (P: number, W: number, N: number) => FeePart[];
  open: (c: PlanCtx) => string;
  core: (c: PlanCtx) => string;
  breadth: (c: PlanCtx) => string;
  breadthSolo: (c: PlanCtx) => string;
  track: (c: PlanCtx) => string;
}

const fee = (label: string, cents: number, at: 'open' | 'window'): FeePart => ({ label, cents: Math.max(0, Math.round(cents)), at });

const MECHS: Record<string, Mech> = {
  dex: {
    label: 'DEX swaps + two-sided liquidity',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('LP rebalance fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Make a first small swap through its main interface, then seed a two-sided position in one of its busiest pools',
    core: () => 'route ordinary swaps through it each session and keep the pool position in range, rebalancing rather than withdrawing when it drifts',
    breadth: () => 'trade and provide on its second-busiest chain as well, so the history is not confined to one network',
    breadthSolo: () => 'add a second pool position on a different pair, so the record is not a single market',
    track: () => 'claim pool fees and any liquidity incentives it issues on its own schedule, and log every rebalance with its fee',
  },
  'liq-mgr': {
    label: 'Managed liquidity position',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('position adjustment fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Deposit a first tranche into its main managed position',
    core: () => 'keep the managed position in range across the window, checking it each session and topping up rather than exiting at the first rebalance',
    breadth: () => 'open a second managed position on another chain it runs',
    breadthSolo: () => 'open a second managed position on another pair, at a different range',
    track: () => 'follow its rebalance notices and claim any manager incentives it pays, logging each adjustment',
  },
  'lev-farm': {
    label: 'Leveraged liquidity farming',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('position adjustment fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Open a small leveraged position at the lowest leverage it offers',
    core: () => 'keep leverage conservative, check the position\u2019s health every session, and top up collateral early rather than letting it near liquidation',
    breadth: () => 'run a second, smaller leveraged position on a different pair it offers',
    breadthSolo: () => 'run a second, smaller position on a different underlying pair it offers',
    track: () => 'claim farm rewards on its schedule and keep a dated log of every health check and top-up',
  },
  lending: {
    label: 'Lending loop: supply, borrow, repay',
    fees: (P, W) => [
      fee('borrow interest on a 55% loan-to-value loop at a modeled 6% APR', 100 * P * 0.55 * 0.06 * (W / 52), 'window'),
    ],
    open: () => 'Supply a first tranche as collateral in its main money market',
    core: () => 'borrow a modest share against the collateral and repay on a cycle, keeping the health factor comfortably clear of liquidation the whole window',
    breadth: () => 'run a second, smaller supply position on another chain it serves',
    breadthSolo: () => 'run a second, smaller supply position in a different asset market it lists',
    track: () => 'claim any supply or borrow incentives it issues and log every loop cycle with the interest it cost',
  },
  vault: {
    label: 'Yield vault deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main vault or strategy',
    core: () => 'keep the deposit live for the whole window, harvest or compound on schedule, and add in tranches rather than one lump sum',
    breadth: () => 'open a smaller position in a second vault on another chain it runs',
    breadthSolo: () => 'open a smaller position in a second vault running a different strategy or asset',
    track: () => 'claim distributions as they are paid and log each tranche with its date and size',
  },
  aggregator: {
    label: 'Auto-compounding vault',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main auto-compounding vault',
    core: () => 'keep the position compounding across the window and top it up in tranches, letting the harvest cycle do its work',
    breadth: () => 'open a smaller position in a vault on another chain it aggregates',
    breadthSolo: () => 'open a smaller position in a second vault on a different underlying asset',
    track: () => 'log each top-up and check the vault\u2019s reported yield against the position\u2019s actual growth weekly',
  },
  farm: {
    label: 'Farm pool staking',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main farm pool',
    core: () => 'keep the farm position live and claim or compound its rewards on a weekly cadence rather than letting them sit',
    breadth: () => 'join a second pool it runs, on a different pair or asset',
    breadthSolo: () => 'join a second pool it runs, on a different pair or asset',
    track: () => 'claim rewards on schedule and keep a dated log of every claim and compound',
  },
  allocator: {
    label: 'Capital allocation vault',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main allocation vault',
    core: () => 'keep the allocation live across the window, claim distributions on schedule, and add in tranches as the vault allocates',
    breadth: () => 'open a smaller position in a second strategy it allocates to',
    breadthSolo: () => 'open a smaller position in a second strategy it allocates to',
    track: () => 'follow its allocation reports and log every distribution the position receives',
  },
  curator: {
    label: 'Curated vault deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche into one of its curated vaults',
    core: () => 'keep the vault position live across the window and follow the curator\u2019s reallocation notices instead of chasing them',
    breadth: () => 'split a smaller tranche into a second vault under a different curator or risk profile',
    breadthSolo: () => 'split a smaller tranche into a second vault under a different curator or risk profile',
    track: () => 'log each reallocation notice and claim any curator incentives the vault pays',
  },
  basis: {
    label: 'Basis position',
    fees: () => [],
    open: () => 'Open a first small basis position through its vault',
    core: () => 'keep the position funded for the whole window; basis returns accrue with time in the trade, not with churn, so resist closing early',
    breadth: () => 'add a second tranche on a different underlying if it offers one',
    breadthSolo: () => 'add a second tranche on a different underlying if it offers one',
    track: () => 'log the funding the position earns or pays each week, since that is the position\u2019s real carry',
  },
  perps: {
    label: 'Perpetuals volume',
    fees: (P, _W, N) => [
      fee('taker fees at 0.05% on 3x notional, one trade a session', 100 * P * 3 * N * 0.0005, 'window'),
    ],
    open: () => 'Open a first small trade on its main perpetual market',
    core: () => 'trade small size on a regular cadence, opening and closing cleanly, rather than holding one large directional position',
    breadth: () => 'trade a second market it lists, so the activity is not one instrument only',
    breadthSolo: () => 'trade a second market it lists, so the activity is not one instrument only',
    track: () => 'log every trade with its fee and funding paid or received; funding is excluded from this plan\u2019s cost model and cuts both ways',
  },
  cdp: {
    label: 'Collateralised debt position',
    fees: (P, W) => [
      fee('mint fee at 0.5% of the amount minted against the collateral', 100 * 0.005 * 0.4 * P, 'open'),
      fee('stability fee at a modeled 3% APR on the minted amount', 100 * 0.4 * P * 0.03 * (W / 52), 'window'),
    ],
    open: () => 'Open a small collateralised debt position and mint a modest amount of its stablecoin against it',
    core: () => 'keep the collateral ratio well above the liquidation line, and repay and re-mint on a cycle rather than letting the position sit untouched',
    breadth: () => 'use the minted stablecoin inside its own ecosystem where it is accepted',
    breadthSolo: () => 'open a second small position on another collateral type it accepts',
    track: () => 'check the collateral ratio weekly and log every mint, repay and stability charge',
  },
  options: {
    label: 'Options flow',
    fees: (P, W) => [
      fee('option premiums at a modeled 2% of the position per weekly roll', 100 * P * 0.02 * W, 'window'),
    ],
    open: () => 'Buy or write a first small option position',
    core: () => 'roll small positions on a weekly cadence and let some expire rather than closing everything early',
    breadth: () => 'use a second strike or expiry series it offers',
    breadthSolo: () => 'use a second strike or expiry series it offers',
    track: () => 'log every premium paid and every expiry; the premium line is this plan\u2019s main cost and it is spent, not held',
  },
  'options-vault': {
    label: 'Options vault epochs',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main options vault',
    core: () => 'keep the deposit across several weekly epochs, since vault strategies settle per epoch and partial epochs earn partial results',
    breadth: () => 'join a second vault on a different underlying where offered',
    breadthSolo: () => 'join a second vault on a different underlying where offered',
    track: () => 'log each epoch\u2019s settlement against the deposit and claim payouts as they land',
  },
  bridge: {
    label: 'Bridge crossings',
    fees: (P, W) => [
      fee('relayer fees at 0.1% of the amount crossed', 100 * P * W * 0.001, 'window'),
      fee('fixed crossing fees at $0.75 a crossing, two a week', 150 * W, 'window'),
    ],
    open: () => 'Bridge a small amount across its busiest route',
    core: () => 'move funds in both directions on two different routes, at varied times of day, rather than one large crossing',
    breadth: () => 'use a second chain pair it supports, so the history is not a single corridor',
    breadthSolo: () => 'use a second chain pair it supports, so the history is not a single corridor',
    track: () => 'use the bridged funds in the destination chain\u2019s own apps between crossings, and log every crossing with its fee',
  },
  chain: {
    label: 'Native chain activity',
    fees: (P) => [fee('bridge-in fee at 0.1% of the amount moved onto the chain', 100 * 0.001 * P, 'open')],
    open: () => 'Bridge starter funds onto the chain and make a first transaction in one of its native apps',
    core: () => 'use its native decentralised apps each session — swaps, lending, a name or NFT mint where cheap — so the wallet builds ordinary history',
    breadth: () => 'hold a small balance and keep transacting through quiet weeks, not only during campaigns',
    breadthSolo: () => 'hold a small balance and keep transacting through quiet weeks, not only during campaigns',
    track: () => 'log active days and distinct apps used; on a chain, breadth of ordinary use is the record that matters',
  },
  staking: {
    label: 'Staking pool',
    fees: () => [],
    open: () => 'Stake a first tranche in its main pool',
    core: () => 'compound or re-stake rewards on a fixed cadence instead of letting them sit idle',
    breadth: () => 'join a second pool it runs where the terms differ',
    breadthSolo: () => 'join a second pool it runs where the terms differ',
    track: () => 'claim rewards on schedule and log every compound with its date',
  },
  restaking: {
    label: 'Restaking delegation',
    fees: () => [],
    open: () => 'Restake or delegate a first tranche through its main vault or operator set',
    core: () => 'keep the position delegated for the full window and track its operator or service rewards as they accrue',
    breadth: () => 'split a smaller second tranche across another operator or vault it lists',
    breadthSolo: () => 'split a smaller second tranche across another operator or vault it lists',
    track: () => 'claim points or rewards it issues on schedule and log the delegation\u2019s state weekly',
  },
  rwa: {
    label: 'Real-world asset holding',
    fees: (P) => [fee('onboarding and subscription fee at 0.25% of the position', 100 * 0.0025 * P, 'open')],
    open: () => 'Complete its onboarding or KYC step if it requires one, then make a first deposit',
    core: () => 'hold the real-world-asset position across the window and claim distributions as they are paid',
    breadth: () => 'add a second asset or tranche it offers rather than concentrating in one',
    breadthSolo: () => 'add a second asset or tranche it offers rather than concentrating in one',
    track: () => 'log every distribution and keep the onboarding records with the position\u2019s paperwork',
  },
  launchpad: {
    label: 'Launchpad participation',
    fees: (P) => [fee('participation fee at 1% of a half-position allocation', 100 * 0.01 * (P / 2), 'open')],
    open: () => 'Register or verify the wallet on its launch platform',
    core: () => 'take part in the sales it runs at small size and hold at least part of each allocation instead of flipping all of it',
    breadth: () => 'stake or lock in its participation tier system if it runs one',
    breadthSolo: () => 'stake or lock in its participation tier system if it runs one',
    track: () => 'log every sale entered, the allocation received and what was held versus sold',
  },
  prediction: {
    label: 'Prediction market trading',
    fees: (P) => [fee('trading fees at 1% on modeled volume of 4x the position', 100 * P * 4 * 0.01, 'window')],
    open: () => 'Fund the account and take a first small position in a liquid market',
    core: () => 'trade both sides across several markets over the window rather than placing one large bet',
    breadth: () => 'take the less crowded side, or provide liquidity, in a second market category',
    breadthSolo: () => 'take the less crowded side, or provide liquidity, in a second market category',
    track: () => 'log every position with its entry price and settlement; settled history is the record here',
  },
  nft: {
    label: 'NFT marketplace trading',
    fees: (P) => [fee('marketplace fees at 2% on modeled volume of 2x the position', 100 * P * 2 * 0.02, 'window')],
    open: () => 'Make a first small purchase or listing on the marketplace',
    core: () => 'trade modest items on a regular cadence, listing as well as buying, so the wallet is not one-directional',
    breadth: () => 'use its second-busiest collection or chain where it operates on more than one',
    breadthSolo: () => 'use a second collection it lists actively, so the history is not one set of items',
    track: () => 'log buys, listings and sales with fees; creator royalties are excluded from this plan\u2019s cost model',
  },
  privacy: {
    label: 'Shielded usage',
    fees: (P, W) => [fee('shield and unshield fees at 0.1% of the position per weekly cycle', 100 * P * 0.001 * W, 'window')],
    open: () => 'Make a first small shielded deposit through its main interface',
    core: () => 'use the private transfer or shield flow a few times at varied amounts and intervals',
    breadth: () => 'withdraw through its standard route so the full cycle is on record',
    breadthSolo: () => 'withdraw through its standard route so the full cycle is on record',
    track: () => 'keep private records of each shield, transfer and unshield with dates and amounts',
  },
  synthetics: {
    label: 'Synthetic positions',
    fees: (P, _W, N) => [fee('trade fees at 0.15% of the position, one trade a session', 100 * P * 0.0015 * N, 'window')],
    open: () => 'Mint or trade a first small synthetic position',
    core: () => 'keep collateral posted and adjust the position each session rather than setting it and forgetting it',
    breadth: () => 'use a second synthetic asset it issues where available',
    breadthSolo: () => 'use a second synthetic asset it issues where available',
    track: () => 'log every adjustment with its fee and the collateral posted against it',
  },
  indexes: {
    label: 'Index holding',
    fees: (P) => [fee('issuance fee at 0.2% of the position', 100 * 0.002 * P, 'open')],
    open: () => 'Buy a first tranche of its main index product',
    core: () => 'hold the index across the window and add on a monthly cadence rather than trading it',
    breadth: () => 'hold a second index it issues where the composition differs',
    breadthSolo: () => 'hold a second index it issues where the composition differs',
    track: () => 'log each monthly addition and the index\u2019s composition changes as they are announced',
  },
  insurance: {
    label: 'Cover and capital pool',
    fees: (P, W) => [fee('cover premium at a modeled 4% APR on the position', 100 * P * 0.04 * (W / 52), 'window')],
    open: () => 'Buy a small cover policy, or stake into its capital pool',
    core: () => 'keep cover or stake live across the window and renew rather than letting it lapse',
    breadth: () => 'take a second cover type it underwrites where offered',
    breadthSolo: () => 'take a second cover type it underwrites where offered',
    track: () => 'log premiums paid and renewals; a claim, if one ever arises, is filed from the same wallet',
  },
  payments: {
    label: 'Payments usage',
    fees: () => [],
    open: () => 'Make a first real payment or transfer through it',
    core: () => 'route ordinary small payments through it each week, the way the product is meant to be used',
    breadth: () => 'use a second rail or currency it supports',
    breadthSolo: () => 'use a second rail or currency it supports',
    track: () => 'log payment count and volume monthly; interchange the product pays the user is excluded from this cost model',
  },
  locker: {
    label: 'Token locking terms',
    fees: (P) => [fee('lock fee at 0.5% of the amount locked', 100 * 0.005 * P, 'open')],
    open: () => 'Lock a small amount through its locker',
    core: () => 'keep a lock live for a full term and renew it once; locker usage is measured in completed terms, not in clicks',
    breadth: () => 'use its vesting or distribution tool if a small project-side use is available',
    breadthSolo: () => 'use its vesting or distribution tool if a small project-side use is available',
    track: () => 'log each lock\u2019s start, term and renewal so completed terms are provable',
  },
  stablecoin: {
    label: 'Stablecoin mint and liquidity',
    fees: (P, W) => [fee('mint, redeem and pool fees at 0.1% of the position per weekly cycle', 100 * P * 0.001 * W, 'window')],
    open: () => 'Mint or acquire a first tranche of its stablecoin and place it in one of its main pools',
    core: () => 'hold and use the stablecoin across the window, cycling a modest share through its pools and redemption route',
    breadth: () => 'use a second chain or pool where the stablecoin circulates',
    breadthSolo: () => 'use a second pool where the stablecoin circulates',
    track: () => 'log mints, redemptions and pool positions with their fees',
  },
  ai: {
    label: 'AI product usage',
    fees: (P) => [fee('usage credits bought over the window, modeled at 25% of the position', 100 * 0.25 * P, 'window')],
    open: () => 'Create an account or wallet link and buy a first small block of usage credits',
    core: () => 'use the product for real tasks each session; on a usage product, genuine consumption is the activity being recorded',
    breadth: () => 'use a second feature or model it offers, so the usage is not one endpoint repeated',
    breadthSolo: () => 'use a second feature or model it offers, so the usage is not one endpoint repeated',
    track: () => 'log credits bought and consumed; unspent credits are a cost only when they expire, which this model does not assume',
  },
  otc: {
    label: 'OTC dealing',
    fees: (P) => [fee('dealer spread at 0.3% on one full-position trade', 100 * 0.003 * P, 'open')],
    open: () => 'Request a first small quote and complete one trade through its desk or interface',
    core: () => 'trade at modest size on a regular cadence, taking quotes rather than posting one large order',
    breadth: () => 'trade a second asset or pair it quotes',
    breadthSolo: () => 'trade a second asset or pair it quotes',
    track: () => 'log every quote taken and the spread it carried',
  },
  governance: {
    label: 'Governance participation',
    fees: () => [],
    open: () => 'Take a first position in its governance or incentive product',
    core: () => 'vote where it asks holders to vote and keep the position live across the window rather than only at snapshot time',
    breadth: () => 'take part in a second programme or season it runs',
    breadthSolo: () => 'take part in a second programme or season it runs',
    track: () => 'log every vote with its date; a voting record is the substance of this plan',
  },
  collateral: {
    label: 'Collateral deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche of collateral through its main interface',
    core: () => 'keep the collateral posted across the window and adjust it on a weekly check rather than chasing minimums',
    breadth: () => 'post a second, smaller tranche in another collateral type it accepts',
    breadthSolo: () => 'post a second, smaller tranche in another collateral type it accepts',
    track: () => 'log the collateral balance weekly and claim any yield or incentives it pays',
  },
  oracle: {
    label: 'Data service usage',
    fees: (P, _W, N) => [fee('data-request fees at 0.1% of the position a session', 100 * P * 0.001 * N, 'window')],
    open: () => 'Make a first data request or stake through its main interface',
    core: () => 'consume its data or staking product on a regular cadence, the way an integrating project would',
    breadth: () => 'use a second feed or product line it offers',
    breadthSolo: () => 'use a second feed or product line it offers',
    track: () => 'log requests made and fees paid per session',
  },
  generic: {
    label: 'Core product usage',
    fees: (P, _W, N) => [fee('protocol fees at a modeled 0.1% of the position a session', 100 * P * 0.001 * N, 'window')],
    open: () => 'Make a first small transaction through its main product',
    core: () => 'use its core product on a regular cadence at modest size, the way a genuine early user would',
    breadth: () => 'use a second surface it offers — another chain, market or product line',
    breadthSolo: () => 'use a second surface it offers — another market or product line on the same chain',
    track: () => 'log every session with its action and fee, so consistent use is provable later',
  },
};

/** Category to mechanism. Categories absent here fall back to generic usage. */
const CATEGORY_MECH: Record<string, string> = {
  Dexs: 'dex',
  'Liquidity Manager': 'liq-mgr',
  'Leveraged Farming': 'lev-farm',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  Yield: 'vault',
  'Yield Aggregator': 'aggregator',
  Farm: 'farm',
  'Onchain Capital Allocator': 'allocator',
  'Risk Curators': 'curator',
  'Basis Trading': 'basis',
  Derivatives: 'perps',
  'Interest Rate Derivatives': 'perps',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  Options: 'options',
  'Options Vault': 'options-vault',
  'Cross Chain Bridge': 'bridge',
  Chain: 'chain',
  'Staking Pool': 'staking',
  Restaking: 'restaking',
  RWA: 'rwa',
  Launchpad: 'launchpad',
  'Prediction Market': 'prediction',
  'NFT Marketplace': 'nft',
  Privacy: 'privacy',
  Synthetics: 'synthetics',
  Indexes: 'indexes',
  Insurance: 'insurance',
  Payments: 'payments',
  'Crypto Card Issuer': 'payments',
  'Token Locker': 'locker',
  'Algo-Stables': 'stablecoin',
  'Dual-Token Stablecoin': 'stablecoin',
  'Stablecoin Issuer': 'stablecoin',
  'Anchor BTC': 'stablecoin',
  'Decentralized BTC': 'stablecoin',
  'Decentralized AI': 'ai',
  'AI Agents': 'ai',
  'OTC Marketplace': 'otc',
  'Governance Incentives': 'governance',
  'Reserve Currency': 'governance',
  'Collateral Management': 'collateral',
  'Collateral Markets': 'collateral',
  DOR: 'oracle',
};

function mechFor(p: Proto): { key: string; mech: Mech } {
  const key = CATEGORY_MECH[p.category ?? ''] ?? 'generic';
  return { key, mech: MECHS[key]! };
}

/**
 * The verdict ladder, defined on the dashboard: the net measured against
 * the plan's own cost. The worst a plan can do is lose its whole cost (a
 * zero reward), so the bottom rung is set where the scenario reward covers
 * less than a quarter of the cost — a rung plans can actually land on.
 */
export function verdictFor(netCents: number, costCents: number): string {
  if (netCents >= costCents) return 'NET POSITIVE';
  if (netCents >= 0) return 'THIN POSITIVE';
  if (netCents >= -0.75 * costCents) return 'THIN NEGATIVE';
  return 'NET NEGATIVE';
}

/**
 * Build one protocol's plan: mechanism steps with their costs, and the
 * closing verdict. Gas is split as 2 sessions of setup, 1 to open, 1 to
 * breadth, the rest to the core cadence; fees land where they are incurred
 * (open parts on the opening step, window parts on the core step).
 */
export function buildPlan(p: Proto, multiple: number, onWatchlist: boolean): { steps: string[]; plan: Plan } {
  const tier = tierFor(p.tvl_usd);
  const position = (tier.band_lo + tier.band_hi) / 2;
  const band = `$${tier.band_lo.toLocaleString('en-US')}–$${tier.band_hi.toLocaleString('en-US')}`;
  const weeks = tier.weeks;
  const sessions = weeks * SESSIONS_PER_WEEK;
  const chain = p.chains[0] ?? 'Ethereum';
  const gasToken = GAS_TOKEN[chain] ?? 'the native gas token';
  const gas = gasCentsFor(chain);
  const { key, mech } = mechFor(p);
  const parts = mech.fees(position, weeks, sessions);
  const openFees = parts.filter((f) => f.at === 'open').reduce((s, f) => s + f.cents, 0);
  const windowFees = parts.filter((f) => f.at === 'window').reduce((s, f) => s + f.cents, 0);

  const stepCosts: StepCost[] = [
    { gas_cents: 2 * gas, fees_cents: 0 },
    { gas_cents: gas, fees_cents: openFees },
    { gas_cents: (sessions - 2) * gas, fees_cents: windowFees },
    { gas_cents: gas, fees_cents: 0 },
    { gas_cents: 0, fees_cents: 0 },
    { gas_cents: 0, fees_cents: 0 },
  ];
  const gasTotal = stepCosts.reduce((s, c) => s + c.gas_cents, 0);
  const feesTotal = openFees + windowFees;
  const total = gasTotal + feesTotal;

  const rewardS = Math.round(SCENARIO.allocation_share / SCENARIO.farmed_fraction * multiple * position * 100);
  const rewardC = Math.round(SCENARIO.allocation_share * multiple * position * 100);
  const netS = rewardS - total;
  const netC = rewardC - total;
  const verdict = verdictFor(netS, total);

  const ctx: PlanCtx = { name: p.name, chain, chains: p.chains, gasToken, band, position, weeks };
  const h = slugHash(p.slug);
  const pick = (options: string[], salt: number): string => options[(h >>> salt) % options.length]!;
  const costClause = (i: number): string => {
    const c = stepCosts[i]!;
    const sum = c.gas_cents + c.fees_cents;
    if (sum === 0) return ' Modeled cost: $0 — this step is off-chain.';
    const split = c.fees_cents === 0 ? 'all gas' : `gas ${fmtUsd(c.gas_cents)}, protocol fees ${fmtUsd(c.fees_cents)}`;
    return ` Modeled cost: ${fmtUsd(sum)} (${split}).`;
  };
  const ageNote = p.listed_at ? `DefiLlama has tracked it since ${p.listed_at}` : 'DefiLlama gives no listing date for it';
  const moveNote = p.change_7d === null
    ? 'its 7-day TVL change is unreported'
    : `its TVL moved ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in the last 7 days`;

  const steps = [
    pick([
      `Set up one dedicated wallet for ${p.name} on ${chain} and fund it with about ${fmtUsd(2 * gas)} of ${gasToken} for setup fees; keep it separate from any main wallet. Allow 30–45 minutes, including a small test transaction.`,
      `Prepare a clean wallet for ${p.name}: fund it on ${chain} with roughly ${fmtUsd(2 * gas)} worth of ${gasToken} so fees never stall a session. Setup takes about 30 minutes, including a small test transaction.`,
      `Start from a fresh farming wallet on ${chain}: send over about ${fmtUsd(2 * gas)} of ${gasToken} for gas and confirm a small test transaction lands before committing real size. Budget 30–45 minutes.`,
    ], 0) + costClause(0),
    `${mech.open(ctx)}, sized as the first slice of a ${band} working position (modeled at $${position.toLocaleString('en-US')}).` + costClause(1),
    `Core activity, ${weeks} weeks at two sessions a week: ${mech.core(ctx)}. ${ageNote}, and ${moveNote}, so size in gradually rather than all at once.` + costClause(2),
    (p.chains.length > 1
      ? `Spread the activity: ${p.name} also runs on ${p.chains.slice(1, 3).join(' and ')}. ${mech.breadth(ctx).charAt(0).toUpperCase() + mech.breadth(ctx).slice(1)}.`
      : `Deepen the single-chain footprint: ${mech.breadthSolo(ctx)}. ${p.name} is tracked on ${chain} only, so breadth has to come from its own product range.`) + costClause(3),
    pick([
      `Track the position: ${mech.track(ctx)}. Also check ${p.name}\u2019s official channels for a points, quests or early-user programme and enrol this same wallet if one is live; keep a dated log of every session, about 10 minutes a week.`,
      `Track the position: ${mech.track(ctx)}. If ${p.name} runs a points or early-user programme on its official channels, join it from this wallet and keep dated records of each action; 5–10 minutes of bookkeeping a week is enough.`,
    ], 3) + costClause(4),
    `Net verdict for ${p.name}: the plan costs ${fmtUsd(total)} all-in (gas ${fmtUsd(gasTotal)}, protocol fees ${fmtUsd(feesTotal)}) over ${weeks} weeks on a $${position.toLocaleString('en-US')} modeled position. Scenario S — a launch at the model's implied value, ${SCENARIO.allocation_share * 100}% of it to early users, the pool shared over an assumed farmed ${SCENARIO.farmed_fraction * 100}% of TVL — pays ${fmtUsd(rewardS)}: net ${fmtSignedUsd(netS)}, ${verdict}. The pure TVL pro-rata bound pays ${fmtUsd(rewardC)} (net ${fmtSignedUsd(netC)}). Scenario rewards are assumptions, not predictions; every input is in the method note.`,
  ];

  const plan: Plan = {
    mechanism: key,
    mechanism_label: mech.label,
    position_usd: position,
    band,
    weeks,
    sessions,
    gas_per_session_cents: gas,
    fee_parts: parts,
    step_costs: stepCosts,
    gas_total_cents: gasTotal,
    fees_total_cents: feesTotal,
    total_cost_cents: total,
    reward_scenario_cents: rewardS,
    reward_pro_rata_cents: rewardC,
    net_scenario_cents: netS,
    net_pro_rata_cents: netC,
    verdict,
  };
  return { steps: steps.map((s) => s.trim()), plan };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildRadar(snapshot: Snap): Radar {
  const fit = fitMultiples(snapshot.protocols);
  const validation = checkOutOfSample(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const m = multipleFor(p, fit);
      return { p, implied: impliedValueOf(p, fit), ...m };
    })
    .sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const board: Row[] = scored.map((s, i) => {
    const { steps, plan } = buildPlan(s.p, s.multiple, watch.has(s.p.slug));
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: s.implied,
      farm_steps: steps,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      multiple_used: s.multiple,
      category_peers: s.peers,
      basis: s.basis,
      watchlist: watch.has(s.p.slug),
      plan,
    };
  });
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 80)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: roundMult(p.mcap_usd! / p.tvl_usd),
      change_7d: p.change_7d,
    }));
  return {
    board,
    live,
    fit,
    validation,
    calibration: calibrationOf(snapshot.protocols),
    decomposition: decompositionOf(snapshot.protocols),
    dq: dataQualityOf(snapshot, fit, board),
    live_total: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
  };
}

/** The board as board.json carries it: the gate's fields plus the plan's headline economics. */
export function boardJsonRows(radar: Radar): unknown[] {
  return radar.board.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
    mechanism: r.plan.mechanism,
    basis: r.basis,
    plan_cost_usd: r.plan.total_cost_cents / 100,
    scenario_reward_usd: r.plan.reward_scenario_cents / 100,
    net_scenario_usd: r.plan.net_scenario_cents / 100,
    verdict: r.plan.verdict,
  }));
}

/** The dashboard's data, written beside the page: window.RADAR = { board, live, fit, validation, meta, scenario }. */
export function dataScript(radar: Radar, snapshot: Snap): string {
  const payload = {
    board: radar.board,
    live: radar.live,
    live_total: radar.live_total,
    fit: {
      global_multiple: radar.fit.global_multiple,
      fit_n: radar.fit.fit_n,
      zero_mcap_seen: radar.fit.zero_mcap_seen,
      cats: radar.fit.cats,
    },
    validation: radar.validation,
    calibration: radar.calibration,
    decomposition: radar.decomposition,
    dq: radar.dq,
    scenario: SCENARIO,
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
    },
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}

/** A self-check in the gate's own terms: the first refusal, or null when the board is clean. */
export function boardIssue(board: Row[], snapshot: Snap): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100–4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  for (const [i, row] of board.entries()) {
    if (!slugs.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}, not ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) {
      return `row ${row.slug}: implied_value_usd ${row.implied_value_usd} is not a positive whole number within the cap`;
    }
    if (row.implied_value_usd > prev) return `row ${row.slug}: implied value rises as rank ascends`;
    prev = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug}: ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug}: a farm step trims to ${len} characters`;
    }
    const planSum = row.plan.step_costs.reduce((s, c) => s + c.gas_cents + c.fees_cents, 0);
    if (planSum !== row.plan.total_cost_cents) return `row ${row.slug}: step costs sum to ${planSum}, plan total says ${row.plan.total_cost_cents}`;
    if (row.plan.net_scenario_cents !== row.plan.reward_scenario_cents - row.plan.total_cost_cents) {
      return `row ${row.slug}: net does not equal scenario reward minus cost`;
    }
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}
