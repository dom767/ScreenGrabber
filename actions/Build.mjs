import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, [join(repoRoot, "api", "scripts", "pack.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
