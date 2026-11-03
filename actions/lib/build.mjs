// @ts-check
/**
 * Shared by Run Local / Deploy Local / Deploy Prod (guidelines/repository-commands.md, export.md).
 * Each deploy packages a fresh build: Deploy Local into Export/Local (0.0.C), Deploy Prod into
 * Export/VersionN (0.N.C). There is no separate Build action and no __VERSION__ stamp step.
 *
 * Each app fills in `packageBuild({ dir, version })` below (bundle, copy data, write HTML with
 * the version already in every local script/stylesheet URL and the asset-version global).
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const exportRoot = path.join(root, "Export");

/** @param {RegExp} re */
function highest(re) {
  if (!fs.existsSync(exportRoot)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(exportRoot)) {
    const m = re.exec(name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** The highest release folder (Export/VersionN): the floor for claimVersion, so a number is never reused. */
export function highestRelease() {
  return highest(/^Version(\d+)$/);
}

const ASSET_VERSION_GLOBAL = "__SCREENGRABBER_ASSET_VERSION__";

/**
 * Package the Lambda zip and a small status page into `dir`, stamped with `version`.
 * ScreenGrabber is an API (not a static app): the live version is `/health`.version and the
 * admin asset-version global; Export/ also gets an index.html so Deploy Local can serve it.
 * @param {{dir: string, version: string}} args
 */
export async function packageBuild({ dir, version }) {
  const { packApi } = await import("../../api/scripts/pack.mjs");
  const zipPath = path.join(dir, "function.zip");
  packApi({ version, zipOut: zipPath });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ScreenGrabber ${version}</title>
  <script>self.${ASSET_VERSION_GLOBAL} = "${version}";</script>
</head>
<body>
  <h1>ScreenGrabber ${version}</h1>
  <p>Lambda package: <code>function.zip</code>. Production serves the API at
  <a href="https://shots.baffledcat.com/health">shots.baffledcat.com</a>; there is no local API runner.</p>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
}

/**
 * Refuse to deploy when the working tree has uncommitted changes. Call before claiming a number.
 * @param {{uncommittedChanges?: boolean}} source  from sourceOf()
 */
export function requireClean(source) {
  if (source?.uncommittedChanges) {
    throw new Error("Uncommitted changes: commit first before deploying.");
  }
}

/**
 * One line for the top of a deploy's log: version string and source commit.
 * @param {string} version
 * @param {{commit?: string} | null | undefined} source
 */
export function describe(version, source) {
  const commit = source?.commit ? String(source.commit).slice(0, 7) : "(unknown)";
  return `version ${version} from ${commit}`;
}

/** @param {string} dir */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/**
 * Clear (if needed) and create an export folder ready for packaging.
 * @param {string} dir
 * @param {{replace?: boolean}} [o]  replace: wipe an existing folder (Export/Local). Release folders never replace.
 */
export function prepareDir(dir, o = {}) {
  if (fs.existsSync(dir)) {
    if (!o.replace) throw new Error(`Refusing to overwrite ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fail if any local script or stylesheet in the packaged HTML lacks `?v=<version>`.
 * Third-party absolute URLs (http, //) are skipped.
 * @param {string} dir
 * @param {string} version
 */
export function assertVersioned(dir, version) {
  const needle = `?v=${version}`;
  const missing = [];
  for (const f of listFiles(dir).filter((p) => p.endsWith(".html"))) {
    const html = fs.readFileSync(f, "utf8");
    const re = /<(?:script[^>]+src|link[^>]+href)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1];
      if (/^(?:https?:|\/\/)/i.test(url)) continue;
      if (!/\.(?:js|mjs|css)(?:$|\?)/i.test(url)) continue;
      if (!url.includes(needle)) missing.push(`${path.relative(dir, f)}: ${url}`);
    }
  }
  if (missing.length) {
    throw new Error(`Packaged HTML is missing ?v=${version} on local script/stylesheet URLs:\n  ${missing.join("\n  ")}`);
  }
}

/**
 * SHA-256 of every shipped file except HTML, keyed by path relative to `dir` (forward slashes).
 * @param {string} dir
 */
export function fileHashes(dir) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const f of listFiles(dir)) {
    if (f.endsWith(".html")) continue;
    if (path.basename(f) === "build.json") continue;
    const rel = path.relative(dir, f).split(path.sep).join("/");
    hashes[rel] = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  }
  return hashes;
}

/**
 * Write `build.json` next to the packaged output. Calls `assertVersioned` first.
 * @param {string} dir
 * @param {{version: string, n: number, c: number, source: {commit: string, uncommittedChanges?: boolean}}} info
 */
export function writeManifest(dir, info) {
  assertVersioned(dir, info.version);
  const manifest = {
    version: info.version,
    n: info.n,
    c: info.c,
    source: {
      commit: info.source.commit,
      uncommittedChanges: !!info.source.uncommittedChanges,
    },
    builtAt: new Date().toISOString(),
    files: fileHashes(dir),
  };
  fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Read Export/Local/build.json when present.
 * @returns {null | {version: string, n: number, c: number, source: {commit: string}, builtAt: string, files: Record<string, string>}}
 */
export function readLocalManifest() {
  const file = path.join(exportRoot, "Local", "build.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * After Deploy Prod packages, compare non-HTML hashes to Export/Local when that local build
 * has the same source commit. Differences are warnings only; they never block the deploy.
 * @param {{source: {commit: string}, files: Record<string, string>}} prod
 */
export function compareToLocal(prod) {
  const local = readLocalManifest();
  if (!local?.source?.commit || local.source.commit !== prod.source.commit) return;
  const localFiles = local.files ?? {};
  const prodFiles = prod.files ?? {};
  const names = new Set([...Object.keys(localFiles), ...Object.keys(prodFiles)]);
  /** @type {string[]} */
  const diffs = [];
  for (const name of [...names].sort()) {
    if (localFiles[name] !== prodFiles[name]) diffs.push(name);
  }
  if (!diffs.length) {
    console.log(`bundles identical to the local build of ${prod.source.commit.slice(0, 7)}`);
    return;
  }
  for (const name of diffs) {
    console.warn(`differs from local build: ${name}`);
  }
}

/**
 * Open a command in its own console window and return at once (the dashboard waits for an
 * action to exit). Closing the window stops it.
 * @param {string} title
 * @param {string} command  run by cmd /k in the repo root; no & | < > (the outer cmd would take them)
 */
export function openWindow(title, command) {
  const env = { ...process.env };
  delete env.AC_NO_PAUSE; // the new window is for a human: keep it open on errors
  const child = spawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd", "/k", command], {
    cwd: root,
    env,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.unref();
}
