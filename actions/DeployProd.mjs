#!/usr/bin/env node
// @ts-check
/**
 * Deploy Prod — claim N on GitHub, package Export/VersionN as 0.N.C, update the Lambda at
 * shots.baffledcat.com, and verify /health.version. Humans only. Agents must never run this.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  compareToLocal,
  describe,
  exportRoot,
  highestRelease,
  packageBuild,
  prepareDir,
  requireClean,
  root,
  writeManifest,
} from "./lib/build.mjs";
import {
  assertHeadOnUpstream,
  claimVersion,
  commitCount,
  formatVersion,
  sourceOf,
} from "../scripts/release-version.mjs";

const FUNCTION_NAME = "baffledcat-screenshots";
const PUBLIC_BASE = process.env.SCREENGRABBER_PUBLIC_BASE ?? "https://shots.baffledcat.com";
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-2";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{stdio?: "inherit" | "pipe"}} [o]
 */
function run(command, args, o = {}) {
  console.log([command, ...args].join(" "));
  const r = spawnSync(command, args, {
    stdio: o.stdio ?? "inherit",
    cwd: root,
    env: { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION },
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

/** @returns {string} */
function awsBin() {
  return process.platform === "win32" ? "aws.cmd" : "aws";
}

/** @returns {boolean} */
function awsIdentityOk() {
  const r = spawnSync(awsBin(), ["sts", "get-caller-identity"], {
    stdio: "ignore",
    cwd: root,
    env: process.env,
    windowsHide: true,
  });
  return r.status === 0;
}

function ensureAwsAuth() {
  if (awsIdentityOk()) return;
  console.log("AWS credentials not found. Running aws login…");
  run(awsBin(), ["login"]);
  if (!awsIdentityOk()) {
    console.error("AWS authentication still failed after aws login.");
    process.exit(1);
  }
}

/** @param {string} filePath */
function toFilebUri(filePath) {
  const full = path.resolve(filePath).replace(/\\/g, "/");
  return `fileb://${full}`;
}

/**
 * Read gitignored api/.deploy-secrets.env without printing values.
 * @returns {Record<string, string>}
 */
function readSecrets() {
  /** @type {Record<string, string>} */
  const map = {};
  const file = path.join(root, "api", ".deploy-secrets.env");
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map[t.slice(0, i).trim()] = v;
  }
  return map;
}

/**
 * @param {string} key
 * @param {Record<string, string>} fileMap
 */
function secret(key, fileMap) {
  const fromEnv = process.env[key];
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  if (fileMap[key]) return fileMap[key];
  return "";
}

/**
 * Read the live Lambda environment so a deploy never wipes secrets that aren't in the file.
 * @returns {Record<string, string>}
 */
function currentLambdaEnv() {
  const r = spawnSync(
    awsBin(),
    ["lambda", "get-function-configuration", "--function-name", FUNCTION_NAME, "--output", "json"],
    {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION },
      windowsHide: true,
    },
  );
  if (r.status !== 0) {
    throw new Error(
      `Could not read Lambda configuration for ${FUNCTION_NAME}. Run scripts\\ensure-aws.ps1 first.\n${r.stderr || r.stdout || ""}`,
    );
  }
  try {
    const cfg = JSON.parse(r.stdout || "{}");
    return { ...(cfg.Environment?.Variables || {}) };
  } catch {
    return {};
  }
}

/**
 * Build Lambda environment JSON file (path returned). Does not log secret values.
 * Merges with the live function env so omitted secrets are preserved.
 * @param {string} publicBase
 * @param {Record<string, string>} fileMap
 */
function writeLambdaEnvFile(publicBase, fileMap) {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "api", "config.production.json"), "utf8"),
  );
  const allowedOrigins = (config.allowedOrigins || []).map(String).join(",");
  const allowedAppIds = (config.allowedAppIds || []).map(String).join(",");
  if (!allowedOrigins || !allowedAppIds) {
    throw new Error("api/config.production.json must define allowedOrigins and allowedAppIds");
  }

  /** @type {Record<string, string>} */
  const vars = {
    ...currentLambdaEnv(),
    SHOTS_TABLE: "baffledcat-shots",
    TICKETS_TABLE: "baffledcat-shots-tickets",
    SHOTS_BUCKET: "baffledcat-shots",
    FAILED_LOG_PREFIX: "logs/failed-attempts",
    ALERT_EMAIL: "images@baffledcat.com",
    ALERT_FROM_EMAIL: "images@baffledcat.com",
    ALLOWED_ORIGINS: allowedOrigins,
    ALLOWED_APP_IDS: allowedAppIds,
    PUBLIC_BASE_URL: publicBase,
    MAX_UPLOAD_BYTES: "2097152",
    MAX_EDGE: "1920",
    THUMB_EDGE: "256",
    TICKET_TTL_SEC: "120",
  };

  const turnstile = secret("TURNSTILE_SECRET", fileMap);
  if (turnstile) vars.TURNSTILE_SECRET = turnstile;

  let devBypass = process.env.DEV_BYPASS_TURNSTILE;
  if (devBypass == null && Object.prototype.hasOwnProperty.call(fileMap, "DEV_BYPASS_TURNSTILE")) {
    devBypass = fileMap.DEV_BYPASS_TURNSTILE;
  }
  if (devBypass != null) vars.DEV_BYPASS_TURNSTILE = String(devBypass);
  else if (vars.DEV_BYPASS_TURNSTILE == null) {
    vars.DEV_BYPASS_TURNSTILE = vars.TURNSTILE_SECRET ? "" : "1";
  }

  const ticket = secret("TICKET_HMAC_SECRET", fileMap);
  const admin = secret("ADMIN_TOKEN", fileMap);
  if (ticket) vars.TICKET_HMAC_SECRET = ticket;
  if (admin) vars.ADMIN_TOKEN = admin;

  if (!vars.TICKET_HMAC_SECRET || !vars.ADMIN_TOKEN) {
    throw new Error(
      "Lambda is missing TICKET_HMAC_SECRET or ADMIN_TOKEN. Put them in api/.deploy-secrets.env or run scripts\\ensure-aws.ps1 once.",
    );
  }

  const envPath = path.join(root, "api", ".deploy-lambda-env.json");
  fs.writeFileSync(envPath, JSON.stringify({ Variables: vars }) + "\n", "utf8");
  return envPath;
}

