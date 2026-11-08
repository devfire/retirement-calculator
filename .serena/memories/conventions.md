# Conventions

- One source file (`app.js`) holds simulation, solver, chart, persistence, and wiring — no modules. Match this: plain top-level functions, no classes/abstractions.
- `"use strict"` at top; `const $ = id => document.getElementById(id)` alias; element IDs are lowerCamelCase matching JS.
- Declarative input schema: `FIELDS` (all 13 input IDs) and `MONEY_FIELDS` (subset that get currency formatting) drive `apply()`, persistence, formatting.
- Currency formatting via shared `Intl.NumberFormat` instances (`fmt`, `fmt2`, `compact`); money inputs keep commas-as-you-type via `formatMoneyInput`.
- Behavior changes MUST update `README.md` (it's the spec, especially method/back-fill/other-income semantics).
- Chart is hand-rolled canvas (`drawChart`), no chart lib.

KISS/YAGNI/DRY: no premature abstraction, no dependencies.