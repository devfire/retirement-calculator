# Task completion

Core tests: `node --test test/core.test.js` (no deps; `js/core.js` exports the pure financial core for Node). Run before browser checks for solver/math changes.

"Done" = core tests pass + manual verification in a browser (no linter/formatter/build/type checker exist):

1. `python3 -m http.server 8765`, open `http://127.0.0.1:8765`.
2. Exercise the changed path (type inputs, watch results/chart update); confirm the specific behavior fixed/added.
3. For solver/math changes, cross-check numbers against the README worked example ($1M now + $4k/mo × 5y, 7%/4.5% returns, 2.5% inflation, 10y out → $6,370/mo sustainable, $2,184,265 future pot; exact months vary with current month, asserted within tolerance in tests). This worked example requires $4k/mo entered — the load/Reset defaults are $0/mo ($5,423/mo, $1,859,308 future pot), so don't expect the worked-example numbers on a fresh open.
4. Confirm no `NaN`/`undefined` in results with extreme-but-legal inputs (clamping should hold).
5. Update `README.md` if behavior changed; no changelog file exists.