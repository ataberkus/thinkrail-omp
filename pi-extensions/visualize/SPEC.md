---
id: module-pi-visualize
type: module-design
status: draft
title: "@thinkrail/pi-visualize — the visualize tool for vanilla omp"
parent: module-pi-extensions
tags: [pi-extension, visualization, mermaid]
---

## Responsibility

The published, portable half of the visualization capability: one tool, `visualize`, that validates a
diagram, comparison or file-preview request, returns a markdown fallback as the model-facing result, and draws the
result in omp's terminal UI. It knows nothing about ThinkRail. ThinkRail composes it through [[module-ext-visualize]]'s server half
(the successor of the deleted `packages/pi-visualize`), injecting its strict validator.

## Public surface

- **Default export** — the omp `ExtensionFactory` with the default configuration; what
  `omp plugin install` loads through the `omp` manifest. The tool is registered with
  `loadMode: "essential"` so omp does not hide it behind tool search.
- **`createVisualizeExtension({ validateMermaid?, checkFile?, scratchDir? })`** — returns an `ExtensionFactory` with an injected
  `MermaidValidator: (source) => void | Promise<void>`. The validator **replaces** the default check
  (never supplements it, so a stricter engine can accept syntax the probe would reject). The package
  keeps shape checks, empty-source rejection, source enumeration, awaiting the callback and wrapping any
  throw into the field-specific diagnostic (`` `mermaid` `` / `` `options[N].mermaid` ``) that asks the
  model to correct and retry. `checkFile: (path, cwd) => void | Promise<void>` is the same seam for
  file previews (every `path`/`before`, wrapped into a `` cannot show `path` `` diagnostic asking the
  model to write the file first); without it paths are not checked, because the package stays
  `node:`-free. `scratchDir` names where the prompt guideline sends mockups.
- **The tool contract** renderers key on: the name `"visualize"`, its argument shape
  (`type: "diagram" | "comparison" | "file"`, `title?`, `mermaid?`, `options?[]`, `path?`, `before?`),
  and `details` = the validated params. Changing this shape is a breaking change for every renderer,
  including ThinkRail's.

## Decisions

- **File previews reference workspace files; they never carry content.** `type: "file"` takes a
  workspace path (plus an optional `before` path for a before/after view, rejected when it names the same
  file) rather than inline HTML, so a
  host renders it with its existing file renderers and review comments anchor to a real file the agent
  then edits in place. The flip side is that a rendered file is always its current content: iterating on a
  mockup updates every earlier card, so the guideline tells the agent to copy a proposal it wants to keep
  visible and pass the copy as `before`. The tool's one prompt guideline (appended to the system prompt from `before_agent_start` while the
  tool is active, because omp tools have no guidelines field) asks the agent to write a self-contained
  HTML mockup (inline CSS, `data:` images, controls drawn with styled elements because hosts may strip
  scripts, form controls and external resources) and show it this way whenever it proposes or asks
  about a UI change. The model-facing result and the terminal are one line naming the path(s); a
  terminal user opens them in a browser.
