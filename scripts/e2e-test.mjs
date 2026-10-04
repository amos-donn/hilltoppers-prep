/* End-to-end tests for the Hilltoppers Prep topping.

   Canvas is never called directly — instructure.com sends no CORS headers, so
   every request goes straight through the Cloudflare relay. These tests cover:
     1. the happy path (relay returns courses + a front page with today's plan)
     2. a rejected token (relay/Canvas 401) renders the real code + message
     3. an unreachable relay renders a classified error, not "Failed to fetch"
     4. a non-JSON 200 body from the relay renders err-5
   Run: bun scripts/e2e-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync("script.js", "utf8");
const RELAY = "https://hilltoppers-canvas-proxy.amos-donn.workers.dev";
const CANVAS = "https://stjacademy.instructure.com";

const results = [];
function assert(cond, msg) {
  results.push({ ok: Boolean(cond), msg });
  console.log((cond ? "ok   " : "FAIL ") + msg);
  if (!cond) process.exitCode = 1;
}

function makeWindow() {
  return new JSDOM(
    `<!doctype html><html><body>
  <div data-topping-content id="topping-content">
    <button id="settings-toggle" aria-expanded="true" aria-controls="settings"></button>
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
}

/* Boot the topping with a controlled fetch and wait for the async refresh. */
async function boot(fetchImpl) {
  const window = makeWindow();
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, auth: init && init.headers && init.headers.Authorization });
    if (urlStr.startsWith(CANVAS)) {
      throw new Error("direct Canvas call must never happen: " + urlStr);
    }
    if (!urlStr.startsWith(RELAY)) {
      throw new Error("request did not use the relay: " + urlStr);
    }
    return fetchImpl(urlStr, init);
  };
  window.localStorage.setItem("hiltoppers.canvasToken", "e2e-token");
  window.localStorage.setItem("hiltoppers.canvasProxyUrl", "");
  window.eval(SCRIPT);

  return { window, calls };
}

