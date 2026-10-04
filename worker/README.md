# Hilltoppers Canvas CORS proxy (Cloudflare Worker)

Canvas instances generally do **not** send CORS headers to arbitrary origins,
so browsers block direct API calls from the topping. This Worker is a
transparent passthrough that adds the missing CORS headers. **It never sees or
stores your token** — the `Authorization` header is forwarded untouched on
every request.

## Deploy (dashboard paste — no tooling needed)

1. Cloudflare Dashboard → **Workers & Pages → Create → Worker** (name it e.g. `hilltoppers-canvas-proxy`) → Deploy.
2. **Edit code** → paste the contents of [`index.mjs`](./index.mjs) → Deploy.
3. Worker → **Settings → Variables & Secrets** → add (after first deploy; see security notes):
   - `ALLOWED_ORIGINS` = `https://amos-donn.github.io` (add `chrome-extension://<your-extension-id>` if the extension ever calls it directly)
   - `ALLOWED_SUFFIXES` = `instructure.com` (add other hosts your school uses, e.g. `myschool.edu`)
   - leave `ALLOW_INSECURE` unset.

   Both variables are **normalized**, so the form you copy from the browser
   bar also works. All of these are equivalent:

   | `ALLOWED_ORIGINS` | `ALLOWED_SUFFIXES` |
   |---|---|
   | `https://amos-donn.github.io` | `instructure.com` |
   | `https://amos-donn.github.io/` | `https://stjacademy.instructure.com/` |
   | `https://amos-donn.github.io/hilltoppers-prep/` | `*.instructure.com` |
   | `https://*.github.io` (subdomain wildcard) | `myschool.edu:443` |
   | `null` (sandboxed iframe) | |

   Values are trimmed and lowercased, schemes/paths/trailing slashes/ports are
   stripped, and `*` is allowed as a wildcard. A wrong value is reported back to
   the topping (it reads the refusal body), which then says which variable to
   fix instead of claiming your token was rejected.
4. Copy the worker URL (`https://hilltoppers-canvas-proxy.<your-subdomain>.workers.dev`) into the topping's Settings → "CORS proxy URL" → **Save & refresh**.

## Deploy (wrangler)

```sh
npx wrangler deploy            # from the repo root (uses worker/wrangler.toml)
```

## Local tests

```sh
node --test scripts/worker-test.mjs
```

## Security notes

- Requests without an `Origin` header (curl, server-side) are answered with
  `Access-Control-Allow-Origin: *` — harmless, since browsers, not the proxy,
  are what enforce origin policy. Set `ALLOWED_ORIGINS` to lock browsers in.
- Targets are restricted to `https://` hosts under `ALLOWED_SUFFIXES`
  (default `instructure.com`); private/internal IPs are blocked (SSRF guard).
- A request from a disallowed origin is refused **before** anything is proxied,
  and that 403 echoes the caller's own `Origin` so the topping can display a
  readable reason (`relay refused the request: Origin not allowed — add … to
  ALLOWED_ORIGINS`). No target is ever contacted for a refused caller.
- Only these request headers are forwarded: `Authorization`, `Accept`,
  `Content-Type`, `X-CSRF-Token`. Nothing else — and nothing about the request
  or token is logged or persisted.
