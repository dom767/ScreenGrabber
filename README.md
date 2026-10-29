# ScreenGrabber

Shared screenshot API, storage, SDK, and admin UI for baffledcat.com apps.

Consumer apps (e.g. [MandelbrotViewer](../MandelbrotViewer)) vendor the browser SDK and own their capture / map-pin UI. Each app pulls the canonical SDK during its own export; deploying ScreenGrabber never changes another repository.

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

Consumer repositories own their vendored SDK and configuration. Their export process
should pull the canonical
[`sdk/baffled-screenshots.js`](sdk/baffled-screenshots.js) from
`https://raw.githubusercontent.com/dom767/ScreenGrabber/master/sdk/baffled-screenshots.js`
into `js/vendor/baffled-screenshots.js` before bundling. The export should fail if the
SDK cannot be refreshed rather than silently shipping a stale copy. This keeps SDK
updates explicit in the app that consumes them and removes ScreenGrabber's dependency
on local paths to sibling repositories.

The stable production API base is `https://shots.baffledcat.com`; consumer
`js/shotsConfig.js` files set it directly. Register allowed app IDs and origins in
[`api/config.production.json`](api/config.production.json).

### Take Screenshot GUI

Consumer apps should follow [`TAKE_SCREENSHOT_GUI.md`](TAKE_SCREENSHOT_GUI.md) for a consistent **"Take Screenshot"** panel (live preview, brightness and contrast sliders, **"Upload to baffledcat.com"** checkbox, and **"Capture"** button that downloads locally and optionally uploads).

## Repository commands

AgentController discovers the three Node actions under `actions/`. The matching
root `.cmd` wrappers work from Explorer or a terminal. Node.js 20+ and npm are
required. Set `AC_NO_PAUSE=1` for unattended wrappers; otherwise they pause on failure.

| Command | Behaviour |
| --- | --- |
| `Build.cmd` / `node actions/Build.mjs` | Install production dependencies in `api/dist` and package `api/function.zip`, without publishing or accessing deployment secrets. |
| `DeployLocal.cmd` / `node actions/DeployLocal.mjs` | Build the same local bundle and print its location and local limitations. |
| `DeployProd.cmd` / `node actions/DeployProd.mjs` | Human-only production deployment through the existing `DeployScreengrabber.ps1` workflow. |

Build reuses `api/scripts/pack.mjs`; its archive step currently requires Windows
PowerShell on Windows or the `zip` executable elsewhere. npm needs access to the
package registry (or cached dependencies). Build replaces `api/dist` and
`api/function.zip`; it does not claim a release number or call AWS.

There is no local API runner, isolated dev stack, or AWS emulator configured for
this service. **Deploy Local means local packaging only**: it starts no server
and deploys no cloud resources. The Lambda expects API Gateway events and AWS
S3/DynamoDB services, so this bundle alone is not a runnable local API.

The production action is a migration bridge to the existing PowerShell script,
preserving Lambda + API Gateway provisioning, production allowlists, and secret
handling. It requires Windows PowerShell (or `pwsh` elsewhere) and AWS CLI.
Agents may run Build and Deploy Local; they must never run Deploy Prod, including
the legacy production entry points or their `-DryRun` mode.

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
.\DeployProd.cmd
# or: node actions/DeployProd.mjs
```

`DeployScreengrabber.ps1` will:

1. Pack + deploy Lambda `baffledcat-screenshots`
2. Ensure S3 bucket + DynamoDB tables + IAM role + HTTP API
3. Request/wire ACM for `shots.baffledcat.com` and print DNS CNAMEs
4. Smoke-test `/health`

Flags are forwarded unchanged: `-SkipSecrets`, `-SkipDomain`,
`-CloudflareTeardown` (opt-in; off by default), `-DryRun`.
`DeployScreengrabber.cmd` remains a compatibility alias for Deploy Prod;
`DeployScreengrabber.ps1` remains the production implementation. Even `-DryRun`
uses AWS credentials and reads deployment secrets; use Build for packaging only.

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

FluidSimulator is registered as `fluidsimulator`, with production origin
`https://baffledcat.com` and development origins `http://localhost:7100` and
`http://127.0.0.1:7100`. It vendors the canonical SDK, uses
`https://shots.baffledcat.com`, and sends JPEG images up to 1920x1080 and 2 MiB
with a 256x256 JPEG thumbnail.

Its public Turnstile site key is `0x4AAAAAAFWa6VDrVl29LSiw`, with
`devBypassTurnstile: false`. On 2026-10-29 this matched the configuration in the
public deployed Mandelbrot bundle at
`https://baffledcat.com/mandelbrot/app.bundle.min.js?v=6`. Public client
configuration does not prove the API secret belongs to that widget. A human
must confirm that association in Cloudflare and ensure the widget permits
`baffledcat.com`, `localhost`, and `127.0.0.1` (hostname settings, without ports).
Any widget hostname changes remain a human step.

To activate this registration, a human must run the production deploy from this
repository (`.\DeployProd.cmd`), which applies the allowlists to Lambda.
Keep production `DEV_BYPASS_TURNSTILE=0`. Registration changes alone do not update
the deployed API; no deployment or widget changes were performed for this registration.

### Validation & failed-attempt logging

To avoid giving hints to attackers probing `POST /v1/ticket` or `POST /v1/shots`, validation failures (unrecognised `appId`, disallowed `origin`, invalid image dimensions/MIME, bad/expired ticket, Turnstile failure, or rate-limiting) still return a normal-looking `200` success payload without storing the image:

- Failed attempts are written as structured JSON logs to the private S3 bucket under `s3://baffledcat-shots/logs/failed-attempts/YYYY-MM-DD/<timestamp>-<id>.json` (not accessible via `/i/...`) and to CloudWatch Logs.
- Each failed attempt sends an alert email via Amazon SES (`eu-west-2`) to `images@baffledcat.com` (`ALERT_EMAIL`). Ensure `images@baffledcat.com` (or the `baffledcat.com` domain) is verified in SES.

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
