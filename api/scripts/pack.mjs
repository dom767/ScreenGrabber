import { execSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, "..");
const dist = join(apiRoot, "dist");
const zipPath = join(apiRoot, "function.zip");

rmSync(dist, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(dist, { recursive: true });

cpSync(join(apiRoot, "src"), join(dist, "src"), { recursive: true });
cpSync(join(apiRoot, "package.json"), join(dist, "package.json"));

execSync("npm install --omit=dev --no-audit --no-fund", {
  cwd: dist,
  stdio: "inherit",
});

// Prefer system zip / PowerShell Compress-Archive via best-effort
const require = createRequire(import.meta.url);
let archived = false;
try {
  // Use built-in PowerShell on Windows
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${dist.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" }
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
writeFileSync(join(apiRoot, "dist", ".pack-ok"), String(size));
console.log(`Packed ${zipPath} (${Math.round(size / 1024)} KiB)`);
