---
id: submodule-web-chat-tools-web
type: submodule-design
status: active
title: web tool renderers (search / URL read)
parent: submodule-web-chat-tools
depends-on: [module-contracts]
tags: [chat, web-tools]
---

## Responsibility

Presentational renderers for the engine's web access: `WebSearchCard` for omp's native **`web_search`**
(joined by tool name in `register.ts`, with a collapsed-header summary) and `WebFetchCard`, the
presentation of a **`read` whose target is an HTTP(S)/`www.` URL** — omp fetches pages through `read`, so the
parent `ReadCard` (the one `read` registration) delegates to it. `register.ts` is imported for its side effect
by the parent `tools/register`.

*History:* this module rendered the third-party `pi-web-access` extension's `web_search` /
`fetch_content` / `get_search_content`. omp replaced all three: search is native, a fetch is a URL `read`,
and there is no stored-content follow-up tool, so its card was removed rather than kept for a name no
session exposes.

## Boundary

- **Owns:** `WebSearchCard` (query + provider + synthesized answer, sources and citations), `WebFetchCard`
  (external link + range + extracted content), the shared folded Markdown result body, `httpUrl`, and
  registration.
- **Public surface:** none beyond the side-effect `register` and `WebFetchCard` for the parent `ReadCard`
  (no barrel — chat pulls shiki; per-file like its siblings).
- **Allowed deps:** sibling/parent chat primitives (`toolRegistry`, `Collapsible`, `Markdown`,
  `readTarget`, `toolDetails`); `@thinkrail/extension-api/web` (`ToolRenderProps`/`ToolStatus` + pure
  helpers); `@remixicon/react`.
- **Forbidden:** value-importing any `pi` package; `store`/`transport` (renderers stay presentational —
  extraction-ready into `packages/chat-ui`).

## Get right

- **Render defensively.** omp's `details` are not a stable public API. `web_search` reads
  `details.response` (`provider`, `answer`, `sources[{title,url,snippet}]`, `citations[{title,url,citedText}]`)
  best-effort and otherwise renders the text content. The model-facing text is not Markdown (indented source
  lists would render as code), so the structured response wins whenever it has content.
- omp reports a failed search as a *successful* result whose text starts `Error:` and whose
  `details.error` is set; the card shows that as an error.
- A URL read's text leads with a `URL:/Content-Type:/Method:` header up to `---`; the card drops it when
  `details.kind` is `url` and the read was not `:raw`. Unranged, non-raw content renders as Markdown; a
  ranged or raw read stays verbatim text.
- Only HTTP(S) URLs become anchors (new-tab, `noreferrer`); any other source or target stays inert text.
- Token-utility styling only (no raw hex / inline `style`).
- Tool name `web_search` must match the engine exactly.
