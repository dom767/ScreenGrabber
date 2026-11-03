import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path, { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, "..");

/**
 * Install production deps into api/dist and zip them.
 * @param {{version?: string, zipOut?: string}} [opts]
 * @returns {{zipPath: string, size: number}}
 */
export function packApi(opts = {}) {
  const version = opts.version ?? "dev";
  const dist = join(apiRoot, "dist");
  const zipPath = opts.zipOut ?? join(apiRoot, "function.zip");

  rmSync(dist, { recursive: true, force: true });
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  mkdirSync(dist, { recursive: true });
  mkdirSync(dirname(zipPath), { recursive: true });

  cpSync(join(apiRoot, "src"), join(dist, "src"), { recursive: true });
  cpSync(join(apiRoot, "package.json"), join(dist, "package.json"));
  writeFileSync(
    join(dist, "src", "version.js"),
    `/** Stamped at package time. */\nexport const ASSET_VERSION = ${JSON.stringify(version)};\n`,
    "utf8",
  );

  execSync("npm install --omit=dev --no-audit --no-fund", {
    cwd: dist,
    stdio: "inherit",
  });

  let archived = false;
  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${dist.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
        { stdio: "inherit" },
      );
      archived = true;
    }
  } catch {
    archived = false;
  }

  if (!archived) {
    execSync(`cd "${dist}" && zip -r "${zipPath}" .`, { stdio: "inherit", shell: true });
  }

  if (!existsSync(zipPath)) {
    throw new Error("Failed to create function.zip");
  }

  const size = readFileSync(zipPath).length;
  writeFileSync(join(dist, ".pack-ok"), String(size));
  console.log(`Packed ${zipPath} (${Math.round(size / 1024)} KiB) as ${version}`);
  return { zipPath, size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packApi({ version: process.argv[2] || "dev" });
}
