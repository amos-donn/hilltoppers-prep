/* Hiltoppers Canvas CORS proxy — Cloudflare Worker.
 *
 * Transparent passthrough: the caller's own Canvas token travels in the
 * Authorization header on every request and is NEVER stored, logged, or
 * rewritten here. Deploy once, paste the worker URL into the topping's
 * Settings, done.
 *
 * Usage:  GET https://<worker>/?url=<URL-encoded absolute Canvas URL>
 * The target host must end with an allowed suffix (default: instructure.com).
 * Configure via Worker env vars:
 *   ALLOWED_ORIGINS    comma-separated origins allowed to call the proxy.
 *                      "*" (default) allows any. Example:
 *                      https://amos-donn.github.io,chrome-extension://<id>
 *   ALLOWED_SUFFIXES   comma-separated target host suffixes.
 *                      Default: instructure.com
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
      return preflight(corsOrigin);
    }
    if (!corsOrigin && origin) {
      return json({ error: "Origin not allowed" }, 403, "");
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
      const suffixes = splitList((env && env.ALLOWED_SUFFIXES) || "instructure.com");
      if (!suffixes.some((s) => host === s || host.endsWith("." + s))) {
        return json({ error: "Target host not allowed" }, 403, corsOrigin);
      }
      if (targetUrl.protocol !== "https:") {
        return json({ error: "Unsupported protocol" }, 400, corsOrigin);
      }
      if (BLOCKED_HOSTS.test(host)) {
        return json({ error: "Target host not allowed" }, 403, corsOrigin);
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

function splitList(value) {
  return String(value)
    .split(",")
    .map((s) => s.trim().replace(/^\*\./, "").toLowerCase())
    .filter(Boolean);
}

function resolveCorsOrigin(origin, allowedOrigins) {
  const list = splitList(allowedOrigins === undefined || allowedOrigins === "" ? "*" : allowedOrigins);
  if (list.includes("*")) return origin || "*";
  return list.includes(origin.toLowerCase()) ? origin : "";
}

function preflight(corsOrigin) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": corsOrigin || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-CSRF-Token",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function json(body, status, corsOrigin) {
  const headers = { "Content-Type": "application/json" };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  return new Response(JSON.stringify(body), { status, headers });
}
