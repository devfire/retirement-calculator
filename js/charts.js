"use strict";
/* D3 charts: balance-over-time + Monte Carlo histogram. Uses shared ui.js globals. */
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
  const retirePt = pts.reduce((best, p) => Math.abs(p.t - chartData.yrs) < Math.abs(best.t - chartData.yrs) ? p : best, pts[0]);
  const chartSummary = `Portfolio balance chart (${basis === "today" ? "today's" : "future"} dollars). Balance at retirement (${chartData.retireYear}): ${fmt.format(retirePt.bal)}; final balance (${yearAt(maxT)}): ${fmt.format(pts[pts.length - 1].bal)}.`;
  const cs = $("chartSummary"); if (cs) cs.textContent = chartSummary;
  const svg = d3.select(wrap).selectAll("svg").data([null]).join("svg").attr("width", W).attr("height", H).attr("role", "img").attr("aria-label", chartSummary);
  const defs = svg.selectAll("defs").data([null]).join("defs");
  const grad = defs.selectAll("linearGradient#balGrad").data([null]).join("linearGradient").attr("id", "balGrad").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
  grad.selectAll("stop").data([[0, .28], [1, .02]]).join("stop").attr("offset", d => d[1] * 100 + "%").attr("stop-color", "#0e7a5f").attr("stop-opacity", d => d[1]);
  const tr = (animate && !prefersReducedMotion()) ? d3.transition().duration(500).ease(d3.easeCubicOut) : d3.transition().duration(0);
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
  g.selectAll("g.axis-x").data([null]).join("g").attr("class", "axis-x").attr("transform", `translate(0,${m.t + ih})`).transition(tr).call(d3.axisBottom(x).ticks(Math.min(9, maxT)).tickFormat(t => yearAt(t)));
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
  const findBi = t => { let bi = 0, bd = 1e9; pts.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd){ bd = d; bi = i; } }); return bi; };
  const showTip = bi => {
    const p = pts[bi], phase = p.t < chartData.yrs && p.t >= chartData.contribStartT && p.t < chartData.contribT ? "Saving" : p.t < chartData.yrs ? "Coasting" : "Spending";
    ch.attr("opacity", 1); ch.select("line").attr("x1", x(p.t)).attr("x2", x(p.t)); ch.select("circle").attr("cx", x(p.t)).attr("cy", y(Math.max(0, p.bal)));
    tip.hidden = false;
    tip.textContent = `${yearAt(p.t)} · ${phase}\nBalance: ${fmt.format(p.bal)}\nContributed: ${fmt.format(p.cum)}\nBalance vs contributed: ${fmt.format(p.growth)}` + (showMC && mc && mc[bi] ? `\nSimulated median: ${fmt.format(mc[bi].p50)}\nSimulated 10–90%: ${fmt.format(mc[bi].p10)} – ${fmt.format(mc[bi].p90)}` : "");
    const rect = wrap.getBoundingClientRect();
    tip.style.left = Math.min(x(p.t) + 14, Math.max(0, rect.width - 180)) + "px"; tip.style.top = "12px";
  };
  const hideTip = () => { ch.attr("opacity", 0); tip.hidden = true; };
  g.selectAll("rect.overlay").data([null]).join("rect").attr("class", "overlay").attr("x", m.l).attr("y", m.t).attr("width", iw).attr("height", ih).attr("fill", "transparent").attr("tabindex", 0).attr("aria-label", chartSummary)
    .on("mousemove", function(event){ showTip(findBi(x.invert(d3.pointer(event)[0]))); })
    .on("touchmove", function(event){ showTip(findBi(x.invert(d3.pointer(event)[0]))); })
    .on("focus", () => showTip(findBi(chartData.yrs)))
    .on("mouseleave", hideTip)
    .on("touchend", hideTip)
    .on("blur", hideTip);
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
  const tr = (animate && !prefersReducedMotion()) ? d3.transition().duration(500).ease(d3.easeCubicOut) : d3.transition().duration(0);
  svg.attr("aria-label", `Monte Carlo histogram: distribution of sustainable monthly spending across 1,000 simulated paths. Headline line ${compact(R.totalSpendToday)}; ${MC.successTarget}% success line at ${compact(MC.spendAtTarget)}.`);
  svg.selectAll("text.mc-wait").remove();
  svg.selectAll("g.axis-y").data([null]).join("g").attr("class", "axis-y grid").attr("transform", `translate(${m.l},0)`).transition(tr).call(d3.axisLeft(y).ticks(3).tickSize(-iw));
  svg.selectAll("g.axis-x").data([null]).join("g").attr("class", "axis-x").attr("transform", `translate(0,${m.t + ih})`).transition(tr).call(d3.axisBottom(x).ticks(6).tickFormat(compact));
  const tip = $("mcTooltip");
  const binLabel = d => `${compact(d.x0)}–${compact(d.x1)} per month: ${d.length} paths (${(d.length/vals.length*100).toFixed(1)}%)`;
  const showBinTip = (d, left) => { tip.hidden = false; tip.textContent = `${compact(d.x0)}–${compact(d.x1)}/mo\n${d.length} paths (${(d.length/vals.length*100).toFixed(1)}%)`; const r = wrapEl.getBoundingClientRect(); tip.style.left = Math.min(left, Math.max(0, r.width - 150)) + "px"; tip.style.top = "8px"; };
  svg.selectAll("rect.bin").data(bins).join("rect").attr("class", "bin")
    .attr("x", d => x(d.x0) + 1).attr("width", d => Math.max(0, x(d.x1) - x(d.x0) - 1))
    .attr("fill", d => d.x1 <= testSpend ? "rgba(196,85,59,.65)" : "rgba(14,122,95,.75)")
    .attr("tabindex", 0).attr("role", "img").attr("aria-label", binLabel)
    .on("mousemove", function(event, d){ showBinTip(d, event.clientX - wrapEl.getBoundingClientRect().left + 12); })
    .on("touchstart", function(event, d){ showBinTip(d, event.touches && event.touches[0] ? event.touches[0].clientX - wrapEl.getBoundingClientRect().left + 12 : 12); })
    .on("focus", function(event, d){ showBinTip(d, x(d.x0) + 12); })
    .on("mouseleave", () => { tip.hidden = true; })
    .on("blur", () => { tip.hidden = true; })
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
