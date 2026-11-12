# RetirePlan — core

Single-page client-only retirement calculator (no backend, no accounts, no network). Answer: "how much can I spend per month in retirement, in today's dollars?" Distinguishing model: contribution phase and retirement date are separate clocks (save N years, then coast, then draw down).

## Files

- `index.html` — markup + form (inputs/results DOM)
- `style.css` — layout, responsive + print
- `js/core.js` — pure financial core: `compute()` monthly simulation, `backfillPlan()` gap solver, Monte Carlo. Vanilla JS, ~425 lines.
- `js/ui.js` — shared UI state, DOM helpers (`$`, `setText`, `setPressed`, `fillCard`), input parsing/formatting.
- `js/charts.js` — D3 balance chart + Monte Carlo histogram.
- `js/render.js` — headline/Monte Carlo rendering, debounced MC scheduling + caches, back-fill UI.
- `js/main.js` — entry point: persistence (localStorage/share links) + event wiring.
- `d3.min.js` — vendored D3 v7.9.0 (MIT, © Mike Bostock). Classic scripts loaded in order by `index.html` (no build step, works from `file://`).
- `README.md` — sole doc; thorough (inputs, method, back-fill, privacy). Keep in sync with behavior changes.

## Invariants

- All money reported in **today's dollars** unless explicitly labelled "future $". Future → today: divide by `(1+inflation)^years`.
- Contributions and withdrawals at the **start** of each month, then that month's growth. Annual rates → effective monthly: `mRate = (1+pct/100)^(1/12) - 1`.
- Sustainable spending is a level real annuity-due solved from the pot in today's $; nominal drawdown inflation-indexes each withdrawal and ends at ~$0 (or at the "End cushion" value).
- Inputs clamped (returns −50%…30%, inflation −10%…30%, non-negative money); past retire year → "retire now"; contribution period capped at time-to-retirement.
- State: `FIELDS` (22 inputs) + `MONEY_FIELDS` drive persistence/apply; localStorage key `retireplan-v1`; share links encode all inputs in URL hash `#…`.
- Back-fill + sticky-solve and delayed "other income" start year are subtle — full semantics in README; don't trust intuition, re-read README sections before touching that logic.

See `mem:tech_stack` for platform; `mem:conventions` for code style; `mem:suggested_commands` / `mem:task_completion` for how to run and finish work.