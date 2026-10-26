# ScreenGrabber

Shared screenshot API, storage, SDK, and admin UI for baffledcat.com apps.

Consumer apps (e.g. [MandelbrotViewer](../MandelbrotViewer)) vendor the browser SDK and own their capture / map-pin UI. Deploy syncs `sdk/baffled-screenshots.js` into each app listed in `apps.json`.

Homepage carousel (repo `Wooexperiments/baffledcat`) is **out of v1** — consume `GET /v1/shots?status=approved` when ready.

## Stack

| Piece | Tech |
| --- | --- |
| API | AWS Lambda (Node 20) + API Gateway HTTP API (`api/`) |
| Images | S3 bucket `baffledcat-shots` (private; served via `/i/...`) |
| Metadata | DynamoDB `baffledcat-shots` (+ `baffledcat-shots-tickets` with TTL) |
| Abuse dampening | CORS allowlist + Turnstile + one-time HMAC tickets + IP rate limits |
| Admin | Served at `/admin` from the Lambda |
| Region | `eu-west-2` |

Public hostname: **`https://shots.baffledcat.com`**.

AWS resource names stay `baffledcat-*` for continuity with the existing production stack.

## Consumer apps

Copy `apps.example.json` → `apps.json` (gitignored) and point each entry at a sibling app:

```json
{
  "apps": [
    {
      "name": "mandelbrot",
      "root": "../MandelbrotViewer",
      "sdkDest": "js/vendor/baffled-screenshots.js",
      "shotsConfig": "js/shotsConfig.js"
    },
    {
      "name": "bifurcation",
      "root": "../BifurcationDiagram",
      "sdkDest": "js/vendor/baffled-screenshots.js",
      "shotsConfig": "js/shotsConfig.js"
    }
  ]
}
```

After deploy, ScreenGrabber copies the SDK to each `sdkDest` and rewrites that app’s `apiBase` in `shotsConfig`.

## Production deploy

From this repo root. Uses your normal **AWS CLI** credentials (`aws sts get-caller-identity`).

Secrets file: `api/.deploy-secrets.env` (gitignored):

```env
AWS_REGION=eu-west-2
TURNSTILE_SECRET=...
# TICKET_HMAC_SECRET / ADMIN_TOKEN generated if omitted
# DEV_BYPASS_TURNSTILE=0
```

```powershell
.\DeployScreengrabber.cmd
# or: .\DeployScreengrabber.ps1
```

`DeployScreengrabber.ps1` will:

1. Pack + deploy Lambda `baffledcat-screenshots`
2. Ensure S3 bucket + DynamoDB tables + IAM role + HTTP API
3. Request/wire ACM for `shots.baffledcat.com` and print DNS CNAMEs
4. Sync SDK + `apiBase` into each app in `apps.json`
5. Smoke-test `/health`

Flags: `-SkipSecrets`, `-SkipDomain`, `-SkipCloudflareTeardown` (default on), `-DryRun`.

### DNS for `shots.baffledcat.com`

1. **ACM validation** CNAME (printed by deploy; required once)
2. **API** CNAME: `shots.baffledcat.com` → the `d-….execute-api.eu-west-2.amazonaws.com` hostname printed after the cert is **ISSUED**

Use DNS-only (grey cloud) if the zone is on Cloudflare DNS.

### Turnstile

1. Create a Turnstile widget (invisible) for `baffledcat.com` (and `localhost` if needed).
2. Put the **secret** in `TURNSTILE_SECRET`.
3. Put the **site key** in each consumer app’s `shotsConfig` and set `devBypassTurnstile: false`.
4. Set `DEV_BYPASS_TURNSTILE=0` (or empty), then redeploy.

The API submits each client token together with `TURNSTILE_SECRET` to
Cloudflare's verification endpoint. The secret must belong to the Turnstile
widget whose public site key is configured in the consumer. If a consumer uses
a different widget, a human must update `TURNSTILE_SECRET` in the gitignored
`api/.deploy-secrets.env` and redeploy; never add the secret to checked-in
configuration.

### CORS / apps

Deployment builds the comma-separated `ALLOWED_ORIGINS` and `ALLOWED_APP_IDS`
Lambda values from [`api/config.production.json`](api/config.production.json).
Origin comparisons are exact; add each production origin explicitly.

## API contract

### `POST /v1/ticket`

```json
{
  "appId": "mandelbrot",
  "bytes": 123456,
  "contentSha256": "<hex sha256 of image bytes>",
  "turnstileToken": "..."
}
```

Returns `{ ticket, expiresIn }`.

### `POST /v1/shots` (multipart)

Fields: `ticket`, `appId`, `image` (file), `thumb` (file, **256×256 JPEG**), optional `pageUrl`, `title`, `note`, `meta` (JSON string).

Image must fit within **1920×1080**. Max bytes default 2 MiB.

### `GET /v1/shots?app_id=mandelbrot&limit=50&cursor=`

Public list of **approved** shots (max `limit` 500).

### Admin

- `GET /v1/admin/shots` — Bearer `ADMIN_TOKEN`
- `PATCH /v1/admin/shots/:id` — `{ "status": "hidden"|"approved"|"pending" }` or hard-delete
- UI: `https://shots.baffledcat.com/admin`

## SDK

Canonical source: [`sdk/baffled-screenshots.js`](sdk/baffled-screenshots.js).

```js
import { createBaffledScreenshots } from "./baffled-screenshots.js";

const shots = createBaffledScreenshots({
  apiBase: "https://shots.baffledcat.com",
  appId: "mandelbrot",
  turnstileSiteKey: "...",
});

await shots.upload({ imageBlob, thumbBlob, pageUrl, meta });
const page = await shots.list({ limit: 50 });
```
