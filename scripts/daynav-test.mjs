/* Look-ahead test.

   The day chips (Today, then the next few days) must re-render every class card
   for the chosen day, using the already-fetched calendar page — no extra Canvas
   requests. The fixture is a weekday-column calendar (Monday..Sunday) with one
   distinct item per day, so the expected content is unambiguous whatever day
   the suite runs on.
   Run: bun scripts/daynav-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync("script.js", "utf8");
const RELAY = "https://hilltoppers-canvas-proxy.amos-donn.workers.dev";
const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

const results = [];
function assert(cond, msg) {
  results.push({ ok: Boolean(cond), msg });
  console.log((cond ? "ok   " : "FAIL ") + msg);
  if (!cond) process.exitCode = 1;
}

/* Monday-first index of today and of tomorrow. */
const mondayFirst = (d) => (d.getDay() + 6) % 7;
const todayIndex = mondayFirst(new Date());
const tomorrowIndex = (todayIndex + 1) % 7;

const item = (i) => "plan-for-day-" + i;
const header = [0, 1, 2, 3, 4, 5, 6]
  .map((i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - todayIndex + i);
    return "<th>" + WEEKDAY_NAMES[d.getDay()] + "</th>";
  })
  .join("");
const row = [0, 1, 2, 3, 4, 5, 6].map((i) => "<td>" + item(i) + "</td>").join("");
const pageBody = "<table><tr>" + header + "</tr><tr><td>CLASSWORK</td>" + row + "</tr></table>";

const window = new JSDOM(
  `<!doctype html><html><body>
  <div data-topping-content id="topping-content">
    <button id="settings-toggle" aria-expanded="true" aria-controls="settings"></button>
    <section id="settings" aria-label="Canvas settings">
      <input id="canvas-token" type="password" />
      <button id="save-settings"></button>
      <span id="settings-status"></span>
    </section>
    <div id="day-bar" class="day-bar"></div>
    <main id="classes"></main>
  </div>
</body></html>`,
  {
    url: "https://amos-donn.github.io/hilltoppers-prep/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  }
).window;

const { document } = window;
const calls = [];
window.fetch = async (url) => {
  const urlStr = String(url);
  calls.push(urlStr);
  if (!urlStr.startsWith(RELAY)) throw new Error("request must use the relay: " + urlStr);
  const target = decodeURIComponent(urlStr.split("url=")[1] || "");
  if (target.includes("/front_page")) {
    return new Response(JSON.stringify({ title: "Weekly Plan", body: pageBody }), { status: 200 });
  }
  if (target.includes("/api/v1/courses")) {
    return new Response(JSON.stringify([{ id: 7, name: "History" }]), { status: 200 });
  }
  return new Response("[]", { status: 200 });
};

window.localStorage.setItem("hiltoppers.canvasToken", "daynav-token");
window.localStorage.setItem("hiltoppers.canvasProxyUrl", "");
window.eval(SCRIPT);

async function waitFor(needle, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (document.body.textContent.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return document.body.textContent.includes(needle);
}

await waitFor(item(todayIndex));
assert(document.body.textContent.includes(item(todayIndex)), "today's column renders first");

const chips = document.querySelectorAll("#day-bar .day-chip");
assert(chips.length === 5, "five day chips render (today + next 4)");
assert(chips[0].textContent === "Today", "the first chip is labelled Today");
assert(chips[0].classList.contains("is-active"), "Today is active by default");
assert(gotTodayOnly(document.body.textContent), "no other day's column leaked in");

function gotTodayOnly(text) {
  for (let i = 0; i < 7; i++) {
    if (i === todayIndex) continue;
    if (text.includes(item(i))) return false;
  }
  return true;
}

const fetchesBefore = calls.length;

/* Click the chip for tomorrow. */
chips[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await waitFor(item(tomorrowIndex));

const text = document.body.textContent;
assert(text.includes(item(tomorrowIndex)), "clicking the next chip shows tomorrow's column");
assert(!text.includes(item(todayIndex)), "today's column is replaced, not appended");
assert(/Tomorrow,/.test(text), "the day note says Tomorrow");
assert(
  document.querySelectorAll("#day-bar .day-chip")[1].classList.contains("is-active"),
  "the chosen chip becomes active"
);
assert(
  calls.length === fetchesBefore,
  "changing the day does not re-fetch Canvas (re-rendered from the cached page)"
);

console.log(
  results.every((r) => r.ok)
    ? "DAYNAV OK — all assertions passed"
    : "DAYNAV FAILED — " + results.filter((r) => !r.ok).length + " assertion(s) failed"
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
