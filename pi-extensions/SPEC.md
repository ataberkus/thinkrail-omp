---
id: module-pi-extensions
type: module-design
status: draft
title: Portable omp packages (pi-extensions/)
parent: architecture
tags: [pi-extension, publishing]
---

## Responsibility

The workspace root for oh-my-pi (`omp`) packages ThinkRail **publishes to npm** and that must work in
**vanilla `omp`** with no ThinkRail present. Directory and package names keep their historical `pi`
prefix. Each package here is a capability (tools, skills) the agent can use anywhere;
ThinkRail is one embedder among others. The ThinkRail-specific halves of a capability live in
[[module-thinkrail-extensions]], never here.

Until a package's wiring PR lands, its predecessor under `packages/pi-*` stays untouched and loaded by the
host — two copies coexist on purpose and the wiring PR deletes the old one. A new package starts at
`version: 0.0.0` and gets its first real version from its first changeset.

## Identity and distribution

- npm name `@thinkrail/pi-<name>` (the npm org is `thinkrail`; org name = scope), directory
  `pi-extensions/<name>/`. Private workspace packages share the scope but stay `private: true`; owning
  the org keeps their names from being claimed on npm. Packages first shipped under the interim
  `thinkrail.ai` org (only `@thinkrail.ai/pi-visualize@0.1.0`) are deprecated there and point here. The
  scope is deliberate: unscoped `pi-*` names collide (`pi-subagents` is
  third-party) and the scope attributes ownership in the
  `pi.dev/packages` gallery, which is an index of npm packages carrying the `pi-package` keyword — there
  is no registry to submit to.
- **Two shapes.** An *installable omp extension* carries an `omp` manifest (`extensions: ["./index.ts"]`)
  and the `pi-package`/`oh-my-pi` keywords. omp reads `pkg.omp || pkg.pi` (plugin loader, installer and
  manager), so only the `omp` key is published; the manifest has no skills key, because omp discovers a
  package's `skills/` directory by convention (`discovery/omp-plugins.ts`). A *portable library* (e.g. delegation)
  has named exports only — no manifest, no keyword, never a no-op factory — and is verified through its
  packed consumer.
- **Raw TypeScript, no build step** (omp is a Bun CLI and loads TypeScript entrypoints directly). `files` is a package-specific
  whitelist of everything the entrypoints and `exports` transitively import, tests excluded; `exports`
  preserves every subpath an existing consumer uses (e.g. `./core`). omp SDK packages are
  `peerDependencies: "*"`; `@oh-my-pi/pi-tui` is a `"*"` peer where TUI rendering exists. omp remaps a
  plugin's `@oh-my-pi/*` imports onto its own instance. Tool schemas use omp's `z` builder from
  `@oh-my-pi/pi-coding-agent`, not TypeBox. The tested omp version is the root catalog's and is never
  restated here (architecture Decision 10).
- The ThinkRail host consumes these packages through `workspace:*`; the published artifact is verified by
  the parity gate, not by the host.

## Vanilla-parity bar

Required before a package's first publish, and the definition of "works in vanilla omp":

- Installs from its **packed tarball** through `omp plugin install` (omp runs `bun install` in its plugins
  root), loads through omp's own plugin discovery with zero diagnostics, binds to the host omp rather than
  a plugin-local copy, and registers its tools and skills.
- **Runtime.** omp is Bun-only: its CLI runs under Bun, the standalone binary embeds it, and plugins are
  imported in-process. There is no Node host to stay portable to, so the old Node run and the scan for
  Bun-only APIs are gone; the gate runs the package in omp's own Bun process instead. What omp hides is a
  stale engine import: its plugin loader silently remaps `@earendil-works/*`, `@mariozechner/*` and
  `typebox` onto a legacy-pi compat layer, so such a package loads and passes every runtime case. Shipped
  code therefore imports only `@oh-my-pi/*` public entries (never `extensibility/legacy-pi-*`), and the
  gate rejects the legacy specifiers in the tarball.
- **Tool registration.** omp presents an extension tool as `discoverable` (behind tool search / `xd://`)
  unless it sets `loadMode: "essential"`; these tools set it so the model sees them directly, as in pi.
  omp's tool definition has no `promptSnippet` or `promptGuidelines`: the description carries the
  summary, and guidelines are appended to the system prompt from `before_agent_start` while the tool is
  active.
- TUI: `renderCall` and `renderResult` wherever the plain text fallback reads poorly; every UI call behind
  `ctx.hasUI`. A **manual check in a real terminal** (Ghostty/iTerm2, and inside tmux) is part of the bar.
- No ThinkRail assumptions: no `~/.thinkrail` paths, no host wire, no `@thinkrail/*` imports other than
  sibling portable packages.
