/* Node-based unit tests for worker/index.mjs.
   Stubs the Workers runtime (Request/Response/fetch/env) — no dependencies.

   Run: node --test scripts/worker-test.mjs
*/

import test from "node:test";
import assert from "node:assert/strict";

let upstreamCalls = [];
let upstreamStatus = 200;

globalThis.fetch = async (url, init = {}) => {
  upstreamCalls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {} });
  const headers = new globalThis.Headers({ "Content-Type": "application/json" });
  return new globalThis.Response(JSON.stringify([{ id: 1 }]), { status: upstreamStatus, headers });
};

const { default: worker } = await import("../worker/index.mjs");

function makeRequest(method, url, headers = {}) {
  return new globalThis.Request(url, { method, headers });
}

test("forwards Authorization header and appends CORS headers on happy path", async () => {
  upstreamCalls = [];
  const res = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://school.instructure.com/api/v1/courses"), {
      Origin: "https://amos-donn.github.io",
      Authorization: "Bearer test-token",
    }),
    {}
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://amos-donn.github.io");
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://school.instructure.com/api/v1/courses");
  assert.equal(upstreamCalls[0].headers.get("Authorization"), "Bearer test-token");
});

test("rejects disallowed target hosts", async () => {
  upstreamCalls = [];
  const res = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://evil.example.com/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    {}
  );
  assert.equal(res.status, 403);
  assert.equal(upstreamCalls.length, 0);
});

test("blocks private/internal target hosts (SSRF guard)", async () => {
  upstreamCalls = [];
  for (const host of ["https://localhost:9/api", "https://10.0.0.5/api", "https://192.168.1.10/api"]) {
    const res = await worker.fetch(
      makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent(host), {
        Origin: "https://amos-donn.github.io",
      }),
      {}
    );
    assert.equal(res.status, 403, host);
  }
  assert.equal(upstreamCalls.length, 0);
});

test("rejects http targets unless ALLOW_INSECURE local testing", async () => {
  upstreamCalls = [];
  const res = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("http://school.instructure.com/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    {}
  );
  assert.equal(res.status, 400);
  const ok = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("http://127.0.0.1:3000/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    { ALLOW_INSECURE: "1" }
  );
  assert.equal(ok.status, 200);
  assert.equal(upstreamCalls.length, 1);
});

test("handles preflight and returns 204 with CORS headers", async () => {
  const res = await worker.fetch(
    makeRequest("OPTIONS", "https://proxy.example/?url=" + encodeURIComponent("https://school.instructure.com/api"), {
      Origin: "https://amos-donn.github.io",
      "Access-Control-Request-Method": "GET",
    }),
    {}
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://amos-donn.github.io");
  assert.match(res.headers.get("Access-Control-Allow-Headers") || "", /Authorization/i);
});

test("enforces ALLOWED_ORIGINS when configured", async () => {
  upstreamCalls = [];
  const env = { ALLOWED_ORIGINS: "https://amos-donn.github.io" };
  const bad = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://school.instructure.com/api"), {
      Origin: "https://attacker.example",
    }),
    env
  );
  assert.equal(bad.status, 403);
  const good = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://school.instructure.com/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    env
  );
  assert.equal(good.status, 200);
});

test("respects custom ALLOWED_SUFFIXES", async () => {
  upstreamCalls = [];
  const env = { ALLOWED_SUFFIXES: "instructure.com,myschool.edu" };
  const ok = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://canvas.myschool.edu/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    env
  );
  assert.equal(ok.status, 200);
  const bad = await worker.fetch(
    makeRequest("GET", "https://proxy.example/?url=" + encodeURIComponent("https://canvas.other.edu/api"), {
      Origin: "https://amos-donn.github.io",
    }),
    env
  );
  assert.equal(bad.status, 403);
});

test("missing url parameter returns 400", async () => {
  const res = await worker.fetch(makeRequest("GET", "https://proxy.example/", { Origin: "https://amos-donn.github.io" }), {});
  assert.equal(res.status, 400);
});
