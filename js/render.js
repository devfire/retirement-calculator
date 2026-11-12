"use strict";
/* Rendering: deterministic headline, Monte Carlo cards (debounced/cached), back-fill UI.
   Uses shared ui.js globals; save()/apply() are defined in js/main.js (called at runtime). */
function syncPresets(){
  document.querySelectorAll("[data-preset]").forEach(b => {
    const [a, c, vb, va] = b.dataset.preset.split(",").map(Number);
    const on = Number($("returnBefore").value) === a && Number($("returnAfter").value) === c && Number($("volBefore").value) === vb && Number($("volAfter").value) === va; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
  });
}
/** Monte Carlo runs ~1,000 paths × every month and takes hundreds of ms — far too
 *  slow to run synchronously on every keystroke/slider tick. The deterministic
 *  headline above is cheap and stays instant; only the MC is deferred: it runs
 *  once, 200 ms after the last render, for the latest inputs only. Baseline and
 *  each guardrail strategy are cached separately: the baseline key excludes every
 *  strategy field, so toggling a guardrail (or changing its cut) reuses the
 *  headline result instantly and only the missing strategy replay is scheduled —
 *  strategies replay the same seeded paths, so their numbers still compare
 *  against exactly the paths behind the cached headline. While a recompute is
 *  pending the card shows a calculating state rather than stale numbers for old
 *  inputs, and the chart band is dropped until the fresh bands land. */
const MC_DEBOUNCE_MS = 200;
/** Animate a money headline from its previous value (D3 tween; instant if unchanged). */
function tweenMoney(el, value){
  if (!window.d3 || !Number.isFinite(value) || prefersReducedMotion()){ el.textContent = fmt.format(value); el._v = value; return; }
  const prev = el._v; el._v = value;
  if (prev === undefined || prev === value){ el.textContent = fmt.format(value); return; }
  d3.select(el).interrupt().transition().duration(380).ease(d3.easeCubicOut)
    .tween("text", () => { const i = d3.interpolateNumber(prev, value); return t => { el.textContent = fmt.format(i(t)); }; })
    .on("end", () => { el.textContent = fmt.format(value); });
}
/** Spend the Monte Carlo lead metric tests: the desired spend when one is
 *  entered (that's the question the user asked), else the headline spend. */
