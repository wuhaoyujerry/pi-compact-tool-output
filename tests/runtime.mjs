import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const extensionPath = fileURLToPath(new URL("../extensions/compact-tool-output.ts", import.meta.url));
const localModules = fileURLToPath(new URL("../node_modules/", import.meta.url));
const agentPackage = (harness) => harness === "pi" ? "@earendil-works/pi-coding-agent" : "@code-yeongyu/senpi";

export function nodeModulesFor(harness) {
  const configured = process.env[harness === "pi" ? "PI_TEST_NODE_MODULES" : "OMO_TEST_NODE_MODULES"];
  if (configured) return configured;
  if (existsSync(join(localModules, agentPackage(harness)))) return localModules;
  return harness === "pi"
    ? join(homedir(), ".pi/agent/install/releases/1.0.2/node_modules")
    : join(homedir(), ".bun/install/global/node_modules");
}

export function displayExtensionFor(runtime, harness) {
  const configured = process.env[harness === "pi" ? "PI_DISPLAY_EXTENSION" : "OMO_DISPLAY_EXTENSION"];
  if (configured) return configured;
  const local = join(runtime, "@zhcsyncer/pi-tool-display-intent/extensions/tool-display-intent.ts");
  return existsSync(local) ? local
    : join(homedir(), harness === "pi" ? ".pi" : ".omo", "agent/npm/node_modules/@zhcsyncer/pi-tool-display-intent/extensions/tool-display-intent.ts");
}

export async function tuiFor(runtime, harness) {
  let current = realpathSync(join(runtime, agentPackage(harness)));
  while (true) {
    const entry = join(current, "node_modules/@earendil-works/pi-tui/dist/index.js");
    if (existsSync(entry)) return import(pathToFileURL(entry).href);
    const parent = dirname(current);
    if (parent === current) throw new Error("Cannot locate the harness's pi-tui dependency");
    current = parent;
  }
}
