"use strict";
const $ = id => document.getElementById(id);
const FIELDS = ["currentSavings","retireYear","monthlyContribution","contribStartYear","contribEndYear","contribGrowth","returnBefore","returnAfter","volBefore","volAfter","inflation","retireYears","mcSuccessTarget","otherIncome","otherIncomeStartYear","desiredEndAmount","desiredSpend","guardrailCut","guardrailEnabled","riskMinChange","riskCutStep","riskGuardEnabled"];
const MONEY_FIELDS = ["currentSavings","monthlyContribution","otherIncome","desiredEndAmount","desiredSpend"];
const nowYear = new Date().getFullYear();
const fmt = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const fmt2 = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2});
const compact = v => "$" + Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(v);
const mRate = annualPct => Math.pow(1 + annualPct/100, 1/12) - 1; // effective monthly

let basis = "today", chartData = null, lastBackfill = null, backfillMode = "monthly", stickySolve = false, resolving = false, sharedView = false, shareLinkFailed = false;
let chartView = "balance", showMC = true, lastMcVis = null;
let mcTimer = null, mcSeq = 0, mcCache = { key: null, value: null, has: false }, guardCache = { key: null, value: null, has: false }, riskCache = { key: null, value: null, has: false };

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
/** Reformat a money input in place, keeping the caret after the same digit/point it followed. */
function formatMoneyInput(input){
  const start = input.selectionStart, end = input.selectionEnd;
  const sigBefore = pos => pos === null || pos === undefined ? 0 : cleanMoney(input.value.slice(0, pos)).length;
  const startSig = sigBefore(start), endSig = sigBefore(end);
  const formatted = formatMoneyString(input.value);
  input.value = formatted;
  if (start === null || start === undefined) return;
  const caretFor = sig => { if (sig === 0) return 0; let seen = 0; for (let i = 0; i < formatted.length; i++) if (/[0-9.]/.test(formatted[i]) && ++seen === sig) return i + 1; return formatted.length; };
  input.setSelectionRange(caretFor(startSig), caretFor(endSig));
}
function readInputs(){
  const v = {};
  for (const f of FIELDS){
    if (f === "guardrailEnabled" || f === "riskGuardEnabled"){ v[f] = $(f).checked ? 1 : 0; continue; }
    const raw = $(f).value; v[f] = raw === "" ? NaN : parseFloat(String(raw).replace(/,/g, ""));
  }
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
    contribGrowth: clamp(num(raw.contribGrowth), -20, 50),
    returnBefore: clamp(num(raw.returnBefore), -50, 30), returnAfter: clamp(num(raw.returnAfter), -50, 30),
    volBefore: clamp(num(raw.volBefore), 0, 40), volAfter: clamp(num(raw.volAfter), 0, 40),
    mcSuccessTarget: Math.round(clamp(num(raw.mcSuccessTarget, 85), 1, 99)),
    guardrailCut: clamp(num(raw.guardrailCut, 10), 0, 50), guardrailEnabled: raw.guardrailEnabled ? 1 : 0,
    riskMinChange: clamp(num(raw.riskMinChange, 5), 0, 50), riskCutStep: clamp(num(raw.riskCutStep, 10), 1, 100), riskGuardEnabled: raw.riskGuardEnabled ? 1 : 0,
    inflation: clamp(num(raw.inflation), -10, 30) };
  const clamped = ["returnBefore","returnAfter","inflation","contribGrowth","volBefore","volAfter","mcSuccessTarget"].some(k => v[k] !== num(raw[k]));
  const warns = clamped ? ["Some assumptions were outside sane ranges and were clamped (−50%…30% returns, −10%…30% inflation, 0…40% volatility, 1…99% Monte Carlo success target)."] : [];
  if (v.retireYear !== retireYearIn) warns.push(`Retirement year is more than 60 years away — clamped to ${nowYear + 60}.`);
  const retireYearEff = Math.max(v.retireYear, nowYear);
  const yearsToRetire = retireYearEff - nowYear;
  if (v.retireYear < nowYear) warns.push("Retirement year is in the past — results below assume retiring now.");
  // Contribution window [start, end) in calendar years, on a today→retirement scale.
  // Contributions run for the months from the start year up to (not including) the end year.
  const startIn = Math.round(num(raw.contribStartYear, nowYear)), endIn = Math.round(num(raw.contribEndYear, retireYearEff));
  v.contribStartYear = clamp(startIn, nowYear, retireYearEff);
  v.contribEndYear = clamp(endIn, nowYear, retireYearEff);
  if (v.contribStartYear !== startIn || v.contribEndYear !== endIn) warns.push(`Contribution window (${startIn}–${endIn}) sits outside today–retirement (${nowYear}–${retireYearEff}) — capped to that range.`);
  if (v.contribEndYear < v.contribStartYear){ v.contribEndYear = v.contribStartYear; warns.push("Contribution end year was before its start year — set equal to the start year (no contributions)."); }
  const yrs = yearsToRetire;
  const monthsRet = Math.round(yrs * 12);
  const contribStartMonths = (v.contribStartYear - nowYear) * 12;
  const contribEndMonths = (v.contribEndYear - nowYear) * 12;
  const contribMonths = contribEndMonths - contribStartMonths;
  const rB = mRate(v.returnBefore), rA = mRate(v.returnAfter), inf = mRate(v.inflation);
  const inflAnnual = v.inflation/100;

  // Accumulation
  let bal = v.currentSavings||0, totalContrib = 0, totalContribReal = v.currentSavings||0;
  const points = [{t:0, bal, cum: bal, cumReal: bal}]; // yearly snapshots for chart
  for (let m = 0; m < monthsRet; m++){
    let c = 0;
    if (m >= contribStartMonths && m < contribEndMonths){ c = (v.monthlyContribution||0) * Math.pow(1 + (v.contribGrowth||0)/100, Math.floor((m - contribStartMonths)/12)); bal += c; totalContrib += c; totalContribReal += c / Math.pow(1+inf, m); }
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
      const potFor = extra => { let b = v.currentSavings; for (let m = 0; m < monthsRet; m++){ if (m >= contribStartMonths && m < contribEndMonths) b += (v.monthlyContribution + extra) * Math.pow(1 + v.contribGrowth/100, Math.floor((m - contribStartMonths)/12)); b *= 1 + rB; } return b; };
      const slope = potFor(1) - potFor(0);
      if (slope > 0) extraMonthly = (targetFuture - potFuture) / slope;
    }
    gap = { requiredPotToday, shortfallToday, extraMonthly, lumpToday };
  }
  return {warns, yrs, contribMonths, contribStartMonths, contribEndMonths, potFuture, potToday, growthEarned, totalContrib, retireYearEff, gap, san: v, incomeDelayMonths,
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
  const v = R.san, N = Math.round((v.retireYears||0) * 12), monthsRet = Math.round(R.yrs * 12);
  const contribAmt = new Float64Array(monthsRet), inflRet = new Float64Array(N);
  for (let m = 0; m < monthsRet; m++) contribAmt[m] = m >= R.contribStartMonths && m < R.contribEndMonths ? (v.monthlyContribution||0) * Math.pow(1 + (v.contribGrowth||0)/100, Math.floor((m - R.contribStartMonths)/12)) : 0;
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
  const successAt = s => { let n = 0; for (const x of sMax) if (x >= s - 1e-6) n++; return n / MC_TRIALS; };
  const bandPts = bands.map((vals, i) => { const s = Float64Array.from(vals).sort(); return {t: R.points[i].t, p10: mcQuantile(s, .1), p50: mcQuantile(s, .5), p90: mcQuantile(s, .9)}; });
  const deflate = yrs => Math.pow(1 + S.inflAnnual, yrs);
  return { trials: MC_TRIALS, success: successAt(S.spend), sMax: Array.from(sorted),
           successDesired: Number.isFinite(v.desiredSpend) ? successAt(Math.max(0, v.desiredSpend)) : null,
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
  const gSorted = Float64Array.from(gMax).sort(), gSuccessAt = s => { let n = 0; for (const x of gMax) if (x >= s - 1e-6) n++; return n / MC_TRIALS; };
  const endsSorted = Float64Array.from(endBalsG).sort(), deflate = yrs => Math.pow(1 + S.inflAnnual, yrs);
  return { cut: v.guardrailCut, success: gSuccessAt(S.spend),
    successDesired: Number.isFinite(v.desiredSpend) ? gSuccessAt(Math.max(0, v.desiredSpend)) : null,
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
  const rRealMC = R.rReal, annuityMC = months => months <= 0 ? 0 : Math.abs(rRealMC) < 1e-12 ? months : (1 + rRealMC) * (1 - Math.pow(1 + rRealMC, -months)) / rRealMC;
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

function syncPresets(){
  document.querySelectorAll("[data-preset]").forEach(b => {
    const [a, c, vb, va] = b.dataset.preset.split(",").map(Number);
    b.classList.toggle("active", Number($("returnBefore").value) === a && Number($("returnAfter").value) === c && Number($("volBefore").value) === vb && Number($("volAfter").value) === va);
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
function mcKeyFor(R){
  const s = { ...R.san };
  delete s.guardrailEnabled; delete s.guardrailCut; delete s.riskGuardEnabled; delete s.riskMinChange; delete s.riskCutStep;
  return JSON.stringify([s, R.yrs, R.contribMonths, R.incomeDelayMonths, R.totalSpendToday, R.cushionFuture]);
}
function guardKeyFor(R){ return mcKeyFor(R) + "|g:" + R.san.guardrailCut; }
function riskKeyFor(R){ return mcKeyFor(R) + "|r:" + R.san.riskMinChange + "," + R.san.riskCutStep; }
/** Animate a money headline from its previous value (D3 tween; instant if unchanged). */
function tweenMoney(el, value){
  if (!window.d3 || !Number.isFinite(value)){ el.textContent = fmt.format(value); el._v = value; return; }
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
    $("guardSuccess").textContent = "—"; $("guardSuccessNote").textContent = "enable guardrails to compare";
    $("guardSpend").textContent = "—"; $("guardSpendNote").textContent = "vs. without guardrails";
    $("guardCutShare").textContent = "—"; $("guardCutNote").textContent = "share of years, averaged across paths";
    return;
  }
  if (pending || !G){
    $("guardSuccess").textContent = "…"; $("guardSuccessNote").textContent = "calculating…";
    $("guardSpend").textContent = "…"; $("guardSpendNote").textContent = "calculating…";
    $("guardCutShare").textContent = "…"; $("guardCutNote").textContent = "calculating…";
    return;
  }
  const hasDesired = G.successDesired !== null, basePct = Math.round((hasDesired ? MC.successDesired : MC.success) * 100);
  $("guardSuccess").textContent = Math.round((hasDesired ? G.successDesired : G.success) * 100) + "%";
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
    $("riskSuccess").textContent = "—"; $("riskSuccessNote").textContent = "enable risk-based guardrails to compare";
    $("riskAvgSpend").textContent = "—"; $("riskAvgNote").textContent = "after annual adjustments, today-$";
    $("riskMinSpend").textContent = "—"; $("riskMinNote").textContent = "how deep the cuts get, today-$";
    return;
  }
  if (pending || !G){
    $("riskSuccess").textContent = "…"; $("riskSuccessNote").textContent = "calculating…";
    $("riskAvgSpend").textContent = "…"; $("riskAvgNote").textContent = "calculating…";
    $("riskMinSpend").textContent = "…"; $("riskMinNote").textContent = "calculating…";
    return;
  }
  const hasDesired = G.successDesired !== null, basePct = Math.round((hasDesired ? MC.successDesired : MC.success) * 100);
  $("riskSuccess").textContent = Math.round((hasDesired ? G.successDesired : G.success) * 100) + "%";
  $("riskSuccessNote").textContent = `vs. ${basePct}% without guardrails, of ${MC.trials.toLocaleString()} paths`;
  $("riskAvgSpend").textContent = fmt.format(G.avgSpendToday);
  $("riskAvgNote").textContent = `per month starting from ${fmt.format(testSpend)}/mo, after adjustments in ${Math.round(G.adjYearShare * 100)}% of years (cuts ${Math.round(G.cutYearShare * 100)}%, raises ${Math.round(G.raiseYearShare * 100)}%)`;
  $("riskMinSpend").textContent = fmt.format(G.minSpendMedian);
  $("riskMinNote").textContent = `lowest month on the median path · 10th-pct paths dip to ${fmt.format(G.minSpendP10)}/mo (starting from ${fmt.format(testSpend)}/mo)`;
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
  const hasDesired = MC.successDesired !== null, testSpend = mcTestSpend(R);
  $("mcSuccessLabel").textContent = `Chance ${fmt.format(testSpend)}/mo lasts ${v.retireYears} yrs`;
  $("mcSuccess").textContent = Math.round((hasDesired ? MC.successDesired : MC.success) * 100) + "%";
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
    const el = $(id); el.min = nowYear; el.max = R.retireYearEff; el.disabled = R.yrs === 0;
  }
  if (document.activeElement !== $("contribStartYear")) $("contribStartYear").value = s;
  if (document.activeElement !== $("contribEndYear")) $("contribEndYear").value = e;
  if (document.activeElement !== $("contribStartYearNum")) $("contribStartYearNum").value = s;
  if (document.activeElement !== $("contribEndYearNum")) $("contribEndYearNum").value = e;
  $("contribRange").style.setProperty("--lo", ((s - nowYear)/span*100) + "%");
  $("contribRange").style.setProperty("--hi", ((e - nowYear)/span*100) + "%");
  $("contribRangeOut").textContent = `${s} – ${e}`;
  const dur = R.contribMonths/12;
  $("contribRangeDur").textContent = dur > 0 ? `${dur} yr${dur === 1 ? "" : "s"} of contributions` : "No contributions";
}

function render(){
  const v = readInputs();
  const R = compute(v);
  syncPresets();
  syncContributionWindow(R);
  $("retireYearsOut").textContent = `${v.retireYears} yrs`;
  $("yearsHint").textContent = R.yrs > 0 ? `${R.yrs} year${R.yrs===1?"":"s"} from now (${nowYear} → ${R.retireYearEff})` : "Retiring now.";
  const warns = shareLinkFailed ? ["Couldn't read this share link — showing your saved plan instead. Your saved plan has not been changed.", ...R.warns] : R.warns;
  $("warn").hidden = warns.length === 0; $("warn").textContent = warns.join(" ");

  const cStart = R.san.contribStartYear, cEnd = R.san.contribEndYear;
  $("timeline").innerHTML =
    (R.contribMonths > 0 && R.contribStartMonths > 0 ? `<div class="tl coast"><b>🌿 ${nowYear}–${cStart} · Coasting</b><span>Contributions start in ${cStart} — compounding only until then</span></div>` : "") +
    (R.contribMonths > 0 ? `<div class="tl save"><b>💰 ${cStart}–${cEnd} · Saving</b><span>${fmt.format(v.monthlyContribution||0)}/mo for ${R.contribMonths/12} yrs</span></div>` : "") +
    (R.contribEndMonths < R.yrs * 12 ? `<div class="tl coast"><b>🌿 ${R.contribMonths > 0 ? cEnd : nowYear}–${R.retireYearEff} · Coasting</b><span>${R.contribMonths > 0 && (v.monthlyContribution||0) > 0 ? `Contributions stop in ${cEnd} — compounding only after that` : "No contributions — compounding only"}</span></div>` : "") +
    `<div class="tl spend"><b>🌅 ${R.retireYearEff}–${R.retireYearEff + (v.retireYears||0)} · Spending</b><span>${fmt.format(R.totalSpendToday)}/mo in today's $</span></div>`;

  $("vYears").textContent = v.retireYears;
  tweenMoney($("spendMonth"), R.totalSpendToday);
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
  { const vals = [scen(-2), R.totalSpendToday, scen(2)], mx = Math.max(...vals, 1);
    if (window.d3) ["scenLowBar","scenBaseBar","scenHighBar"].forEach((id, i) => d3.select("#"+id).transition().duration(450).ease(d3.easeCubicOut).style("width", (vals[i]/mx*100) + "%")); }
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
      apply(lastBackfill);
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


  chartData = {points: R.points, yrs: R.yrs, contribStartT: R.contribStartMonths/12, contribT: R.contribEndMonths/12, retireYear: R.retireYearEff, inflation: R.san.inflation/100, mc: MC ? MC.bands : null};
  drawChart();
  save(v);
}

function drawChart(animate = true){
  if (!chartData || !window.d3) return;
  const wrap = $("chart"), W = wrap.clientWidth || 600, H = W < 560 ? 280 : 340;
  const deflate = t => basis === "today" ? 1/Math.pow(1+chartData.inflation, t) : 1;
  const pts = chartData.points.map(p => ({ t: p.t, bal: p.bal * deflate(p.t), cum: 0, growth: 0 }));
  // Today-$: cumReal is already in today's dollars; future-$: nominal cum. Growth is the residual.
  chartData.points.forEach((p, i) => { pts[i].cum = basis === "today" ? p.cumReal : p.cum; pts[i].growth = pts[i].bal - pts[i].cum; });
  const mc = chartData.mc ? chartData.mc.map(p => ({ t: p.t, p10: p.p10 * deflate(p.t), p50: p.p50 * deflate(p.t), p90: p.p90 * deflate(p.t) })) : null;
  const m = { l: 58, r: 14, t: 22, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const maxT = Math.max(...pts.map(p => p.t), 1);
  const maxV = Math.max(...pts.map(p => p.bal), ...(showMC && mc ? mc.map(p => p.p90) : []), 1) * 1.08;
  const x = d3.scaleLinear().domain([0, maxT]).range([m.l, m.l + iw]);
  const y = d3.scaleLinear().domain([0, maxV]).range([m.t + ih, m.t]).nice();
  const svg = d3.select(wrap).selectAll("svg").data([null]).join("svg").attr("width", W).attr("height", H).attr("role", "img");
  const defs = svg.selectAll("defs").data([null]).join("defs");
  const grad = defs.selectAll("linearGradient#balGrad").data([null]).join("linearGradient").attr("id", "balGrad").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
  grad.selectAll("stop").data([[0, .28], [1, .02]]).join("stop").attr("offset", d => d[1] * 100 + "%").attr("stop-color", "#0e7a5f").attr("stop-opacity", d => d[1]);
  const tr = animate ? d3.transition().duration(500).ease(d3.easeCubicOut) : d3.transition().duration(0);
  const g = svg.selectAll("g.root").data([null]).join("g").attr("class", "root");
  // Phase bands: saving / coasting / spending
  const phases = [
    { x0: 0, x1: chartData.contribStartT, label: "🌿 Coasting", fill: "rgba(233,161,59,.10)" },
    { x0: chartData.contribStartT, x1: chartData.contribT, label: "💰 Saving", fill: "rgba(14,122,95,.07)" },
    { x0: chartData.contribT, x1: chartData.yrs, label: "🌿 Coasting", fill: "rgba(233,161,59,.10)" },
    { x0: chartData.yrs, x1: maxT, label: "🌅 Spending", fill: "rgba(196,85,59,.06)" }
  ].filter(p => p.x1 > p.x0);
  const ph = g.selectAll("g.phases").data([null]).join("g").attr("class", "phases");
  ph.selectAll("rect").data(phases).join("rect").transition(tr).attr("x", d => x(d.x0)).attr("width", d => Math.max(0, x(d.x1) - x(d.x0))).attr("y", m.t).attr("height", ih).attr("fill", d => d.fill);
  ph.selectAll("text").data(phases).join("text").attr("class", "phase-label").transition(tr).attr("x", d => x(d.x0) + 8).attr("y", m.t + 14).attr("opacity", d => x(d.x1) - x(d.x0) > 64 ? 1 : 0).text(d => d.label);
  // Axes + grid
  g.selectAll("g.axis-y").data([null]).join("g").attr("class", "axis-y grid").attr("transform", `translate(${m.l},0)`).transition(tr).call(d3.axisLeft(y).ticks(5).tickFormat(compact).tickSize(-iw));
  g.selectAll("g.axis-x").data([null]).join("g").attr("class", "axis-x").attr("transform", `translate(0,${m.t + ih})`).transition(tr).call(d3.axisBottom(x).ticks(Math.min(9, maxT)).tickFormat(t => nowYear + Math.round(t)));
  const lineBal = d3.line().x(d => x(d.t)).y(d => y(Math.max(0, d.bal))).curve(d3.curveMonotoneX);
  const areaBal = d3.area().x(d => x(d.t)).y0(y(0)).y1(d => y(Math.max(0, d.bal))).curve(d3.curveMonotoneX);
  const areaCum = d3.area().x(d => x(d.t)).y0(y(0)).y1(d => y(Math.max(0, Math.min(d.cum, d.bal)))).curve(d3.curveMonotoneX);
  const areaGrowth = d3.area().x(d => x(d.t)).y0(d => y(Math.max(0, Math.min(d.cum, d.bal)))).y1(d => y(Math.max(0, d.bal))).curve(d3.curveMonotoneX);
  const areaMC = d3.area().x(d => x(d.t)).y0(d => y(Math.max(0, d.p10))).y1(d => y(Math.max(0, d.p90))).curve(d3.curveMonotoneX);
  const comp = chartView === "composition";
  const P = (sel, cls) => g.selectAll("path." + cls).data([null]).join("path").attr("class", cls);
  P(null, "mc-band").attr("fill", "rgba(23,33,27,.10)").attr("stroke", "none").transition(tr).attr("d", showMC && mc ? areaMC(mc) : areaMC(pts.map(p => ({ t: p.t, p10: 0, p90: 0 })))).attr("opacity", showMC && mc && !comp ? 1 : 0);
  P(null, "bal-area").attr("fill", "url(#balGrad)").transition(tr).attr("d", areaBal(pts)).attr("opacity", comp ? 0 : 1);
  P(null, "cum-area").attr("fill", "rgba(233,161,59,.45)").transition(tr).attr("d", areaCum(pts)).attr("opacity", comp ? 1 : 0);
  P(null, "growth-area").attr("fill", "rgba(14,122,95,.45)").transition(tr).attr("d", areaGrowth(pts)).attr("opacity", comp ? 1 : 0);
  P(null, "mc-median").attr("fill", "none").attr("stroke", "#17211b").attr("stroke-width", 1.5).attr("stroke-dasharray", "6 4").transition(tr).attr("d", showMC && mc ? lineBal(mc.map(d => ({ t: d.t, bal: d.p50 }))) : lineBal(pts.map(p => ({ t: p.t, bal: 0 })))).attr("opacity", showMC && mc && !comp ? 1 : 0);
  P(null, "cum-line").attr("fill", "none").attr("stroke", "#e9a13b").attr("stroke-width", 2).transition(tr).attr("d", lineBal(pts.map(p => ({ t: p.t, bal: p.cum })))).attr("opacity", comp ? 1 : 0);
  P(null, "bal-line").attr("fill", "none").attr("stroke", "#0e7a5f").attr("stroke-width", 2.5).transition(tr).attr("d", lineBal(pts));
  P(null, "spend-line").attr("fill", "none").attr("stroke", "#c4553b").attr("stroke-width", 2.5).transition(tr).attr("d", lineBal(pts.filter(p => p.t >= chartData.yrs)));
  // Retirement marker
  const mk = g.selectAll("g.retire-mark").data([null]).join("g").attr("class", "retire-mark");
  mk.selectAll("line").data([null]).join("line").transition(tr).attr("x1", x(chartData.yrs)).attr("x2", x(chartData.yrs)).attr("y1", m.t).attr("y2", m.t + ih).attr("stroke", "#c4553b").attr("stroke-dasharray", "4 4");
  mk.selectAll("text").data([null]).join("text").attr("class", "retire-label").transition(tr).attr("x", Math.min(x(chartData.yrs) + 6, W - 92)).attr("y", m.t + ih - 8).text(`Retire ${chartData.retireYear}`);
  // Crosshair + hover overlay
  const ch = g.selectAll("g.cross").data([null]).join("g").attr("class", "cross").attr("opacity", 0);
  ch.selectAll("line").data([null]).join("line").attr("y1", m.t).attr("y2", m.t + ih).attr("stroke", "#17211b").attr("stroke-opacity", .35);
  ch.selectAll("circle").data([null]).join("circle").attr("r", 5).attr("fill", "#0e7a5f").attr("stroke", "#fff").attr("stroke-width", 2);
  const tip = $("tooltip");
  g.selectAll("rect.overlay").data([null]).join("rect").attr("class", "overlay").attr("x", m.l).attr("y", m.t).attr("width", iw).attr("height", ih).attr("fill", "transparent")
    .on("mousemove", function(event){
      const [px] = d3.pointer(event), t = x.invert(px);
      let bi = 0, bd = 1e9; pts.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd){ bd = d; bi = i; } });
      const p = pts[bi], phase = p.t < chartData.yrs && p.t >= chartData.contribStartT && p.t < chartData.contribT ? "Saving" : p.t < chartData.yrs ? "Coasting" : "Spending";
      ch.attr("opacity", 1); ch.select("line").attr("x1", x(p.t)).attr("x2", x(p.t)); ch.select("circle").attr("cx", x(p.t)).attr("cy", y(Math.max(0, p.bal)));
      tip.hidden = false;
      tip.textContent = `${nowYear + Math.floor(p.t)} · ${phase}\nBalance: ${fmt.format(p.bal)}\nContributed: ${fmt.format(p.cum)}\nBalance vs contributed: ${fmt.format(p.growth)}` + (showMC && mc && mc[bi] ? `\nSimulated median: ${fmt.format(mc[bi].p50)}\nSimulated 10–90%: ${fmt.format(mc[bi].p10)} – ${fmt.format(mc[bi].p90)}` : "");
      const rect = wrap.getBoundingClientRect();
      tip.style.left = Math.min(x(p.t) + 14, Math.max(0, rect.width - 180)) + "px"; tip.style.top = "12px";
    })
    .on("mouseleave", () => { ch.attr("opacity", 0); tip.hidden = true; });
}

/** Monte Carlo histogram: sustainable spend per simulated path, headline + success-target markers. */
function drawMcChart(MC, R, animate = true){
  if (!window.d3) return;
  if (MC && R) lastMcVis = { MC, R }; if (!MC) lastMcVis = null;
  const svgEl = $("mcChart"), wrapEl = svgEl.parentElement, W = svgEl.clientWidth || wrapEl.clientWidth || 600, H = 190;
  const svg = d3.select(svgEl).attr("width", W).attr("height", H);
  if (!MC || !MC.sMax){ svg.selectAll("*").remove(); svg.append("text").attr("x", 8).attr("y", 24).attr("class", "mc-wait").text("Calculating 1,000 simulated paths…"); return; }
  const vals = MC.sMax.map(v => Number.isFinite(v) ? Math.max(0, v) : 0);
  const desiredSpend = Number.isFinite(R.san.desiredSpend) ? Math.max(0, R.san.desiredSpend) : null;
  const testSpend = desiredSpend ?? R.totalSpendToday;
  const cap = Math.max(d3.quantile(vals.slice().sort(d3.ascending), .99) || 1, R.totalSpendToday, testSpend, MC.spendAtTarget, 1);
  const m = { l: 34, r: 22, t: 20, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scaleLinear().domain([0, cap]).range([m.l, m.l + iw]);
  const bins = d3.bin().domain(x.domain()).thresholds(36)(vals.map(v => Math.min(v, cap)));
  const y = d3.scaleLinear().domain([0, d3.max(bins, d => d.length) || 1]).range([m.t + ih, m.t]).nice();
  const tr = animate ? d3.transition().duration(500).ease(d3.easeCubicOut) : d3.transition().duration(0);
  svg.selectAll("text.mc-wait").remove();
  svg.selectAll("g.axis-y").data([null]).join("g").attr("class", "axis-y grid").attr("transform", `translate(${m.l},0)`).transition(tr).call(d3.axisLeft(y).ticks(3).tickSize(-iw));
  svg.selectAll("g.axis-x").data([null]).join("g").attr("class", "axis-x").attr("transform", `translate(0,${m.t + ih})`).transition(tr).call(d3.axisBottom(x).ticks(6).tickFormat(compact));
  const tip = $("mcTooltip");
  svg.selectAll("rect.bin").data(bins).join("rect").attr("class", "bin")
    .attr("x", d => x(d.x0) + 1).attr("width", d => Math.max(0, x(d.x1) - x(d.x0) - 1))
    .attr("fill", d => d.x1 <= testSpend ? "rgba(196,85,59,.65)" : "rgba(14,122,95,.75)")
    .on("mousemove", function(event, d){ tip.hidden = false; tip.textContent = `${compact(d.x0)}–${compact(d.x1)}/mo\n${d.length} paths (${(d.length/vals.length*100).toFixed(1)}%)`; const r = wrapEl.getBoundingClientRect(); tip.style.left = Math.min(event.clientX - r.left + 12, r.width - 150) + "px"; tip.style.top = "8px"; })
    .on("mouseleave", () => { tip.hidden = true; })
    .transition(tr).attr("y", d => y(d.length)).attr("height", d => y(0) - y(d.length));
  const marker = (cls, val, label, dash, anchor, labelDy = 4) => {
    const g = svg.selectAll("g." + cls).data(val <= cap ? [val] : []).join("g").attr("class", cls);
    g.selectAll("line").data([null]).join("line").transition(tr).attr("x1", x(val)).attr("x2", x(val)).attr("y1", m.t).attr("y2", m.t + ih).attr("stroke", "#17211b").attr("stroke-width", 1.5).attr("stroke-dasharray", dash);
    g.selectAll("text").data([null]).join("text").attr("class", "mc-mark-label").attr("text-anchor", anchor).transition(tr).attr("x", x(val) + (anchor === "end" ? -5 : 5)).attr("y", m.t + labelDy).text(label);
  };
  marker("mark-head", R.totalSpendToday, `Headline ${compact(R.totalSpendToday)}`, "none", R.totalSpendToday > cap * .7 ? "end" : "start");
  if (desiredSpend !== null && Math.abs(desiredSpend - R.totalSpendToday) > 1)
    marker("mark-desired", desiredSpend, `Desired ${compact(desiredSpend)}`, "2 3", desiredSpend > cap * .7 ? "end" : "start", 17);
  else svg.selectAll("g.mark-desired").remove();
  marker("mark-target", MC.spendAtTarget, `${MC.successTarget}% ${compact(MC.spendAtTarget)}`, "5 4", MC.spendAtTarget > cap * .7 ? "end" : "start");
  $("mcChartCap").textContent = desiredSpend !== null
    ? "Distribution of the monthly spending each simulated path could sustain — bars left of the desired line are paths where your desired spending runs short."
    : "Distribution of the monthly spending each simulated path could sustain — bars left of the headline line are paths where it runs short.";
}
$("basisToday").onclick = () => { basis="today"; $("basisToday").classList.add("active"); $("basisNominal").classList.remove("active"); drawChart(); };
$("basisNominal").onclick = () => { basis="nominal"; $("basisNominal").classList.add("active"); $("basisToday").classList.remove("active"); drawChart(); };
$("viewBalance").onclick = () => { chartView="balance"; $("viewBalance").classList.add("active"); $("viewComposition").classList.remove("active"); $("legendContrib").hidden = true; $("legendGrowth").hidden = true; drawChart(); };
$("viewComposition").onclick = () => { chartView="composition"; $("viewComposition").classList.add("active"); $("viewBalance").classList.remove("active"); $("legendContrib").hidden = false; $("legendGrowth").hidden = false; drawChart(); };
document.querySelectorAll(".lg[data-series='mc']").forEach(el => el.addEventListener("click", () => {
  showMC = !showMC;
  document.querySelectorAll(".lg[data-series='mc']").forEach(n => n.classList.toggle("off", !showMC));
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
