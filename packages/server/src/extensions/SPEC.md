---
id: submodule-server-extensions
type: submodule-design
status: active
title: extensions — the server registry of ThinkRail extensions
parent: module-server
depends-on: [module-extension-api, module-thinkrail-extensions]
tags: [extensions, public-surface-checked]
---

## Responsibility

The one place the host lists the ThinkRail extensions it composes ([[module-thinkrail-extensions]]
§ Composition). `registry.ts` statically imports every `@thinkrail/ext-*/server` and exports ordered
entries `{ specifier, extension }` — the `defineServerExtension` descriptor **and** its public server
specifier as a string. The static imports carry the factories into the compiled CLI binary and the
desktop server-runtime bundle through the normal server graph, so the packagers generate no factory
list for registry extensions.

## Boundary

- **Owns:** `serverExtensions` (the ordered entries), `registryInlineExtensions(kind, isDisabled?,
  entries?, session?, onLoaded?)` (flattens `extensions` / `childExtensions` into omp `ExtensionFactory`s,
  each tagged with its owner as `registryName`; each factory asks `isDisabled(name)` **when omp loads it**,
  so a disabled extension contributes nothing to a chat created — or rebuilt by a reload — while it is off,
  and a reload re-decides membership. A parent flatten given a `session` appends `sessionExtensions(session)`
  after the static factories; it calls it once per flatten, so every parent session's factories close over
  its own services. Without a session, and in the child set, session factories are absent),
  `registryToolOwner(tool)` (the registry extension that registered a tool name, recorded through a
  `registerTool` proxy because omp names inline factories by position; process-wide, so the session manager
  also requires that the chat itself loaded that extension). Same-name precedence needs no host ordering:
  omp loads discovered extension paths before inline factories (`sdk.ts`) and resolves a tool name to its
  last registration (`ExtensionRunner.getRegisteredTool`), so a registry tool wins over a user package's
  same-name tool — `ask_user_question` is why that matters ([[pi-compatibility]]),
  `listExtensionCatalog(disabled)` (the Settings catalog: per entry `name`, `title` — falling back to
  `name` — optional `description`, `hasChildExtensions`, `enabled = !disabled.has(name)`, and the tool names
  its **parent** factories register against a recording stub `ExtensionAPI` whose every other member is
  inert. Per-session factories are built for this with an inert session whose `awaitToolResponse`
  rejects. The tools are computed once per process, never from a live session, and a factory that throws against the stub
  keeps the tools it recorded before throwing), and `resolveExtensionSkillRoots(entry)` (the owner-scoped skill resolver: the extension's
  entry file from `specifier`, then each `skillPackages` manifest via `createRequire(extensionEntry)`,
  returning its `pi.skills` directories; a named package with no skills fails loudly). The specifier is kept
  as a string precisely because a descriptor holds functions, which yield no module identity.
- **Public surface (barrel):** `serverExtensions`, `ServerExtensionEntry`, `registryInlineExtensions`,
  `RegistryExtensionKind`, `RegistryExtensionFactory`, `ExtensionDisabled`, `registryToolOwner`,
  `listExtensionCatalog`,
  `resolveExtensionSkillRoots`, `interactiveTools`, `InteractiveTools`, `ExtensionSessionServices`,
  `InteractiveTool`, `ToolResponse`.
- **Session-seam types:** `ExtensionSessionServices`, `InteractiveTool` and `ToolResponse` are re-exported
  from `extension-api/server` so that `agent` can type the services it builds through this barrel.
- **Interactive tools (`interactive.ts`):** `interactiveTools(isDisabled)` folds the enabled registry
  extensions' `interactiveTools` declarations into one name → `InteractiveTool` map (first declaration of a
  name wins). It is the only tool knowledge `agent` holds for restart repair, transcript-derived
  needs-input and late-response wording; nothing in `packages/server` names a tool or imports an extension
  outside `registry.ts`.
- **Allowed deps:** `@thinkrail/extension-api/server` (types), every `@thinkrail/ext-*/server`,
  `@oh-my-pi/pi-coding-agent` (types only), `@thinkrail/contracts` (the `ExtensionCatalogEntry` type),
  Node `module`/`fs`/`path`.
- **Forbidden:** `host`; `settings` (the disabled set arrives as a parameter); sibling features; resolving extension-owned packages from the host's own
  `createRequire` (the host does not depend on the pi packages an extension composes, so that resolution
  breaks in isolated layouts).

## Consumers

`host` answers `extension.list` with `listExtensionCatalog` over the `disabledExtensions` setting.
`agent/extensions.ts` composes the flattened parent set into every resource loader and the child set
into the curated hidden-child extensions in dev and bundled mode alike; `buildSupport.ts` stages the
flattened skill roots for both packagers; unbundled dev resolves the same roots at runtime, and the
bundled runtime uses only the launcher-staged root.
