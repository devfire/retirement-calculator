"use strict";
/* Pure financial core: no DOM. Browser: populates window.RP (classic script,
   file://-safe). Node: require() returns RP (see test/core.test.js). */
const RP = (typeof window !== "undefined" ? window : globalThis).RP ||
  ((typeof window !== "undefined" ? window : globalThis).RP = {});
(function (RP) {
const FIELDS = ["currentSavings","retireYear","monthlyContribution","contribStartYear","contribEndYear","contribGrowth","returnBefore","returnAfter","volBefore","volAfter","inflation","retireYears","mcSuccessTarget","otherIncome","otherIncomeStartYear","desiredEndAmount","desiredSpend","guardrailCut","guardrailEnabled","riskMinChange","riskCutStep","riskGuardEnabled"];
const MONEY_FIELDS = ["currentSavings","monthlyContribution","otherIncome","desiredEndAmount","desiredSpend"];
const nowDate = new Date();
const nowYear = nowDate.getFullYear();
const nowMonth = nowDate.getMonth(); // 0=Jan; simulation starts at the start of the current month
// Retirement and year boundaries are Jan 1 of the named year. Months (not
// whole years) avoid overstating late-year horizons by nearly a year.
const monthsUntilJan = year => Math.max(0, (year - nowYear) * 12 - nowMonth);
const yearAt = t => nowYear + Math.floor((nowMonth + Math.round(t * 12)) / 12);
const monthsLabel = months => { const m = Math.round(months); if (m <= 0) return "0 months"; const y = Math.floor(m / 12), r = m % 12; if (y === 0) return `${r} month${r === 1 ? "" : "s"}`; if (r === 0) return `${y} year${y === 1 ? "" : "s"}`; return `${y} year${y === 1 ? "" : "s"} ${r} month${r === 1 ? "" : "s"}`; };
const fmt = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const fmt2 = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2});
const compact = v => "$" + Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(v);
const mRate = annualPct => Math.pow(1 + annualPct/100, 1/12) - 1; // effective monthly
/** PV (today-$ at retirement) of $1/mo real, paid at start of each month for `months` months at real monthly rate rReal. */
const annuityDueFor = (rReal, months) => months <= 0 ? 0 : Math.abs(rReal) < 1e-12 ? months : (1 + rReal) * (1 - Math.pow(1 + rReal, -months)) / rReal;
/** Contribution in month m: monthly amount escalating growthPct%/yr from the window start; 0 outside [startMonths, endMonths). */
const contribAt = (monthly, growthPct, m, startMonths, endMonths) => m >= startMonths && m < endMonths ? (monthly || 0) * Math.pow(1 + (growthPct || 0) / 100, Math.floor((m - startMonths) / 12)) : 0;
/** Share of simulated paths whose maximum sustainable spend reaches `spend`. */
const successRate = (arr, spend) => { let n = 0; for (const x of arr) if (x >= spend - 1e-6) n++; return arr.length ? n / arr.length : 0; };
/** Nominal→today-$ divisor for a Monte Carlo setup: (1+inflation)^yrs. */
const deflatorFor = S => yrs => Math.pow(1 + S.inflAnnual, yrs);
/** Keep only digits and the first decimal point (commas, $, spaces, letters dropped). */
function cleanMoney(s){
  let out = "", dot = false;
  for (const ch of String(s)) if (ch >= "0" && ch <= "9") out += ch; else if (ch === "." && !dot){ out += ch; dot = true; }
  return out;
}
/** Group the integer part in thousands; fractional part (incl. a trailing "." or "0") stays as typed. */
function formatMoneyString(value){
  const clean = cleanMoney(value);
  if (!clean) return "";
  const dot = clean.indexOf(".");
  const intPart = dot === -1 ? clean : clean.slice(0, dot);
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dot === -1 ? "" : "." + clean.slice(dot + 1));
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
    contribGrowth: clamp(num(raw.contribGrowth), -20, 50),
    returnBefore: clamp(num(raw.returnBefore), -50, 30), returnAfter: clamp(num(raw.returnAfter), -50, 30),
    volBefore: clamp(num(raw.volBefore), 0, 40), volAfter: clamp(num(raw.volAfter), 0, 40),
    mcSuccessTarget: Math.round(clamp(num(raw.mcSuccessTarget, 85), 1, 99)),
    guardrailCut: clamp(num(raw.guardrailCut, 10), 0, 50), guardrailEnabled: raw.guardrailEnabled ? 1 : 0,
    riskMinChange: clamp(num(raw.riskMinChange, 5), 0, 50), riskCutStep: clamp(num(raw.riskCutStep, 10), 1, 100), riskGuardEnabled: raw.riskGuardEnabled ? 1 : 0,
    inflation: clamp(num(raw.inflation), -10, 30) };
  const clampRanges = { returnBefore:[-50,30], returnAfter:[-50,30], inflation:[-10,30], contribGrowth:[-20,50], volBefore:[0,40], volAfter:[0,40], mcSuccessTarget:[1,99], guardrailCut:[0,50], riskMinChange:[0,50], riskCutStep:[1,100], retireYears:[0,60] };
  // Warn only on an actual clamp: a blank (non-finite) input falls back to its
  // default silently, and in-range rounding (e.g. a fractional MC target) is not clamping.
  const clamped = Object.entries(clampRanges).some(([k, [lo, hi]]) => Number.isFinite(raw[k]) && (raw[k] < lo || raw[k] > hi));
  const warns = clamped ? ["Some assumptions were outside sane ranges and were clamped (−50%…30% returns, −10%…30% inflation, −20%…50% contribution growth, 0…40% volatility, 1…99% Monte Carlo success target, 0…50% guardrail cuts, 1…100% risk step, 0…60 retirement years)."] : [];
  if (v.retireYear !== retireYearIn) warns.push(`Retirement year is more than 60 years away — clamped to ${nowYear + 60}.`);
  const retireYearEff = Math.max(v.retireYear, nowYear);
  if (v.retireYear < nowYear) warns.push("Retirement year is in the past — results below assume retiring now.");
  // "Today" is the start of the current month; retirement is Jan 1 of the
  // retirement year. Months (not whole years) keep late-year horizons honest.
  const monthsRet = monthsUntilJan(retireYearEff);
  const yrs = monthsRet / 12; // fractional years: deflation and chart use this
  // Contribution window [start, end) in calendar years, on a today→retirement scale.
  // Contributions run from Jan 1 of the start year (or today if that is this year)
  // up to (not including) Jan 1 of the end year.
  const startIn = Math.round(num(raw.contribStartYear, nowYear)), endIn = Math.round(num(raw.contribEndYear, retireYearEff));
  v.contribStartYear = clamp(startIn, nowYear, retireYearEff);
  v.contribEndYear = clamp(endIn, nowYear, retireYearEff);
  if (v.contribStartYear !== startIn || v.contribEndYear !== endIn) warns.push(`Contribution window (${startIn}–${endIn}) sits outside today–retirement (${nowYear}–${retireYearEff}) — capped to that range.`);
  if (v.contribEndYear < v.contribStartYear){ v.contribEndYear = v.contribStartYear; warns.push("Contribution end year was before its start year — set equal to the start year (no contributions)."); }
  const contribStartMonths = monthsUntilJan(v.contribStartYear);
  const contribEndMonths = monthsUntilJan(v.contribEndYear);
  const contribMonths = contribEndMonths - contribStartMonths;
  const rB = mRate(v.returnBefore), rA = mRate(v.returnAfter), inf = mRate(v.inflation);
  const inflAnnual = v.inflation/100;

  // Accumulation
  let bal = v.currentSavings||0, totalContrib = 0, totalContribReal = v.currentSavings||0;
  const points = [{t:0, bal, cum: bal, cumReal: bal}]; // yearly snapshots for chart
  for (let m = 0; m < monthsRet; m++){
    let c = 0;
    if (m >= contribStartMonths && m < contribEndMonths){ c = contribAt(v.monthlyContribution, v.contribGrowth, m, contribStartMonths, contribEndMonths); bal += c; totalContrib += c; totalContribReal += c / Math.pow(1+inf, m); }
    const g = bal * rB; bal += g;
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
  const annuityDue = months => annuityDueFor(rReal, months);
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
  for (let m = 0; m < N; m++){
    const wToday = m < incomeDelayMonths ? totalSpendToday : Math.max(0, totalSpendToday - otherIncome); // real portfolio withdrawal
    const wNominal = wToday * Math.pow(1+inf, monthsRet + m);
    bal -= wNominal;
    const g = bal * rA; bal += g;
    if ((m+1) % 12 === 0 || m === N-1) points.push({t: yrs + (m+1)/12, bal: Math.max(bal, 0), cum:(v.currentSavings||0)+totalContrib, cumReal: totalContribReal});
  }

  // Desired-spending longevity (portfolio funds desired, minus other income once it starts)
  let desiredMonths = null;
  if (Number.isFinite(v.desiredSpend)){
    const desiredToday = Math.max(0, v.desiredSpend);
    let b = potFuture; desiredMonths = 0;
    if (incomeDelayMonths <= 0 && desiredToday <= otherIncome) desiredMonths = Infinity;
    else {
      // The cushion is due only at the end of the horizon, not at every month-end:
      // with a positive real return the pot can sit below the cushion's face value
      // early on and still grow into it (its PV, cushionPVToday, is what the solver
      // reserves). So pay spending until the money runs out, and report the longest
      // horizon whose end balance still meets the cushion. Checking every month-end
      // and stopping at the first dip reported 0 months for fully funded plans.
      let cushionMonths = cushionToday > 0 ? 0 : null;
      while (desiredMonths < 1200){
        const needToday = desiredMonths < incomeDelayMonths ? desiredToday : Math.max(0, desiredToday - otherIncome);
        const w = needToday * Math.pow(1+inf, monthsRet + desiredMonths);
        if (b < w) break;
        b = (b - w) * (1 + rA); desiredMonths++;
        if (cushionToday > 0 && b >= cushionToday * Math.pow(1+inf, monthsRet + desiredMonths) - 1) cushionMonths = desiredMonths;
      }
      if (cushionMonths !== null) desiredMonths = cushionMonths;
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
      const potFor = extra => { let b = v.currentSavings; for (let m = 0; m < monthsRet; m++){ b += contribAt(v.monthlyContribution + extra, v.contribGrowth, m, contribStartMonths, contribEndMonths); b *= 1 + rB; } return b; };
      const slope = potFor(1) - potFor(0);
      if (slope > 0) extraMonthly = (targetFuture - potFuture) / slope;
    }
    gap = { requiredPotToday, shortfallToday, extraMonthly, lumpToday };
  }
  return {warns, yrs, monthsRet, contribMonths, contribStartMonths, contribEndMonths, potFuture, potToday, growthEarned, totalContrib, retireYearEff, gap, san: v, incomeDelayMonths,
          portfolioSpendToday, totalSpendToday, points, desiredMonths, rReal, cushionToday, cushionFuture, cushionPVToday, endBalanceFuture: N > 0 ? bal : potFuture};
}
/** Monte Carlo: 1,000 seeded (therefore stable while typing) monthly paths. Monthly gross
 *  returns are lognormal, calibrated so the MEDIAN compounded return equals the entered
 *  growth rate — the deterministic plan above is the middle path. Per trial, balances are
 *  affine in the level total spend S (portfolio withdrawal is S during any other-income
 *  bridge, S − income afterwards), so tracking coefficients A − S·B through retirement
 *  gives that trial's exact maximum sustainable S from two passes' worth of constraints:
 *  never overdraw a month, and finish at or above the end cushion. That yields success
 *  rates at any spend and the spend at any success target with no bisection. Two affine
 *  regimes are tracked because after other income starts the withdrawal floors at $0
 *  when S ≤ income; the low regime governs exactly when its own maximum stays below it.
 *  The guardrail strategies are NOT part of this baseline: they replay the identical
 *  seeded paths in guardrailMC/riskGuardrailMC below, so toggling them never changes
 *  (or recomputes) a single headline number. */
