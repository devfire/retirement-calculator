# Tech stack

- **Language**: vanilla JavaScript (ES2017+), `"use strict"`. No TypeScript, no framework.
- **No build step, no bundler, no npm/package.json, no network calls.** Only dependency is D3 v7.9.0, vendored as `d3.min.js` (loaded locally, no CDN). Open `index.html` directly or serve the folder.
- Language support via Serena `typescript` LSP (project.yml), which also covers plain JS.
- Styling: plain CSS. Persistence: `localStorage`. Sharing: URL hash encoding.
- Git remote: `git@github.com:devfire/retirement-calculator.git`.