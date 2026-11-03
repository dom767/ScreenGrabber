#!/usr/bin/env node
/**
 * Release version numbers, shared through GitHub, so every machine exporting this repo uses the
 * same chain of numbers (they go into ?v= cache-busting, so a number must never be reused).
 *
 * VERSION (repo root, committed) holds the last released number N. A release is stamped
 * `0.N.C` where C is the source commit count (`git rev-list --count HEAD`) taken before the
 * VERSION claim, so it names the code that was packaged. Local deploys use `0.0.C` and never
 * claim a number.
 *
 * Claiming the next N:
 *   1. fetch, and read VERSION from origin's branch (not from this clone);
 *   2. next = the highest of that, this clone's VERSION and any local floor, plus 1;
 *   3. commit only VERSION on top of origin's branch, without touching your working copy or
 *      staged files (so none of your own changes go with it), and push it;
 *   4. if the push is refused, another machine took that number: go round again.
 * The number is claimed before packaging for prod, so two machines can never ship the same one;
 * if the upload then fails, a skipped number does no harm.
 *
 *   node scripts/release-version.mjs current   prints the last released number
 *   node scripts/release-version.mjs claim     claims the next one, pushes it, prints it
 *
 * Canonical copy: AgentController/standards/tools/release-version.mjs (see guidelines/export.md). Each repo
 * keeps a copy at scripts/release-version.mjs; the CLI works on the repo the scripts/ folder is in.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "VERSION";

/**
 * @param {string} root
 * @param {string[]} args
 * @param {{input?: string, env?: NodeJS.ProcessEnv}} [o]
 */
function git(root, args, o = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input: o.input,
    env: o.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/** "12\n" → 12; anything else → 0. @param {string | undefined} text */
function parse(text) {
  const n = Number.parseInt(String(text ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The last released number, as this clone has it. @param {string} root */
export function currentVersion(root) {
  const file = path.join(root, FILE);
  return fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : 0;
}

/**
 * Commit count of HEAD (C in `0.N.C`). Take it before claiming VERSION so it names the packaged
 * source, not the release commit.
 * @param {string} root
 */
export function commitCount(root) {
  return Number.parseInt(git(root, ["rev-list", "--count", "HEAD"]), 10);
}

/**
 * Version string written into HTML: local is `0.0.C`, a release is `0.N.C`.
 * @param {number} n  release number (0 for local)
 * @param {number} c  commit count
 */
export function formatVersion(n, c) {
  return `0.${n}.${c}`;
}

/** The branch this clone's branch tracks, e.g. {remote: "origin", branch: "main"}. @param {string} root */
function upstream(root) {
  let ref = "";
  try {
    ref = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  } catch {
    try {
      ref = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
      throw new Error("Can't tell which GitHub branch to release from: this branch tracks nothing and origin has no HEAD.");
    }
  }
  const i = ref.indexOf("/");
  return { remote: ref.slice(0, i), branch: ref.slice(i + 1) };
}

/**
 * Fetch and require that HEAD is an ancestor of (or equal to) the GitHub branch, so C names a
 * commit every machine can see. Call before claiming a number.
 * @param {string} root
 */
export function assertHeadOnUpstream(root) {
  const { remote, branch } = upstream(root);
  const base = `${remote}/${branch}`;
  try {
    git(root, ["fetch", "-q", remote, branch]);
  } catch (err) {
    throw new Error(`Couldn't reach GitHub to check that HEAD is on ${base}: ${firstLine(err)}`);
  }
  try {
    // exit 0 ⇒ HEAD is an ancestor of base (or equal)
    git(root, ["merge-base", "--is-ancestor", "HEAD", base]);
  } catch {
    throw new Error(`HEAD is not on GitHub (${base}): push first so the release names a commit every machine can see.`);
  }
  return { remote, branch, base };
}

/**
 * Claim the next release number on GitHub. Returns it.
 * @param {string} root  the repo
 * @param {{floor?: number, log?: (msg: string) => void}} [o]  floor: never go below this (e.g. the highest local export folder)
 */
export function claimVersion(root, o = {}) {
  const log = o.log ?? ((m) => console.log(m));
  const { remote, branch } = upstream(root);
  const base = `${remote}/${branch}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      git(root, ["fetch", "-q", remote, branch]);
    } catch (err) {
      throw new Error(`Couldn't reach GitHub to claim a version number, so nothing was released: ${firstLine(err)}`);
    }
    let onGitHub = 0;
    try {
      onGitHub = parse(git(root, ["show", `${base}:${FILE}`]));
    } catch {
      // No VERSION on GitHub yet: this is the first claim.
    }
    const n = Math.max(onGitHub, currentVersion(root), o.floor ?? 0) + 1;

    // A commit of just VERSION on top of origin's branch, built in a scratch index.
    const blob = git(root, ["hash-object", "-w", "--stdin"], { input: `${n}\n` });
    const index = path.join(os.tmpdir(), `release-version-${process.pid}-${Date.now()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    let commit;
    try {
      git(root, ["read-tree", base], { env });
      git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${FILE}`], { env });
      const tree = git(root, ["write-tree"], { env });
      commit = git(root, ["commit-tree", tree, "-p", base, "-m", `chore(release): claim release version ${n}`]);
    } finally {
      fs.rmSync(index, { force: true });
    }
    try {
      git(root, ["push", "-q", remote, `${commit}:refs/heads/${branch}`]);
    } catch (err) {
      if (/rejected|fetch first|non-fast-forward/i.test(String(/** @type {any} */ (err).stderr ?? err))) {
        log(`Version ${n} was taken meanwhile; trying the next one.`);
        continue;
      }
      throw new Error(`Couldn't push the version number, so nothing was released: ${firstLine(err)}`);
    }
    log(`Claimed release version ${n} on GitHub (${base}).`);
    catchUp(root, base, log);
    return n;
  }
  throw new Error("Couldn't claim a version number after 5 tries (other machines kept taking them).");
}

/**
 * Bring this clone up to the claimed commit if it's a plain fast-forward; otherwise say so and
 * leave it (your own work is never touched).
 * @param {string} root
 * @param {string} base
 * @param {(msg: string) => void} log
 */
function catchUp(root, base, log) {
  try {
    git(root, ["fetch", "-q", ...base.split("/")]);
    // A VERSION left changed by the old way of numbering is superseded by the claim.
    if (git(root, ["status", "--porcelain", "--", FILE])) git(root, ["checkout", "--", FILE]);
    git(root, ["merge", "-q", "--ff-only", base]);
  } catch {
    log(`This clone isn't a plain fast-forward of ${base}; pull when you're ready to pick up the new VERSION.`);
  }
}

/**
 * What a release was built from, for the export manifest.
 * @param {string} root
 */
export function sourceOf(root) {
  try {
    return { commit: git(root, ["rev-parse", "HEAD"]), uncommittedChanges: !!git(root, ["status", "--porcelain"]) };
  } catch {
    return { commit: "", uncommittedChanges: false };
  }
}

/** @param {unknown} err */
function firstLine(err) {
  const e = /** @type {any} */ (err);
  return String(e?.stderr || e?.message || e).trim().split("\n")[0];
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cmd = process.argv[2];
  try {
    if (cmd === "current") console.log(currentVersion(root));
    else if (cmd === "claim") {
      const floor = Number(process.argv[3]) || 0;
      // Progress on stdout too (Windows PowerShell treats stderr as an error); the number is the last line.
      const n = claimVersion(root, { floor });
      console.log(n);
    } else {
      console.error("Usage: node scripts/release-version.mjs current | claim [floor]");
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
