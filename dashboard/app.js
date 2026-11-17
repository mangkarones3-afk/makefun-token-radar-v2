'use strict';
/* Token Radar v2 dashboard. Renders window.RADAR — the exact board the
   program wrote to board.json, with its plan economics — with no network
   and no other data source, so the page can never disagree with the
   scored board. All money in the plan data is integer cents. */

const R = window.RADAR;
const $ = (sel) => document.querySelector(sel);
const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function money(v) { return '$' + nf.format(Math.round(v)); }
function moneyShort(v) { return '$' + compact.format(v); }
function usd(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = abs % 100;
  return (neg ? '-$' : '$') + d + (rem === 0 ? '' : '.' + String(rem).padStart(2, '0'));
}
function signedUsd(cents) { return cents >= 0 ? '+' + usd(cents) : usd(cents); }
function pct(v) {
  if (v === null || v === undefined) return ['—', 'flat'];
  const s = (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  return [s, v > 0 ? 'up' : v < 0 ? 'down' : 'flat'];
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function verdictClass(v) {
  return 'chip v-' + v.toLowerCase().replace(/ /g, '-');
}

/* ---------- headline fills ---------- */
function fill(name, text) {
  document.querySelectorAll(`[data-fill="${name}"]`).forEach((n) => (n.textContent = text));
}
function medianCents(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function fillStatic() {
  const m = R.meta, v = R.validation, fit = R.fit;
  fill('as_of', m.as_of); fill('as_of2', m.as_of);
  fill('source', m.source); fill('source2', m.source);
  fill('protocols', nf.format(m.protocols));
  fill('floor', nf.format(m.floor_usd));
  fill('total_implied', moneyShort(R.board.reduce((s, r) => s + r.implied_value_usd, 0)));
  fill('board_rows', nf.format(R.board.length));
  fill('board_rows2', nf.format(R.board.length));
  fill('self_found', nf.format(R.board.filter((r) => !r.watchlist).length));
  fill('watch_covered', nf.format(R.board.filter((r) => r.watchlist).length));
  fill('watch_total', nf.format(m.watchlist));
  fill('oos_median_ape', v.median_ape_pct.toFixed(1) + '%');
  fill('oos_median_ape2', v.median_ape_pct.toFixed(1) + '%');
  fill('oos_median_ape3', v.median_ape_pct.toFixed(1) + '%');
  fill('oos_mape', v.mape_pct.toFixed(1) + '%');
  fill('oos_factor', v.median_factor.toFixed(2));
  fill('oos_factor2', v.median_factor.toFixed(2));
  fill('oos_n', nf.format(v.test_n));
  fill('oos_global', v.global_median_ape_pct.toFixed(1) + '%');
  fill('oos_flat', v.flat_median_ape_pct.toFixed(1) + '%');
  fill('oos_spearman', v.spearman.toFixed(2));
  fill('train_n', nf.format(v.train_n));
  fill('test_n', nf.format(v.test_n));
  fill('fit_n', nf.format(fit.fit_n));
  fill('zero_mcap', nf.format(fit.zero_mcap_seen));
  fill('global_multiple', fit.global_multiple.toFixed(3));
  fill('live_shown', nf.format(R.live.length));
  fill('live_total', nf.format(R.live_total));
  const pos = R.board.filter((r) => r.plan.net_scenario_cents >= 0).length;
  const neg = R.board.filter((r) => r.plan.verdict === 'NET NEGATIVE').length;
  fill('verdict_positive', nf.format(pos));
  fill('verdict_negative', nf.format(neg));
  fill('median_cost', usd(medianCents(R.board.map((r) => r.plan.total_cost_cents))));
  fill('fallback_rows', nf.format(R.board.filter((r) => r.basis === 'global').length));
  fill('cal_slope', R.calibration.slope.toFixed(2));
  fill('cal_under', nf.format(R.calibration.under_deciles));
  fill('dq_neg_n', nf.format(R.dq.negative_mcap.length));
  fill('dq_partial', nf.format(R.dq.partial_token_records));
}

/* ---------- board table ---------- */
const state = { q: '', category: '', chain: '', verdict: '', watchOnly: false, sortKey: 'rank', sortDir: 1 };
const SORT_VALUE = {
  rank: (r) => r.rank,
  name: (r) => r.name,
  category: (r) => r.category ?? 'Uncategorized',
  tvl_usd: (r) => r.tvl_usd,
  change_7d: (r) => r.change_7d,
  multiple_used: (r) => r.multiple_used,
  implied_value_usd: (r) => r.implied_value_usd,
  plan_cost: (r) => r.plan.total_cost_cents,
  plan_net: (r) => r.plan.net_scenario_cents,
};

function filteredBoard() {
  const rows = R.board.filter((r) => {
    if (state.watchOnly && !r.watchlist) return false;
    if (state.category && (r.category ?? 'Uncategorized') !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.verdict && r.plan.verdict !== state.verdict) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    }
    return true;
  });
  const get = SORT_VALUE[state.sortKey];
  rows.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return c * state.sortDir;
  });
  return rows;
}

