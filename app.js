"use strict";
const $ = id => document.getElementById(id);
const FIELDS = ["currentSavings","retireYear","monthlyContribution","contribYears","contribGrowth","returnBefore","returnAfter","inflation","retireYears","otherIncome","desiredSpend"];
const nowYear = new Date().getFullYear();
const fmt = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const fmt2 = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2});
const compact = v => "$" + Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}).format(v);
const mRate = annualPct => Math.pow(1 + annualPct/100, 1/12) - 1; // effective monthly

let basis = "today", chartData = null, lastBackfill = null, backfillMode = "monthly";

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
  const v = { ...raw,
    currentSavings: Math.max(0, num(raw.currentSavings)), monthlyContribution: Math.max(0, num(raw.monthlyContribution)),
    otherIncome: Math.max(0, num(raw.otherIncome)), desiredSpend: raw.desiredSpend,
    retireYear: Math.round(num(raw.retireYear, nowYear)), retireYears: clamp(num(raw.retireYears), 0, 60),
    contribYears: clamp(num(raw.contribYears), 0, 60), contribGrowth: clamp(num(raw.contribGrowth), -20, 50),
    returnBefore: clamp(num(raw.returnBefore), -50, 30), returnAfter: clamp(num(raw.returnAfter), -50, 30),
    inflation: clamp(num(raw.inflation), -10, 30) };
  const clamped = ["returnBefore","returnAfter","inflation","contribGrowth"].some(k => v[k] !== num(raw[k]));
  const warns = clamped ? ["Some assumptions were outside sane ranges and were clamped (−50%…30% returns, −10%…30% inflation)."] : [];
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

  // Sustainable level real spending from the pot (annuity-due in real terms)
  const N = Math.round((v.retireYears||0) * 12);
  const rReal = (1 + rA) / (1 + inf) - 1;
  let portfolioSpendToday; // per month, today's dollars
  if (N <= 0) portfolioSpendToday = 0;
  else if (Math.abs(rReal) < 1e-12) portfolioSpendToday = potToday / N;
  else portfolioSpendToday = potToday * rReal / ((1 + rReal) * (1 - Math.pow(1 + rReal, -N)));
  const totalSpendToday = portfolioSpendToday + (v.otherIncome||0);

  // Drawdown simulation (nominal) using the solved spend; spending indexed to inflation from today
  cur = null;
  for (let m = 0; m < N; m++){
    const calYear = retireYearEff + Math.floor(m/12);
    if (!cur || cur.year !== calYear) pushYear(calYear, "Spending");
    const wToday = portfolioSpendToday; // real, constant
    const wNominal = wToday * Math.pow(1+inf, monthsRet + m);
    bal -= wNominal; cur.spent += wNominal;
    const g = bal * rA; bal += g; cur.growth += g; cur.end = bal;
    if ((m+1) % 12 === 0 || m === N-1) points.push({t: yrs + (m+1)/12, bal: Math.max(bal, 0), cum:(v.currentSavings||0)+totalContrib, cumReal: totalContribReal});
  }

  // Desired-spending longevity (portfolio funds desired − other income)
  let desiredMonths = null;
  if (Number.isFinite(v.desiredSpend)){
    const needToday = Math.max(0, v.desiredSpend - (v.otherIncome||0));
    let b = potFuture; desiredMonths = 0;
    if (needToday <= 0) desiredMonths = Infinity;
    else while (desiredMonths < 1200){
      const w = needToday * Math.pow(1+inf, monthsRet + desiredMonths);
      if (b < w) break;
      b = (b - w) * (1 + rA); desiredMonths++;
    }
  }
  // Gap solver: what pot does the desired spend need, and what closes any shortfall?
  // potFor() mirrors the accumulation loop above (same contribution formula) for extra monthly amounts.
  let gap = null;
  if (Number.isFinite(v.desiredSpend) && N > 0){
    const needToday = Math.max(0, v.desiredSpend - v.otherIncome);
    if (needToday <= 0) gap = { needToday, requiredPotToday: 0, shortfallToday: -potToday, extraMonthly: 0, lumpToday: 0 };
    else {
      // Invert the annuity-due directly (not pot × need ÷ sustainable) so a $0 pot still gets an answer.
      const requiredPotToday = Math.abs(rReal) < 1e-12 ? needToday * N
        : needToday * (1 + rReal) * (1 - Math.pow(1 + rReal, -N)) / rReal;
      const shortfallToday = requiredPotToday - potToday;
      // Signed on purpose: negative means "trim this much" — back-fill adjusts both ways.
      // potFor() is linear in `extra`, so one slope gives the exact signed delta (no bisection).
      const targetFuture = requiredPotToday * Math.pow(1 + inflAnnual, yrs);
      const lumpToday = (targetFuture - potFuture) / Math.pow(1 + rB, monthsRet);
      let extraMonthly = 0;
      if (contribMonths > 0){
        const potFor = extra => { let b = v.currentSavings; for (let m = 0; m < monthsRet; m++){ if (m < contribMonths) b += v.monthlyContribution * Math.pow(1 + v.contribGrowth/100, Math.floor(m/12)) + extra; b *= 1 + rB; } return b; };
        const slope = potFor(1) - potFor(0);
        if (slope > 0) extraMonthly = (targetFuture - potFuture) / slope;
      }
      gap = { needToday, requiredPotToday, shortfallToday, extraMonthly, lumpToday };
    }
  }
  return {warns, yrs, contribMonths, potFuture, potToday, growthEarned, totalContrib, retireYearEff, gap, san: v,
          portfolioSpendToday, totalSpendToday, annual, points, desiredMonths, rReal};
}

