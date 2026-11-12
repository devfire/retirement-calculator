# Suggested commands

- Run/serve (no build): `python3 -m http.server 8765` then open `http://127.0.0.1:8765`. (`python3`, not `python`; also works from `file://` by double-clicking `index.html`.)
- `git log --oneline` for recent change context.

Core tests (no deps): `node --test test/core.test.js`. No linter/formatter/build exists. Generic `ls`/`grep`/`git` behave normally here.