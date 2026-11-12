"use strict";
/* Shared UI state + DOM helpers. Classic script: top-level const/let/function
   here are visible to charts.js, render.js and main.js (loaded after). */
const { FIELDS, MONEY_FIELDS, nowYear, yearAt, monthsLabel, fmt, fmt2, compact, cleanMoney, formatMoneyString,
  compute, monteCarlo, guardrailMC, riskGuardrailMC, backfillPlan, encodeShare, decodeShare,
  successAtSpend, desiredSuccess, mcKeyFor, guardKeyFor, riskKeyFor, guardIsActive } = RP;
const $ = id => document.getElementById(id);
const setText = (id, text) => { $(id).textContent = text; };
const setPressed = (id, on) => { const el = $(id); el.classList.toggle("active", on); el.setAttribute("aria-pressed", String(on)); };
/** Set every [valueId, noteId, note] triple in a stat card to a common placeholder value. */
const fillCard = (triples, value) => { for (const [id, noteId, note] of triples) { setText(id, value); setText(noteId, note); } };
const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let verdictSummaryTimer = null;
function announceVerdict(text){
  clearTimeout(verdictSummaryTimer);
  verdictSummaryTimer = setTimeout(() => { const el = document.getElementById("verdictSummary"); if (el) el.textContent = text; }, 500);
}
let basis = "today", chartData = null, lastBackfill = null, backfillMode = "monthly", stickySolve = false, resolving = false, sharedView = false, shareLinkFailed = false;
let chartView = "balance", showMC = true, lastMcVis = null;
let mcTimer = null, mcSeq = 0, mcCache = { key: null, value: null, has: false }, guardCache = { key: null, value: null, has: false }, riskCache = { key: null, value: null, has: false };
function readInputs(){
  const v = {};
  for (const f of FIELDS){
    if (f === "guardrailEnabled" || f === "riskGuardEnabled"){ v[f] = $(f).checked ? 1 : 0; continue; }
    const raw = $(f).value; v[f] = raw === "" ? NaN : parseFloat(String(raw).replace(/,/g, ""));
  }
  return v;
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
