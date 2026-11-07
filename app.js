"use strict";
const $ = id => document.getElementById(id);
const FIELDS = ["currentSavings","retireYear","monthlyContribution","contribYears","contribGrowth","returnBefore","returnAfter","inflation","retireYears","otherIncome","otherIncomeStartYear","desiredEndAmount","desiredSpend"];
const nowYear = new Date().getFullYear();
const fmt = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const fmt2 = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2});
const compact = v => "$" + Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(v);
const mRate = annualPct => Math.pow(1 + annualPct/100, 1/12) - 1; // effective monthly

let basis = "today", chartData = null, lastBackfill = null, backfillMode = "monthly", stickySolve = false, resolving = false;

function readInputs(){
  const v = {};
  for (const f of FIELDS){ const raw = $(f).value; v[f] = raw === "" ? NaN : parseFloat(raw); }
  return v;
}

/** Monthly simulation. Contributions/spending at start of month, then growth. */
function compute(raw){
  // Sanitize: never let a typed extreme (return ≤ −100%, negative savings, blank) turn the page into NaNs.
  const num = (x, d=0) => Number.isFinite(x) ? x : d;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const retireYearIn = Math.round(num(raw.retireYear, nowYear));
  const v = { ...raw,
    currentSavings: Math.max(0, num(raw.currentSavings)), monthlyContribution: Math.max(0, num(raw.monthlyContribution)),
    otherIncome: Math.max(0, num(raw.otherIncome)), otherIncomeStartYear: Number.isFinite(raw.otherIncomeStartYear) ? Math.round(raw.otherIncomeStartYear) : NaN, desiredEndAmount: Math.max(0, num(raw.desiredEndAmount)), desiredSpend: raw.desiredSpend,
    retireYear: Math.min(retireYearIn, nowYear + 60), retireYears: clamp(num(raw.retireYears), 0, 60),
    contribYears: clamp(num(raw.contribYears), 0, 60), contribGrowth: clamp(num(raw.contribGrowth), -20, 50),
    returnBefore: clamp(num(raw.returnBefore), -50, 30), returnAfter: clamp(num(raw.returnAfter), -50, 30),
    inflation: clamp(num(raw.inflation), -10, 30) };
  const clamped = ["returnBefore","returnAfter","inflation","contribGrowth"].some(k => v[k] !== num(raw[k]));
  const warns = clamped ? ["Some assumptions were outside sane ranges and were clamped (−50%…30% returns, −10%…30% inflation)."] : [];
  if (v.retireYear !== retireYearIn) warns.push(`Retirement year is more than 60 years away — clamped to ${nowYear + 60}.`);
  const retireYearEff = Math.max(v.retireYear, nowYear);
  const yearsToRetire = retireYearEff - nowYear;
  if (v.retireYear < nowYear) warns.push("Retirement year is in the past — results below assume retiring now.");
  if (v.contribYears > yearsToRetire) warns.push(`Contribution duration (${v.contribYears}y) exceeds time to retirement (${yearsToRetire}y) — capped at retirement.`);
  const yrs = yearsToRetire;
  const monthsRet = Math.round(yrs * 12);
  const contribMonths = Math.round(Math.min(v.contribYears, yrs) * 12);
  const rB = mRate(v.returnBefore), rA = mRate(v.returnAfter), inf = mRate(v.inflation);
  const inflAnnual = v.inflation/100;

  // Accumulation
  let bal = v.currentSavings||0, totalContrib = 0, totalContribReal = v.currentSavings||0;
  const annual = []; // {year, phase, start, contrib, growth, spent, end}
  const points = [{t:0, bal, cum: bal, cumReal: bal}]; // yearly snapshots for chart
  let cur = null;
  const pushYear = (year, phase) => { cur = {year, phase, start: bal, contrib:0, growth:0, spent:0, end: bal}; annual.push(cur); };
  if (monthsRet === 0) pushYear(nowYear, "Retire");
  for (let m = 0; m < monthsRet; m++){
    const calYear = nowYear + Math.floor(m/12);
    const phase = m < contribMonths ? "Saving" : "Coasting";
    if (!cur || cur.year !== calYear || cur.phase !== phase) pushYear(calYear, phase);
    let c = 0;
    if (m < contribMonths){ c = (v.monthlyContribution||0) * Math.pow(1 + (v.contribGrowth||0)/100, Math.floor(m/12)); bal += c; totalContrib += c; totalContribReal += c / Math.pow(1+inf, m); cur.contrib += c; }
    const g = bal * rB; bal += g; cur.growth += g; cur.end = bal;
    if ((m+1) % 12 === 0 || m === monthsRet-1) points.push({t:(m+1)/12, bal, cum:(v.currentSavings||0)+totalContrib, cumReal: totalContribReal});
  }
  const potFuture = bal;
  const potToday = potFuture / Math.pow(1+inflAnnual, yrs);
  const growthEarned = potFuture - (v.currentSavings||0) - totalContrib;

  // Sustainable level real spending from the pot (annuity-due in real terms), reserving the
  // desired end cushion: PV at retirement of the cushion (today-$ at end of retirement) is
  // cushionToday / (1+rReal)^N, so only the remainder of the pot funds spending.
  // Other income may start after retirement (e.g. Social Security claimed later): until it
  // starts the portfolio funds ALL spending (the bridge), afterwards only spending − income.
  const N = Math.round((v.retireYears||0) * 12);
  const rReal = (1 + rA) / (1 + inf) - 1;
  const cushionToday = v.desiredEndAmount||0;
  const cushionPVToday = N > 0 ? cushionToday * Math.pow(1 + rReal, -N) : 0;
  const cushionFuture = cushionToday * Math.pow(1 + inflAnnual, yrs + (v.retireYears||0)); // nominal $ at end
  const spendableToday = Math.max(0, potToday - cushionPVToday);
  const otherIncome = v.otherIncome||0;
  const incomeDelayMonths = Number.isFinite(v.otherIncomeStartYear) ? Math.max(0, Math.round((v.otherIncomeStartYear - retireYearEff) * 12)) : 0;
  if (otherIncome > 0 && N > 0 && incomeDelayMonths >= N) warns.push("Other income starts after your retirement period ends — it doesn't fund any of this plan.");
  // PV (today-$ at retirement) of $1/mo real, paid at the start of each month for `months` months.
  const annuityDue = months => months <= 0 ? 0 : Math.abs(rReal) < 1e-12 ? months : (1 + rReal) * (1 - Math.pow(1 + rReal, -months)) / rReal;
  const bridgeMonths = Math.min(incomeDelayMonths, N); // months portfolio funds everything
  const pvBridge = annuityDue(bridgeMonths), pvAfter = annuityDue(N) - pvBridge, pvTotal = annuityDue(N);
  let totalSpendToday = 0; // level total spending, per month in today's dollars
  if (N > 0){
    if (otherIncome <= 0) totalSpendToday = spendableToday / pvTotal;
    else {
      const candidate = (spendableToday + otherIncome * pvAfter) / pvTotal; // assumes spending ≥ income after it starts
      // If the pot can't even fund `otherIncome` through the bridge, income alone covers
      // spending once it starts — the bridge is the binding constraint.
      totalSpendToday = candidate >= otherIncome ? candidate : (pvBridge > 0 ? spendableToday / pvBridge : candidate);
    }
  }
  // Portfolio withdrawal in the first retirement month (full spend during any bridge).
  const portfolioSpendToday = N <= 0 ? 0 : incomeDelayMonths > 0 ? totalSpendToday : Math.max(0, totalSpendToday - otherIncome);

  // Drawdown simulation (nominal) using the solved spend; spending indexed to inflation from today
  cur = null;
  for (let m = 0; m < N; m++){
    const calYear = retireYearEff + Math.floor(m/12);
    if (!cur || cur.year !== calYear) pushYear(calYear, "Spending");
    const wToday = m < incomeDelayMonths ? totalSpendToday : Math.max(0, totalSpendToday - otherIncome); // real portfolio withdrawal
    const wNominal = wToday * Math.pow(1+inf, monthsRet + m);
    bal -= wNominal; cur.spent += wNominal;
    const g = bal * rA; bal += g; cur.growth += g; cur.end = bal;
    if ((m+1) % 12 === 0 || m === N-1) points.push({t: yrs + (m+1)/12, bal: Math.max(bal, 0), cum:(v.currentSavings||0)+totalContrib, cumReal: totalContribReal});
  }

  // Desired-spending longevity (portfolio funds desired, minus other income once it starts)
  let desiredMonths = null;
  if (Number.isFinite(v.desiredSpend)){
    const desiredToday = Math.max(0, v.desiredSpend);
    let b = potFuture; desiredMonths = 0;
    if (incomeDelayMonths <= 0 && desiredToday <= otherIncome) desiredMonths = Infinity;
    else while (desiredMonths < 1200){
      const needToday = desiredMonths < incomeDelayMonths ? desiredToday : Math.max(0, desiredToday - otherIncome);
      const w = needToday * Math.pow(1+inf, monthsRet + desiredMonths);
      if (b < w) break;
      const bNext = (b - w) * (1 + rA);
      // Longevity counts only months that leave the cushion intact at month-end.
      if (cushionToday > 0 && bNext < cushionToday * Math.pow(1+inf, monthsRet + desiredMonths + 1) - 1) break;
      b = bNext; desiredMonths++;
    }
  }
  // Gap solver: what pot does the desired spend need, and what closes any shortfall?
  // potFor() mirrors the accumulation loop above (same contribution formula) for extra monthly amounts.
  let gap = null;
  if (Number.isFinite(v.desiredSpend) && N > 0){
    const desiredToday = Math.max(0, v.desiredSpend);
    // Invert the annuity-due directly (not pot × need ÷ sustainable) so a $0 pot still gets an answer.
    // Plus the PV of the end cushion, which the pot must also still hold at the end. The cushion
    // term stands even when other income covers all spending (both spending terms are 0 then):
    // dropping it would report a $0 required pot and hide Back-fill for an unfunded end amount.
    const requiredPotToday = desiredToday * pvBridge + Math.max(0, desiredToday - otherIncome) * pvAfter + cushionPVToday;
    const shortfallToday = requiredPotToday - potToday;
    // Signed on purpose: negative means "trim this much" — back-fill adjusts both ways.
    // potFor() is linear in `extra`, so one slope gives the exact signed delta (no bisection).
    const targetFuture = requiredPotToday * Math.pow(1 + inflAnnual, yrs);
    const lumpToday = (targetFuture - potFuture) / Math.pow(1 + rB, monthsRet);
    let extraMonthly = 0;
    if (contribMonths > 0){
      // `extra` is a delta to monthlyContribution itself, so it must escalate by
      // contribGrowth each year exactly as the real contribution will once
      // backfillPlan writes (monthly + extra) back into that field. Adding it flat
      // here would understate the slope whenever growth ≠ 0 and the solved amount
      // would overshoot, then bounce instead of settling on the target.
      const potFor = extra => { let b = v.currentSavings; for (let m = 0; m < monthsRet; m++){ if (m < contribMonths) b += (v.monthlyContribution + extra) * Math.pow(1 + v.contribGrowth/100, Math.floor(m/12)); b *= 1 + rB; } return b; };
      const slope = potFor(1) - potFor(0);
      if (slope > 0) extraMonthly = (targetFuture - potFuture) / slope;
    }
    gap = { requiredPotToday, shortfallToday, extraMonthly, lumpToday };
  }
  return {warns, yrs, contribMonths, potFuture, potToday, growthEarned, totalContrib, retireYearEff, gap, san: v, incomeDelayMonths,
          portfolioSpendToday, totalSpendToday, annual, points, desiredMonths, rReal, cushionToday, cushionFuture, cushionPVToday, endBalanceFuture: N > 0 ? bal : potFuture};
}

