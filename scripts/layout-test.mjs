/* Spreadsheet-layout regression suite: runs the real page flow
   (courses -> front_page -> extraction -> render) for each known layout.
   Run: bun scripts/layout-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync("script.js", "utf8");

/* Each case: page HTML + substrings that must (or must not) render today. */
const CASES = [
  {
    name: "verticalDayList (dates down the left, plans to the right)",
    html:
      "<table><tr><th>Day</th><th>Plan</th></tr>" +
      "<tr><td>10/2</td><td>Reading</td></tr>" +
      "<tr><td>10/3</td><td>Quiz ch. 5</td></tr>" +
      "<tr><td>10/6</td><td>Essay draft</td></tr></table>",
    expect: ["Quiz ch. 5"],
    reject: ["Reading", "Essay draft"],
  },
  {
    name: "headerMulti (several dates across the top)",
    html:
      "<table><tr><th>10/2</th><th>10/3</th><th>10/6</th></tr>" +
      "<tr><td>Reading</td><td>Quiz ch. 5</td><td>Essay draft</td></tr></table>",
    expect: ["Quiz ch. 5"],
    reject: ["Reading", "Essay draft"],
  },
  {
    name: "headerSingle (one date header, items stacked below)",
    html:
      "<table><tr><th>10/3</th></tr>" +
      "<tr><td>Quiz ch. 5</td></tr>" +
      "<tr><td>Workbook p. 41</td></tr></table>",
    expect: ["Quiz ch. 5", "Workbook p. 41"],
    reject: [],
  },
  {
    name: "inlineCell (date and plan in the same cell)",
    html:
      "<table><tr><th>Day</th><th>Assignment</th></tr>" +
      "<tr><td>10/2</td><td>Reading</td></tr>" +
      "<tr><td>10/3</td><td>10/3 - Quiz ch. 5</td></tr></table>",
    expect: ["Quiz ch. 5"],
    reject: ["Reading", "10/3 - Quiz"],
  },
  
  {
    name: "dayList (month-name dates)",
    html:
      "<table><tr><th>Day</th></tr>" +
      "<tr><td>October 2</td></tr>" +
      "<tr><td>October 3 - Quiz ch. 5</td></tr>" +
      "<tr><td>October 6</td></tr></table>",
    expect: ["Quiz ch. 5"],
    reject: ["October 2", "October 6"],
  },
  {
    name: "noMatch (no today entry anywhere)",
    html:
      "<table><tr><th>10/2</th><th>10/6</th></tr>" +
      "<tr><td>Reading</td><td>Essay draft</td></tr></table>",
    expect: ["No plan found for"],
    reject: ["Reading", "Essay draft"],
  },
  {
    name: "embedSheet (homepage embeds an external sheet iframe)",
    html:
      '<p>This week:</p>' +
      '<iframe src="https://docs.google.com/spreadsheets/d/xyz/edit"></iframe>',
    expect: ["embeds an external sheet"],
    reject: ["No plan found for today."],
  },
];

/* The fixtures above are written with "10/3" as *today* and "10/2"/"10/6" as
   other days. Rewrite them against the real current date so the suite does not
   break when the calendar day changes. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const dayShift = (off) => {
  const d = new Date();
  d.setDate(d.getDate() + off);
  return d;
};
const short = (d) => d.getMonth() + 1 + "/" + d.getDate();
const long = (d) => MONTHS[d.getMonth()] + " " + d.getDate();
const TODAY_D = dayShift(0);
const OTHER_A_D = dayShift(-1);
const OTHER_B_D = dayShift(3);

const SUB = [
  ["October 3", long(TODAY_D)],
  ["October 2", long(OTHER_A_D)],
  ["October 6", long(OTHER_B_D)],
  ["10/3", short(TODAY_D)],
  ["10/2", short(OTHER_A_D)],
  ["10/6", short(OTHER_B_D)],
];
const sub = (s) => SUB.reduce((acc, [from, to]) => acc.split(from).join(to), s);

for (const c of CASES) {
  c.html = sub(c.html);
  c.expect = c.expect.map(sub);
  c.reject = c.reject.map(sub);
}

/* Real-world weekday-header shapes, generated from the actual current week so
   they stay correct on any day of the week. */
const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const weekStart = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday of this week
  return d;
})();
const dayAt = (i) => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + i);
  return d;
};
const withDate = (i) =>
  WEEKDAY_NAMES[dayAt(i).getDay()] + " " + (dayAt(i).getMonth() + 1) + "/" + dayAt(i).getDate();
const todayIndex = (new Date().getDay() + 6) % 7; // 0 = Monday
const cols = (fn) => [0, 1, 2, 3, 4, 5, 6].map((i) => "<td>" + fn(i) + "</td>").join("");
const heads = (fn) => [0, 1, 2, 3, 4, 5, 6].map((i) => "<th>" + fn(i) + "</th>").join("");

/* A weekly grid whose header carries a "week of" corner cell, with one data row
   that repeats the date in its first cell and then lists each day's plan.
   Generated from the real current week: the weekday columns have to be the
   actual days or nothing lines up with today and the whole row reads as another
   day's plan. */