- **Dependency-light for vanilla users: `lovely-mermaid`.** The package depends on `lovely-mermaid` only
  (zero dependencies, ~1 MB, synchronous, Apache-2.0). It is the maintained successor of `grok-mermaid`,
  the engine family that draws ```` ```mermaid ```` fences in chat messages, so a `visualize` diagram
  looks like one the model writes inline. omp's `Markdown` component draws mermaid fences itself through
  its markdown theme's `resolveMermaidAscii`; this package renders tool results with that hook removed so
  its own width-aware tiers below decide when source is shown. `mermaid` (~83 MB with its tree) and the `linkedom` DOM shim it needs under
  Node/Bun were rejected here: they buy strict parsing but no terminal rendering, and a host that
  renders with mermaid can inject that parser through the seam.
- **Post-mortem: `beautiful-mermaid` was replaced.** Its ASCII engine (shared by the `@vercel` and
  `@ktrysmt` forks) routes every edge between one pair of nodes along a single path, so a
  back-and-forth or parallel pair — the common request/response or `Idle ⇄ Running` shape — overprinted
  labels, dropped one, or lost which way each went, and the collapsed TUI showed that drawing with no
  hint. Found in a live vanilla-pi check on an OAuth flow; it also cost ~10 MB with `elkjs`.
- **Default validation is the renderer's own parse, best-effort.** For the kinds `lovely-mermaid`
  draws (flowchart/graph, state, sequence, class, ER, pie, mindmap, timeline, gitGraph — its
  `diagramKind`, which skips frontmatter, directives and comments) the probe rejects an unknown
  flowchart direction (`lovely-mermaid` silently accepts `flowchart XX`; mermaid does not), a source
  in which nothing parsed (`render` → `null`), and any fragment the parse **dropped** (`warnings`:
  dangling links, unclosed labels, unreadable statements). The size-cap warning (`diagram truncated`)
  is a renderer limit, not a source error, and is never a rejection. The library advises against
  gating *rendering* on warnings because streamed sources warn mid-edit; a tool call is complete, so a
  dropped fragment there is a real defect worth a retry. Accepted cost: the grammar is lenient (an
  unclosed class body passes) and has rare false positives (`accTitle`/`accDescr`); a host with a
  strict parser replaces the probe through the seam. Other families (gantt, xychart, …) **pass through
  unvalidated** rather than risk rejecting a diagram type the renderer merely does not know. Probe and
  TUI share one render call that strips leading blank and `%%` lines first: `lovely-mermaid` 0.3.3
  returns `null` for a mindmap behind a comment or `%%{init}%%` directive (other kinds are unaffected).
- **Terminal rendering tiers.** `renderCall` is a one-line summary (`visualize <title | diagram |
  comparison — N options>`). `renderResult` returns a width-aware component: in `render(width)` a
  diagram is drawn only when the art is **complete** (no warnings) and every row fits the width by
  pi-tui's `visibleWidth` (which agrees with the renderer's grapheme-correct widths, so CJK and emoji
  labels draw); otherwise, and for kinds the renderer does not draw, the pi-tui `Markdown` fence of the
  source is shown. Span roles map to omp's theme as pi's native renderer did (`border` →
  `borderMuted`, `text` → `text`, `edge` → `accent`, `edgeLabel` → `muted`). A diagram is never
  word-wrapped. Collapsed = drawing only; expanded = drawing + source fence. Diagrams render from
  defensively checked `result.details`; comparisons, errors (`context.isError`) and missing details
  render from `result.content`; partial results show a placeholder. Image-tier rendering
  (Kitty/iTerm2) is deferred: it needs SVG rasterisation without a browser and degrades under tmux/SSH.
- **Portable runtime.** Shipped code uses `node:`-free standard ESM and omp's host-provided packages
  only; omp and ThinkRail both run it under Bun. Runtime imports from `@oh-my-pi/pi-coding-agent` are
  limited to `getMarkdownTheme` and the `z` schema builder; `@oh-my-pi/pi-tui` supplies `Text`,
  `TruncatedText`, `Markdown`, `truncateToWidth`, `visibleWidth`.

## Boundary

- **Allowed deps:** `lovely-mermaid` (exact pin); peers `@oh-my-pi/pi-coding-agent`,
  `@oh-my-pi/pi-tui`.
- **Forbidden:** anything from ThinkRail (`@thinkrail/*`, `apps/*`, `packages/server`), `mermaid`,
  `linkedom`, Bun-specific APIs.

## Structure

`index.ts` (exports + default), `src/extension.ts` (factory, tool registration, validator wrapping),
`src/schema.ts`, `src/validate.ts` (shape + source enumeration), `src/markdown.ts` (tier-1 fallbacks),
`src/probe.ts` (the shared render call + default validator), `src/tui.ts` (renderers + `DiagramComponent`). `bun test` covers each; the vanilla-parity gate in
[[module-pi-extensions]] exercises the packed artifact.