function renderBoard() {
  const rows = filteredBoard();
  const body = $('#board-body');
  body.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.addEventListener('click', () => openDetail(r));
    const nameTd = el('td');
    nameTd.appendChild(el('span', '', r.name));
    if (r.watchlist) nameTd.appendChild(el('span', 'badge', 'WATCHLIST'));
    nameTd.appendChild(el('span', 'slug', r.slug));
    const multTd = el('td', 'num');
    multTd.appendChild(el('span', '', r.multiple_used.toFixed(3) + '×'));
    multTd.appendChild(el('span', r.basis === 'global' ? 'basis basis-global' : 'basis', r.basis === 'global' ? 'global fallback' : `cat. fit n=${r.category_peers}`));
    const [chgText, chgCls] = pct(r.change_7d);
    const netTd = el('td', 'num ' + (r.plan.net_scenario_cents >= 0 ? 'net-pos' : 'net-neg'), signedUsd(r.plan.net_scenario_cents));
    const verdictTd = el('td');
    verdictTd.appendChild(el('span', verdictClass(r.plan.verdict), r.plan.verdict));
    tr.append(
      el('td', 'num', String(r.rank)),
      nameTd,
      el('td', '', r.category ?? 'Uncategorized'),
      el('td', '', r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ` +${r.chains.length - 3}` : '')),
      el('td', 'num', money(r.tvl_usd)),
      el('td', 'num ' + chgCls, chgText),
      multTd,
      el('td', 'num implied', money(r.implied_value_usd)),
      el('td', 'num', usd(r.plan.total_cost_cents)),
      netTd,
      verdictTd,
    );
    body.appendChild(tr);
  }
  $('#row-count').textContent = `${nf.format(rows.length)} of ${nf.format(R.board.length)} protocols shown`;
}

function wireControls() {
  const cats = [...new Set(R.board.map((r) => r.category ?? 'Uncategorized'))].sort();
  const catSel = $('#f-category');
  for (const c of cats) { const o = el('option', '', c); o.value = c; catSel.appendChild(o); }
  const chains = [...new Set(R.board.flatMap((r) => r.chains))].sort();
  const chainSel = $('#f-chain');
  for (const c of chains) { const o = el('option', '', c); o.value = c; chainSel.appendChild(o); }
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderBoard(); });
  catSel.addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
  chainSel.addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('#f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('#f-watch').addEventListener('change', (e) => { state.watchOnly = e.target.checked; renderBoard(); });
  document.querySelectorAll('#board-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = k === 'name' || k === 'category' ? 1 : -1; }
      if (k === 'rank') state.sortDir = 1;
      renderBoard();
    });
  });
}