function mcTestSpend(R){
  return Number.isFinite(R.san.desiredSpend) ? Math.max(0, R.san.desiredSpend) : R.totalSpendToday;
}
function renderGuardrails(MC, R, v, pending = false){
  const testSpend = mcTestSpend(R), active = !!R.san.guardrailEnabled && R.san.guardrailCut > 0, G = MC && MC.guardrail;
  $("guardSuccessLabel").textContent = `Chance ${fmt.format(testSpend)}/mo lasts ${v.retireYears} yrs`;
  $("guardSpendLabel").textContent = `Spending at ${R.san.mcSuccessTarget}% success, down-year rule`;
  $("guardDesc").textContent = active
    ? `Cutting spending by ${R.san.guardrailCut}% for the 12 months after any year with a negative market return (including the last year before retirement), then restoring it after an up year — on the same 1,000 simulated paths. Median pot left with guardrails: ${G ? fmt.format(G.medianEndToday) + " in today's $" : "…"}.`
    : "Enable “Cut spending after a down year” in Your plan: in the 12 months after a year with a negative market return, spending drops by your chosen cut, then restores after an up year. Same 1,000 simulated paths as above.";
  if (!active){
    fillCard([["guardSuccess","guardSuccessNote","enable guardrails to compare"],["guardSpend","guardSpendNote","vs. without guardrails"],["guardCutShare","guardCutNote","share of years, averaged across paths"]], "—");
    return;
  }
  if (pending || !G){
    fillCard([["guardSuccess","guardSuccessNote","calculating…"],["guardSpend","guardSpendNote","calculating…"],["guardCutShare","guardCutNote","calculating…"]], "…");
    return;
  }
  const baseDesired = desiredSuccess(MC.sMax, R), guardDesired = desiredSuccess(G.sMax, R), hasDesired = baseDesired !== null, basePct = Math.round((hasDesired ? baseDesired : MC.success) * 100);
  $("guardSuccess").textContent = Math.round((hasDesired ? guardDesired : G.success) * 100) + "%";
  $("guardSuccessNote").textContent = `vs. ${basePct}% without guardrails, of ${MC.trials.toLocaleString()} paths`;
  $("guardSpend").textContent = fmt.format(G.spendAtTarget);
  $("guardSpendNote").textContent = `vs. ${fmt.format(MC.spendAtTarget)}/mo without — ${fmt.format(Math.max(0, G.spendAtTarget - MC.spendAtTarget))}/mo more at the same ${MC.successTarget}% target`;
  $("guardCutShare").textContent = Math.round(G.cutYearShare * 100) + "%";
  $("guardCutNote").textContent = `in cut years spending drops to ${fmt.format(testSpend * (1 - R.san.guardrailCut/100))}/mo (from ${fmt.format(testSpend)}/mo), today-$`;
}
function renderRiskGuardrails(MC, R, v, pending = false){
  const testSpend = mcTestSpend(R), active = !!R.san.riskGuardEnabled, G = MC && MC.riskGuardrail;
  $("riskSuccessLabel").textContent = `Chance ${fmt.format(testSpend)}/mo lasts ${v.retireYears} yrs`;
  $("riskDesc").textContent = active
    ? `Re-solving yearly from the actual pot over the years left, targeting the ${R.san.mcSuccessTarget}%-success spend (re-solve haircut ×${G ? G.haircut.toFixed(2) : "…"} at the full horizon, fading as years pass): raises go fully to the re-solved level, cuts close ${R.san.riskCutStep}% of the gap per year, changes under ${R.san.riskMinChange}% are ignored — on the same 1,000 simulated paths. Median pot left starting at the tested spend: ${G ? fmt.format(G.medianEndToday) + " in today's $" : "…"}.`
    : "Enable “Risk-based guardrails” in Your plan: each retirement anniversary, sustainable spending is re-solved from the pot you actually have over the years left, on the same 1,000 paths. Raises go fully to the re-solved level; cuts close only part of the gap each year.";
  if (!active){
    fillCard([["riskSuccess","riskSuccessNote","enable risk-based guardrails to compare"],["riskAvgSpend","riskAvgNote","after annual adjustments, today-$"],["riskMinSpend","riskMinNote","how deep the cuts get, today-$"]], "—");
    return;
  }
  if (pending || !G){
    fillCard([["riskSuccess","riskSuccessNote","calculating…"],["riskAvgSpend","riskAvgNote","calculating…"],["riskMinSpend","riskMinNote","calculating…"]], "…");
    return;
  }
  const hasDesired = G.successDesired !== null, baseDesired = desiredSuccess(MC.sMax, R), basePct = Math.round((hasDesired ? baseDesired : MC.success) * 100);
  $("riskSuccess").textContent = Math.round((hasDesired ? G.successDesired : G.success) * 100) + "%";
  $("riskSuccessNote").textContent = `vs. ${basePct}% without guardrails, of ${MC.trials.toLocaleString()} paths`;
  $("riskAvgSpend").textContent = fmt.format(G.avgSpendToday);
  $("riskAvgNote").textContent = `per month starting from ${fmt.format(testSpend)}/mo, after adjustments in ${Math.round(G.adjYearShare * 100)}% of years (cuts ${Math.round(G.cutYearShare * 100)}%, raises ${Math.round(G.raiseYearShare * 100)}%)`;
  $("riskMinSpend").textContent = fmt.format(G.minSpendMedian);
  $("riskMinNote").textContent = `median across paths of each path's lowest month · 10th-pct paths dip to ${fmt.format(G.minSpendP10)}/mo (starting from ${fmt.format(testSpend)}/mo)`;
}
function applyMonteCarlo(MC, R, v, overlaysPending = false){
  if (!MC){
    $("mcSuccessLabel").textContent = "Chance the headline spending lasts";
    $("mcSuccess").textContent = "—";
    $("mcSuccessNote").textContent = "of 1,000 simulated paths";
    $("mcSpendLabel").textContent = `Spending at ${R.san.mcSuccessTarget}% success`;
    $("mcSpendTarget").textContent = "—";
    $("mcMedianEnd").textContent = "—";
    $("mcMedianEndNote").textContent = "in today's $";
    $("mcDesiredOut").hidden = true;
    renderGuardrails(null, R, v);
    renderRiskGuardrails(null, R, v);
    drawMcChart(null, null, false);
    return;
  }
  const successDesired = desiredSuccess(MC.sMax, R), hasDesired = successDesired !== null, testSpend = mcTestSpend(R);
  $("mcSuccessLabel").textContent = `Chance ${fmt.format(testSpend)}/mo lasts ${v.retireYears} yrs`;
  $("mcSuccess").textContent = Math.round((hasDesired ? successDesired : MC.success) * 100) + "%";
  $("mcSuccessNote").textContent = `of ${MC.trials.toLocaleString()} simulated paths`;
  $("mcSpendLabel").textContent = `Spending at ${MC.successTarget}% success`;
  $("mcSpendTarget").textContent = fmt.format(MC.spendAtTarget);
  $("mcMedianEnd").textContent = fmt.format(MC.medianEndToday);
  $("mcMedianEndNote").textContent = `in today's $ · headline spend is solved to end near $0 · 10th pct leaves ${fmt.format(MC.p10EndToday)}`;
  const dMC = $("mcDesiredOut");
  if (hasDesired){
    dMC.hidden = false;
    dMC.textContent = `For comparison, the headline ${fmt.format(R.totalSpendToday)}/mo lasted in ${Math.round(MC.success * 100)}% of simulated paths. Spending ${fmt.format(MC.spendAtTarget)}/mo would have lasted in ${MC.successTarget}%.`;
  } else dMC.hidden = true;
  renderGuardrails(MC, R, v, overlaysPending && !MC.guardrail);
  renderRiskGuardrails(MC, R, v, overlaysPending && !MC.riskGuardrail);
  drawMcChart(MC, R, true);
}
function showMonteCarloPending(R, v){
  $("mcSuccessLabel").textContent = `Chance ${fmt.format(mcTestSpend(R))}/mo lasts ${v.retireYears} yrs`;
  $("mcSuccess").textContent = "…";
  $("mcSuccessNote").textContent = "calculating…";
  $("mcSpendLabel").textContent = `Spending at ${R.san.mcSuccessTarget}% success`;
  $("mcSpendTarget").textContent = "…";
  $("mcMedianEnd").textContent = "…";
  $("mcMedianEndNote").textContent = "calculating 1,000 simulated paths…";
  $("mcDesiredOut").hidden = true;
  renderGuardrails(null, R, v, true);
  renderRiskGuardrails(null, R, v, true);
  drawMcChart(null, null, false);
}
function scheduleMonteCarlo(R, v, job){
  const seq = ++mcSeq;
  clearTimeout(mcTimer);
  mcTimer = setTimeout(() => {
    mcTimer = null;
    if (seq !== mcSeq) return; // a newer render superseded this one
    let base = mcCache.value;
    if (job.needBase){ base = monteCarlo(R); mcCache = { key: job.baseKey, value: base, has: true }; }
    let guardrail = null, riskGuardrail = null;
    if (guardIsActive(R)){ if (job.needGuard){ guardrail = guardrailMC(R); guardCache = { key: job.gKey, value: guardrail, has: true }; } else guardrail = guardCache.value; }
    if (R.san.riskGuardEnabled){ if (job.needRisk){ riskGuardrail = base ? riskGuardrailMC(R, base.spendAtTarget) : null; riskCache = { key: job.rKey, value: riskGuardrail, has: true }; } else riskGuardrail = riskCache.value; }
    const MC = base ? { ...base, guardrail, riskGuardrail } : null;
    applyMonteCarlo(MC, R, v);
    if (chartData){ chartData.mc = MC ? MC.bands : null; drawChart(); }
  }, MC_DEBOUNCE_MS);
}