- Gate: `bun run check:pi-packages` (`scripts/check-pi-packages.ts`, CI job `pi-packages`, provider-free).
  Packs every publishable package and rejects legacy engine imports in each tarball. Installs omp at the
  catalog version with `bun add` into a fixture **outside the repository**. Serves the packed tarballs
  from a loopback npm registry for the packages' scope, so pending sibling versions resolve and any other
  `@thinkrail/*` dependency fails. Then, per package, with an isolated `HOME` (the user plugins root is
  `~/.omp/plugins`), `PI_CODING_AGENT_DIR`, bun cache and a scope-only `.npmrc`, it runs the fixture's
  `omp plugin install @thinkrail/pi-<name>`: the command the package README gives users. That install
  already loads every declared `omp.extensions` entry and fails on a missing or factory-less one. The gate
  copies `scripts/pi-package-parity.omp.mjs` **into the fixture** and runs it under Bun. It refuses to run
  unless the runner sits in the fixture, `@oh-my-pi/pi-coding-agent` resolves into the fixture's
  `node_modules`, and `PI_CODING_AGENT_DIR` was set at spawn (omp snapshots it on import). The runner
  finds extensions as a session does: `discoverSessionExtensionPaths` with settings loaded from the
  isolated agent dir, then `loadExtensions`. It asserts zero errors, a loaded extension inside the
  installed plugin directory, no module loaded from the plugin root's own `@oh-my-pi/` copy (bun installs
  the `*` peers there), and the expected tools with `loadMode: "essential"`. Skills are checked through
  `discoverSkills`. Last, it executes a per-package case table: tool calls, expected text or error, a
  `renderResult(...).render(width)` check against omp's real theme with terminal sequences stripped, and
  an expected `terminate` flag. A case may script the UI the tool sees: `ui.mode` (`tui` or `rpc`),
  `ui.replies` answering `select` (a number picks that choice) and `input` in order with `null` dismissing,
  and `ui.keys` as raw terminal input fed to the component a `ui.custom` factory returns. Cases without
  `ui` get `hasUI: false`. `--packages-dir <dir>` points the gate at another packages root, e.g. a
  deliberately broken copy. *Session-bound* tools (registered in `session_start`, e.g. subagents,
  background-commands) will need a mode that binds an isolated `AgentSession` on the faux provider, added
  with the first wave that ships one. Token-backed smokes stay on-demand.

## Release

`@changesets/cli` (catalog-pinned; `privatePackages: { version: false, tag: false }` so only this root is
ever versioned or tagged). A PR that changes a published package adds a changeset (`bun changeset`).
**Versioning is a human step**: a maintainer runs `bun run release:version` (`changeset version` +
`bun install`) on a branch and opens an ordinary PR — JetBrains' org policy forbids Actions from creating
PRs, and an ordinary PR also gets normal CI, which a bot-opened one would not. When that PR is on `main`,
`.github/workflows/release-pi-packages.yml` runs in the `npm-release` environment with `id-token: write`:
re-runs the parity gate, then `bun run release:publish` (`scripts/publish-pi-packages.ts`), which exits
early while any changeset is still pending (versions not bumped yet) and otherwise publishes
**dependencies before dependents**, each package whose version is not yet on npm: `bun pm pack`
(rewrites `workspace:*`/`catalog:` to exact versions, satisfying Decision 10) → `npm publish <tgz>
--provenance --access public` under npm Trusted Publishing (Bun has no OIDC auth; npm ≥ 11.5.1) →
`changeset tag` + push only when the script reports `readyToTag=true`: no pending changesets, not a dry
run, and every current public version is on npm (published now or earlier, e.g. by the manual
bootstrap). An early exit therefore never tags the placeholder `0.0.0`, and `changeset tag`'s skip of
existing tags makes a retry after a failed tag push safe.

Trusted Publishing is configured per *existing* package, so each new package gets one manual bootstrap
publish first: `bun run release:pack <dir>` packs it and prints the `npm publish … --provenance=false`
command for an npm-org owner (the manifest's `publishConfig.provenance` would otherwise make a local
publish fail; only CI can attest).

Order: visualize → ask-user-question → delegation + subagents → background-commands → spec-graph →
todos. Not published:
`pi-thinkrail-workflow` (workspace-internal), `pi-dag` (until it has a consumer).

## Boundary

- **Allowed deps:** pi SDK peers, sibling `pi-extensions/*`, ordinary npm runtime deps declared exactly.
- **Forbidden:** `@thinkrail/*` host packages, `packages/server`, `apps/*`, `thinkrail-extensions/*`.
- Dependency edges between siblings (e.g. subagents → delegation) are listed here when they exist:
  `subagents → delegation`, `dag → delegation`.

## Members

| package | shape | notes |
| --- | --- | --- |
| `visualize` | extension | `visualize` tool; `lovely-mermaid` for TUI box-drawing and the best-effort vanilla validation; exports `createVisualizeExtension({ validateMermaid })` so an embedder can inject a strict validator — ThinkRail does, from [[module-ext-visualize]]. Detail: [[module-pi-visualize]]. |
| `ask-user-question` | extension | `ask_user_question` tool: a terminal questionnaire in omp's interactive mode, one dialog per question in RPC hosts; exports `createAskUserQuestionExtension({ ask, guidance })` so an embedder can answer through its own UI, and a runtime-import-free `./core`. ThinkRail composes it from [[module-ext-ask-user-question]] with an asker over its answer mailbox. Detail: [[module-pi-ask-user-question]]. |
