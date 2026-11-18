# dsh-project-board

A read-only project board for **DeepSeek Harness (DSH)**, built for projects whose design docs live in the repository.

The DSH right sidebar keeps a small launcher. The real board is a **standalone web app**: it opens full screen in any browser, shows the current project's docs, a zoomable/draggable dependency canvas, and the development log. The plugin never writes project files.

## What you get

| Area | Source (default) | Behaviour |
| --- | --- | --- |
| Reference docs | `docs/reference/**/*.md` | Read-only Markdown, grouped by directory, image support for files under the reference directory |
| Structure canvas | `docs/board/project-map.json` | Layered module graph with dependency edges, status colours, pan/zoom, node dragging, filters, focus, SVG/layout export |
| Development log | `docs/DEVLOG.md` | Entries split by `## `, newest open first |

The board follows the **current Session working directory**. Switch to another DSH workspace and the board resolves that project, or use the project picker for any workspace registered in DSH.

## One graph, four projections

The structure canvas reads one `project-map.json` and defaults to a **top-down architecture view**:

| View | Question it answers |
| --- | --- |
| Architecture (default) | Which conceptual modules does the project consist of (rendering, first-person movement, card combat, …), their completion and cross-module dependencies; double-click a card to enter its module dependency |
| Dependencies | Who depends on whom; modules can contain submodules — double-click a parent to drill in, breadcrumbs go back, out-of-scope dependencies become "external" stubs |
| Data flow | Where a key attribute is defined, who writes it, who reads it. Pick an attribute; the canvas marks definition/modifier/reader and draws write/read edges |
| Execution flow | In what order one scenario crosses systems. Pick a flow; nodes show step numbers, edges follow the order, and the inspector shows a step-by-step sequence with reads/writes |

The architecture view follows **divide and conquer → stepwise refinement → separation of concerns**: start with a few `subsystems` cards, drill into one subsystem's modules, then inspect attributes/flows. Each subsystem declares a `concern` (gameplay / presentation / services / data / core / tooling) shown by colour. Projects without `subsystems` fall back to the dependency view.

### Key attributes and flows

- `attributes` is a **small catalog of key values**, not every config field. Each entry names a source path, a `sourceModule`, `writtenBy`, `readBy`, `affects`, whether it is tunable, and a `default`. `default: null` means "the user has not decided yet"; the plugin never invents gameplay values.
- `flows` are named step sequences. Each step names a module, an action, and the attributes it reads/writes. Use 3–10 steps per scenario; do not dump a call stack.
- The Host validates the catalog and flows: unknown modules/attributes, parent cycles, duplicate ids and dangling edges fail with a readable error instead of a blank canvas.

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or a later `0.2.x` (the plugin uses the right sidebar, `ctx.webServer`, and Session working-directory services).
- The plugin is a bundle with a Host half and a browser launcher; no build step and no npm dependencies.

## Repository and development

