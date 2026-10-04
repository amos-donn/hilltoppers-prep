/* Hilltoppers Canvas CORS proxy — Cloudflare Worker.
 *
 * Transparent passthrough: the caller's own Canvas token travels in the
 * Authorization header on every request and is NEVER stored, logged, or
 * rewritten here.
 *
 * Usage:  GET https://<worker>/?url=<URL-encoded absolute Canvas URL>
 * Configure via Worker env vars — entries are normalized, so both the bare
 * form and the copy-pasted-from-the-browser form work:
 *
 *   ALLOWED_ORIGINS    comma-separated origins allowed to call the proxy.
 *                      "*" (default) allows any.
 *                      All of these are accepted and mean the same thing:
 *                        https://amos-donn.github.io
 *                        https://amos-donn.github.io/
 *                        https://amos-donn.github.io/hilltoppers-prep/
 *                        https://*.github.io          (wildcard subdomain)
 *                        chrome-extension://<id>
 *                        null                          (sandboxed iframe)
 *   ALLOWED_SUFFIXES   comma-separated target host suffixes. Default:
 *                      instructure.com. Both forms work:
 *                        instructure.com
 *                        https://stjacademy.instructure.com/    (path/scheme
 *                        *.instructure.com                       stripped)
 *   ALLOW_INSECURE     set to "1" only for local testing (permits http://
 *                      targets on 127.0.0.1/localhost).
 */

const BLOCKED_HOSTS =
  /(^|\.)(localhost|local|internal|intranet)$|^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = resolveCorsOrigin(origin, env && env.ALLOWED_ORIGINS);
    if (request.method === "OPTIONS") {
      return preflight(corsOrigin, origin);
    }
    if (!corsOrigin && origin) {
      /* Deliberately readable: the request is refused before anything is
         proxied, so echoing the caller's own origin back costs nothing and
         lets the topping show *why* it was blocked instead of an opaque
         "Failed to fetch". */
      return json({ error: "Origin not allowed", origin: origin }, 403, origin);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return json({ error: "Missing ?url= parameter" }, 400, corsOrigin);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: "Invalid ?url= value" }, 400, corsOrigin);
    }

    const insecureOk = (env && env.ALLOW_INSECURE) === "1";
    const host = targetUrl.hostname.toLowerCase();
    const isLocalHttp =
      targetUrl.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(host);
    if (isLocalHttp && !insecureOk) {
      return json({ error: "Only https targets are allowed" }, 400, corsOrigin);
    }
    if (!isLocalHttp) {
      const suffixes = splitList(env && env.ALLOWED_SUFFIXES, "instructure.com");
      if (!suffixes.some((s) => host === s || host.endsWith("." + s))) {
        return json(
          { error: "Target host not allowed", host: host, allowed: suffixes },
          403,
          corsOrigin
        );
      }
      if (targetUrl.protocol !== "https:") {
        return json({ error: "Unsupported protocol" }, 400, corsOrigin);
      }
      if (BLOCKED_HOSTS.test(host)) {
        return json({ error: "Target host not allowed", host: host }, 403, corsOrigin);
      }
    }

    const headers = new Headers();
    for (const name of ["authorization", "accept", "content-type", "x-csrf-token"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("accept")) headers.set("accept", "application/json");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "follow",
    });

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    if (corsOrigin) {
      responseHeaders.set("Access-Control-Allow-Origin", corsOrigin);
      responseHeaders.set("Vary", "Origin");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function splitList(value, fallback) {
  const raw = value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : value;
  return String(raw)
    .split(",")
    .map(normalizeSuffix)
    .filter(Boolean);
}

/* Accept "instructure.com", ".instructure.com", "*.instructure.com",
   "https://stjacademy.instructure.com/", "canvas.edu:443" — all become
   "instructure.com" / "stjacademy.instructure.com" / "canvas.edu". */
function normalizeSuffix(value) {
  let s = String(value).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^\*\./, "").replace(/^\./, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return s.split("/")[0].replace(/:\d+$/, "");
}

/* Accept "https://site.github.io", "https://site.github.io/", "https://site.github.io/app/",
   "https://*.github.io", "chrome-extension://<id>", "*", "null" — all become a
   comparable origin pattern. */
function normalizeOrigin(value) {
  let s = String(value).trim().toLowerCase();
  if (!s) return "";
  if (s === "*" || s === "null") return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).origin.toLowerCase();
    } catch {
      return "";
    }
  }
  return s.replace(/\/+$/, "");
}

function resolveCorsOrigin(origin, allowedOrigins) {
  const raw =
    allowedOrigins === undefined || allowedOrigins === null || String(allowedOrigins).trim() === ""
      ? "*"
      : allowedOrigins;
  const list = String(raw).split(",").map(normalizeOrigin).filter(Boolean);
  if (list.includes("*")) return origin || "*";

  const o = String(origin || "").toLowerCase();
  if (!o) return ""; /* non-browser caller — no CORS headers needed */
  if (o === "null") return list.includes("null") ? "null" : "";

  for (const entry of list) {
    if (entry === o) return origin;
    if (entry.includes("*")) {
      const rx = new RegExp(
        "^" + entry.split("*").map(escapeRegExp).join(".*") + "$"
      );
      if (rx.test(o)) return origin;
    }
  }
  return "";
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preflight(corsOrigin, origin) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": corsOrigin || origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-CSRF-Token",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function json(body, status, corsOrigin) {
  const headers = { "Content-Type": "application/json", Vary: "Origin" };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  return new Response(JSON.stringify(body), { status, headers });
}