/** Plan that rewrites savings/contributions so sustainable spending meets the desired level, in
 *  either direction: mode "monthly" adjusts contributions, "savings" adjusts current savings
 *  (toggle in the form). Rounded up to the nearest $10 so rounding can't reopen a gap; floored at $0. */
function backfillPlan(R, mode){
  if (!R.gap || R.gap.needToday <= 0) return null;
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
  $("otherSpend").textContent = fmt.format(v.otherIncome||0);
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
    if (R.desiredMonths === Infinity) msg = `✅ Your desired ${fmt.format(v.desiredSpend)}/mo is fully covered by other income — the pot is untouched.`;
    else if (R.desiredMonths >= (v.retireYears||0)*12) msg = `✅ Desired ${fmt.format(v.desiredSpend)}/mo (today's $) lasts ${(R.desiredMonths/12).toFixed(1)} years — covers your ${v.retireYears}-year retirement with room to spare.`;
    else msg = `⚠️ Desired ${fmt.format(v.desiredSpend)}/mo (today's $) runs out after ${(R.desiredMonths/12).toFixed(1)} years of retirement — ${(v.retireYears - R.desiredMonths/12).toFixed(1)} years short. Sustainable level is ${fmt.format(R.totalSpendToday)}/mo.`;
    if (R.gap && R.gap.needToday > 0){
      if (R.gap.shortfallToday > 0) msg += ` To fund it fully you'd need a ${fmt.format(R.gap.requiredPotToday)} pot (today-$) — a ${fmt.format(R.gap.shortfallToday)} shortfall. Close it with ${R.gap.extraMonthly > 0 ? `~${fmt.format(R.gap.extraMonthly)}/mo extra during your contribution phase, or ` : ""}${fmt.format(Math.max(0, R.gap.lumpToday))} as a lump sum today.`;
      else msg += ` It needs a ${fmt.format(R.gap.requiredPotToday)} pot (today-$); you'll have ${fmt.format(R.potToday)} — a ${fmt.format(-R.gap.shortfallToday)} cushion.`;
    }
    dOut.textContent = msg;
  } else dOut.hidden = true;
  // Button never disables or relabels: adjusting the target up or down and re-pressing is the
  // intended workflow, so it stays armed while a portfolio-funded desired spend is entered.
  lastBackfill = backfillPlan(R, backfillMode);
  const showBackfill = Number.isFinite(v.desiredSpend) && !!R.gap && R.gap.needToday > 0;
  $("backfillRow").hidden = !showBackfill;
  $("backfillMonthly").classList.toggle("active", backfillMode === "monthly");
  $("backfillSavings").classList.toggle("active", backfillMode === "savings");
  if (lastBackfill){
    const parts = [];
    if (lastBackfill.currentSavings !== R.san.currentSavings) parts.push(`savings ${fmt.format(R.san.currentSavings)} → ${fmt.format(lastBackfill.currentSavings)}`);
    if (lastBackfill.monthlyContribution !== R.san.monthlyContribution) parts.push(`monthly ${fmt.format(R.san.monthlyContribution)} → ${fmt.format(lastBackfill.monthlyContribution)}`);
    if (!parts.length) $("backfillHint").textContent = R.totalSpendToday > v.desiredSpend + 1
      ? `Can't trim to ${fmt.format(v.desiredSpend)}/mo with this lever alone — it still funds ${fmt.format(R.totalSpendToday)}/mo at $0. Switch the toggle to trim the other input.`
      : `Already funding ${fmt.format(v.desiredSpend)}/mo — change the target or the toggle, then press again.`;
    else {
      $("backfillHint").textContent = `Would set ${parts.join(" · ")} so sustainable spending meets ${fmt.format(v.desiredSpend)}/mo. Nothing changes until you press the button.`;
      if (R.gap.shortfallToday < 0){ // trimming: warn if the chosen lever alone can't get down to the target
        const funded = compute({ ...v, ...lastBackfill }).totalSpendToday;
        if (funded > v.desiredSpend + 1) $("backfillHint").textContent += ` Even at $0 it still funds ${fmt.format(funded)}/mo — the other input alone covers more than this target.`;
      }
    }
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
$("resetBtn").onclick = () => { localStorage.removeItem("retireplan-v1"); apply({currentSavings:1000000, retireYear:nowYear+10, monthlyContribution:4000, contribYears:5, contribGrowth:0, returnBefore:7, returnAfter:4.5, inflation:2.5, retireYears:30, otherIncome:0, desiredSpend:NaN}); $("desiredSpend").value=""; render(); };
$("backfillBtn").onclick = () => { if (!lastBackfill) return; $("currentSavings").value = lastBackfill.currentSavings; $("monthlyContribution").value = lastBackfill.monthlyContribution; render(); };
$("backfillMonthly").onclick = () => { backfillMode = "monthly"; render(); };
$("backfillSavings").onclick = () => { backfillMode = "savings"; render(); };
document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  const [a, c] = b.dataset.preset.split(","); $("returnBefore").value = a; $("returnAfter").value = c; render();
});
$("returnBefore").addEventListener("input", () => document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("active")));
$("form").addEventListener("input", render);
addEventListener("resize", drawChart);
load(); render();
