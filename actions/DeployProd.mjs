import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Migration bridge: retain the existing infrastructure and secrets workflow.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const result = spawnSync(powershell, [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", join(repoRoot, "DeployScreengrabber.ps1"),
  ...process.argv.slice(2),
], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
