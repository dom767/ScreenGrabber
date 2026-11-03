#!/usr/bin/env node
// @ts-check
/**
 * Run Local — serve the working tree (mainline source, no packaging) on this machine.
 * Opens StartServer.cmd in its own window and returns, so the dashboard isn't left waiting;
 * closing that window stops the server (see guidelines/repository-commands.md).
 * Agents use StartServer.cmd directly with their assigned PORT instead of this action.
 */
import fs from "node:fs";
import path from "node:path";
import { openWindow, root } from "./lib/build.mjs";

if (!fs.existsSync(path.join(root, "StartServer.cmd"))) {
  console.error("Run Local: no StartServer.cmd at the repo root (see guidelines/start-scripts.md).");
  process.exit(1);
}
openWindow(`${path.basename(root)} local server`, ".\\StartServer.cmd");
console.log(`Run Local: started StartServer.cmd in a new window (${root}). Close that window to stop it.`);