/**
 * @param {string} expectedVersion
 */
async function verifyLiveVersion(expectedVersion) {
  const url = `${PUBLIC_BASE.replace(/\/$/, "")}/health`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok || body.version !== expectedVersion) {
    throw new Error(
      `Live /health version mismatch: expected ${expectedVersion}, got ${JSON.stringify(body)}`,
    );
  }
  console.log(`Verified live version ${expectedVersion} at ${url}`);
}

try {
  const source = sourceOf(root);
  requireClean(source);
  assertHeadOnUpstream(root);
  const c = commitCount(root);
  const n = claimVersion(root, { floor: highestRelease() });
  const version = formatVersion(n, c);
  console.log(`Deploy Prod: ${describe(version, source)}`);

  const dir = prepareDir(path.join(exportRoot, `Version${n}`));
  await packageBuild({ dir, version });
  const manifest = writeManifest(dir, { version, n, c, source });
  compareToLocal(manifest);

  const zipPath = path.join(dir, "function.zip");
  if (!fs.existsSync(zipPath)) throw new Error(`Missing packaged zip: ${zipPath}`);

  ensureAwsAuth();
  const fileMap = readSecrets();
  const publicBase = secret("PUBLIC_BASE_URL", fileMap) || PUBLIC_BASE;
  const envFile = writeLambdaEnvFile(publicBase, fileMap);

  console.log(`\nUpdating Lambda ${FUNCTION_NAME} from ${path.relative(root, zipPath)}`);
  run(awsBin(), [
    "lambda",
    "update-function-code",
    "--function-name",
    FUNCTION_NAME,
    "--zip-file",
    toFilebUri(zipPath),
  ]);
  run(awsBin(), ["lambda", "wait", "function-updated", "--function-name", FUNCTION_NAME]);
  run(awsBin(), [
    "lambda",
    "update-function-configuration",
    "--function-name",
    FUNCTION_NAME,
    "--environment",
    `file://${path.resolve(envFile).replace(/\\/g, "/")}`,
  ]);
  run(awsBin(), ["lambda", "wait", "function-updated", "--function-name", FUNCTION_NAME]);

  try {
    fs.rmSync(envFile, { force: true });
  } catch {
    /* ignore */
  }

  console.log("Waiting briefly for the new code to serve…");
  await new Promise((r) => setTimeout(r, 3000));
  await verifyLiveVersion(version);
  console.log(`\nDeploy Prod complete: ${version} live at ${PUBLIC_BASE}`);
  console.log("If this is a first-time setup (missing bucket/tables/API), run scripts\\ensure-aws.ps1 once.");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