/** Sync the dual-thumb contribution window to the sanitized plan: scale is
 *  today → retirement, thumbs and number boxes show the clamped [start, end). */
function syncContributionWindow(R){
  // While the retirement year is being retyped, intermediate values ("2", "20", blank)
  // read as retiring now. Rescaling the range inputs then lets the browser clamp the
  // stored window to nowYear, and save() persists the loss. Leave the inputs untouched
  // until a complete in-range year is entered, or the field commits (change -> render).
  const retireEl = $("retireYear"), rawYear = retireEl.value.trim(), yearNum = Number(rawYear);
  const completeYear = /^\d{4}$/.test(rawYear) && yearNum >= nowYear && yearNum <= nowYear + 60;
  if (document.activeElement === retireEl && !completeYear) return;
  const s = R.san.contribStartYear, e = R.san.contribEndYear, span = Math.max(1, R.retireYearEff - nowYear);
  for (const id of ["contribStartYear","contribEndYear","contribStartYearNum","contribEndYearNum"]){
    const el = $(id); el.min = nowYear; el.max = R.retireYearEff; el.disabled = R.monthsRet === 0;
  }
  if (document.activeElement !== $("contribStartYear")) $("contribStartYear").value = s;
  if (document.activeElement !== $("contribEndYear")) $("contribEndYear").value = e;
  if (document.activeElement !== $("contribStartYearNum")) $("contribStartYearNum").value = s;
  if (document.activeElement !== $("contribEndYearNum")) $("contribEndYearNum").value = e;
  $("contribRange").style.setProperty("--lo", ((s - nowYear)/span*100) + "%");
  $("contribRange").style.setProperty("--hi", ((e - nowYear)/span*100) + "%");
  $("contribRangeOut").textContent = `${s} – ${e}`;
  $("contribRangeDur").textContent = R.contribMonths > 0 ? `${monthsLabel(R.contribMonths)} of contributions` : "No contributions";
}

