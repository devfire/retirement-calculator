// Automated tests for the financial core (issue #8).
// Run: node --test   (no deps; core is require()d directly from app.js —
// app.js guards browser-only wiring and exports the pure functions).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FIELDS, nowYear, compute, monteCarlo, guardrailMC, riskGuardrailMC,
  backfillPlan, encodeShare, decodeShare, successAtSpend, makeGauss, mcSetup,
} = require("../app.js");

const base = (over = {}) => ({
  currentSavings: 1_000_000, retireYear: nowYear + 10, monthlyContribution: 4000,
  contribStartYear: nowYear, contribEndYear: nowYear + 5, contribGrowth: 0,
  returnBefore: 7, returnAfter: 4.5, volBefore: 14, volAfter: 9, inflation: 2.5,
  retireYears: 30, mcSuccessTarget: 85, otherIncome: 0, desiredEndAmount: 0,
  desiredSpend: NaN, guardrailCut: 10, guardrailEnabled: 0, riskMinChange: 5,
  riskCutStep: 10, riskGuardEnabled: 0, ...over,
});

// README worked example, date-robust: exact months vary with the current
// month, so assert the published figures within a small tolerance for a
// gross-regression check plus the stable ordering invariants below.
test("worked example: $1M + $4k/mo x 5y matches README figures", () => {
  const r = compute(base());
  assert.ok(Math.abs(r.totalSpendToday - 6370) / 6370 < 0.07,
    `sustainable spend ${r.totalSpendToday}`);
  assert.ok(Math.abs(r.potFuture - 2_184_265) / 2_184_265 < 0.07,
    `future pot ${r.potFuture}`);
  assert.ok(r.potFuture > r.potToday);
  assert.ok(r.totalContrib === r.contribMonths * 4000);
});

test("back-fill hits the desired spend exactly (monthly + savings modes)", () => {
  for (const mode of ["monthly", "savings"]) {
    const r = compute(base({ desiredSpend: 8000 }));
    const plan = backfillPlan(r, mode);
    assert.ok(plan, `${mode} plan exists`);
    const after = compute(base({ ...plan, desiredSpend: 8000 }));
    assert.ok(after.totalSpendToday >= 8000 - 1e-6,
      `${mode}: sustainable ${after.totalSpendToday} must cover 8000`);
    assert.ok(after.desiredMonths >= 360,
      `${mode}: desired spend lasts the full horizon (${after.desiredMonths})`);
  }
});

test("shortfall <= 0 implies longevity reaches the horizon", () => {
  const r = compute(base({ desiredSpend: 1000 }));
  assert.ok(r.gap.shortfallToday <= 0);
  assert.ok(r.desiredMonths >= r.san.retireYears * 12);
});

test("share encode/decode round-trips and rejects bad links", () => {
  const v = base();
  const back = decodeShare("#" + encodeShare(v));
  for (const f of FIELDS) {
    if (Number.isFinite(v[f])) assert.equal(back[f], v[f], f);
    else assert.equal(back[f], undefined, f);
  }
  assert.throws(() => decodeShare("#v1:1,2,bad"), /bad share link/);
  assert.throws(() => decodeShare("#v1:"), /bad share link/);
  assert.throws(() => decodeShare("#%7Bbad"), SyntaxError);
});

test("compute() never returns NaN for extreme inputs", () => {
  const extremes = [
    { currentSavings: -1e9, returnBefore: 500, returnAfter: -500, inflation: -50 },
    { returnBefore: NaN, returnAfter: NaN, inflation: NaN, retireYears: 999 },
    { retireYear: nowYear - 5, monthlyContribution: -100, retireYears: 0 },
    { retireYear: nowYear + 200, volBefore: 999, volAfter: -5, contribGrowth: 500 },
    { currentSavings: NaN, monthlyContribution: NaN, desiredSpend: NaN, otherIncome: NaN },
  ];
  for (const over of extremes) {
    const r = compute(base(over));
    for (const k of ["totalSpendToday", "potFuture", "potToday", "growthEarned", "endBalanceFuture"]) {
      assert.ok(Number.isFinite(r[k]), `${k} finite for ${JSON.stringify(over)}: ${r[k]}`);
    }
    assert.ok(!Number.isNaN(r.desiredMonths), "desiredMonths not NaN");
  }
});

// Independent brute-force check of monteCarlo()'s analytic per-path maximum:
// replay the same seeded paths and bisect each path's exact sustainable
// spend, then compare the sorted distributions.
test("monteCarlo analytic sMax matches brute-force bisection", () => {
  const R = compute(base({
    retireYears: 20, contribGrowth: 3, otherIncome: 1200,
    otherIncomeStartYear: nowYear + 12, desiredEndAmount: 50_000,
  }));
  const mc = monteCarlo(R);
  assert.equal(mc.trials, 1000);
  const S = mcSetup(R);
  const gauss = makeGauss(); // same seed/order as monteCarlo()
  const brute = [];
  for (let trial = 0; trial < mc.trials; trial++) {
    let bal = S.v.currentSavings;
    const gB = new Float64Array(S.monthsRet);
    for (let m = 0; m < S.monthsRet; m++) { bal += S.contribAmt[m]; bal *= (gB[m] = Math.exp(S.muB + S.sigB * gauss())); }
    const gA = new Float64Array(S.N);
    for (let m = 0; m < S.N; m++) gA[m] = Math.exp(S.muA + S.sigA * gauss());
    const balRetire = bal;
    const ok = (spend) => {
      let b = balRetire;
      for (let m = 0; m < S.N; m++) {
        const w = (m >= S.delay ? Math.max(0, spend - S.income) : spend) * S.inflRet[m];
        if (b < w - 1e-6) return false;
        b = (b - w) * gA[m];
      }
      return b >= R.cushionFuture - 1e-6;
    };
    if (!ok(0)) { brute.push(-1); continue; }
    let lo = 0, hi = Math.max(1, S.spend, S.income);
    while (ok(hi) && hi < 1e8) hi *= 2;
    for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    brute.push(lo);
  }
  brute.sort((a, b) => a - b);
  for (let i = 0; i < brute.length; i++) {
    assert.ok(Math.abs(brute[i] - mc.sMax[i]) < 1.0,
      `trial ${i}: bisection ${brute[i]} vs analytic ${mc.sMax[i]}`);
  }
  assert.ok(Math.abs(successAtSpend(mc.sMax, mc.spendAtTarget) - mc.successTarget / 100) < 0.01);
});

test("guardrail + risk-guardrail replays stay finite and in [0,1]", () => {
  const R = compute(base({ guardrailEnabled: 1, riskGuardEnabled: 1, retireYears: 15 }));
  const mc = monteCarlo(R);
  const g = guardrailMC(R);
  assert.ok(g && g.success >= 0 && g.success <= 1 && Number.isFinite(g.spendAtTarget));
  assert.equal(guardrailMC(compute(base())), null);
  const rk = riskGuardrailMC(R, mc.spendAtTarget);
  assert.ok(rk && rk.success >= 0 && rk.success <= 1 && Number.isFinite(rk.avgSpendToday));
});