/* Wait until the rendered page contains `needle` (or the timeout elapses). */
async function settle(window, needle, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (window.document.body.textContent.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function targetOf(urlStr) {
  return decodeURIComponent(urlStr.split("url=")[1] || "");
}

const statusEl = (w) => w.document.getElementById("settings-status").textContent;
const bodyText = (w) => w.document.body.textContent;

/* ---------- 1) happy path: everything through the relay ---------- */
/* Build the plan table around the real current date so the fixture never
   goes stale. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayShift = (off) => {
  const d = new Date();
  d.setDate(d.getDate() + off);
  return d;
};
const label = (d) => WEEKDAYS[d.getDay()] + " " + (d.getMonth() + 1) + "/" + d.getDate();
const planHtml =
  "<table><tr><th>" + label(dayShift(-1)) + "</th><th>" + label(dayShift(0)) +
  "</th><th>" + label(dayShift(2)) + "</th></tr>" +
  "<tr><td>Reading</td><td>Quiz ch. 5</td><td>Homework 12</td></tr></table>";

{
  const { window, calls } = await boot(async (urlStr) => {
    const target = targetOf(urlStr);
    if (target.includes("/front_page")) {
      return new Response(JSON.stringify({ title: "Weekly Plan", body: planHtml }), { status: 200 });
    }
    if (target.includes("/api/v1/courses")) {
      return new Response(JSON.stringify([{ id: 101, name: "Algebra I" }]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  });
  await settle(window, "Quiz ch. 5");

  assert(window.document.querySelectorAll(".class-card").length === 1, "one class card rendered");
  assert(bodyText(window).includes("Algebra I"), "course name shown");
  assert(bodyText(window).includes("Quiz ch. 5"), "today's plan line rendered");
  assert(bodyText(window).includes("Weekly Plan"), "source page note shown");
  assert(calls.length > 0, "requests were made");
  assert(
    calls.every((c) => c.url.startsWith(RELAY)),
    "relay-only: every request went to the relay (no direct Canvas call)"
  );
  assert(calls.every((c) => c.auth === "Bearer e2e-token"), "requests carried the token to the relay");
  assert(
    calls.some((c) => /url=https%3A%2F%2Fstjacademy\.instructure\.com/.test(c.url)),
    "relay URL wraps the Canvas URL"
  );
}

/* ---------- 2) rejected token: real HTTP code + server message ---------- */
{
  const { window } = await boot(async () => {
    return new Response(JSON.stringify({ message: "Invalid access token." }), { status: 401 });
  });
  await settle(window, "[err-6]");

  const text = bodyText(window);
  assert(text.includes("[err-6]"), "401 renders the err-6 code");
  assert(text.includes("Canvas rejected the token (HTTP 401)"), "401 renders the real HTTP code");
  assert(text.includes("Invalid access token."), "401 renders the server's own message");
  assert(!/Failed to fetch/.test(text), "no generic 'Failed to fetch' text for a 401");
  assert(statusEl(window).includes("[err-6]"), "status bar shows the classified code");
}

/* ---------- 3) unreachable relay: classified, not generic ---------- */
{
  const { window } = await boot(async () => {
    throw new TypeError("Failed to fetch");
  });
  await settle(window, "[err-0]");

  const text = bodyText(window);
  assert(text.includes("[err-0]"), "unreachable relay renders err-0");
  assert(
    text.includes("relay unreachable at hilltoppers-canvas-proxy.amos-donn.workers.dev"),
    "err-0 names the relay that could not be reached"
  );
  assert(!/^\s*Failed to fetch\s*$/.test(text), "never shows a bare 'Failed to fetch' as the whole message");
  assert(statusEl(window).includes("[err-0]"), "status bar shows err-0");
}

/* ---------- 4) non-JSON 200 body ---------- */
{
  const { window } = await boot(async () => new Response("<html>maintenance</html>", { status: 200 }));
  await settle(window, "[err-5]");

  const text = bodyText(window);
  assert(text.includes("[err-5]"), "non-JSON 200 renders err-5");
  assert(text.includes("relay returned non-JSON"), "err-5 explains the non-JSON body");
}

/* ---------- 5) relay refuses the target host (ALLOWED_SUFFIXES) ---------- */
{
  const { window } = await boot(async () =>
    new Response(
      JSON.stringify({
        error: "Target host not allowed",
        host: "stjacademy.instructure.com",
        allowed: ["instructure.com"],
      }),
      { status: 403 }
    )
  );
  await settle(window, "[err-7]");

  const text = bodyText(window);
  assert(text.includes("[err-7]"), "a relay refusal renders err-7");
  assert(
    text.includes("relay refused the request: Target host not allowed"),
    "err-7 names the relay's own refusal"
  );
  assert(text.includes("ALLOWED_SUFFIXES"), "err-7 points at ALLOWED_SUFFIXES to fix");
  assert(text.includes("relay allows: instructure.com"), "err-7 lists what the relay does allow");
  assert(
    !text.includes("Canvas rejected the token"),
    "a relay refusal is NOT reported as a token problem"
  );
}

/* ---------- 6) relay refuses this page's origin (ALLOWED_ORIGINS) ---------- */
{
  const { window } = await boot(async () =>
    new Response(
      JSON.stringify({ error: "Origin not allowed", origin: "https://example.test" }),
      { status: 403 }
    )
  );
  await settle(window, "[err-7]");

  const text = bodyText(window);
  assert(text.includes("relay refused the request: Origin not allowed"), "origin refusal is named");
  assert(
    text.includes("add https://example.test to ALLOWED_ORIGINS"),
    "origin refusal shows the exact origin to allow"
  );
}

console.log(
  results.every((r) => r.ok)
    ? "E2E OK — all assertions passed"
    : "E2E FAILED — " + results.filter((r) => !r.ok).length + " assertion(s) failed"
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
