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
    name: "weekRows (horizontal weekly rows, date + plans in one row)",
    html:
      "<table><tr><th>Week of 9/28</th><th>Mon</th><th>Tue</th><th>Wed</th></tr>" +
      "<tr><td>10/3</td><td>Reading</td><td>Quiz ch. 5</td><td>Lab report</td></tr></table>",
    expect: ["Quiz ch. 5", "Lab report"],
    reject: ["Reading:"],
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
    expect: ["No plan found for today."],
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

  for (let i = 0; i < 100 && !window.document.querySelector(".class-body .state, .plan-list"); i++) {
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
