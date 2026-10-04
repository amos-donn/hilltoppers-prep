/* Iframe/embed regression suite.

   The topping is meant to be embedded in the Hilltoppers extension popup — a
   ~318px-wide iframe using "fit content" height, with the page inside
   [data-topping-content]. Two things broke in that popup:

     1. an inline <svg viewBox> with no width/height renders at the 300x150
        used-value default, so the gear looked enormous and the two day-arrow
        glyphs shoved the row into "weird places" — and
     2. the theme arrives via a relative <link rel="stylesheet">, which an
        embed that loads this HTML out of context (srcdoc / shadow DOM) can
        fail to resolve, leaving layout rules unapplied.

   The fixes are explicit SVG dimensions plus a small inline critical block in
   <head>. These assertions load the real index.html and lock both in.
   Run: bun scripts/iframe-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("index.html", "utf8");
const RESIZE = readFileSync("resize.js", "utf8");

const results = [];
function assert(cond, msg) {
  results.push({ ok: Boolean(cond), msg });
  console.log((cond ? "ok   " : "FAIL ") + msg);
  if (!cond) process.exitCode = 1;
}

const { document } = new JSDOM(HTML).window;
const flat = (s) => s.replace(/\s+/g, " ");

/* --- 1) every inline SVG carries explicit dimensions (no 300x150 default) --- */
const svgs = [...document.querySelectorAll("svg")];
assert(svgs.length >= 3, "the gear and both day arrows are inline SVGs");
for (const svg of svgs) {
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  assert(
    w > 0 && h > 0,
    "svg " + (svg.getAttribute("class") || "(unclassed)") +
      " has explicit width/height (got " + w + "x" + h + ")"
  );
}

/* --- 2) critical CSS is inlined in <head>, before the external stylesheet --- */
const head = document.head;
const critEl = head.querySelector("style");
const link = head.querySelector('link[rel="stylesheet"]');
assert(Boolean(critEl), "head has an inline critical <style> block");
assert(Boolean(link), "the full stylesheet is still linked");
assert(
  Boolean(critEl && link) &&
    (critEl.compareDocumentPosition(link) & 4) === 4, // DOCUMENT_POSITION_FOLLOWING
  "the critical block sits before style.css so it paints first"
);

const crit = flat(critEl ? critEl.textContent : "");
assert(crit.includes("box-sizing: border-box"), "critical block uses border-box so padding can't overflow the iframe");
assert(crit.includes(".day-nav { display: flex"), "critical block lays the day row out as a flex row");
assert(crit.includes(".gear-icon { width: 16px"), "critical block pins the gear icon to 16px");
assert(crit.includes(".day-arrow {") && crit.includes("width: 20px"), "critical block pins the day arrows to 20px");
assert(crit.includes(".day-arrow svg { width: 14px"), "critical block pins the arrow glyphs to 14px");

/* --- 3) the embed contract: the wrapper plus the day-switcher landmarks --- */
const content = document.querySelector("[data-topping-content]");
assert(Boolean(content), "content lives inside [data-topping-content]");
for (const sel of [
  ".top-header", "#day-nav", "#day-prev", "#day-next",
  "#day-name", "#day-date", "#settings", "#classes",
]) {
  assert(Boolean(content && content.querySelector(sel)), "embed contract: " + sel + " is inside [data-topping-content]");
}

/* --- 4) the day switcher is real, labelled, glyph-bearing buttons --- */
for (const id of ["day-prev", "day-next"]) {
  const btn = document.getElementById(id);
  assert(Boolean(btn && btn.tagName === "BUTTON"), id + " is a <button>");
  assert(Boolean(btn && (btn.getAttribute("aria-label") || "").length), id + " has an accessible label");
  assert(Boolean(btn && btn.querySelector("svg")), id + " contains its arrow glyph");
}

/* --- 5) relative asset URLs, so a relative embed can resolve them --- */
for (const el of [...document.querySelectorAll("script[src], link[href]")]) {
  const url = el.getAttribute("src") || el.getAttribute("href") || "";
  assert(!/^https?:\/\//i.test(url), "asset is referenced relatively: " + url);
}

/* --- 6) the fit-content height contract --- */
assert(/hiltoppers:topping-resize/.test(RESIZE), "resize.js posts the hiltoppers:topping-resize message");
assert(/data-topping-content/.test(RESIZE), "resize.js measures [data-topping-content]");

console.log(
  results.every((r) => r.ok)
    ? "IFRAME OK — all assertions passed"
    : "IFRAME FAILED — " + results.filter((r) => !r.ok).length + " assertion(s) failed"
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
