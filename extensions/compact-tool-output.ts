import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, InteractiveMode, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const RESULT_PREVIEW = Symbol("compact-tool-result-preview");
type Renderers = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;
type ToolRenderContext = Parameters<NonNullable<Renderers["renderCall"]>>[2];

function isRenderers(value: unknown): value is Renderers {
  return typeof value === "object" && value !== null
    && (!("renderCall" in value) || value.renderCall === undefined || typeof value.renderCall === "function")
    && (!("renderResult" in value) || value.renderResult === undefined || typeof value.renderResult === "function")
    && (!("renderShell" in value) || value.renderShell === undefined || value.renderShell === "default" || value.renderShell === "self");
}

// Limit rendered terminal rows, including wrapping, without changing tool results.
class Preview implements Component {
  rendererChild: Component;

  constructor(
    readonly child: Component,
    private readonly limit: number,
    private readonly expanded: boolean,
    private readonly toggleIcon?: string,
    private readonly intent?: string,
    private readonly canExpand?: (width: number) => boolean,
  ) {
    this.rendererChild = child;
  }

  hasHiddenLines(width: number): boolean {
    return this.child.render(width).filter((line) => stripTerminalSequences(line).trim()).length > this.limit;
  }

  render(width: number): string[] {
    const showIcon = this.toggleIcon && (this.expanded || !this.canExpand || this.canExpand(width));
    const lines = this.child.render(showIcon ? Math.max(1, width - 2) : width);
    const content = this.expanded ? lines : lines.filter((line) => stripTerminalSequences(line).trim());
    const preview = this.expanded ? content : content.slice(0, this.limit);
    if (!this.expanded && this.intent && preview.length > 0) {
      const title = stripTerminalSequences(preview[0]);
      const separator = title.lastIndexOf(" — ");
      if (separator >= 0) preview[0] = sliceByColumn(preview[0], 0, visibleWidth(title.slice(0, separator)));
      preview.push(...new Text(this.intent, 0, 0).render(width));
    }
    if (showIcon && preview.length > 0 && width > 0) {
      const title = truncateToWidth(preview[0], Math.max(0, width - 2), "");
      preview[0] = title + " ".repeat(Math.max(0, width - visibleWidth(title) - 1)) + this.toggleIcon;
    }
    return preview;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

function innerContext(context: ToolRenderContext): ToolRenderContext {
  return {
    ...context,
    lastComponent: context.lastComponent instanceof Preview
      ? context.lastComponent.rendererChild
      : context.lastComponent,
  };
}

export default function (pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "extensions", "compact-tool-output.json");
  let renderTheme: Parameters<NonNullable<Renderers["renderCall"]>>[1] | undefined;
  let previewLines = 2;
  let configWarning: string | undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Expected a JSON object");
    const value = config.previewLines === undefined ? 2 : config.previewLines;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("previewLines must be an integer from 0 to 100");
    previewLines = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      configWarning = `${configPath}: ${error instanceof Error ? error.message : String(error)}. Using 2 preview lines.`;
    }
  }

  const createRenderers = (name: string, original?: Renderers): Renderers => {
    const hidesDiff = name === "edit" || name === "write" || name === "apply_patch";
    const styled = original?.renderShell === "self" && pi.getAllTools().some(
      (tool) => tool.name === name && tool.sourceInfo.path.includes("pi-tool-display-intent"),
    );
    return {
      renderShell: styled ? "self" : "default",
      renderCall(args, theme, context) {
        renderTheme = theme;
        const child = original?.renderCall?.(args, theme, styled ? innerContext(context) : { ...innerContext(context), expanded: true })
          ?? new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
        if (styled && !(child instanceof Box)) return child;
        const displaySummary = typeof args === "object" && args !== null && "displaySummary" in args && typeof args.displaySummary === "string"
          ? args.displaySummary.trim() : "";
        return new Preview(child, 1, context.expanded,
          name === "read" ? undefined : theme.fg("muted", theme.bold(context.expanded ? "▲" : "▼")),
          displaySummary ? theme.fg("accent", `— ${displaySummary}`) : undefined,
          (width) => {
            const resultPreview = context.state[RESULT_PREVIEW] as Preview | undefined;
            const hiddenCall = (name === "codemode" || name === "eval" || hidesDiff)
              && child.render(width).filter((line) => stripTerminalSequences(line).trim()).length > 1;
            return hiddenCall || resultPreview?.hasHiddenLines(width) === true;
          });
      },
      renderResult(result, options, theme, context) {
        renderTheme = theme;
        const child = original?.renderResult?.(result, { ...options, expanded: true }, theme, { ...innerContext(context), expanded: true })
          ?? new Text(result.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n"), 0, 0);
        // Keep failures visible even when a tool's own renderer omits an error label.
        let displayedChild = child;
        if (context.isError) {
          const errorText = new Text(theme.fg("error", "Error") + "\n" + result.content
            .filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
          displayedChild = styled ? {
            render(width) {
              const lines = child.render(width);
              return lines.some((line) => stripTerminalSequences(line).trim()) ? lines : errorText.render(width);
            },
            invalidate() { child.invalidate(); },
          } : errorText;
        }
        const preview = new Preview(displayedChild, context.isError ? 2 : hidesDiff ? 1 : previewLines, options.expanded);
        preview.rendererChild = child;
        context.state[RESULT_PREVIEW] = preview;
        return preview;
      },
    };
  };

  if (typeof pi.registerToolRenderer === "function") {
    pi.registerToolRenderer((name, next) => createRenderers(name, next()));
  } else {
    // OmO aliases Pi imports, but has no renderer middleware. Decorate only
    // the definitions handed to its TUI, never the execution registry.
    const prototype = InteractiveMode.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "getRegisteredToolDefinition");
    const getDefinition: unknown = descriptor?.value;
    if (typeof getDefinition !== "function") {
      throw new TypeError("This harness has no supported tool display hook");
    }
    const wrapped = function (this: unknown, name: string) {
      const original: unknown = Reflect.apply(getDefinition, this, [name]);
      if (original !== undefined && !isRenderers(original)) {
        throw new TypeError(`Invalid tool renderers for ${name}`);
      }
      return { ...original, ...createRenderers(name, original) };
    };
    Object.defineProperty(prototype, "getRegisteredToolDefinition", { ...descriptor, value: wrapped });
    // The display plugin's aggregate cards still read these upstream fields.
    // OmO moved them into presentationSnapshot.identity.
    const cardPrototype = ToolExecutionComponent.prototype;
    const identityDescriptors = new Map(
      (["toolName", "toolCallId"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(cardPrototype, key)]),
    );
    for (const key of identityDescriptors.keys()) {
      Object.defineProperty(cardPrototype, key, {
        configurable: true,
        get(this: { readonly presentationSnapshot: { readonly identity: { readonly toolName: string; readonly toolCallId: string } } }) {
          return this.presentationSnapshot.identity[key];
        },
      });
    }
    pi.on("session_shutdown", () => {
      if (descriptor && Reflect.get(prototype, "getRegisteredToolDefinition") === wrapped) {
        Object.defineProperty(prototype, "getRegisteredToolDefinition", descriptor);
        for (const [key, previous] of identityDescriptors) {
          if (previous) Object.defineProperty(cardPrototype, key, previous);
          else Reflect.deleteProperty(cardPrototype, key);
        }
      }
    });
  }

  // Color the final card, including aggregate Run rows, without replacing
  // the display plugin's renderer or changing its mouse coordinates.
  const cardPrototype = ToolExecutionComponent.prototype;
  const displayDescriptor = Object.getOwnPropertyDescriptor(cardPrototype, "updateDisplay");
  const updateDisplay: unknown = displayDescriptor?.value;
  if (typeof updateDisplay !== "function") throw new TypeError("This harness has no tool card display hook");
  const coloredCards = new WeakSet<ToolExecutionComponent>();
  const updateColoredDisplay = function (this: ToolExecutionComponent) {
    Reflect.apply(updateDisplay, this, []);
    if (coloredCards.has(this)) return;
    coloredCards.add(this);
    this.render = function (width) {
      const lines = ToolExecutionComponent.prototype.render.call(this, width);
      if (!renderTheme || !lines.length) return lines;
      const result: unknown = Reflect.get(this, "result");
      const failed = typeof result === "object" && result !== null && "isError" in result && result.isError === true;
      const background = Reflect.get(this, "isPartial") ? "toolPendingBg" : failed ? "toolErrorBg" : "toolSuccessBg";
      const theme = renderTheme;
      const box = new Box(0, 0, (text) => theme.bg(background, text));
      box.addChild({ render: () => lines, invalidate() {} });
      return box.render(width).map((line, index) => lines[index] === "" ? "" : line);
    };
  };
  Object.defineProperty(cardPrototype, "updateDisplay", { ...displayDescriptor, value: updateColoredDisplay });
  pi.on("session_shutdown", () => {
    if (displayDescriptor && Reflect.get(cardPrototype, "updateDisplay") === updateColoredDisplay) {
      Object.defineProperty(cardPrototype, "updateDisplay", displayDescriptor);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setToolsExpanded(false);
      if (configWarning) ctx.ui.notify(configWarning, "warning");
    }
  });
}
