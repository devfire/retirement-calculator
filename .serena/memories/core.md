# RetirePlan — core

Single-page client-only retirement calculator (no backend, no accounts, no network). Answer: "how much can I spend per month in retirement, in today's dollars?" Distinguishing model: contribution phase and retirement date are separate clocks (save N years, then coast, then draw down).

## Files (flat root, 4 files)

- `index.html` — markup + form (inputs/results DOM)
- `style.css` — layout, responsive + print
- `app.js` — all logic: `compute()` monthly simulation, `backfillPlan()` gap solver, `render()`, `drawChart()`, persistence, share-link, event wiring. Vanilla JS, ~300 lines.
- `README.md` — sole doc; thorough (inputs, method, back-fill, privacy). Keep in sync with behavior changes.

## Invariants

- All money reported in **today's dollars** unless explicitly labelled "future $". Future → today: divide by `(1+inflation)^years`.
- Contributions and withdrawals at the **start** of each month, then that month's growth. Annual rates → effective monthly: `mRate = (1+pct/100)^(1/12) - 1`.
- Sustainable spending is a level real annuity-due solved from the pot in today's $; nominal drawdown inflation-indexes each withdrawal and ends at ~$0 (or at "Desired amount to be left" cushion).
- Inputs clamped (returns −50%…30%, inflation −10%…30%, non-negative money); past retire year → "retire now"; contribution period capped at time-to-retirement.
- State: `FIELDS` (13 inputs) + `MONEY_FIELDS` drive persistence/apply; localStorage key `retireplan-v1`; share links encode all inputs in URL hash `#…`.
- Back-fill + sticky-solve and delayed "other income" start year are subtle — full semantics in README; don't trust intuition, re-read README sections before touching that logic.

See `mem:tech_stack` for platform; `mem:conventions` for code style; `mem:suggested_commands` / `mem:task_completion` for how to run and finish work.