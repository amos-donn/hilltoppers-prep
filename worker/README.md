# Hiltoppers Canvas CORS proxy (Cloudflare Worker)

Canvas instances generally do **not** send CORS headers to arbitrary origins,
so browsers block direct API calls from the topping. This Worker is a
transparent passthrough that adds the missing CORS headers. **It never sees or
stores your token** — the `Authorization` header is forwarded untouched on
every request.

## Deploy (dashboard paste — no tooling needed)

1. Cloudflare Dashboard → **Workers & Pages → Create → Worker** (name it e.g. `hiltoppers-canvas-proxy`) → Deploy.
2. **Edit code** → paste the contents of [`index.mjs`](./index.mjs) → Deploy.
3. Worker → **Settings → Variables & Secrets** → add (after first deploy; see security notes):
   - `ALLOWED_ORIGINS` = `https://amos-donn.github.io` (add `chrome-extension://<your-extension-id>` if the extension ever calls it directly)
   - `ALLOWED_SUFFIXES` = `instructure.com` (add other hosts your school uses, e.g. `myschool.edu`)
   - leave `ALLOW_INSECURE` unset.
4. Copy the worker URL (`https://hiltoppers-canvas-proxy.<your-subdomain>.workers.dev`) into the topping's Settings → "CORS proxy URL" → **Save & refresh**.

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
- Only these request headers are forwarded: `Authorization`, `Accept`,
  `Content-Type`, `X-CSRF-Token`. Nothing else — and nothing about the request
  or token is logged or persisted.
