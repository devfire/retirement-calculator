# Task completion

No linter, formatter, test runner, build, or type checker exist. "Done" = manual verification in a browser:

1. `python3 -m http.server 8765`, open `http://127.0.0.1:8765`.
2. Exercise the changed path (type inputs, watch results/chart update); confirm the specific behavior fixed/added.
3. For solver/math changes, cross-check numbers against the README worked example ($1M now + $4k/mo × 5y, 7%/4.5% returns, 2.5% inflation, 10y out → $6,768/mo sustainable, $2,368,833 future pot).
4. Confirm no `NaN`/`undefined` in results with extreme-but-legal inputs (clamping should hold).
5. Update `README.md` if behavior changed; no changelog file exists.