CASES.push({
  name: "weekRows (horizontal weekly rows, date + plans in one row)",
  html:
    "<table><tr><th>Week of " + (weekStart.getMonth() + 1) + "/" + weekStart.getDate() + "</th>" +
    heads(withDate) +
    "</tr><tr><td>" + (dayAt(todayIndex).getMonth() + 1) + "/" + dayAt(todayIndex).getDate() + "</td>" +
    cols((i) => (i === todayIndex ? "Quiz ch. 5<br>Lab report" : "Reading: ch. " + (i + 1))) +
    "</tr></table>",
  expect: ["Quiz ch. 5", "Lab report"],
  reject: ["Reading:"],
});

CASES.push({
  name: "weekdayHeaderWithDates (Week 6 / Monday 9/28 / Tuesday 9/29 columns)",
  html:
    "<table><tr><th>Week 6</th>" +
    heads(withDate) +
    "</tr><tr><td>Concepts</td>" +
    cols((i) => (i === todayIndex ? "Linear Inequalities" : "Other topic")) +
    "</tr><tr><td>Homework</td>" +
    cols((i) => (i === todayIndex ? "HW 2.10" : "Other HW")) +
    "</tr></table>",
  expect: ["Linear Inequalities", "HW 2.10"],
  reject: ["Other topic", "Other HW"],
});

CASES.push({
  name: "weekdayHeaderNoDates (Monday..Friday columns, no dates anywhere)",
  html:
    "<table><tr>" +
    heads((i) => WEEKDAY_NAMES[dayAt(i).getDay()]) +
    "</tr><tr><td>FOCUS</td>" +
    cols((i) => (i === todayIndex ? "Kallipolis / Justice" : "Other focus")) +
    "</tr><tr><td>HOMEWORK</td>" +
    cols((i) => (i === todayIndex ? "Watch this video" : "Other homework")) +
    "</tr></table>",
  expect: ["Kallipolis / Justice", "Watch this video"],
  reject: ["Other focus", "Other homework"],
});

/* A labelled row whose cell holds several lines (one per <br>) — the
   humanities CLASSWORK cell — must surface every line under its title. */
CASES.push({
  name: "weekdayHeaderMultiLineCell (several lines in one day's cell)",
  html:
    "<table><tr><th>Day</th>" +
    heads((i) => WEEKDAY_NAMES[dayAt(i).getDay()]) +
    "</tr><tr><td>FOCUS</td>" +
    cols((i) => (i === todayIndex ? "Kallipolis / Justice" : "Other focus")) +
    "</tr><tr><td>CLASSWORK</td>" +
    cols((i) =>
      i === todayIndex
        ? "Vocabulary Quiz<br>Finish Kallipolis<br>Plato vs Aristotle"
        : "Other work"
    ) +
    "</tr><tr><td>HOMEWORK</td>" +
    cols((i) => (i === todayIndex ? "TBA" : "Other homework")) +
    "</tr></table>",
  expect: ["FOCUS", "Kallipolis / Justice", "CLASSWORK", "Vocabulary Quiz", "Finish Kallipolis", "Plato vs Aristotle", "HOMEWORK", "TBA"],
  reject: ["Other focus", "Other work", "Other homework"],
});

let failures = 0;

for (const c of CASES) {
  const window = new JSDOM(`<!doctype html><html><body>
    <div data-topping-content id="topping-content">
      <button id="settings-toggle" aria-expanded="true" aria-controls="settings"></button>
      <section id="settings" aria-label="Canvas settings">
        <input id="canvas-token" type="password" />
        <input id="canvas-proxy-url" type="url" />
        <button id="save-settings"></button>
        <span id="settings-status"></span>
      </section>
      <main id="classes"></main>
    </div>
  </body></html>`, { url: "https://amos-donn.github.io/hiltoppers-prep/", runScripts: "outside-only", pretendToBeVisual: true }).window;

  window.fetch = async (url) => {
    const target = String(url).startsWith("https://stjacademy.instructure.com/")
      ? String(url)
      : decodeURIComponent(String(url).split("url=")[1] || "");
    if (target.includes("/front_page")) {
      return new Response(JSON.stringify({ title: "Plan", body: c.html }), { status: 200 });
    }
    if (target.includes("/api/v1/courses")) {
      return new Response(JSON.stringify([{ id: 1, name: "Class" }]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };

  window.localStorage.setItem("hiltoppers.canvasToken", "t");
  window.localStorage.setItem("hiltoppers.canvasProxyUrl", "https://proxy.example");
  window.eval(SCRIPT);

  /* Wait for a settled render, not just for the first state element: the page
     paints a "Loading classes…" state first and only fills the plan in on a
     later round trip, so stopping at that first element reads a half-drawn
     card and reports missing entries that do arrive. */
  const settled = () => {
    const body = window.document.body;
    const drawn = body.querySelector(".class-body .state, .fact-list");
    return drawn && !/Loading classes/.test(body.textContent);
  };
  for (let i = 0; i < 200 && !settled(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const text = window.document.body.textContent;
  for (const want of c.expect) {
    if (!text.includes(want)) {
      failures++;
      console.log(`FAIL [${c.name}] missing: ${JSON.stringify(want)}\n  got: ${JSON.stringify(text.slice(0, 200))}`);
    }
  }
  for (const no of c.reject) {
    if (text.includes(no)) {
      failures++;
      console.log(`FAIL [${c.name}] must not contain: ${JSON.stringify(no)}\n  got: ${JSON.stringify(text.slice(0, 200))}`);
    }
  }
  console.log(`ok [${c.name}]`);
}

console.log(failures === 0 ? `LAYOUT OK — ${CASES.length}/${CASES.length} layouts pass` : `LAYOUT FAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
