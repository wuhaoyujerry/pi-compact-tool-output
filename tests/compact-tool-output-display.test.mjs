import { extensionPath, nodeModulesFor, displayExtensionFor, tuiFor } from "./runtime.mjs";
// Run: node tests/compact-tool-output-display.test.mjs pi individual
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const harness = process.argv[2];
const layout = process.argv[3];
assert.ok(["pi", "omo"].includes(harness));
assert.ok(["individual", "aggregate"].includes(layout));
const runtime = nodeModulesFor(harness);
const agent = `${runtime}/${harness === "pi" ? "@earendil-works/pi-coding-agent" : "@code-yeongyu/senpi"}/dist`;
const moduleAt = (path) => import(pathToFileURL(path).href);
const temp = mkdtempSync(join(tmpdir(), "compact-display-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalNow = Date.now;
Date.now = () => 1000;
process.env.PI_CODING_AGENT_DIR = temp;
mkdirSync(join(temp, "extension-data", "pi-tool-display-intent"), { recursive: true });
writeFileSync(join(temp, "extension-data", "pi-tool-display-intent", "config.json"), JSON.stringify({
  version: 2,
  toolCalls: { layout, expandedTimeline: "turns" },
  results: { mode: "compact", previewRows: 2 },
  diff: { collapsedMode: "summary" },
}));

let loaded;
const rows = [];
try {
  const { loadExtensions } = await moduleAt(`${agent}/core/extensions/loader.js`);
  const { initTheme, theme } = await moduleAt(`${agent}/modes/interactive/theme/theme.js`);
  const { InteractiveMode } = await moduleAt(`${agent}/modes/interactive/interactive-mode.js`);
  const { ToolExecutionComponent } = await moduleAt(`${agent}/modes/interactive/components/tool-execution.js`);
  const { stripTerminalSequences, visibleWidth } = await tuiFor(runtime, harness);
  initTheme("dark");
  const originalHook = InteractiveMode.prototype.getRegisteredToolDefinition;
  const originalIdentity = Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "toolName");
  const originalDisplay = Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "updateDisplay");
  loaded = await loadExtensions([
    displayExtensionFor(runtime, harness),
    extensionPath,
  ], temp);
  assert.deepEqual(loaded.errors, []);
  const [display, compact] = loaded.extensions;
  assert.ok(display.tools.size > 0, "real display plugin owns its styled tools");
  const definitions = Object.fromEntries([...display.tools].map(([name, tool]) => [name, tool.definition]));
  loaded.runtime.getAllTools = () => Object.values(definitions).map((definition) => ({ ...definition, sourceInfo: display.sourceInfo }));
  loaded.runtime.getCommands = () => [];
  const resolve = harness === "pi"
    ? (name) => compact.toolRenderers[0](name, () => definitions[name])
    : (name) => InteractiveMode.prototype.getRegisteredToolDefinition.call({
      session: { getToolDefinition: (key) => definitions[key] },
    }, name);
  const emit = async (event, payload, context) => {
    for (const extension of loaded.extensions) {
      for (const handler of extension.handlers.get(event) ?? []) await handler(payload, context);
    }
  };
  const ctx = {
    mode: "tui", hasUI: true, cwd: temp,
    ui: { setToolsExpanded() {}, setStatus() {}, setWidget() {}, notify() {}, requestRender() {} },
    sessionManager: { getBranch: () => [], buildContextEntries: () => [], buildSessionContext: () => ({ messages: [] }) },
  };
  const content = [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `row ${i} 界 ${"x".repeat(60)}`).join("\n") }];
  const before = JSON.stringify(content);
  const result = { content, details: { diff: "-1 old\n+1 new", firstChangedLine: 1 }, isError: false };
  const assertBackground = (row, width, role) => {
    const raw = ToolExecutionComponent.prototype.render.call(row, width);
    const colored = row.render(width);
    const plain = (lines) => lines.map((line) => stripTerminalSequences(line).trimEnd());
    assert.deepEqual(plain(colored), plain(raw), "background does not change text or row geometry");
    const background = theme.bg(role, "MARKER").split("MARKER")[0];
    assert.ok(colored.some((line) => stripTerminalSequences(line).trim()), "card has visible content");
    assert.ok(colored.filter((line) => stripTerminalSequences(line).trim()).every((line) => line.includes(background)),
      `${role}: every content row has the native background`);
    assert.ok(colored.every((line) => visibleWidth(line) <= width), "background respects terminal width");
    return colored;
  };
  if (layout === "individual") {
    for (const colorMode of ["dark", "light"]) {
      initTheme(colorMode);
      for (const name of ["bash", "read", "edit", "write"]) {
        const args = name === "bash" ? { command: "printf fixture", displaySummary: "Read the fixture" }
          : name === "write" ? { path: "fixture.ts", content: content[0].text } : { path: "fixture.ts" };
        const original = definitions[name];
        const styled = resolve(name);
        assert.equal(styled.renderShell, original.renderShell, `${name}: original self-rendered shell preserved`);
        const context = { args, state: {}, cwd: temp, argsComplete: true, expanded: false, isPartial: false, isError: false };
        for (const width of [30, 100]) {
          assert.deepEqual(
            styled.renderCall(args, theme, { ...context, state: {} }).render(width),
            original.renderCall(args, theme, { ...context, state: {} }).render(width),
            `${name}: call styling and summary are unchanged`,
          );
          const collapsed = styled.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(width);
          assert.ok(collapsed.length <= (["edit", "write"].includes(name) ? 1 : 2), `${name}: strict result rows`);
          assert.ok(collapsed.every((line) => visibleWidth(line) <= width), `${name}: width safety`);
          if (collapsed.length) assert.ok(collapsed.map(stripTerminalSequences).some((line) => /[⎿│└]/.test(line)), `${name}: result connector styling preserved`);
          const expanded = styled.renderResult(result, { expanded: true, isPartial: false }, theme, { ...context, expanded: true }).render(width);
          if (name === "read") assert.deepEqual(expanded, [], "compact read mode keeps the display plugin's hidden output");
          else assert.ok(expanded.length > collapsed.length, `${name}: details expand`);
          const error = styled.renderResult({ content: [{ type: "text", text: "Permission denied" }], details: {} },
            { expanded: false, isPartial: false }, theme, { ...context, isError: true }).render(width);
          assert.ok(error.map(stripTerminalSequences).join("\n").includes("Permission denied"), `${name}: styled error stays visible`);
          assert.ok(error.length <= 2, `${name}: bounded styled error`);
        }
        const row = new ToolExecutionComponent(name, name, args, { showImages: false }, styled, { requestRender() {} }, temp);
        rows.push(row);
        for (const width of [30, 100]) assertBackground(row, width, "toolPendingBg");
        row.updateResult(result);
        for (const width of [30, 100]) assertBackground(row, width, "toolSuccessBg");
        row.updateResult({ content: [{ type: "text", text: "Permission denied" }], details: {}, isError: true });
        for (const width of [30, 100]) assertBackground(row, width, "toolErrorBg");
        row.updateResult(result);
        if (process.argv.includes("--visual")) console.log(`${harness} ${colorMode} ${name}\n${row.render(100).join("\n")}`);
      }
    }
  } else {
    await emit("session_start", {}, ctx);
    const message = { role: "assistant", id: "fixture-turn", timestamp: 1000, content: [{ type: "toolCall", id: "aggregate-fixture", name: "bash", arguments: { command: "printf fixture", displaySummary: "Read the fixture" } }] };
    await emit("message_start", { message }, ctx);
    const row = new ToolExecutionComponent("bash", "aggregate-fixture", message.content[0].arguments,
      { showImages: false }, resolve("bash"), { requestRender() {} }, temp);
    rows.push(row);
    row.markExecutionStarted();
    for (const width of [30, 100]) assertBackground(row, width, "toolPendingBg");
    row.updateResult(result);
    await emit("message_end", { message: { role: "toolResult", toolCallId: "aggregate-fixture", toolName: "bash", ...result } }, ctx);
    for (const colorMode of ["dark", "light"]) {
      initTheme(colorMode);
      row.invalidate();
      for (const width of [30, 100]) {
      const collapsed = assertBackground(row, width, "toolSuccessBg");
      assert.ok(collapsed.map(stripTerminalSequences).join("\n").includes("Run"), "saved aggregate Run UI works");
      assert.ok(!collapsed.map(stripTerminalSequences).join("\n").includes("row 19"), "aggregate output starts collapsed");
      assert.ok(collapsed.every((line) => visibleWidth(line) <= width), "aggregate width safety");
      if (process.argv.includes("--visual")) console.log(`${harness} ${colorMode} aggregate @${width}\n${collapsed.join("\n")}`);
      row.setExpanded(true);
      const expanded = assertBackground(row, width, "toolSuccessBg");
      assert.notDeepEqual(expanded.map(stripTerminalSequences), collapsed.map(stripTerminalSequences), "aggregate expansion changes the visible timeline");
      assert.ok(expanded.map(stripTerminalSequences).join("\n").includes("↻ 1/1"), "expanded aggregate shows its turn index");
      if (process.argv.includes("--visual")) console.log(`${harness} ${colorMode} aggregate expanded @${width}\n${expanded.join("\n")}`);
      const titleRow = expanded.findIndex((line) => stripTerminalSequences(line).includes("Run"));
      assert.equal(row.handleMouse({ type: "click", button: "left", x: 4, y: titleRow, width, height: expanded.length })?.handled, true,
        "clicking the aggregate header is handled");
      assert.deepEqual(row.render(width).length, collapsed.length, "aggregate collapses again");
      row.setExpanded(false);
      row.updateResult({ content: [{ type: "text", text: "Permission denied" }], details: {}, isError: true });
      assertBackground(row, width, "toolErrorBg");
      row.updateResult(result);
      }
    }
  }
  assert.equal(JSON.stringify(content), before, "model-facing results unchanged");
  for (const extension of loaded.extensions) {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
  }
  loaded = undefined;
  assert.equal(InteractiveMode.prototype.getRegisteredToolDefinition, originalHook, "display hook restored on reload");
  assert.deepEqual(Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "toolName"), originalIdentity, "identity bridge restored on reload");
  assert.deepEqual(Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "updateDisplay"), originalDisplay, "background hook restored on reload");
  console.log(`Passed: ${harness} ${layout} real display plugin + strict wrapper`);
} finally {
  for (const row of rows) row.dispose?.();
  if (loaded) {
    for (const extension of loaded.extensions) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" });
    }
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  Date.now = originalNow;
  rmSync(temp, { recursive: true, force: true });
}
