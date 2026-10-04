/* Top-bar test: header layout, settings default state, and the arrow glyphs.

   The popup header is a single row: the title, the day switcher, and the
   settings gear. Settings is collapsed until the gear is clicked, and the day
   arrows are plain filled triangles (no circle around them, no chevrons).
   This loads the real index.html and boots the page's own script.js, so it
   checks the shipped markup, not a hand-written fixture.
   Run: bun scripts/topbar-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync("index.html", "utf8");
const SCRIPT = readFileSync("script.js", "utf8");
const CSS = readFileSync("style.css", "utf8");

const results = [];
function assert(cond, msg) {
  results.push({ ok: Boolean(cond), msg });
  console.log((cond ? "ok   " : "FAIL ") + msg);
  if (!cond) process.exitCode = 1;
}

const window = new JSDOM(HTML, {
  url: "https://amos-donn.github.io/hilltoppers-prep/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
}).window;
const { document } = window;

/* No token is set, so init() must not touch the network. */
window.fetch = async () => {
  throw new Error("the top bar boots without a token and must not fetch");
};
window.eval(SCRIPT);

/* Wait for the script's DOMContentLoaded init to attach its listeners. */
if (document.readyState === "loading") {
  await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
}
await new Promise((r) => setTimeout(r, 20));

/* --- the day switcher sits between the title and the gear --- */
const header = document.querySelector(".top-header");
assert(Boolean(header), "the header exists");
assert(!document.querySelector(".top-header h1"), "the \"Today's Plan\" title is gone");
assert(!/\.top-header h1/.test(CSS), "its now-unused CSS rule went with it");
const order = header
  ? [...header.children].map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""))
  : [];
assert(
  order.join(",") === "nav#day-nav,button#settings-toggle",
  "header is the day switcher then settings (got " + order.join(",") + ")"
);
assert(
  document.getElementById("day-nav").parentElement === header,
  "the day switcher is inside the header, not a separate block"
);

/* --- the day row has no card box, and the arrows have no circle --- */
const dayNavRule = (CSS.match(/\.day-nav\s*\{([^}]*)\}/) || [])[1] || "";
assert(!/border|background/.test(dayNavRule), ".day-nav has no box of its own");
const arrowRule = (CSS.match(/\.day-arrow\s*\{([^}]*)\}/) || [])[1] || "";
assert(!/border-radius/.test(arrowRule), ".day-arrow has no circular border-radius");
assert(/border:\s*(0|none)/.test(arrowRule), ".day-arrow draws no border");
assert(/background:\s*none/.test(arrowRule), ".day-arrow draws no filled circle");

/* --- the arrows are filled isosceles triangles, left and right --- */
function triPoints(d) {
  return d
    .trim()
    .replace(/z$/i, "")
    .split(/\s*[ml]\s*/i)
    .filter(Boolean)
    .map((pair) => pair.trim().split(/[\s,]+/).map(Number));
}
function apexSide(d) {
  const pts = triPoints(d);
  if (pts.length !== 3) return "not-a-triangle";
  const xs = pts.map((p) => p[0]);
  const uniq = xs.find((x) => xs.filter((y) => y === x).length === 1);
  const base = xs.filter((x) => x !== uniq);
  if (base.length !== 2 || base[0] !== base[1]) return "base-not-vertical";
  return uniq < base[0] ? "left" : "right";
}
for (const [id, want] of [["day-prev", "left"], ["day-next", "right"]]) {
  const svg = document.getElementById(id).querySelector("svg");
  const paths = [...svg.querySelectorAll("path")];
  assert(paths.length === 1, id + " has exactly one path");
  const p = paths[0];
  assert(!p.hasAttribute("stroke"), id + " arrow is filled, not stroked (no chevron)");
  assert(p.getAttribute("fill") === "currentColor", id + " arrow is filled with currentColor");
  assert(/^m[-\d.,\s]+l[-\d.,\s]+l[-\d.,\s]+z$/i.test(p.getAttribute("d").trim()), id + " path is a 3-point closed triangle");
  assert(apexSide(p.getAttribute("d")) === want, id + " triangle points " + want);
}

/* --- no box around the gear, and the word does not slide out --- */
const gearRule = (CSS.match(/\.gear-btn\s*\{([^}]*)\}/) || [])[1] || "";
assert(/border:\s*(0|none)/.test(gearRule), ".gear-btn draws no box");
assert(/background:\s*none/.test(gearRule), ".gear-btn has no fill");
assert(
  !/ghost-btn/.test(document.getElementById("settings-toggle").className),
  "the gear button no longer carries the boxed ghost-btn class"
);

const labelRule = (CSS.match(/\.settings-label\s*\{([^}]*)\}/) || [])[1] || "";
assert(/display:\s*none/.test(labelRule), "the word Settings is hidden until hover");
assert(
  !/transition/.test(labelRule) && !/opacity/.test(labelRule),
  "the word does not slide out (no transition/opacity fade)"
);
assert(
  /position:\s*absolute/.test(labelRule) && /right:\s*100%/.test(labelRule),
  "the word is out of flow to the left, so the gear never shifts"
);
assert(
  /\.gear-btn:hover \.settings-label,[\s\S]*?display:\s*block/.test(CSS),
  "hovering the gear shows the word Settings"
);

/* --- the date only surfaces when the day is hovered --- */
const dateRule = (CSS.match(/\.day-date\s*\{([^}]*)\}/) || [])[1] || "";
assert(/max-height:\s*0/.test(dateRule), "the date is collapsed by default (day word stays centred)");
assert(/transition:/.test(dateRule), "the date animates in and out");
assert(
  /\.day-current:hover \.day-date,[\s\S]*?max-height:\s*16px/.test(CSS),
  "hovering the day slides the date down"
);

/* --- settings is closed until the gear is clicked --- */
const settings = document.getElementById("settings");
const gear = document.getElementById("settings-toggle");
assert(settings.hasAttribute("hidden"), "settings starts hidden");
assert(gear.getAttribute("aria-expanded") === "false", "the gear reports settings collapsed");

gear.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(!settings.hasAttribute("hidden"), "clicking the gear opens settings");
assert(gear.getAttribute("aria-expanded") === "true", "the gear reports settings expanded");

gear.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(settings.hasAttribute("hidden"), "clicking the gear again closes settings");
assert(gear.getAttribute("aria-expanded") === "false", "the gear reports settings collapsed again");

console.log(
  results.every((r) => r.ok)
    ? "TOPBAR OK — all assertions passed"
    : "TOPBAR FAILED — " + results.filter((r) => !r.ok).length + " assertion(s) failed"
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
