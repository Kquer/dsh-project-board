# Changelog

## 0.4.0 — 2026-11-20

- Manual **project documentation folder** picker (DSH native chooser, absolute-path fallback).
- **Update from docs folder** button parses `.md/.txt/.docx/.pos/images` into `docs/board/AI-CONTEXT.md` + `ai-context.json` and refreshes `flow-reference.json`.
- New **AI 上下文** tab renders the generated Markdown; context images are served through a token-protected route.
- Dependency-free DOCX text/image extraction and ProcessOn `.pos` flow extraction in the Host.
- Removed the 10-second automatic poll; refresh and reindex are manual.

## 0.3.0 — 2026-11-18


- Separate current/short-term structure from long-term suggestions.
- New **长期方向** tab: AI-generated roadmap grouped by horizon, with why/related modules/source docs.
- **长期参考** panel: user curates long-term items; persisted atomically to `docs/board/long-term-reference.json` through a token-protected POST.
- Architecture view honours `subsystems[].horizon` and hides `later` subsystems by default; an inspector toggle reveals them.
- Host reads/validates `roadmap.json` and `long-term-reference.json`; the reference route is the only write path.

## 0.2.0 — 2026-11-18


- Standalone full-screen web board served by DSH, launched from the right sidebar.
- Read-only reference docs, development log, and an interactive SVG structure canvas.
- Architecture (top-down) view with conceptual subsystems, concerns, and derived subsystem dependencies.
- Dependency view with module hierarchy drill-down and external dependency stubs.
- Data-flow view for key attributes: definition, writers, readers, affected concerns.
- Execution-flow view with numbered path, sequence panel, and step navigation.
- Session-workspace resolution with configurable docs/map/log/layout paths.
- Optional committed `docs/board/layout.json` merged under the local drag layout.
- MIT license, English/Chinese README, and public package metadata.
