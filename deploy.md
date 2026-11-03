# Deploy — ScreenGrabber

Project-specific notes for the shared screenshot API at `shots.baffledcat.com`.

## App shape

| Item | Value |
|---|---|
| Runtime | AWS Lambda Node 20 (`api/`), API Gateway HTTP API |
| Package | `function.zip` via `api/scripts/pack.mjs` → `Export/Local` or `Export/VersionN` |
| Admin UI | Embedded HTML from `api/src/adminHtml.js`, served at `/admin` |
| Asset-version | `self.__SCREENGRABBER_ASSET_VERSION__` in admin HTML; `/health` returns `{ version }` |
| Public URL | `https://shots.baffledcat.com` |
| Region | `eu-west-2` |
| S3 (images) | private bucket `baffledcat-shots` (not a website sync) |

This is not a static site under `baffledcat.com/<prefix>/`. Deploy Prod updates the Lambda
code and configuration; it does not `aws s3 sync` HTML to the website bucket.

## Versioning

| Deploy | Folder | Version |
|---|---|---|
| Local | `Export/Local` (replaced each run) | `0.0.C` |
| Prod | `Export/VersionN` (never overwritten) | `0.N.C` |

`C` is `git rev-list --count HEAD` of the source commit (taken before any VERSION claim).
`N` is claimed on GitHub via `scripts/release-version.mjs` (`VERSION` at repo root), with
`highestRelease()` as a floor. Both deploys refuse a dirty tree; Deploy Prod also requires
HEAD on the upstream branch. Each package writes `build.json` (version, n, c, source, hashes).

Packaging stamps `ASSET_VERSION` into the Lambda zip (`api/src/version.js` in the bundle).
The source tree keeps `"dev"`. `Export/*/index.html` is a status page for Deploy Local’s
static preview only.

## Repository commands

| Action | What it does |
|---|---|
| **Run Local** (`RunLocal.cmd`) | Opens `StartServer.cmd` — static preview of the working tree (SDK/docs). No local API. |
| **Deploy Local** (`DeployLocal.cmd`) | Clean tree → package `Export/Local` as `0.0.C` → serve that folder on `PORT` or **8092**. |
| **Deploy Prod** (`DeployProd.cmd`) | Humans only. Clean tree + HEAD on upstream → claim N → package `Export/VersionN` → update Lambda code/config → verify live `/health.version`. |

```powershell
.\RunLocal.cmd
.\DeployLocal.cmd
# $env:PORT=7140; node actions\DeployLocal.mjs
# .\DeployProd.cmd   # humans / dashboard only — agents never run this
```

Agents may run Deploy Local with their assigned `PORT`. Agents never run Deploy Prod,
`scripts/ensure-aws.ps1` with live credentials for production uploads, or AWS syncs to live.

## First-time / repair infra

If the Lambda, bucket, tables, IAM role, HTTP API or custom domain are missing, a human runs:

```powershell
.\scripts\ensure-aws.ps1
```

That script provisions resources and can also pack+deploy for repair. Day-to-day releases
use **Deploy Prod** only.

Secrets: `api/.deploy-secrets.env` (gitignored). Allowlists:
`api/config.production.json` → Lambda `ALLOWED_ORIGINS` / `ALLOWED_APP_IDS`.

## Smoke-test checklist

After Deploy Local (`http://127.0.0.1:8092/` or `PORT`):

- [ ] Status page shows `0.0.C` matching `Export/Local/build.json`
- [ ] `function.zip` is present and hashed in `build.json`
- [ ] Working tree stayed clean (deploy refused otherwise)

After a human runs Deploy Prod:

- [ ] `GET https://shots.baffledcat.com/health` → `{ "ok": true, "version": "0.N.C" }`
- [ ] Admin page contains `self.__SCREENGRABBER_ASSET_VERSION__ = "0.N.C"`
- [ ] `Export/VersionN/build.json` names the intended source commit
- [ ] Allowlist changes in `config.production.json` are live (upload from a registered app)
