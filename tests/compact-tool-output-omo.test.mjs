import { extensionPath, nodeModulesFor, displayExtensionFor, tuiFor } from "./runtime.mjs";
// Run: bun tests/compact-tool-output-omo.test.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const runtime = nodeModulesFor("omo");
const agent = `${runtime}/@code-yeongyu/senpi/dist`;
const moduleAt = (path) => import(pathToFileURL(path).href);
const { loadExtensions } = await moduleAt(`${agent}/core/extensions/loader.js`);
const { InteractiveMode } = await moduleAt(`${agent}/modes/interactive/interactive-mode.js`);
const { initTheme, theme } = await moduleAt(`${agent}/modes/interactive/theme/theme.js`);
const { ToolExecutionComponent } = await moduleAt(`${agent}/modes/interactive/components/tool-execution.js`);
const { createAllToolDefinitions } = await moduleAt(`${agent}/core/tools/index.js`);
const { Text, visibleWidth, stripTerminalSequences } = await tuiFor(runtime, "omo");

initTheme("dark");
const originalHook = InteractiveMode.prototype.getRegisteredToolDefinition;
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
loaded.runtime.getAllTools = () => [];
assert.equal(extension.tools.size, 0, "display adapter never overrides tool execution");
const definitions = createAllToolDefinitions(process.cwd());
const content = [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `Line ${i}: 界 😀 ${"x".repeat(80)}`).join("\n") }];
const before = JSON.stringify(content);
const details = { diff: Array.from({ length: 20 }, (_, i) => `-${i + 1} old\n+${i + 1} new`).join("\n"), firstChangedLine: 1 };
const mode = { session: { getToolDefinition: (name) => definitions[name] } };
const resolve = (name) => InteractiveMode.prototype.getRegisteredToolDefinition.call(mode, name);

try {
  for (const colorMode of ["dark", "light"]) {
    initTheme(colorMode);
    for (const name of ["bash", "read", "grep", "edit", "write", "apply_patch", "eval", "mcp_example", "custom"]) {
      const args = name === "bash" ? { command: "printf hello" }
        : name === "write" ? { path: "fake-file.ts", content: content[0].text }
        : { path: "fake-file.ts" };
      const original = definitions[name];
      const renderers = resolve(name);
      if (original) {
        assert.equal(renderers.execute, original.execute, `${name}: execution is unchanged`);
        assert.equal(renderers.parameters, original.parameters, `${name}: schema is unchanged`);
      }
      const row = new ToolExecutionComponent(name, name, args, { showImages: false }, renderers, { requestRender() {} }, process.cwd());
      try {
        for (const partial of [true, false]) {
          row.updateResult({ content, details, isError: false }, partial);
          for (const width of [10, 30, 100]) {
            const lines = row.render(width);
            assert.ok(lines.length <= 6, `${name}: bounded collapsed card`);
            assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name}: width safety`);
          }
        }
        row.invalidate();
        assert.ok(row.render(30).length <= 6, `${name}: component reuse`);
        row.setExpanded(true);
        const expanded = row.render(30).map(stripTerminalSequences);
        assert.ok(expanded.length > 6, `${name}: full expansion`);
        const clickRow = expanded.findIndex((line) => line.trim());
        assert.equal(row.handleMouse({ type: "click", button: "left", x: 10, y: clickRow, width: 30, height: expanded.length })?.handled, true);
        assert.ok(row.render(30).length <= 6, `${name}: click collapses card`);
        row.updateResult({ content: [{ type: "text", text: "Permission denied\nMore details" }], details: {}, isError: true });
        const errorLines = row.render(80);
        assert.ok(errorLines.map(stripTerminalSequences).join("\n").includes("Permission denied"), `${name}: error details visible`);
        assert.ok(errorLines.some((line) => line.includes(theme.bg("toolErrorBg", "MARKER").split("MARKER")[0])), `${name}: error background`);
        row.updateResult({ content, details, isError: false }, true);
        assert.ok(row.render(30).length <= 6, `${name}: resumed output stays collapsed after error`);
        row.setExpanded(true);
        assert.ok(row.render(30).length > 6, `${name}: resumed output can expand after error`);
        row.setExpanded(false);
        if (process.argv.includes("--visual") && ["bash", "eval", "apply_patch"].includes(name)) {
          console.log(`${colorMode} ${name} error @80\n${errorLines.join("\n")}`);
          row.updateResult({ content, details, isError: false });
          console.log(`${colorMode} ${name} collapsed @30\n${row.render(30).join("\n")}`);
          console.log(`${colorMode} ${name} collapsed @100\n${row.render(100).join("\n")}`);
        }
      } finally {
        row.dispose();
      }
    }
  }
  const state = {};
  const context = { expanded: false, state, lastComponent: undefined, isError: false };
  const result = { content, details: {} };
  const options = { expanded: false, isPartial: false };
  const intent = "Inspect the fake fixture without changing it";
  const call = resolve("bash").renderCall({ command: "printf hello", displaySummary: intent }, theme, context);
  assert.ok(call.render(30).map(stripTerminalSequences).join(" ").replace(/\s+/g, " ").includes(intent), "full intent survives wrapping");
  definitions.apply_patch = {
    renderCall: () => new Text("Update(fake-file.ts)\n-old\n+new", 0, 0),
    renderResult: () => new Text("diff +1 -1\n-old\n+new", 0, 0),
  };
  const patch = resolve("apply_patch");
  assert.equal(patch.renderCall({}, theme, context).render(80).length, 1, "patch diff hidden");
  assert.equal(patch.renderResult(result, options, theme, context).render(80).length, 1, "patch stats only");
  assert.ok(patch.renderResult(result, { ...options, expanded: true }, theme, { ...context, expanded: true }).render(80).length > 1, "patch diff expands");
  assert.equal(JSON.stringify(content), before, "model-facing output is unchanged");
  let toolsExpanded;
  extension.handlers.get("session_start")[0]({}, { mode: "tui", ui: { setToolsExpanded(value) { toolsExpanded = value; } } });
  assert.equal(toolsExpanded, false, "TUI starts collapsed");
} finally {
  for (const handler of extension.handlers.get("session_shutdown")) await handler();
}
assert.equal(InteractiveMode.prototype.getRegisteredToolDefinition, originalHook, "shutdown restores the native display hook");
const reloaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(reloaded.errors, []);
for (const handler of reloaded.extensions[0].handlers.get("session_shutdown")) await handler();
assert.equal(InteractiveMode.prototype.getRegisteredToolDefinition, originalHook, "reload does not stack adapters");
console.log("Passed: OmO loading, native cards, light/dark, width safety, click expansion, errors, patch diffs, unchanged execution and model output, reload cleanup");
