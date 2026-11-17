# makefun-token-radar-v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mangkarones3-afk/makefun-token-radar-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mangkarones3-afk/makefun-token-radar-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the frozen DefiLlama snapshot sealed with the bounty — second generation. Every protocol in the snapshot that records no token is ranked by an implied launch value fitted from the snapshot's own tokenized protocols: the median market-cap/TVL multiple of its category, shrunk toward the global median in log space, with a global-median fallback that is labelled on the board wherever it applies. The model is tested out-of-sample (fit on two thirds of the tokenized set, scored on the held-out third) and its error is printed on the dashboard, not hidden.

What v2 adds: every farm plan is **mechanism-aware and netted to a verdict**. Plans are generated from what the protocol actually does — lending loops, DEX liquidity, perps volume, bridge crossings, options epochs, locker terms — priced session by session in integer cents under a stated gas schedule and per-mechanism fee formulas, and closed by a net verdict under a clearly labelled reward scenario (Scenario S: a launch at the model's implied value, 5% to early users, the pool shared over an assumed farmed 25% of TVL), with the pure TVL pro-rata bound printed beside it. Scenario rewards are assumptions, not predictions; the dashboard's method note shows every input. All 40 watchlist protocols are covered, plus every other rankable pre-token protocol the model finds in the snapshot (198 rows).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only. The program writes `board.json` (the ranked board), `data.js` (the same board for the page), `dashboard/` and `screenshots/` into the output directory, and `dossier.json` last.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ram1fzcx&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