/** Plan that rewrites savings/contributions so sustainable spending meets the desired level, in
 *  either direction: mode "monthly" adjusts contributions, "savings" adjusts current savings
 *  (toggle in the form). Rounded up to the nearest $10 so rounding can't reopen a gap; floored at $0. */
function backfillPlan(R, mode){
  if (!R.gap || R.gap.requiredPotToday <= 0) return null;
  const savings = R.san.currentSavings, monthly = R.san.monthlyContribution, ceil10 = x => Math.max(0, Math.ceil(x/10)*10);
  if (mode === "savings" || R.contribMonths <= 0) // no contribution phase left → savings is the only lever
    return { currentSavings: ceil10(savings + R.gap.lumpToday), monthlyContribution: monthly };
  return { currentSavings: savings, monthlyContribution: ceil10(monthly + R.gap.extraMonthly) };
}

function render(){
  const v = readInputs();
  const R = compute(v);
  $("contribYearsOut").textContent = `${v.contribYears} yrs`;
  $("retireYearsOut").textContent = `${v.retireYears} yrs`;
  $("yearsHint").textContent = R.yrs > 0 ? `${R.yrs} year${R.yrs===1?"":"s"} from now (${nowYear} → ${R.retireYearEff})` : "Retiring now.";
  $("warn").hidden = R.warns.length === 0; $("warn").textContent = R.warns.join(" ");
  $("contribYears").max = Math.max(40, Math.ceil(R.yrs));

  const contribEndYear = Math.round(nowYear + R.contribMonths/12);
  $("timeline").innerHTML =
    (R.contribMonths > 0 ? `<div class="tl save"><b>💰 ${nowYear}–${contribEndYear} · Saving</b>${fmt.format(v.monthlyContribution||0)}/mo for ${R.contribMonths/12} yrs</div>` : "") +
    (R.contribMonths/12 < R.yrs ? `<div class="tl coast"><b>🌿 ${contribEndYear}–${R.retireYearEff} · Coasting</b>No contributions — compounding only</div>` : "") +
    `<div class="tl spend"><b>🌅 ${R.retireYearEff}–${R.retireYearEff + (v.retireYears||0)} · Spending</b>${fmt.format(R.totalSpendToday)}/mo in today's $</div>`;

  $("vYears").textContent = v.retireYears;
  $("spendMonth").textContent = fmt.format(R.totalSpendToday);
  $("spendYear").textContent = fmt.format(R.totalSpendToday * 12);
  $("spendFirst").textContent = fmt.format(R.totalSpendToday * Math.pow(1 + R.san.inflation/100, R.yrs));
  $("portfolioSpend").textContent = fmt.format(R.portfolioSpendToday);
  $("portfolioSpendNote").textContent = R.incomeDelayMonths > 0 && R.incomeDelayMonths < (v.retireYears||0)*12 && (v.otherIncome||0) > 0 ? `/mo until ${R.retireYearEff + R.incomeDelayMonths/12}, then ${fmt.format(Math.max(0, R.totalSpendToday - (v.otherIncome||0)))}/mo` : "/mo today-$";
  $("otherSpend").textContent = fmt.format(v.otherIncome||0);
  $("otherSpendNote").textContent = R.incomeDelayMonths > 0 && (v.otherIncome||0) > 0 ? `/mo from ${R.retireYearEff + R.incomeDelayMonths/12}` : "/mo today-$";
  $("otherIncomeStartHint").textContent = !Number.isFinite(R.san.otherIncomeStartYear) || R.san.otherIncomeStartYear <= R.retireYearEff ? "Blank = starts at retirement, no bridge needed." : `Starts ${R.san.otherIncomeStartYear - R.retireYearEff} yr after retirement — portfolio funds all spending until ${R.san.otherIncomeStartYear}, then only the top-up.`;
  $("swr").textContent = R.potToday > 0 ? (R.portfolioSpendToday*12 / R.potToday * 100).toFixed(1) + "%" : "—";
  const scen = d => compute({ ...v, returnBefore: (v.returnBefore||0) + d, returnAfter: (v.returnAfter||0) + d }).totalSpendToday;
  $("scenLow").textContent = fmt.format(scen(-2)); $("scenBase").textContent = fmt.format(R.totalSpendToday); $("scenHigh").textContent = fmt.format(scen(2));
  $("potFuture").textContent = fmt.format(R.potFuture);
  $("potToday").textContent = `= ${fmt.format(R.potToday)} in today's dollars`;
  $("putIn").textContent = fmt.format((v.currentSavings||0) + R.totalContrib);
  $("putInDetail").textContent = `${fmt.format(v.currentSavings||0)} now + ${fmt.format(R.totalContrib)} contributed`;
  $("growthEarned").textContent = fmt.format(R.growthEarned);
  const bite = R.yrs > 0 ? (1 - 1/Math.pow(1 + R.san.inflation/100, R.yrs)) * 100 : 0;
  $("inflBite").textContent = bite.toFixed(1) + "%";
  $("inflBiteDetail").textContent = R.yrs > 0 ? `purchasing power lost over ${R.yrs}y at ${R.san.inflation}% inflation` : "—";

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
      $("currentSavings").value = lastBackfill.currentSavings;
      $("monthlyContribution").value = lastBackfill.monthlyContribution;
      render();
    } finally { resolving = false; }
    return;
  }
  const showBackfill = Number.isFinite(v.desiredSpend) && !!R.gap && R.gap.requiredPotToday > 0;
  $("backfillRow").hidden = !showBackfill;
  $("backfillMonthly").classList.toggle("active", backfillMode === "monthly");
  $("backfillSavings").classList.toggle("active", backfillMode === "savings");
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


  $("tbody").innerHTML = R.annual.map(a =>
    `<tr class="phase-${a.phase.toLowerCase()}"><td>${a.year}</td><td><span class="badge">${a.phase}</span></td><td>${fmt.format(a.start)}</td><td>${a.contrib?fmt.format(a.contrib):"—"}</td><td>${fmt.format(a.growth)}</td><td>${a.spent?fmt.format(a.spent):"—"}</td><td>${fmt.format(Math.max(a.end,0))}</td></tr>`).join("");

  chartData = {points: R.points, yrs: R.yrs, retireYear: R.retireYearEff, inflation: R.san.inflation/100};
  drawChart();
  save(v);
}