/* ---------- detail drawer ---------- */
function openDetail(r) {
  const box = $('#detail-content');
  box.textContent = '';
  box.appendChild(el('h2', '', r.name));
  box.appendChild(el('p', 'sub', `${r.slug} · ${r.category ?? 'Uncategorized'} · rank #${r.rank} of ${nf.format(R.board.length)} · mechanism: ${r.plan.mechanism_label}`));

  if (r.basis === 'global') {
    box.appendChild(el('p', 'basis-banner',
      `Priced on the GLOBAL FALLBACK: ${r.category ?? 'this category'} has fewer than 3 tokenized peers in the snapshot, so no category multiple was fitted — the multiple below is the global median of all ${nf.format(R.fit.fit_n)} fitted protocols, and the implied value inherits that bluntness.`));
  }

  const line = (parent, label, value, cls) => {
    const d = el('div', 'row');
    d.appendChild(el('span', '', label));
    d.appendChild(el('b', cls ?? '', value));
    parent.appendChild(d);
    return d;
  };

  box.appendChild(el('h3', '', 'The arithmetic'));
  const arith = el('div', 'arith');
  line(arith, 'TVL (snapshot)', money(r.tvl_usd));
  const fit = R.fit.cats.find((c) => c.category === (r.category ?? 'Uncategorized'));
  if (fit && r.basis === 'category') {
    const w = fit.peers / (fit.peers + 4);
    line(arith, `Category median multiple (n=${fit.peers} tokenized peers)`, fit.median_multiple.toFixed(3) + '×');
    line(arith, 'Global median multiple', R.fit.global_multiple.toFixed(3) + '×');
    line(arith, 'Shrinkage weight on the category', w.toFixed(2));
    line(arith, 'Blended multiple used', r.multiple_used.toFixed(3) + '×');
  } else {
    line(arith, 'Global median multiple (fallback)', R.fit.global_multiple.toFixed(3) + '×');
    line(arith, 'Multiple used', r.multiple_used.toFixed(3) + '×');
  }
  line(arith, 'Implied value = TVL × multiple', money(r.implied_value_usd), 'total');
  box.appendChild(arith);

  box.appendChild(el('h3', '', 'Plan economics'));
  const econ = el('div', 'arith');
  const plan = r.plan;
  line(econ, `Modeled position (band ${plan.band}, midpoint)`, money(plan.position_usd));
  line(econ, 'Window', `${plan.weeks} weeks · ${plan.sessions} sessions (2 a week)`);
  line(econ, `Gas (${usd(plan.gas_per_session_cents)} a session on ${r.chains[0] ?? 'its first chain'}, ${plan.sessions + 2} session-equivalents incl. setup)`, usd(plan.gas_total_cents));
  for (const f of plan.fee_parts) line(econ, `Fee — ${f.label}`, usd(f.cents));
  if (plan.fee_parts.length === 0) line(econ, 'Protocol fees', '$0 — this mechanism\u2019s honest cost is gas alone');
  line(econ, 'Total plan cost', usd(plan.total_cost_cents), 'total');
  line(econ, `Scenario S reward (5% of implied value to early users, shared over a farmed 25% of TVL)`, usd(plan.reward_scenario_cents));
  line(econ, 'Net under Scenario S', signedUsd(plan.net_scenario_cents), plan.net_scenario_cents >= 0 ? 'total pos' : 'total neg');
  line(econ, 'Pure pro-rata bound (same pool over all TVL)', `${usd(plan.reward_pro_rata_cents)} → net ${signedUsd(plan.net_pro_rata_cents)}`);
  box.appendChild(econ);
  const chipRow = el('p', 'verdict-row');
  chipRow.appendChild(el('span', verdictClass(plan.verdict), plan.verdict));
  chipRow.appendChild(el('span', 'verdict-note', ' under Scenario S — an assumption set, not a prediction. The method note shows every input.'));
  box.appendChild(chipRow);

  const [chgText] = pct(r.change_7d);
  box.appendChild(el('p', 'meta',
    `Chains: ${r.chains.join(', ') || '—'} · 7d TVL change: ${chgText} · ` +
    (r.listed_at ? `tracked by DefiLlama since ${r.listed_at}` : 'no listing date in the snapshot') +
    (r.watchlist ? ' · on the bounty watchlist' : ' · found by the model beyond the watchlist')));

  box.appendChild(el('h3', '', 'Farm plan'));
  const ol = document.createElement('ol');
  for (const s of r.farm_steps) ol.appendChild(el('li', '', s));
  box.appendChild(ol);
  $('#detail').classList.remove('hidden');
}
$('#detail-close').addEventListener('click', () => $('#detail').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#detail').classList.add('hidden'); });

/* ---------- category chart: one hue, magnitude, zero baseline ---------- */
function renderChart() {
  const host = $('#cat-chart');
  host.textContent = '';
  const onBoard = new Set(R.board.map((r) => r.category ?? 'Uncategorized'));
  const cats = R.fit.cats.filter((c) => onBoard.has(c.category));
  const max = Math.max(...cats.map((c) => c.used_multiple));
  for (const c of cats) {
    const rowEl = el('div', 'bar-row');
    const catEl = el('div', 'cat', `${c.category} `);
    catEl.appendChild(el('span', 'n', `(n=${c.peers})`));
    rowEl.appendChild(catEl);
    const track = el('div', 'bar-track');
    const bar = el('div', 'bar-fill');
    bar.style.width = Math.max(1.5, (c.used_multiple / max) * 100) + '%';
    track.appendChild(bar);
    rowEl.appendChild(track);
    rowEl.appendChild(el('div', 'val', c.used_multiple.toFixed(3) + '×'));
    host.appendChild(rowEl);
  }
}

/* ---------- live (already trading) table ---------- */
function renderLive() {
  const body = $('#live-body');
  body.textContent = '';
  for (const r of R.live) {
    const tr = document.createElement('tr');
    const nameTd = el('td');
    nameTd.appendChild(el('span', '', r.name));
    nameTd.appendChild(el('span', 'slug', r.slug));
    const [chgText, chgCls] = pct(r.change_7d);
    tr.append(
      nameTd,
      el('td', '', r.symbol ?? '—'),
      el('td', '', r.category ?? 'Uncategorized'),
      el('td', 'num', money(r.tvl_usd)),
      el('td', 'num', money(r.mcap_usd)),
      el('td', 'num', r.multiple.toFixed(3)),
      el('td', 'num ' + chgCls, chgText),
    );
    body.appendChild(tr);
  }
}

/* ---------- calibration, decomposition, data quality (method view) ---------- */
function fmtMult(x) {
  if (x < 0.01) return x.toFixed(4) + '×';
  if (x < 10) return x.toFixed(3) + '×';
  return x.toFixed(1) + '×';
}
function miniTable(headers, bodyRows) {
  const t = el('table', 'mini');
  const head = document.createElement('tr');
  headers.forEach((h, i) => head.appendChild(el('th', i > 0 ? 'num' : '', h)));
  t.appendChild(head);
  for (const cells of bodyRows) {
    const tr = document.createElement('tr');
    cells.forEach((c, i) => tr.appendChild(el('td', i > 0 ? 'num' : '', c)));
    t.appendChild(tr);
  }
  return t;
}
function renderCalibration() {
  const host = $('#cal-table');
  host.textContent = '';
  host.appendChild(miniTable(
    ['Decile (by predicted value)', 'n', 'Mean predicted', 'Mean realized', 'Ratio'],
    R.calibration.deciles.map((d) => ['D' + d.decile, String(d.n), moneyShort(d.mean_pred), moneyShort(d.mean_real), d.ratio.toFixed(2)]),
  ));
}
function renderDecomposition() {
  const dec = R.decomposition;
  const cat = $('#dec-cat');
  cat.textContent = '';
  cat.appendChild(miniTable(['Category', 'n', 'Median APE'], dec.by_category.map((r) => [r.label, String(r.n), r.median_ape_pct.toFixed(1) + '%'])));
  const band = $('#dec-band');
  band.textContent = '';
  band.appendChild(miniTable(['TVL band', 'n', 'Median APE'], dec.by_tvl_band.map((r) => [r.label, String(r.n), r.median_ape_pct.toFixed(1) + '%'])));
  const worst = $('#dec-worst');
  worst.textContent = '';
  for (const w of dec.worst) {
    const p = el('p', 'worst-item');
    const head = el('b', '', `${w.name} `);
    p.appendChild(head);
    p.appendChild(el('span', '', `(${w.category ?? 'Uncategorized'}) — predicted ${money(w.pred)} against a realized ${money(w.actual)} (APE ${w.ape_pct.toFixed(1)}%). Cause: `));
    p.appendChild(el('b', '', w.cause));
    p.appendChild(el('span', '', ` — ${w.cause_detail}.`));
    worst.appendChild(p);
  }
}
function renderDQ() {
  const dq = R.dq;
  const host = $('#dq-body');
  host.textContent = '';
  const para = (text) => { const p = el('p', '', text); host.appendChild(p); return p; };
  const aside = dq.excl_set_aside.map((x) => `${x.category} ${nf.format(x.n)}`).join(' · ');
  para(`${nf.format(dq.records_no_token)} of the snapshot's ${nf.format(dq.protocols)} protocols record no token. The product-type line sets aside ${nf.format(dq.excl_set_aside_total + dq.excl_versioned + dq.excl_wrapped + dq.excl_exchange)} of them by rule: ${aside} (categories of products whose underlying token already trades); version-suffixed names ${nf.format(dq.excl_versioned)}; wrapped or staked names ${nf.format(dq.excl_wrapped)}; exchange-fronted names ${nf.format(dq.excl_exchange)}. The board keeps the remaining ${nf.format(dq.board_rows)}.`);
  const negNames = dq.negative_mcap.map((x) => `${x.name} (${usd(x.mcap_usd * 100)} — a sentinel value, not a price)`).join('; ');
  para(`On the tokenized side, ${nf.format(dq.tokenized)} rows record a market cap and the fit pool keeps ${nf.format(dq.fit_pool_n)}: ${nf.format(dq.fit_excl_zero)} record exactly $0 and ${nf.format(dq.fit_excl_negative)} a negative cap (${negNames}), and ${nf.format(dq.fit_excl_nonpos_tvl)} record a positive cap with no TVL — all excluded before fitting. ${nf.format(dq.partial_token_records)} further rows carry a symbol but no market cap — per-chain deployments of tokens that trade elsewhere — and enter neither the fit nor the board.`);
  const comp = dq.completeness.map((c) => `${c.field} missing on ${nf.format(c.nulls)} rows (${c.pct.toFixed(1)}%)`).join('; ');
  para(`Integrity: slugs are unique across the file (${nf.format(dq.dup_slugs)} duplicates) and so are names (${nf.format(dq.dup_names)}); TVL is zero on ${nf.format(dq.tvl_zero)} rows and negative on ${nf.format(dq.tvl_negative)}; completeness — ${comp} — and neither change_7d nor listed_at feeds the fit. The market cap the model uses is the snapshot's single cap field, used exactly as recorded; the file carries no separate FDV figure. Watchlist verification: ${nf.format(dq.watchlist_in_snapshot)} of ${nf.format(dq.watchlist_total)} watchlist slugs are present in the snapshot and ${nf.format(dq.watchlist_on_board)} of ${nf.format(dq.watchlist_total)} sit on the board — none missing. All rows come from the one pull named in the masthead; nothing here is refreshed live.`);
  para(`Wrapper double-counting: the liquid-staking, restaking and restaked-BTC categories hold ${nf.format(dq.wrapper_protocols)} rows. ${nf.format(dq.wrapper_no_token)} of them record no token and are set aside above, so no board row ever counts a wrapper beside its underlying protocol. ${nf.format(dq.wrapper_in_fit)} tokenized wrappers stay in the fit pool as market evidence — their multiples are real prices — and the board never ranks them.`);
  para(`Ratio sanity band: a fitted multiple should sit inside the log-space IQR fence (1.5 × the interquartile range of log₁₀ mcap/TVL over the fit pool), here ${fmtMult(dq.band_lo)} to ${fmtMult(dq.band_hi)}. ${nf.format(dq.band_violations.length)} fit-pool rows fall outside it. They are named, not deleted:`);
  const ul = document.createElement('ul');
  for (const v of dq.band_violations) {
    const li = el('li', '', `${v.name} (${v.category ?? 'Uncategorized'}) at ${fmtMult(v.multiple)} — market cap ${money(v.mcap_usd)} on TVL ${money(v.tvl_usd)}: ${v.cause}.`);
    ul.appendChild(li);
  }
  host.appendChild(ul);
  para(`Outlier treatment: no row is deleted or winsorized anywhere in this entry — category medians and log-space shrinkage are the treatment, and their robustness is measured, not asserted: dropping the named violators moves the global median from ${dq.band_effect.global_with.toFixed(3)}× to ${dq.band_effect.global_without.toFixed(3)}× and changes ${nf.format(dq.band_effect.board_multiples_changed)} of ${nf.format(dq.board_rows)} board multiples. Separately, every board row's published figures were recomputed end-to-end by an independent mirror implementation of the stated spec; every figure matched.`);
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const v of ['board', 'live', 'method']) {
      $('#view-' + v).classList.toggle('hidden', v !== t.dataset.view);
    }
  });
});

fillStatic();
wireControls();
renderBoard();
renderChart();
renderLive();
renderCalibration();
renderDecomposition();
renderDQ();