function render(){
  const v = readInputs();
  const R = compute(v);
  syncPresets();
  syncContributionWindow(R);
  $("retireYearsOut").textContent = `${v.retireYears} yrs`;
  $("yearsHint").textContent = R.monthsRet > 0 ? `${monthsLabel(R.monthsRet)} from now (${nowYear} → ${R.retireYearEff})` : "Retiring now.";
  const warns = shareLinkFailed ? ["Couldn't read this share link — showing your saved plan instead. Your saved plan has not been changed.", ...R.warns] : R.warns;
  $("warn").hidden = warns.length === 0; $("warn").textContent = warns.join(" ");

  const cStart = R.san.contribStartYear, cEnd = R.san.contribEndYear;
  $("timeline").innerHTML =
    (R.contribMonths > 0 && R.contribStartMonths > 0 ? `<div class="tl coast"><b>🌿 ${nowYear}–${cStart} · Coasting</b><span>Contributions start in ${cStart} — compounding only until then</span></div>` : "") +
    (R.contribMonths > 0 ? `<div class="tl save"><b>💰 ${cStart}–${cEnd} · Saving</b><span>${fmt.format(v.monthlyContribution||0)}/mo for ${monthsLabel(R.contribMonths)}</span></div>` : "") +
    (R.contribEndMonths < R.monthsRet ? `<div class="tl coast"><b>🌿 ${R.contribMonths > 0 ? cEnd : nowYear}–${R.retireYearEff} · Coasting</b><span>${R.contribMonths > 0 && (v.monthlyContribution||0) > 0 ? `Contributions stop in ${cEnd} — compounding only after that` : "No contributions — compounding only"}</span></div>` : "") +
    `<div class="tl spend"><b>🌅 ${R.retireYearEff}–${R.retireYearEff + (v.retireYears||0)} · Spending</b><span>${fmt.format(R.totalSpendToday)}/mo in today's $</span></div>`;

  $("vYears").textContent = v.retireYears;
  tweenMoney($("spendMonth"), R.totalSpendToday);
  announceVerdict(`Sustainable spending ${fmt.format(R.totalSpendToday)} per month in today's dollars (${fmt.format(R.totalSpendToday * 12)} per year) for ${v.retireYears} years of retirement.`);
  $("spendYear").textContent = fmt.format(R.totalSpendToday * 12);
  $("spendFirst").textContent = fmt.format(R.totalSpendToday * Math.pow(1 + R.san.inflation/100, R.yrs));
  $("portfolioSpend").textContent = fmt.format(R.portfolioSpendToday);
  $("portfolioSpendNote").textContent = R.incomeDelayMonths > 0 && R.incomeDelayMonths < (v.retireYears||0)*12 && (v.otherIncome||0) > 0 ? `/mo until ${R.retireYearEff + R.incomeDelayMonths/12}, then ${fmt.format(Math.max(0, R.totalSpendToday - (v.otherIncome||0)))}/mo` : "/mo today-$";
  $("otherSpend").textContent = fmt.format(v.otherIncome||0);
  $("otherSpendNote").textContent = R.incomeDelayMonths > 0 && (v.otherIncome||0) > 0 ? `/mo from ${R.retireYearEff + R.incomeDelayMonths/12}` : "/mo today-$";
  $("otherIncomeStartHint").textContent = !Number.isFinite(R.san.otherIncomeStartYear) || R.san.otherIncomeStartYear <= R.retireYearEff ? "Blank = starts at retirement, no bridge needed." : `Starts ${R.san.otherIncomeStartYear - R.retireYearEff} yr after retirement — portfolio funds all spending until ${R.san.otherIncomeStartYear}, then only the top-up.`;
  $("swr").textContent = R.potToday > 0 ? (R.portfolioSpendToday*12 / R.potToday * 100).toFixed(1) + "%" : "—";
  const scen = d => compute({ ...v, returnBefore: (v.returnBefore||0) + d, returnAfter: (v.returnAfter||0) + d }).totalSpendToday;
  const scenLow = scen(-2), scenHigh = scen(2);
  $("scenLow").textContent = fmt.format(scenLow); $("scenBase").textContent = fmt.format(R.totalSpendToday); $("scenHigh").textContent = fmt.format(scenHigh);
  { const vals = [scenLow, R.totalSpendToday, scenHigh], mx = Math.max(...vals, 1);
    if (window.d3) ["scenLowBar","scenBaseBar","scenHighBar"].forEach((id, i) => { const sel = d3.select("#"+id); if (prefersReducedMotion()) sel.style("width", (vals[i]/mx*100) + "%"); else sel.transition().duration(450).ease(d3.easeCubicOut).style("width", (vals[i]/mx*100) + "%"); }); }
  const baseKey = mcKeyFor(R), gKey = guardKeyFor(R), rKey = riskKeyFor(R);
  const baseHit = mcCache.has && mcCache.key === baseKey;
  const needGuard = guardIsActive(R) && !(guardCache.has && guardCache.key === gKey);
  const needRisk = !!R.san.riskGuardEnabled && !(riskCache.has && riskCache.key === rKey);
  let MC = null;
  if (baseHit && !needGuard && !needRisk){
    mcSeq++;
    clearTimeout(mcTimer);
    mcTimer = null;
    MC = { ...mcCache.value, guardrail: guardIsActive(R) ? guardCache.value : null, riskGuardrail: R.san.riskGuardEnabled ? riskCache.value : null };
    applyMonteCarlo(MC, R, v);
  } else if (baseHit){
    // Headline is unaffected by the strategies: show it instantly, replay only the missing strategy.
    MC = { ...mcCache.value, guardrail: guardIsActive(R) && !needGuard ? guardCache.value : null, riskGuardrail: R.san.riskGuardEnabled && !needRisk ? riskCache.value : null };
    applyMonteCarlo(MC, R, v, true);
    scheduleMonteCarlo(R, v, { baseKey, gKey, rKey, needBase: false, needGuard, needRisk });
  } else {
    showMonteCarloPending(R, v);
    scheduleMonteCarlo(R, v, { baseKey, gKey, rKey, needBase: true, needGuard, needRisk });
  }
  $("potFuture").textContent = fmt.format(R.potFuture);
  $("potToday").textContent = `= ${fmt.format(R.potToday)} in today's dollars`;
  $("putIn").textContent = fmt.format((v.currentSavings||0) + R.totalContrib);
  $("putInDetail").textContent = `${fmt.format(v.currentSavings||0)} now + ${fmt.format(R.totalContrib)} contributed`;
  $("growthEarned").textContent = fmt.format(R.growthEarned);
  const bite = R.yrs > 0 ? (1 - 1/Math.pow(1 + R.san.inflation/100, R.yrs)) * 100 : 0;
  $("inflBite").textContent = bite.toFixed(1) + "%";
    $("inflBiteDetail").textContent = R.monthsRet > 0 ? `purchasing power lost over ${monthsLabel(R.monthsRet)} at ${R.san.inflation}% inflation` : "—";

  const dOut = $("desiredOut");
  if (Number.isFinite(v.desiredSpend)){
    dOut.hidden = false;
    let msg;
    if (R.desiredMonths === Infinity) msg = `✅ Your desired ${fmt.format(v.desiredSpend)}/mo is fully covered by other income — ${R.cushionToday > 0 ? "the pot only needs to fund the end amount" : "the pot is untouched"}.`;
    else if (R.desiredMonths >= (v.retireYears||0)*12) msg = `✅ Desired ${fmt.format(v.desiredSpend)}/mo (today's $) lasts ${(R.desiredMonths/12).toFixed(1)} years — covers your ${v.retireYears}-year retirement with room to spare.`;
    else msg = `⚠️ Desired ${fmt.format(v.desiredSpend)}/mo (today's $) runs out after ${(R.desiredMonths/12).toFixed(1)} years of retirement — ${(v.retireYears - R.desiredMonths/12).toFixed(1)} years short. Sustainable level is ${fmt.format(R.totalSpendToday)}/mo.`;
    if (R.gap && R.gap.requiredPotToday > 0){
      if (R.gap.shortfallToday > 0) msg += ` To fund it fully you'd need a ${fmt.format(R.gap.requiredPotToday)} pot (today-$) — a ${fmt.format(R.gap.shortfallToday)} shortfall. Close it with ${R.gap.extraMonthly > 0 ? `~${fmt.format(R.gap.extraMonthly)}/mo extra during your contribution phase${R.san.contribGrowth ? `, that extra itself rising ${R.san.contribGrowth}%/yr like your other contributions` : ""}, or ` : ""}${fmt.format(Math.max(0, R.gap.lumpToday))} as a lump sum today.`;
      else msg += ` It needs a ${fmt.format(R.gap.requiredPotToday)} pot (today-$); you'll have ${fmt.format(R.potToday)} — a ${fmt.format(Math.max(0, -R.gap.shortfallToday))} cushion.`;
    }
    dOut.textContent = msg;
  } else dOut.hidden = true;
  const eOut = $("endAmountOut");
  if (R.cushionToday > 0){
    eOut.hidden = false;
    eOut.textContent = R.cushionPVToday > R.potToday
      ? `⚠️ Cushion of ${fmt.format(R.cushionToday)} (today's $) at the end needs a ${fmt.format(R.cushionPVToday)} pot (today-$) — more than your projected ${fmt.format(R.potToday)}, so the portfolio funds $0/mo. Projected end balance is ${fmt.format(R.endBalanceFuture)} future $.`
      : `🛟 Leaving ${fmt.format(R.cushionToday)} (today's $) at the end — ${fmt.format(R.cushionFuture)} in future $. Projected end balance: ${fmt.format(R.endBalanceFuture)} future $. Sustainable spending above already accounts for this cushion.`;
  } else eOut.hidden = true;
  // Button never disables or relabels: adjusting the target up or down and re-pressing is the
  // intended workflow, so it stays armed while the pot must fund any desired spend or cushion.
  lastBackfill = backfillPlan(R, backfillMode);
  // Floored at $0 yet still overshooting: the chosen lever isn't needed at all — the other
  // input alone funds more than the target, so $0 is the solved value, not a blanked field.
  // Only trimming Current savings (or Monthly, conversely) can hit the target exactly.
  const bfSavingsLever = backfillMode === "savings" || R.contribMonths <= 0;
  const bfFloored = !!lastBackfill && !!R.gap && R.gap.shortfallToday < 0 &&
    (bfSavingsLever ? lastBackfill.currentSavings : lastBackfill.monthlyContribution) === 0;
  const bfFunded = bfFloored ? compute({ ...v, ...lastBackfill }).totalSpendToday : 0;
  const bfUnneeded = bfFloored && bfFunded > v.desiredSpend + 1;
  // Sticky solve: once Back-fill has been pressed, changing assumptions (presets, returns,
  // inflation, …) re-solves the same lever immediately instead of letting the plan drift off
  // the desired spend until the button is pressed again. Manual edits to the lever inputs or
  // the target itself unlock it (see the form input handler). `resolving` is held for the
  // whole nested render, so that render cannot re-solve in turn (recursion depth ≤ 1 even
  // if a solve ever failed to reach a fixed point); the solved plan is itself a fixed
  // point, so the nested render normally finds nothing left to change anyway.
  if (stickySolve && lastBackfill && !resolving &&
      (lastBackfill.currentSavings !== R.san.currentSavings || lastBackfill.monthlyContribution !== R.san.monthlyContribution)){
    resolving = true;
    try {
      apply(lastBackfill);
      render();
    } finally { resolving = false; }
    return;
  }
  const showBackfill = Number.isFinite(v.desiredSpend) && !!R.gap && R.gap.requiredPotToday > 0;
  $("backfillRow").hidden = !showBackfill;
  setPressed("backfillMonthly", backfillMode === "monthly");
  setPressed("backfillSavings", backfillMode === "savings");
  if (lastBackfill){
    const parts = [];
    if (lastBackfill.currentSavings !== R.san.currentSavings) parts.push(`savings ${fmt.format(R.san.currentSavings)} → ${fmt.format(lastBackfill.currentSavings)}`);
    if (lastBackfill.monthlyContribution !== R.san.monthlyContribution) parts.push(`monthly ${fmt.format(R.san.monthlyContribution)} → ${fmt.format(lastBackfill.monthlyContribution)}`);
    if (bfUnneeded) $("backfillHint").textContent = bfSavingsLever
      ? `No current savings needed — your monthly contributions alone still fund ${fmt.format(bfFunded)}/mo, above your ${fmt.format(v.desiredSpend)}/mo target, so savings solve to $0. To hit the target exactly, switch the toggle to Monthly contributions and back-fill that instead.`
      : `No monthly contributions needed — your current savings alone still fund ${fmt.format(bfFunded)}/mo, above your ${fmt.format(v.desiredSpend)}/mo target, so monthly solves to $0 (that's the answer, not a blank field). To hit the target exactly, switch the toggle to Current savings and back-fill that instead.`;
    else if (!parts.length) $("backfillHint").textContent = R.totalSpendToday > v.desiredSpend + 1
      ? `Can't trim to ${fmt.format(v.desiredSpend)}/mo with this lever alone — it still funds ${fmt.format(R.totalSpendToday)}/mo at $0. Switch the toggle to trim the other input.`
      : `Already funding ${fmt.format(v.desiredSpend)}/mo — change the target or the toggle, then press again.`;
    else $("backfillHint").textContent = `Would set ${parts.join(" · ")} so sustainable spending meets ${fmt.format(v.desiredSpend)}/mo. Nothing changes until you press the button.`;
    if (stickySolve && !bfUnneeded) $("backfillHint").textContent = `🔒 Solve locked — ${(backfillMode === "savings" || R.contribMonths <= 0) ? "current savings" : "monthly contributions"} re-adjust automatically to keep ${fmt.format(v.desiredSpend)}/mo funded when assumptions change. Edit current savings, monthly contributions, or the target to unlock.`;
  }


  chartData = {points: R.points, yrs: R.yrs, contribStartT: R.contribStartMonths/12, contribT: R.contribEndMonths/12, retireYear: R.retireYearEff, inflation: R.san.inflation/100, mc: MC ? MC.bands : null};
  drawChart();
  save(v);
}