function drawChart(){
  if (!chartData) return;
  const cv = $("chart"), wrap = cv.parentElement, dpr = devicePixelRatio || 1;
  const W = wrap.clientWidth, H = 320;
  cv.width = W*dpr; cv.height = H*dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H);
  const pts = chartData.points.map(p => ({t:p.t, bal: basis==="today" ? p.bal/Math.pow(1+chartData.inflation,p.t) : p.bal,
                                                      cum: basis==="today" ? p.cumReal : p.cum}));
  const pad = {l:58, r:14, t:14, b:28}, iw = W-pad.l-pad.r, ih = H-pad.t-pad.b;
  const maxT = Math.max(...pts.map(p=>p.t), 1), maxV = Math.max(...pts.map(p=>p.bal), 1) * 1.08;
  const X = t => pad.l + t/maxT*iw, Y = val => pad.t + ih - val/maxV*ih;
  ctx.font = "11px system-ui"; ctx.fillStyle = "#66736b"; ctx.strokeStyle = "#e3e9e3";
  for (let i=0;i<=4;i++){ const val = maxV*i/4, y = Y(val); ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(W-pad.r,y); ctx.stroke(); ctx.fillText(compact(val), 6, y+4); }
  for (let yr=0; yr<=maxT; yr+=Math.max(1,Math.round(maxT/8))){ ctx.fillText(String(nowYear+yr), X(yr)-12, H-8); }
  // balance area, split at retirement
  const line = (key, color, dash) => { ctx.beginPath(); ctx.setLineDash(dash||[]); pts.forEach((p,i)=> i?ctx.lineTo(X(p.t),Y(p[key])):ctx.moveTo(X(p.t),Y(p[key]))); ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke(); ctx.setLineDash([]); };
  ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(X(p.t),Y(p.bal)):ctx.moveTo(X(p.t),Y(p.bal))); ctx.lineTo(X(maxT),Y(0)); ctx.lineTo(X(0),Y(0)); ctx.closePath(); ctx.fillStyle="rgba(14,122,95,.13)"; ctx.fill();
  line("bal", "#0e7a5f"); line("cum", "#e9a13b", [5,4]);
  ctx.beginPath(); pts.filter(p=>p.t>=chartData.yrs).forEach((p,i)=> i?ctx.lineTo(X(p.t),Y(p.bal)):ctx.moveTo(X(p.t),Y(p.bal))); ctx.strokeStyle="#c4553b"; ctx.lineWidth=2; ctx.stroke();
  const rx = X(chartData.yrs);
  ctx.beginPath(); ctx.setLineDash([4,4]); ctx.moveTo(rx,pad.t); ctx.lineTo(rx,pad.t+ih); ctx.strokeStyle="#c4553b"; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle="#c4553b"; ctx.fillText(`Retire ${chartData.retireYear}`, Math.min(rx+6, W-90), pad.t+12);
  cv._pts = pts; cv._geom = {X, Y, pad, maxT, maxV};
}
$("chart").addEventListener("mousemove", e => {
  const cv = e.currentTarget, tip = $("tooltip"); if (!cv._pts) return;
  const rect = cv.getBoundingClientRect(), x = e.clientX - rect.left;
  const {X} = cv._geom;
  let best = cv._pts[0], bd = 1e9;
  for (const p of cv._pts){ const d = Math.abs(X(p.t)-x); if (d<bd){bd=d;best=p;} }
  tip.hidden = false;
  tip.textContent = `${nowYear + Math.floor(best.t)}\nBalance: ${fmt.format(best.bal)}\nContributed: ${fmt.format(best.cum)}`;
  tip.style.left = Math.min(x+14, rect.width-150)+"px"; tip.style.top = "12px";
});
$("chart").addEventListener("mouseleave", () => $("tooltip").hidden = true);
$("basisToday").onclick = () => { basis="today"; $("basisToday").classList.add("active"); $("basisNominal").classList.remove("active"); drawChart(); };
$("basisNominal").onclick = () => { basis="nominal"; $("basisNominal").classList.add("active"); $("basisToday").classList.remove("active"); drawChart(); };

