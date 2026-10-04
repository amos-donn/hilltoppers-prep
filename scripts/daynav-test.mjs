/* Day navigation + fact-card test.

   The top of the popup shows "< Monday >": arrow buttons step one day at a
   time, the day name follows, and every class card re-renders that day's
   column as fact cards — a title per labelled row with the value beneath it.
   The fixture is a weekday-column calendar (Monday..Sunday) with one distinct
   item per day, so expectations hold whatever day the suite runs on.
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
/* No label cell in the header row, but the data rows do have one — the parser
   has to notice that and shift the day columns. */
const row = [0, 1, 2, 3, 4, 5, 6].map((i) => "<td>" + item(i) + "</td>").join("");
const pageBody = "<table><tr>" + header + "</tr><tr><td>CLASSWORK</td>" + row + "</tr></table>";

const window = new JSDOM(
  `<!doctype html><html><body>
  <div data-topping-content id="topping-content">
    <button id="settings-toggle" aria-expanded="true" aria-controls="settings"></button>
    <nav id="day-nav" class="day-nav">
      <button id="day-prev" class="day-arrow" type="button"></button>
      <div class="day-current">
        <span id="day-name" class="day-name"></span>
        <span id="day-date" class="day-date"></span>
      </div>
      <button id="day-next" class="day-arrow" type="button"></button>
    </nav>
    <section id="settings" aria-label="Canvas settings">
      <input id="canvas-token" type="password" />
      <button id="save-settings"></button>
      <span id="settings-status"></span>
    </section>
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

const dayName = () => document.getElementById("day-name").textContent;
const dayDate = () => document.getElementById("day-date").textContent;

await waitFor(item(todayIndex));
assert(document.body.textContent.includes(item(todayIndex)), "today's column renders first");

/* --- the day navigator --- */
const prev = document.getElementById("day-prev");
const next = document.getElementById("day-next");
assert(Boolean(prev) && Boolean(next), "prev/next arrow buttons exist");
assert(dayName() === "Today", "the nav shows one word: Today on the current day");
assert(dayDate() === (new Date().getMonth() + 1) + "/" + new Date().getDate(),
  "the hover-only date is the current date");
assert(prev.getAttribute("aria-disabled") === "false", "prev is enabled on the current day");

/* --- fact cards: a title per labelled row, value beneath --- */
const label = document.querySelector(".fact-label");
assert(Boolean(label), "a fact card renders with a label element");
assert(label.textContent === "CLASSWORK", "the row's left-hand cell becomes the card title");
const value = label.nextElementSibling;
assert(
  value && value.classList.contains("fact-value"),
  "the value sits directly beneath the title"
);
assert(value.textContent === item(todayIndex), "the value is today's column content");

/* --- stepping forward --- */
const fetchesBefore = calls.length;
next.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await waitFor(item(tomorrowIndex));

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
assert(
  dayName() === WEEKDAY_NAMES[tomorrow.getDay()],
  "clicking the right arrow moves to the next weekday"
);
assert(document.body.textContent.includes(item(tomorrowIndex)), "the card shows tomorrow's column");
assert(!document.body.textContent.includes(item(todayIndex)), "today's column is replaced, not appended");
assert(
  calls.length === fetchesBefore,
  "changing the day does not re-fetch Canvas (re-rendered from the cached page)"
);

/* --- stepping back --- */
prev.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await waitFor(item(todayIndex));
assert(
  document.body.textContent.includes(item(todayIndex)),
  "clicking the left arrow returns to today's column"
);

console.log(
  results.every((r) => r.ok)
    ? "DAYNAV OK — all assertions passed"
    : "DAYNAV FAILED — " + results.filter((r) => !r.ok).length + " assertion(s) failed"
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
