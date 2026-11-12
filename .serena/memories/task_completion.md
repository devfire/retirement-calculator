# Task completion

Core tests: `node --test test/core.test.js` (no deps; app.js guards browser wiring and exports the pure financial core). Run before browser checks for solver/math changes.

"Done" = core tests pass + manual verification in a browser (no linter/formatter/build/type checker exist):

1. `python3 -m http.server 8765`, open `http://127.0.0.1:8765`.
2. Exercise the changed path (type inputs, watch results/chart update); confirm the specific behavior fixed/added.
3. For solver/math changes, cross-check numbers against the README worked example ($1M now + $4k/mo × 5y, 7%/4.5% returns, 2.5% inflation, 10y out → $6,370/mo sustainable, $2,184,265 future pot; exact months vary with current month, asserted within tolerance in tests).
4. Confirm no `NaN`/`undefined` in results with extreme-but-legal inputs (clamping should hold).
5. Update `README.md` if behavior changed; no changelog file exists.