function save(v){ try{ localStorage.setItem("retireplan-v1", JSON.stringify(v)); }catch{} }
function apply(obj){ for (const f of FIELDS) if (obj[f] !== undefined && obj[f] !== null && !Number.isNaN(obj[f])) $(f).value = obj[f]; }
function load(){
  $("retireYear").value = nowYear + 10;
  try{
    if (location.hash.length > 1) apply(JSON.parse(decodeURIComponent(location.hash.slice(1))));
    else { const s = localStorage.getItem("retireplan-v1"); if (s) apply(JSON.parse(s)); }
  }catch{}
}
$("shareBtn").onclick = async () => {
  const url = location.href.split("#")[0] + "#" + encodeURIComponent(JSON.stringify(readInputs()));
  try{ await navigator.clipboard.writeText(url); $("shareBtn").textContent = "✓ Link copied"; }
  catch{ prompt("Copy your share link:", url); }
  setTimeout(() => $("shareBtn").textContent = "🔗 Copy share link", 1800);
};
$("resetBtn").onclick = () => { stickySolve = false; localStorage.removeItem("retireplan-v1"); apply({currentSavings:1000000, retireYear:nowYear+10, monthlyContribution:4000, contribYears:5, contribGrowth:0, returnBefore:7, returnAfter:4.5, inflation:2.5, retireYears:30, otherIncome:0, desiredEndAmount:0, desiredSpend:NaN}); $("desiredSpend").value=""; $("otherIncomeStartYear").value=""; render(); };
$("backfillBtn").onclick = () => { if (!lastBackfill) return; stickySolve = true; $("currentSavings").value = lastBackfill.currentSavings; $("monthlyContribution").value = lastBackfill.monthlyContribution; render(); };
$("backfillMonthly").onclick = () => { backfillMode = "monthly"; render(); };
$("backfillSavings").onclick = () => { backfillMode = "savings"; render(); };
document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  const [a, c] = b.dataset.preset.split(","); $("returnBefore").value = a; $("returnAfter").value = c; render();
});
$("returnBefore").addEventListener("input", () => document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("active")));
$("form").addEventListener("input", e => { if (["currentSavings","monthlyContribution","desiredSpend"].includes(e.target.id)) stickySolve = false; render(); });
addEventListener("resize", drawChart);
$("retireYear").max = nowYear + 60;
load(); render();
