# Conventions

- Five classic scripts under `js/` (loaded in order by `index.html`, no modules): `core.js` (pure financial core), `ui.js` (shared DOM/state), `charts.js` (D3 charts), `render.js` (rendering/caches), `main.js` (entry wiring). Match this: plain top-level functions in the owning file, no classes/abstractions; shared globals flow in load order.
- `"use strict"` at top; `const $ = id => document.getElementById(id)` alias; element IDs are lowerCamelCase matching JS.
- Declarative input schema: `FIELDS` (all 22 input IDs) and `MONEY_FIELDS` (subset that get currency formatting) drive `apply()`, persistence, formatting.
- Currency formatting via shared `Intl.NumberFormat` instances (`fmt`, `fmt2`, `compact`); money inputs keep commas-as-you-type via `formatMoneyInput`.
- Behavior changes MUST update `README.md` (it's the spec, especially method/back-fill/other-income semantics).
- Charts are D3 SVG (`drawChart`/`drawMcChart` in `js/charts.js`); D3 v7.9.0 is vendored as `d3.min.js` (no CDN).

KISS/YAGNI/DRY: no premature abstraction; only vendored dependency is D3 (no npm/CDN).