/* End-to-end test: the topping must render today's plan when Canvas refuses
   direct cross-origin calls (no CORS headers) and only the proxy succeeds.
   Run: bun scripts/e2e-test.mjs   (requires: bun add -d jsdom) */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const window = new JSDOM(`<!doctype html><html><body>
  <div data-topping-content id="topping-content">
    <button id="settings-toggle" aria-expanded="true" aria-controls="settings"></button>
    <section id="settings" aria-label="Canvas settings">
      <input id="canvas-token" type="password" />
      <button id="save-settings"></button>
      <span id="settings-status"></span>
    </section>
    <main id="classes"></main>
  </div>
</body></html>`, {
  url: "https://amos-donn.github.io/hilltoppers-prep/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
}).window;

const { document } = window;

const planHtml =
  '<table><tr><th>Fri 10/2</th><th>Sat 10/3</th><th>Mon 10/5</th></tr>' +
  '<tr><td>Reading</td><td>Quiz ch. 5</td><td>Homework 12</td></tr></table>';

const calls = [];
window.fetch = async (url, init = {}) => {
  const urlStr = String(url);
  const auth = init && init.headers && init.headers.Authorization;
  calls.push({ url: urlStr, auth });
  if (urlStr.startsWith("https://stjacademy.instructure.com/")) {
    // Direct call: opaque network failure — what a browser hits without CORS.
    throw new TypeError("Failed to fetch");
  }
  // Proxy path: https://proxy.example/?url=<encoded canvas url>
  const target = decodeURIComponent(urlStr.split("url=")[1] || "");
  if (target.includes("/front_page")) {
    return new Response(JSON.stringify({ title: "Weekly Plan", body: planHtml }), { status: 200 });
  }
  if (target.includes("/api/v1/courses")) {
    return new Response(JSON.stringify([{ id: 101, name: "Algebra I" }]), { status: 200 });
  }
  return new Response("[]", { status: 200 });
};

const results = [];
function assert(cond, msg) {
  results.push({ ok: Boolean(cond), msg });
  if (!cond) console.error("FAIL: " + msg);
}  window.localStorage.setItem("hiltoppers.canvasToken", "e2e-token");
  window.localStorage.setItem("hiltoppers.canvasProxyUrl", "");

window.eval(readFileSync("script.js", "utf8"));
// JSDOM fires DOMContentLoaded itself after parsing; do not double-dispatch.

const errors = [];
process.on("unhandledRejection", (r) => errors.push("unhandled: " + String((r && r.stack) || r)));

// Wait for the async refresh chain to finish rendering.
for (let i = 0; i < 100 && !document.body.textContent.includes("Algebra I"); i++) {
  await new Promise((r) => setTimeout(r, 10));
}

const cards = document.querySelectorAll(".class-card");
assert(cards.length === 1, "one class card rendered");
assert(document.body.textContent.includes("Algebra I"), "course name shown");
assert(document.body.textContent.includes("Quiz ch. 5"), "today's plan line rendered");
assert(document.body.textContent.includes("Weekly Plan"), "source page note shown");

const direct = calls.filter((c) => c.url.includes("stjacademy.instructure.com"));
assert(direct.length >= 1, "direct Canvas call attempted first");
assert(direct.every((c) => c.auth === "Bearer e2e-token"), "direct calls carried the token");

const proxied = calls.filter((c) => c.url.includes("hilltoppers-canvas-proxy.amos-donn.workers.dev"));
assert(proxied.length >= 2, "proxy fallback used for courses + page fetches");
assert(proxied.every((c) => c.auth === "Bearer e2e-token"), "proxied calls carried the token");
assert(
  proxied.some((c) => /url=https%3A%2F%2Fstjacademy\.instructure\.com/.test(c.url)),
  "proxy URL wraps the Canvas URL"
);
assert(
  proxied.every((c) => c.url.includes("hilltoppers-canvas-proxy.amos-donn.workers.dev")),
  "all proxied calls target the fixed worker URL"
);



console.log(results.every((r) => r.ok) ? "E2E OK — all assertions passed" : "E2E FAILED");
if (errors.length) console.log("window errors:\n  " + errors.join("\n  "));
console.log("status:", JSON.stringify(document.getElementById("settings-status").textContent));
console.log("classes HTML:", document.getElementById("classes").innerHTML.slice(0, 400));
console.log(calls.map((c) => "  call: " + c.url).join("\n"));
process.exit(results.every((r) => r.ok) ? 0 : 1);