This package is developed at [github.com/Kquer/dsh-project-board](https://github.com/Kquer/dsh-project-board) (private). The repository root **is** the plugin package, so a clone can be installed directly with **Plugins → Add plugin**.

```bash
git clone git@github.com:Kquer/dsh-project-board.git
cd dsh-project-board
node --check index.js client.js web/app.js
git tag -a v0.2.1 -m "dsh-project-board 0.2.1"   # for the next release
git push origin main --tags
```

Keep `CHANGELOG.md` current and bump `version` in `package.json`. The consuming project keeps its own `docs/reference`, `docs/board/project-map.json`, and `docs/DEVLOG.md`; this repository only ships the plugin.

## Install (local folder)

1. Put this directory anywhere on the machine, for example `<repo>/plugins/dsh-project-board`.
2. In DSH, open **Plugins → Add plugin**, choose the directory, enable it.
3. Refresh the DSH page once so the browser launcher module loads.

The saved profile links the directory, so editing the plugin does not require re-installing; Host changes need a plugin reload or a DSH restart.

## Open the board

- Click **看板** in the composer tool row (it opens the right-sidebar launcher), then **在浏览器打开看板**.
- Or open the right sidebar's **+** guide and pick **项目看板**.

The launcher shows the resolved project, doc/module counts, and the tokenized URL. The URL is valid until DSH restarts; reopening from DSH always gives a fresh one.

## Configuration

The bundle patch sets these defaults. Override them in the plugin row's config:

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | `''` | Project root. Empty resolves the current Session working directory, then the configured root, then the first registered workspace. |
| `referenceDir` | `docs/reference` | Directory scanned for `.md` files. |
| `mapPath` | `docs/board/project-map.json` | Module/edge data for the canvas. |
| `devlogPath` | `docs/DEVLOG.md` | Development log. |
| `projectPath` | `docs/PROJECT.md` | Allowed in the read-only doc endpoint (optional). |
| `layoutPath` | `docs/board/layout.json` | Optional committed manual layout; the browser merges it under its local layout. |

Relative paths are resolved against the project root and may not escape it.

## Project data contract

```text
<project>/
├── AGENTS.md
├── docs/
│   ├── reference/                 # your technical / gameplay docs
│   │   ├── INDEX.md
│   │   └── assets/                # images referenced by docs
│   ├── board/
│   │   ├── project-map.json       # modules, layers, edges, status
│   │   └── layout.json            # optional exported layout
│   ├── PROJECT.md
│   └── DEVLOG.md
└── ...
```

`project-map.json`:

```jsonc
{
  "schemaVersion": 2,
  "project": { "name": "My game", "phase": "Prototype", "updated": "2026-11-18" },
  "layers": [{ "id": "gameplay", "label": "Gameplay", "order": 1 }],
  "subsystems": [{
    "id": "first-person",
    "label": "First-person movement",
    "order": 1,
    "concern": "gameplay",
    "summary": "Input → player state → movement/dodge → camera",
    "modules": ["player", "movement", "player-view", "config"]
  }],
  "modules": [{
    "id": "cards",
    "label": "Card system",
    "layer": "gameplay",
    "status": "todo",           // done | partial | todo | unknown | blocked
    "summary": "Pure C# rules core",
    "path": "src/Gameplay/Cards",
    "focus": true
  }, {
    "id": "cards-rules",
    "label": "Deck & rules",
    "layer": "gameplay",
    "status": "unknown",
    "parent": "cards",
    "entry": "CardRules.Resolve"
  }],
  "attributes": [{
    "id": "cardEnergy",
    "label": "Energy per turn",
    "kind": "config",          // config | state | derived
    "source": "Config/Cards.asset#energy",
    "sourceModule": "config",
    "default": null,           // null = user has not decided
    "writtenBy": ["cards-rules"],
    "readBy": ["cards-rules", "card-ui"],
    "affects": ["pacing"],
    "tunable": true,
    "status": "unknown"        // confirmed | pending | unknown
  }],
  "flows": [{
    "id": "card-play",
    "label": "Play a card",
    "trigger": "player input",
    "status": "draft",         // draft | confirmed
    "steps": [
      { "module": "card-ui", "action": "Select a card" },
      { "module": "cards-rules", "action": "Validate cost", "reads": ["cardEnergy"] },
      { "module": "cards-effects", "action": "Apply the effect" }
    ]
  }],
  "edges": [{ "from": "cards", "to": "config", "kind": "depends" }],
  "focus": [{ "module": "cards", "why": "Start here" }]
}
```

`edges[].kind` may be `depends` (default), `uses`, `contains`, or `event`; the canvas colours and dashes them accordingly. `parent` builds the hierarchy; `attributes` and `flows` power the data-flow and execution views. Unknown module/attribute ids, parent cycles, duplicate ids and dangling edges are rejected by the Host instead of crashing the page.

## Canvas cheatsheet

| Action | Control |
| --- | --- |
| Enter a subsystem | Double-click an architecture card; the breadcrumb returns to the overview |
| Zoom | Mouse wheel, `+` / `-`, or the toolbar |
| Pan | Drag empty canvas |
| Move a node | Drag the node |
| Fit all | `0`, double-click empty canvas, or **⤢** |
| Enter a module with children | Double-click it (dependency view); breadcrumbs go back |
| Focus a node | Double-click a leaf, or **居中** in the inspector |
| Inspect | Click a node; the inspector shows summary, code path, dependencies, dependents, key attributes, flows |
| Trace an attribute | Switch to **数据流**, pick an attribute; orange = write, green = read, 定/改/读 badges |
| Walk a flow | Switch to **流程**, pick a flow; `[` / `]` or the previous/next buttons step through |
| Filter | Status chips, **分层** layer menu, search field (`Enter` jumps to the first match) |
| Reset layout | **重置布局** clears local drag positions |
| Persist across devices | **导出布局** → commit the JSON as `docs/board/layout.json` |

Layout is stored in `localStorage` per project and per browser; a committed `docs/board/layout.json` is merged underneath it so a team can share a starting arrangement.

## Collaboration with Git

- Put `docs/` in the same repository as the code and commit doc changes with the code change they describe.
- Each collaborator clones the repository and runs DSH in that clone. The board reads the local working copy, so no token or GitHub API access is needed for private repositories.
- Pull before starting; the board refreshes every 10 seconds and reloads a doc when its mtime changes.
- Keep `docs/reference/` human-owned. If an AI assistant should not edit it, state that in `AGENTS.md`; this plugin is read-only regardless.
- A committed `layout.json` avoids layout churn; treat it as a normal reviewed file.

## Publish to a DSH market index

DSH's **Plugins → Discover** reads indexes that users add; there is no official index. To publish:

1. Push this package to a public Git repository (or npm), tag a commit.
2. Write a format-1 index that pins the commit:

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins", "zh": "我的 DSH 插件" },
  "plugins": [{
    "name": "dsh-project-board",
    "metadata": {},
    "versions": [{
      "version": "0.2.0",
      "publishTimestamp": 1763500000,
      "source": {
        "type": "git",
        "url": "https://github.com/<you>/<repo>",
        "commit": "<40-hex-commit>",
      },
      "engines": { "dsh": ">=0.2.2-rc.3 <0.3.0" }
    }]
  }]
}
```

3. Host the JSON at an HTTPS URL (GitHub Pages or raw).
4. Users add that URL under **Plugins → Discover → Index sources**.

## Security and read-only guarantees

- The standalone page is served on the local DSH web server. The static shell is public; every data endpoint requires the random per-process token embedded in the page URL.
- Data endpoints only read: they scan the configured reference directory and parse the map/log. There is no write route anywhere in the plugin.
- The doc endpoint is whitelisted to the reference directory, `DEVLOG.md`, and `PROJECT.md`; `realpath` checks prevent escaping the project root. Images are limited to the reference directory and common raster formats.

## Limitations

- Markdown supports headings, lists, tables, quotes, code fences, links, emphasis, and images; Mermaid is shown as source, and relative `.md` links to docs in the board are clickable.
- The canvas edits **layout**, not architecture data. Add modules/edges/attributes/flows in `project-map.json` (or ask an assistant to). Key attributes are deliberately a small catalog, not every config field.
- Layout is not streamed to other users; commit `layout.json` for a shared arrangement.
- The launcher's token expires when DSH restarts; reopen from DSH.
- DSH is a fast-moving pre-1.0 product. The plugin targets the `0.2.x` sidebar and web-server APIs.

## License

MIT. See [LICENSE](LICENSE).
