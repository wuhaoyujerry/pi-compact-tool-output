import { extensionPath, nodeModulesFor, displayExtensionFor, tuiFor } from "./runtime.mjs";
// Run: node tests/compact-tool-output.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runtime = nodeModulesFor("pi");
const agent = `${runtime}/@earendil-works/pi-coding-agent/dist`;
const moduleAt = (path) => import(pathToFileURL(path).href);
const { loadExtensions } = await moduleAt(`${agent}/core/extensions/loader.js`);
const { initTheme, theme } = await moduleAt(`${agent}/modes/interactive/theme/theme.js`);
const { ToolExecutionComponent } = await moduleAt(`${agent}/modes/interactive/components/tool-execution.js`);
const { codemodeRenderers } = await moduleAt(`${agent}/extensions/codemode/renderer.js`);
const { createShellRenderers } = await moduleAt(`${agent}/core/tools/renderers/bash.js`);
const { Text, visibleWidth, stripTerminalSequences } = await tuiFor(runtime, "pi");
initTheme("dark");
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
loaded.runtime.getAllTools = () => [];
const resolve = extension.toolRenderers[0];
const content = [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `Line ${i}: 界 😀 ${"x".repeat(80)}`).join("\n") }];
const before = JSON.stringify(content);

for (const [name, original, args, details] of [
  ["codemode", codemodeRenderers, { code: "console.log('hello');\n".repeat(20) }, { calls: [{ name: "read", args: "file.ts", status: "ok" }] }],
  ["bash", createShellRenderers("$"), { command: "printf hello\nprintf world" }, {}],
  ["custom", undefined, {}, {}],
]) {
  const renderers = resolve(name, () => original);
  const row = new ToolExecutionComponent(name, name, args, { showImages: false }, renderers, { requestRender() {} }, process.cwd());
  for (const partial of [true, false]) {
    row.updateResult({ content, details }, partial);
    for (const width of [10, 30, 100]) {
      const lines = row.render(width);
      assert.ok(lines.length <= 6, `${name}: three content rows plus Pi's padding and separator`);
      assert.ok(lines.map(stripTerminalSequences).every((line) => !line.includes("...") && !line.includes("…")), `${name}: no added preview dots`);
      const background = theme.bg(partial ? "toolPendingBg" : "toolSuccessBg", "MARKER").split("MARKER")[0];
      assert.ok(lines.some((line) => line.includes(background)), `${name}: standard block background`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name}: width safety`);
    }
  }
  row.invalidate();
  assert.ok(row.render(30).length <= 6, `${name}: component reuse`);
  row.setExpanded(true);
  const expandedLines = row.render(30).map(stripTerminalSequences);
  assert.ok(expandedLines.length > 6, `${name}: expansion preserves full view`);
  const iconRow = expandedLines.findIndex((line) => line.includes("▲"));
  assert.ok(iconRow >= 0, `${name}: expanded collapse icon stays visible`);
  assert.equal(expandedLines[iconRow].trimEnd().at(-1), "▲", `${name}: icon is right-aligned`);
  assert.ok(!expandedLines[iconRow].includes("..."), `${name}: no spurious dots beside collapse icon`);
  const click = row.handleMouse({ type: "click", button: "left", x: 28, y: iconRow, width: 30, height: expandedLines.length });
  assert.equal(click?.handled, true, `${name}: collapse icon click handled`);
  assert.ok(row.render(30).length <= 6, `${name}: clicking icon collapses block`);
  assert.ok(row.render(30).map(stripTerminalSequences).some((line) => line.includes("▼")), `${name}: collapsed expand icon`);
  row.updateResult({ content, details, isError: true });
  assert.ok(row.render(30).map(stripTerminalSequences).join("\n").includes("Error"));
  assert.ok(row.render(30).length <= 6);
  assert.ok(row.render(30).some((line) => line.includes(theme.bg("toolErrorBg", "MARKER").split("MARKER")[0])), `${name}: error background`);
  row.updateResult({ content, details, isError: false }, true);
  assert.ok(row.render(30).length <= 6, `${name}: resumed output stays collapsed after error`);
  row.setExpanded(true);
  assert.ok(row.render(30).length > 6, `${name}: resumed output can expand after error`);
}
const shortRow = new ToolExecutionComponent("custom", "short-output", {}, { showImages: false }, resolve("custom", () => undefined), { requestRender() {} }, process.cwd());
for (const [text, needsIcon] of [["", false], ["one", false], ["one\ntwo", false], ["one\ntwo\nthree", true], ["x".repeat(200), true], ["short again", false]]) {
  shortRow.updateResult({ content: [{ type: "text", text }] }, true);
  assert.equal(shortRow.render(30).map(stripTerminalSequences).join("\n").includes("▼"), needsIcon, "arrow tracks hidden output, including wrapping and streaming changes");
}
assert.equal(JSON.stringify(content), before, "model-facing output remains unchanged");
const fakeContext = { expanded: false, lastComponent: undefined, isError: false, state: {} };
const intent = "Verify diffs are hidden by default and remain available when expanded";
const intentRenderer = resolve("bash", () => ({
  renderCall: (args) => new Text(`Bash(node test.mjs) — ${args.displaySummary}`, 0, 0),
}));
for (const width of [10, 30, 100]) {
  const call = intentRenderer.renderCall({ displaySummary: intent }, theme, fakeContext);
  const lines = call.render(width);
  const visibleIntent = lines.slice(1).map((line) => stripTerminalSequences(line).trim()).join(" ").replace(/\s+/g, " ");
  assert.equal(visibleIntent, `— ${intent}`, "collapsed call preserves the full intent");
  assert.ok(lines.every((line) => visibleWidth(line) <= width), "wrapped intent respects terminal width");
  assert.ok(!stripTerminalSequences(lines[0]).includes("▼"), "full intent alone does not need an expand arrow");
}
const empty = resolve("empty", () => undefined).renderResult({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, fakeContext);
assert.deepEqual(empty.render(30), []);
for (const expanded of [false, true]) {
  const readCall = resolve("read", () => undefined).renderCall({ path: "file.ts" }, theme, { ...fakeContext, expanded });
  const text = readCall.render(30).map(stripTerminalSequences).join("\n");
  assert.ok(!text.includes("▲") && !text.includes("▼"), "read calls have no toggle arrow");
}
for (const name of ["edit", "write"]) {
  const stats = "⎿ diff +2 -3 split [━━━━━━━━━━━]";
  const renderer = resolve(name, () => ({
    renderCall: () => new Text("Update(file.ts)\nDiff header\n-border\n+change", 0, 0),
    renderResult: () => new Text(`${stats}\n────────────────────\n-old\n+new`, 0, 0),
  }));
  for (const expanded of [false, true]) {
    const context = { ...fakeContext, expanded };
    const call = renderer.renderCall({}, theme, context).render(80).map(stripTerminalSequences);
    assert.equal(call.length, expanded ? 4 : 1, `${name}: inline diff hidden until expanded`);
    assert.ok(call[0].includes(expanded ? "▲" : "▼"), `${name}: diff toggle stays visible`);
    const options = { expanded, isPartial: false };
    const output = renderer.renderResult({ content, details: { diff: "-old\n+new" } }, options, theme, context).render(80);
    if (expanded) assert.ok(output.map(stripTerminalSequences).join("\n").includes("+new"), `${name}: full diff visible when expanded`);
    else assert.deepEqual(output.map((line) => stripTerminalSequences(line).trimEnd()), [stats], `${name}: only diff stats visible by default`);
    const error = renderer.renderResult({ content: [{ type: "text", text: "Permission denied" }] }, options, theme, { ...context, isError: true });
    assert.ok(error.render(80).map(stripTerminalSequences).join("\n").includes("Permission denied"), `${name}: errors remain visible`);
  }
}
const { editRenderers } = await moduleAt(`${agent}/core/tools/renderers/edit.js`);
const editRow = new ToolExecutionComponent("edit", "diff-toggle", { path: "file.ts" }, { showImages: false }, resolve("edit", () => editRenderers), { requestRender() {} }, process.cwd());
editRow.updateResult({ content: [{ type: "text", text: "Updated" }], details: { diff: "-1 old\n+1 new", firstChangedLine: 1 } });
assert.ok(!editRow.render(80).map(stripTerminalSequences).join("\n").includes("old"), "native inline diff hidden by default");
editRow.setExpanded(true);
const diffLines = editRow.render(80).map(stripTerminalSequences);
assert.ok(diffLines.join("\n").includes("old") && diffLines.join("\n").includes("new"), "native inline diff visible on expansion");
const diffIconRow = diffLines.findIndex((line) => line.includes("▲"));
assert.equal(editRow.handleMouse({ type: "click", button: "left", x: 78, y: diffIconRow, width: 80, height: diffLines.length })?.handled, true);
assert.ok(!editRow.render(80).map(stripTerminalSequences).join("\n").includes("old"), "clicking arrow hides native inline diff again");
let expanded;
extension.handlers.get("session_start")[0]({}, { mode: "tui", ui: { setToolsExpanded(value) { expanded = value; } } });
assert.equal(expanded, false);
for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler();
const tempAgentDir = mkdtempSync(join(tmpdir(), "compact-tool-config-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  mkdirSync(join(tempAgentDir, "extensions"));
  const configPath = join(tempAgentDir, "extensions", "compact-tool-output.json");
  const cases = [
    [undefined, 2, false], ["{}", 2, false],
    ...[0, 1, 5, 100].map((value) => [JSON.stringify({ previewLines: value }), value, false]),
    ...[-1, 1.5, 101, "3", null].map((value) => [JSON.stringify({ previewLines: value }), 2, true]),
    ["{broken", 2, true], ["null", 2, true], ["[]", 2, true],
  ];
  for (const [json, expected, warns] of cases) {
    if (json === undefined) rmSync(configPath, { force: true });
    else writeFileSync(configPath, json);
    const configured = await loadExtensions([extensionPath], process.cwd());
    assert.deepEqual(configured.errors, []);
    const configuredExtension = configured.extensions[0];
    const resolver = configuredExtension.toolRenderers[0];
    const result = { content: [{ type: "text", text: Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n") }] };
    const options = { expanded: false, isPartial: false };
    assert.equal(resolver("codemode", () => undefined).renderResult(result, options, theme, fakeContext).render(80).length, expected, `configured preview limit: ${json}`);
    for (const total of new Set([0, Math.max(0, expected - 1), expected, expected + 1])) {
      const row = new ToolExecutionComponent("custom", "config-threshold", {}, { showImages: false }, resolver("custom", () => undefined), { requestRender() {} }, process.cwd());
      row.updateResult({ content: [{ type: "text", text: Array.from({ length: total }, (_, i) => `row ${i}`).join("\n") }] });
      assert.equal(row.render(80).map(stripTerminalSequences).join("\n").includes("▼"), total > expected, "expand icon appears only above configured line limit");
    }
    assert.ok(resolver("codemode", () => undefined).renderResult(result, options, theme, { ...fakeContext, isError: true }).render(80).length >= 2, "zero preview limit does not hide errors");
    const statsRenderer = resolver("edit", () => ({ renderResult: () => new Text("diff +2 -3\n-border\n+change", 0, 0) }));
    assert.equal(statsRenderer.renderResult(result, options, theme, fakeContext).render(80).length, 1, "diff stats remain one line regardless of preview limit");
    const notifications = [];
    configuredExtension.handlers.get("session_start")[0]({}, { mode: "tui", ui: { setToolsExpanded() {}, notify(message) { notifications.push(message); } } });
    assert.equal(notifications.length, warns ? 1 : 0, "invalid configuration reports a warning");
    for (const handler of configuredExtension.handlers.get("session_shutdown") ?? []) await handler();
  }
} finally {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(tempAgentDir, { recursive: true, force: true });
}
console.log("Passed: configurable limits, invalid config fallback, full intents, diff stats, backgrounds, arrows, errors, expansion, unchanged model output");
