# Pi / OmO Compact Tool Output

Strict tool-output previews for Pi and OmO. Keep the full tool result available
to the model and to expanded views, while limiting collapsed output to two
terminal rows. Edit, write, and patch results use a one-row preview.

The extension also restores native pending, success, and error backgrounds.
It preserves `pi-tool-display-intent` styling, summaries, diff statistics,
aggregate Run blocks, and expansion controls when that extension is installed.

## Install

### Pi

```sh
pi install git:github.com/wuhaoyujerry/pi-omo-compact-tool-output
```

For the display-intent UI, also install its extension:

```sh
pi install npm:@zhcsyncer/pi-tool-display-intent
```

### OmO

Add these sources to the existing `packages` array in
`~/.omo/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/wuhaoyujerry/pi-omo-compact-tool-output",
    "npm:@zhcsyncer/pi-tool-display-intent"
  ]
}
```

Keep your other package entries. Run `/reload` in an existing Pi or OmO
session, or restart the harness.

Load only one copy of `compact-tool-output.ts`. If you previously installed
it as a local extension, disable that copy before switching to this package.

## Use

- Click a Run header to expand or collapse its timeline.
- Press `Ctrl+O` to expand or collapse tool output globally.
- Backgrounds follow the active theme and native tool state.
- Errors remain visible even when the preview limit is zero.

The display-intent extension still owns its layout and result mode.
In its compact mode, read results can remain hidden, as they do without this
wrapper. Its detail viewer provides the full result.

## Configure

The default preview limit is two terminal rows, including wrapped text.
Set `previewLines` in your harness's configuration file:

- Pi: `~/.pi/agent/extensions/compact-tool-output.json`
- OmO: `~/.omo/agent/extensions/compact-tool-output.json`

```json
{
  "previewLines": 2
}
```

The supported range is `0` through `100`. Invalid configuration produces a
warning and uses the two-row default. Run `/reload` after changing this file.

For aggregate Run blocks, configure `pi-tool-display-intent` in
`~/.pi/agent/extension-data/pi-tool-display-intent/config.json` or the
corresponding `~/.omo/agent/extension-data/` path:

```json
{
  "version": 2,
  "toolCalls": {
    "layout": "aggregate",
    "expandedTimeline": "turns"
  },
  "results": {
    "mode": "compact",
    "previewRows": 2
  },
  "diff": {
    "collapsedMode": "summary"
  }
}
```

## Development

Requires Node.js 20 or later and Bun.

```sh
bun install
bun run check
```

The checks use real harness loaders and terminal components. They cover
native cards, display-intent composition, individual and aggregate layouts,
light and dark themes, pending/success/error backgrounds, wrapped-row limits,
expansion, header clicks, error recovery, and reload cleanup.

Tested versions:

| Component | Version |
| --- | --- |
| Pi | 1.0.2 |
| OmO's Senpi engine | 2026.10.10 |
| pi-tool-display-intent | 0.10.1 |

Tests use local development dependencies when installed. To use existing
harness installations, set `PI_TEST_NODE_MODULES` and `OMO_TEST_NODE_MODULES`
to their respective `node_modules` directories. `PI_DISPLAY_EXTENSION` and
`OMO_DISPLAY_EXTENSION` can override the display-intent extension entry path.
