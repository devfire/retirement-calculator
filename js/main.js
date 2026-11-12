"use strict";
/* Entry point: persistence (localStorage/share links) + DOM wiring only.
   Load order (index.html): js/core.js → js/ui.js → js/charts.js → js/render.js → js/main.js. */
$("basisToday").onclick = () => { basis = "today"; setPressed("basisToday", true); setPressed("basisNominal", false); drawChart(); };
$("basisNominal").onclick = () => { basis = "nominal"; setPressed("basisNominal", true); setPressed("basisToday", false); drawChart(); };
$("viewBalance").onclick = () => { chartView = "balance"; setPressed("viewBalance", true); setPressed("viewComposition", false); $("legendContrib").hidden = true; $("legendGrowth").hidden = true; drawChart(); };
$("viewComposition").onclick = () => { chartView = "composition"; setPressed("viewComposition", true); setPressed("viewBalance", false); $("legendContrib").hidden = false; $("legendGrowth").hidden = false; drawChart(); };
document.querySelectorAll(".lg[data-series='mc']").forEach(el => el.addEventListener("click", () => {
  showMC = !showMC;
  document.querySelectorAll(".lg[data-series='mc']").forEach(n => { n.classList.toggle("off", !showMC); n.setAttribute("aria-pressed", String(showMC)); });
  drawChart(false);
}));

function save(v){ if (sharedView) return; try{ localStorage.setItem("retireplan-v1", JSON.stringify(v)); }catch{} }
/** A plan opened from a share link is a view, not the saved plan: it must not reach
 *  localStorage until the user changes it. Adopting clears the hash so a reload
 *  doesn't re-apply the shared copy over the now-owned, saved one. */
function adoptShared(){
  if (!sharedView) return;
  sharedView = false;
  shareLinkFailed = false;
  try{ history.replaceState(null, "", location.href.split("#")[0]); }catch{}
}
function apply(obj){
  const o = { ...obj };
  // Legacy plans (saved/shared before the window slider) carried a duration from today.
  if (o.contribStartYear === undefined && o.contribEndYear === undefined && Number.isFinite(Number(o.contribYears)) && o.contribYears !== null && o.contribYears !== ""){
    o.contribStartYear = nowYear; o.contribEndYear = nowYear + Number(o.contribYears);
  }
  for (const id of ["contribStartYear","contribEndYear"]){ $(id).min = nowYear; $(id).max = Math.max(nowYear + 60, Number(o.contribEndYear) || 0, Number(o.retireYear) || 0); }
  for (const f of FIELDS) if (o[f] !== undefined && o[f] !== null && !Number.isNaN(o[f])){ if (f === "guardrailEnabled" || f === "riskGuardEnabled"){ $(f).checked = !!o[f]; continue; } $(f).value = MONEY_FIELDS.includes(f) ? formatMoneyString(o[f]) : o[f]; }
}
function load(){
  $("retireYear").value = nowYear + 10;
  // Set the scale before the values: a range input still at its default max would clamp them.
  for (const id of ["contribStartYear","contribEndYear"]){ $(id).min = nowYear; $(id).max = nowYear + 60; }
  $("contribStartYear").value = nowYear; $("contribEndYear").value = nowYear + 5;
  const loadSaved = () => { try{ const s = localStorage.getItem("retireplan-v1"); if (s) apply(JSON.parse(s)); }catch{} };
  if (location.hash.length > 1){
    // Set sharedView before decoding: a bad hash must never let render()->save()
    // overwrite the saved plan with the HTML defaults shown in its place.
    sharedView = true;
    try{ apply(decodeShare(location.hash)); }
    catch{ shareLinkFailed = true; loadSaved(); }
  } else loadSaved();
  for (const f of MONEY_FIELDS) if ($(f).value !== "") $(f).value = formatMoneyString($(f).value);
}
$("shareBtn").onclick = async () => {
  const url = location.href.split("#")[0] + "#" + encodeShare(readInputs());
  try{ await navigator.clipboard.writeText(url); $("shareBtn").textContent = "✓ Link copied"; }
  catch{ prompt("Copy your share link:", url); }
  setTimeout(() => $("shareBtn").textContent = "🔗 Copy share link", 1800);
};
$("resetBtn").onclick = () => { stickySolve = false; backfillMode = "monthly"; adoptShared(); localStorage.removeItem("retireplan-v1"); apply({currentSavings:1000000, retireYear:nowYear+10, monthlyContribution:0, contribStartYear:nowYear, contribEndYear:nowYear+5, contribGrowth:0, returnBefore:7, returnAfter:4.5, volBefore:14, volAfter:9, inflation:2.5, retireYears:30, mcSuccessTarget:85, otherIncome:0, desiredEndAmount:0, desiredSpend:NaN, guardrailCut:10, guardrailEnabled:0, riskMinChange:5, riskCutStep:10, riskGuardEnabled:0}); $("desiredSpend").value=""; $("otherIncomeStartYear").value=""; render(); };
$("backfillBtn").onclick = () => { if (!lastBackfill) return; adoptShared(); stickySolve = true; apply(lastBackfill); render(); };
$("backfillMonthly").onclick = () => { backfillMode = "monthly"; stickySolve = false; render(); };
$("backfillSavings").onclick = () => { backfillMode = "savings"; stickySolve = false; render(); };
document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
  const [a, c, vb, va] = b.dataset.preset.split(","); adoptShared(); $("returnBefore").value = a; $("returnAfter").value = c; $("volBefore").value = vb; $("volAfter").value = va; render();
});
for (const f of MONEY_FIELDS) $(f).addEventListener("input", e => formatMoneyInput(e.target));
// Dual-thumb clamping: the dragged end stops at the other end (window can empty, never invert).
// These run on the target before the form-level render, so compute() sees a valid window.
$("contribStartYear").addEventListener("input", e => { if (+e.target.value > +$("contribEndYear").value) e.target.value = $("contribEndYear").value; });
$("contribEndYear").addEventListener("input", e => { if (+e.target.value < +$("contribStartYear").value) e.target.value = $("contribStartYear").value; });
$("contribStartYearNum").addEventListener("input", e => { if (e.target.value !== ""){ $("contribStartYear").value = e.target.value; if (+$("contribStartYear").value > +$("contribEndYear").value) $("contribStartYear").value = $("contribEndYear").value; } });
$("contribEndYearNum").addEventListener("input", e => { if (e.target.value !== ""){ $("contribEndYear").value = e.target.value; if (+$("contribEndYear").value < +$("contribStartYear").value) $("contribEndYear").value = $("contribStartYear").value; } });
// Both thumbs stacked at one year: the end thumb sits on top, so dragging expands/shrinks
// from the end; the start thumb stays reachable by keyboard and via its number box.
$("contribStartYear").style.zIndex = 3; $("contribEndYear").style.zIndex = 4;
$("form").addEventListener("input", e => { adoptShared(); if (["currentSavings","monthlyContribution","desiredSpend"].includes(e.target.id)) stickySolve = false; render(); });
addEventListener("resize", () => { drawChart(false); if (lastMcVis) drawMcChart(lastMcVis.MC, lastMcVis.R, false); });
$("retireYear").max = nowYear + 60;
// Commit (blur/Enter) applies any clamp deferred while the year was being retyped.
$("retireYear").addEventListener("change", render);
load(); render();