const MC_TRIALS = 1000;
const mcQuantile = (arr, q) => arr[Math.min(arr.length-1, Math.max(0, Math.floor(q * arr.length)))];
function makeGauss(){
  let state = 0x9e3779b9, spare = null;
  const rng = () => { state |= 0; state = state + 0x6D2B79F5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return () => { if (spare !== null){ const s = spare; spare = null; return s; } let u = 0, w = 0, r = 0; do { u = 2*rng()-1; w = 2*rng()-1; r = u*u + w*w; } while (r >= 1 || r === 0); const m = Math.sqrt(-2*Math.log(r)/r); spare = w*m; return u*m; };
}
/** Per-month constants shared by the baseline and both strategy replays. */
function mcSetup(R){
  const v = R.san, N = Math.round((v.retireYears||0) * 12), monthsRet = R.monthsRet ?? Math.round(R.yrs * 12);
  const contribAmt = new Float64Array(monthsRet), inflRet = new Float64Array(N);
  for (let m = 0; m < monthsRet; m++) contribAmt[m] = contribAt(v.monthlyContribution, v.contribGrowth, m, R.contribStartMonths, R.contribEndMonths);
  for (let m = 0; m < N; m++) inflRet[m] = Math.pow(1 + v.inflation/100, (monthsRet + m)/12);
  return { v, N, monthsRet, contribAmt, inflRet, delay: R.incomeDelayMonths, income: v.otherIncome||0,
           spend: R.totalSpendToday, inflAnnual: v.inflation/100,
           muB: Math.log(1 + v.returnBefore/100)/12, sigB: (v.volBefore||0)/100/Math.sqrt(12),
           muA: Math.log(1 + v.returnAfter/100)/12, sigA: (v.volAfter||0)/100/Math.sqrt(12) };
}
/** Accumulation phase of one seeded path (draws consumed in the same order as monteCarlo). */
function accumulateToRetirement(S, gauss){
  let bal = S.v.currentSavings||0, prodB = 1, lastYearProd = null;
  for (let m = 0; m < S.monthsRet; m++){
    bal += S.contribAmt[m];
    const gB = Math.exp(S.muB + S.sigB * gauss()); bal *= gB; prodB *= gB;
    if ((m+1) % 12 === 0){ lastYearProd = prodB; prodB = 1; }
  }
  // A partial final year (today's month offsets retirement from Jan) is the last
  // pre-retirement year too: its raw product's sign is the annualized sign.
  if (S.monthsRet > 0 && S.monthsRet % 12 !== 0) lastYearProd = prodB;
  return { balRetire: bal, priorDown: lastYearProd !== null && lastYearProd < 1 }; // last pre-retirement year down → first retirement year is a cut year
}
const guardIsActive = R => !!R.san.guardrailEnabled && (R.san.guardrailCut||0) > 0;
function monteCarlo(R){
  const S = mcSetup(R), v = S.v, N = S.N;
  if (N <= 0) return null;
  const gauss = makeGauss();
  const sMax = new Float64Array(MC_TRIALS);
  const bands = R.points.map(() => []); // nominal balance at each chart point, under the headline spend
  for (let trial = 0; trial < MC_TRIALS; trial++){
    let bal = v.currentSavings||0, bi = 0;
    bands[bi++].push(bal);
    for (let m = 0; m < S.monthsRet; m++){
      bal += S.contribAmt[m];
      bal *= Math.exp(S.muB + S.sigB * gauss());
      if ((m+1) % 12 === 0 || m === S.monthsRet-1) bands[bi++].push(bal);
    }
    // Retirement: A/S·B coefficients for the high regime (S ≥ income) and low regime (S ≤ income),
    // plus the actual balance path under the headline spend for the chart bands.
    let aH = bal, bH = 0, aL = bal, bL = 0, maxH = Infinity, maxL = Infinity;
    for (let m = 0; m < N; m++){
      const inflF = S.inflRet[m], g = Math.exp(S.muA + S.sigA * gauss()), bridged = m >= S.delay;
      maxH = Math.min(maxH, (aH + (bridged ? S.income * inflF : 0)) / (bH + inflF));
      const denL = bL + (bridged ? 0 : inflF);
      if (denL > 0) maxL = Math.min(maxL, aL / denL); else if (aL < 0) maxL = -Infinity;
      aH = (aH + (bridged ? S.income * inflF : 0)) * g; bH = (bH + inflF) * g;
      aL *= g; if (!bridged) bL = (bL + inflF) * g; else bL *= g;
      const w = (bridged ? Math.max(0, S.spend - S.income) : S.spend) * inflF;
      bal = bal < w ? 0 : (bal - w) * g;
      if ((m+1) % 12 === 0 || m === N-1) bands[bi++].push(bal);
    }
    if (bH > 0) maxH = Math.min(maxH, (aH - R.cushionFuture) / bH);
    if (bL > 0) maxL = Math.min(maxL, (aL - R.cushionFuture) / bL);
    sMax[trial] = S.income > 0 && maxL < S.income ? maxL : maxH;
  }
  const sorted = Float64Array.from(sMax).sort();
  const successAt = s => successRate(sMax, s);
  const bandPts = bands.map((vals, i) => { const s = Float64Array.from(vals).sort(); return {t: R.points[i].t, p10: mcQuantile(s, .1), p50: mcQuantile(s, .5), p90: mcQuantile(s, .9)}; });
  const deflate = deflatorFor(S);
  return { trials: MC_TRIALS, success: successAt(S.spend), sMax: Array.from(sorted),
           spendAtTarget: Math.max(0, mcQuantile(sorted, 1 - v.mcSuccessTarget/100)), successTarget: v.mcSuccessTarget,
           medianEndToday: bandPts[bandPts.length-1].p50 / deflate(R.yrs + (v.retireYears||0)),
           p10EndToday: bandPts[bandPts.length-1].p10 / deflate(R.yrs + (v.retireYears||0)), bands: bandPts, guardrail: null, riskGuardrail: null };
}
/** Down-year guardrail, replayed on the same seeded paths. Guardrailed spend is
 *  path-dependent (cut factor depends on prior-year returns), so no affine shortcut:
 *  bisect each path's exact maximum level spend S. Withdrawals are monotone in S,
 *  so success is monotone and bisection is exact to ~$1. */
function guardrailMC(R){
  const S = mcSetup(R), v = S.v, N = S.N;
  if (N <= 0 || !guardIsActive(R)) return null;
  const gauss = makeGauss(), cutFrac = v.guardrailCut/100;
  const gMax = new Float64Array(MC_TRIALS), endBalsG = new Float64Array(MC_TRIALS);
  let guardCutYears = 0, guardYearsTotal = 0;
  for (let trial = 0; trial < MC_TRIALS; trial++){
    const { balRetire, priorDown } = accumulateToRetirement(S, gauss);
    const gRet = new Float64Array(N), factorRet = new Float64Array(N);
    let balG = balRetire, yearProd = 1, prevDown = false, curFactor = 1;
    for (let m = 0; m < N; m++){
      const g = Math.exp(S.muA + S.sigA * gauss());
      if (m % 12 === 0){ const isCut = m === 0 ? priorDown : prevDown; curFactor = isCut ? 1 - cutFrac : 1; if (isCut) guardCutYears++; guardYearsTotal++; }
      gRet[m] = g; factorRet[m] = curFactor;
      const wG = (m >= S.delay ? Math.max(0, S.spend * curFactor - S.income) : S.spend * curFactor) * S.inflRet[m];
      balG = balG < wG ? 0 : (balG - wG) * g;
      yearProd *= g; if ((m+1) % 12 === 0){ prevDown = yearProd < 1; yearProd = 1; }
    }
    endBalsG[trial] = balG;
    const simG = Sv => { let b = balRetire; for (let m = 0; m < N; m++){ const total = Sv * factorRet[m], pw = m >= S.delay ? Math.max(0, total - S.income) : total, w = pw * S.inflRet[m]; if (b < w - 1e-6) return false; b = (b - w) * gRet[m]; } return b >= R.cushionFuture - 1e-6; };
    if (!simG(0)) gMax[trial] = -1;
    else { let lo = 0, hi = Math.max(1, S.spend, S.income); while (simG(hi) && hi < 1e8) hi *= 2; for (let it = 0; it < 24; it++){ const mid = (lo + hi)/2; if (simG(mid)) lo = mid; else hi = mid; } gMax[trial] = lo; }
  }
  const gSorted = Float64Array.from(gMax).sort(), gSuccessAt = s => successRate(gMax, s);
  const endsSorted = Float64Array.from(endBalsG).sort(), deflate = deflatorFor(S);
  return { cut: v.guardrailCut, success: gSuccessAt(S.spend),
    spendAtTarget: Math.max(0, mcQuantile(gSorted, 1 - v.mcSuccessTarget/100)),
    medianEndToday: mcQuantile(endsSorted, .5) / deflate(R.yrs + (v.retireYears||0)),
    cutYearShare: guardYearsTotal > 0 ? guardCutYears / guardYearsTotal : 0, sMax: Array.from(gSorted) };
}
/** Risk-based guardrails, replayed on the same seeded paths. Run only once the baseline
 *  distribution exists: the annual re-solve targets the spend supportable at the success
 *  target, not the median spend. The median re-solve is haircut by kFull at the full
 *  horizon, fading to no haircut as the remaining horizon shrinks
 *  (k = 1 − (1−kFull)·√(months left / N)) — raising to the median would reset every
 *  good year to a coin-flip and collapse success. Re-solve uses the entered real return
 *  from then on (no look-ahead at the path's future returns). */
function riskGuardrailMC(R, spendAtTargetBase){
  const S = mcSetup(R), v = S.v, N = S.N;
  if (N <= 0 || !v.riskGuardEnabled) return null;
  const gauss = makeGauss();
  const rbMinFrac = (v.riskMinChange||0)/100, rbCutStepFrac = (v.riskCutStep||0)/100;
  const rbEndBals = new Float64Array(MC_TRIALS), rbMinSpends = new Float64Array(MC_TRIALS);
  let rbSuccHead = 0, rbSuccDes = 0, rbSpendSum = 0, rbAdjYears = 0, rbCutYears = 0, rbRaiseYears = 0, rbAnnivTotal = 0;
  const rRealMC = R.rReal, annuityMC = months => annuityDueFor(rRealMC, months);
  const solveSpendMC = (spendable, bridge, total) => { const pvB = annuityMC(bridge), pvT = annuityMC(total), pvA = pvT - pvB; if (pvT <= 0) return 0; if (S.income <= 0) return spendable / pvT; const cand = (spendable + S.income * pvA) / pvT; return cand >= S.income ? cand : (pvB > 0 ? spendable / pvB : cand); };
  const rbKFull = S.spend > 0 ? Math.min(1, Math.max(0, spendAtTargetBase / S.spend)) : 1, kFull = rbKFull;
  for (let trial = 0; trial < MC_TRIALS; trial++){
    const { balRetire } = accumulateToRetirement(S, gauss);
    const gRet = new Float64Array(N);
    for (let m = 0; m < N; m++) gRet[m] = Math.exp(S.muA + S.sigA * gauss());
    const simR = S0 => {
      let b = balRetire, cur = S0, failed = false, spendSum = 0, minSpend = Infinity, adj = 0, cuts = 0, raises = 0, anniv = 0;
      for (let m = 0; m < N; m++){
        const bridged = m >= S.delay;
        if (!failed && m > 0 && m % 12 === 0){
          anniv++;
          const Mrem = N - m, k = 1 - (1 - kFull) * Math.sqrt(Mrem / N);
          const St = k * solveSpendMC(Math.max(0, b / S.inflRet[m] - R.cushionToday * Math.pow(1 + rRealMC, -Mrem)), Math.min(Math.max(S.delay - m, 0), Mrem), Mrem);
          if (cur <= 0){ if (St > 0){ cur = St; raises++; adj++; } }
          else if (St > cur * (1 + rbMinFrac)){ cur = St; raises++; adj++; }
          else if (St < cur * (1 - rbMinFrac)){ cur = Math.max(0, cur + rbCutStepFrac * (St - cur)); cuts++; adj++; }
        }
        if (failed){ const paid = bridged ? S.income : 0; spendSum += paid; if (paid < minSpend) minSpend = paid; continue; }
        const w = (bridged ? Math.max(0, cur - S.income) : cur) * S.inflRet[m];
        if (b < w - 1e-6){ failed = true; const paid = bridged ? S.income : 0; spendSum += paid; if (paid < minSpend) minSpend = paid; b = 0; continue; }
        b = (b - w) * gRet[m]; spendSum += cur; if (cur < minSpend) minSpend = cur;
      }
      return { success: !failed && b >= R.cushionFuture - 1e-6, spendSum, minSpend: Number.isFinite(minSpend) ? minSpend : 0, endBal: b, adj, cuts, raises, anniv };
    };
    const stHead = simR(S.spend); if (stHead.success) rbSuccHead++;
    let stTest = stHead;
    if (Number.isFinite(v.desiredSpend)){ const stDes = simR(Math.max(0, v.desiredSpend)); if (stDes.success) rbSuccDes++; stTest = stDes; }
    rbSpendSum += stTest.spendSum; rbEndBals[trial] = stTest.endBal; rbMinSpends[trial] = stTest.minSpend;
    rbAdjYears += stTest.adj; rbCutYears += stTest.cuts; rbRaiseYears += stTest.raises; rbAnnivTotal += stTest.anniv;
  }
  const rbEnds = Float64Array.from(rbEndBals).sort(), rbMins = Float64Array.from(rbMinSpends).sort(), deflate = yrs => Math.pow(1 + S.inflAnnual, yrs);
  return { minChange: v.riskMinChange, cutStep: v.riskCutStep, haircut: rbKFull, success: rbSuccHead / MC_TRIALS,
    successDesired: Number.isFinite(v.desiredSpend) ? rbSuccDes / MC_TRIALS : null,
    avgSpendToday: rbSpendSum / (MC_TRIALS * N),
    minSpendMedian: mcQuantile(rbMins, .5), minSpendP10: mcQuantile(rbMins, .1),
    medianEndToday: Math.max(0, mcQuantile(rbEnds, .5) / deflate(R.yrs + (v.retireYears||0))),
    adjYearShare: rbAnnivTotal > 0 ? rbAdjYears / rbAnnivTotal : 0,
    cutYearShare: rbAnnivTotal > 0 ? rbCutYears / rbAnnivTotal : 0,
    raiseYearShare: rbAnnivTotal > 0 ? rbRaiseYears / rbAnnivTotal : 0 };
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
function mcKeyFor(R){
  const s = { ...R.san };
  delete s.guardrailEnabled; delete s.guardrailCut; delete s.riskGuardEnabled; delete s.riskMinChange; delete s.riskCutStep; delete s.desiredSpend;
  return JSON.stringify([s, R.yrs, R.contribMonths, R.incomeDelayMonths, R.totalSpendToday, R.cushionFuture]);
}
/** Success rate at `spend` from a cached sorted sMax/gMax distribution (baseline or
 *  down-year guardrail). Cheap O(trials) count, so desiredSpend stays out of their
 *  cache keys: typing it reuses the paths instead of re-running the simulation.
 *  The risk replay keeps desiredSpend in its key — its path dynamics depend on it. */
function successAtSpend(sMax, spend){ return successRate(sMax, spend); }
function desiredSuccess(sMax, R){ return Number.isFinite(R.san.desiredSpend) ? successAtSpend(sMax, Math.max(0, R.san.desiredSpend)) : null; }
function guardKeyFor(R){ return mcKeyFor(R) + "|g:" + R.san.guardrailCut; }
function riskKeyFor(R){ return mcKeyFor(R) + "|r:" + R.san.riskMinChange + "," + R.san.riskCutStep + "," + R.san.desiredSpend; }
/** Share format v1: values in FIELDS order, comma-joined, blanks empty, trailing
 *  blanks dropped — e.g. #v1:1000000,2036,5000,2026,2031,… Append new fields to
 *  FIELDS only at the end, or bump the prefix. */
function encodeShare(v){
  const parts = FIELDS.map(f => Number.isFinite(v[f]) ? String(v[f]) : "");
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return "v1:" + parts.join(",");
}
function decodeShare(hash){
  const raw = hash.slice(1);
  if (raw.startsWith("v1:")){
    const parts = raw.slice(3).split(",");
    if (parts.length > FIELDS.length) throw new Error("bad share link");
    const o = {};
    parts.forEach((p, i) => { if (p === "") return; const n = Number(p); if (!Number.isFinite(n)) throw new Error("bad share link"); o[FIELDS[i]] = n; });
    if (!Object.keys(o).length) throw new Error("bad share link");
    return o;
  }
  // Pre-v1 links: #<encodeURIComponent(JSON.stringify(plan))>. Keep only known
  // numeric fields (plus contribYears, which apply() migrates to a window).
  const parsed = JSON.parse(decodeURIComponent(raw));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad share link");
  const o = {};
  for (const f of [...FIELDS, "contribYears"]) if (typeof parsed[f] === "boolean") o[f] = parsed[f] ? 1 : 0; else if (Number.isFinite(parsed[f])) o[f] = parsed[f];
  if (!Object.keys(o).length) throw new Error("bad share link");
  return o;
}
Object.assign(RP, { FIELDS, MONEY_FIELDS, nowYear, nowMonth, monthsUntilJan, yearAt, monthsLabel, fmt, fmt2, compact, cleanMoney, formatMoneyString,
  compute, monteCarlo, guardrailMC, riskGuardrailMC, backfillPlan, encodeShare, decodeShare,
  successAtSpend, desiredSuccess, makeGauss, mcSetup, accumulateToRetirement, mcQuantile, mcKeyFor, guardKeyFor, riskKeyFor, guardIsActive, MC_TRIALS, annuityDueFor, contribAt, successRate });
})(RP);
if (typeof module !== "undefined" && module.exports) module.exports = RP;
