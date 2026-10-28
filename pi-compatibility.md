---
id: pi-compatibility
type: architecture-design
status: draft
title: Engine compatibility — host adaptations and upgrade removal gates
parent: architecture
references: [submodule-server-agent, submodule-server-agent-mcp, submodule-server-history, submodule-server-templates, submodule-server-host, module-cli, module-desktop, submodule-web-chat, module-pi-subagents, module-pi-background-commands, module-pi-delegation]
tags: [pi, omp, compatibility]
---

## Responsibility

The upgrade checklist for host code that compensates for a missing engine API, an engine defect, or a
packaging constraint. The engine is omp (`@oh-my-pi/*`); file and identifier names still say `pi`. The
engine remains the state owner. Module specs own detailed rationale; this index records what an upgrade
must re-check and what would let us delete each adaptation. The installed version comes only from the root
dependency catalog, not a second pin in this file. Line references below are to the catalog-pinned omp
sources (`node_modules/@oh-my-pi/<package>/src`).

## Last re-check: the pi → omp port

Every entry of the pi 1.4.0 registry was re-checked against omp's installed sources when the engine was
replaced (pi `@earendil-works/pi-*` 1.4.0 → omp `@oh-my-pi/pi-*` 18.13.2). Verdicts:

| Adaptation (pi era) | Verdict | Where it stands |
|---|---|---|
| MCP configuration loader and writers | changed | below |
| MCP runtime status, management, sign-in outcomes | removed (parsers) | below |
| MCP ordered engine shutdown and reload admission | changed | below |
| MCP exposure while codemode is not packaged | changed | below |
| MCP durable presentation details | retained | below |
| MCP ownership guard (`builtin:mcp`, `/mcp` takeover, extension-registered servers) | removed | below |
| Registry-tool reconcile at attach | retained (changed) | below |
| Registry tool precedence (`preferRegistryTools`) | removed | below |
| Image-only queued input (pi #8612) | removed | below |
| Bundled extension loading: forced Jiti transform | removed | below |
| Bundled extension loading: virtual-module identity | changed | below |
| Bundled extension loading: static OAuth/Bedrock registration | removed | below |
| Image-resize override (`images.autoResize:false`) | removed | below |
| Account-scoped model availability: ChatGPT allowlist | removed | below |
| Account-scoped model availability: Central `/models` listing | retained | below |
| Default-model preference mirror | removed | below |
| Headless theme | retained | below |
| Trust discovery and exclusion reloads | changed | below |
| Session discovery and prompt-template parsing | changed | below |
| Subagent usage totals from child transcripts | retained (re-pointed) | below |
| Rollback of a failed usage append | removed | below |
| Detached result hold | retained (changed) | below |
| Session repair (dangling questions) | retained | below |
| Compaction and `length` recovery | changed (regression) | below |
| Context-budget limitations | retained (upstream) | below |
| pi `trust.json` seed for new projects | removed | below |
| pi device id for logins (`piLoginOptions.getDeviceId`) | removed (export kept, empty) | below |

New adaptations the port introduced are listed under **omp-only seams**.

## Upgrade contract

Every engine upgrade checks each entry against the **installed package's exports and implementation**,
not only release notes or an upstream issue's status. The upgrade's verification summary names the
adaptations removed, retained with evidence, or changed, and the affected tests run. A new workaround
adds an entry here and rationale in its owning spec; its removal deletes both the workaround and its
entry. A parity failure is evidence of drift, not permission to weaken the test.

A public SDK replacement must preserve session isolation, cancellation, project trust, durable
transcripts, and compiled/desktop behavior before the host implementation is removed. Production code
imports only `@oh-my-pi/*` package roots and subpaths in their `exports` maps, never omp's
`extensibility/legacy-pi-*` compatibility shims.

## MCP adaptations

### Configuration loader and writers — changed

**Owner:** [[submodule-server-agent-mcp]], `agent/mcp/config.ts` and `writers.ts`.
The host loader is now handed to omp's `MCPManager` as its `MCPConfigLoader` (`mcp/manager.ts:357`); it
reads omp's own files (`<agentDir>/mcp.json`, `<cwd>/.omp/mcp.json`) in omp's schema and ends validation
with omp's public `validateServerConfig` (`mcp/config.ts:339`). omp's `loadAllMCPConfigs`
(`mcp/config.ts:103`) is multi-source, silently drops invalid entries (`capability/index.ts:290`) and has
no per-entry admission, so ThinkRail's loader and project policy stay. omp's writers
(`mcp/config-writer.ts:69`) add `$schema`, force mode 0600 and replace symlinks, so ThinkRail's
multi-client writers stay. **Removal gate:** a public loader with entry provenance and admission before
project overrides merge, and writers that preserve the file as written. Run `agent/mcp/config.test.ts`
(parity cases run against omp's real loader) and `host/mcp.test.ts`. Known divergences from omp's own
CLI: a project override entry other than `{enabled:false}` shadows the user server there; omp collapses
servers with identical transports while the host keeps both.

### Runtime status, management and sign-in outcomes — text parsers removed

**Owner:** [[submodule-server-agent]] `mcpSessions.ts` / `mcpSignIn.ts`, [[submodule-server-agent-mcp]]
`status.ts` / `auth.ts` / `log.ts`. omp exposes typed status and actions — `addConnectionStatusListener`
(`mcp/manager.ts:368`), `getConnectionStatus` (:1235), `waitForStartup` (:1188), `reconnectServer`
(:1472) — and cancellable OAuth (`reauthorizeMcpServer`, `mcp/oauth-reauth.ts:729`, `signal` at :687).
`parseMcpStatusText`, `parseMcpAttentionNotice`, the notice intercept and the isolated probe session are
deleted. The MCP log stays, host-written, because omp writes none (`mcp/transports/stdio.ts:684`
ignores stderr). **Removal gate for the log:** omp-owned per-server diagnostics. Run `mcpEngine.test.ts`,
`mcpSignIn.test.ts`, and the status/log/redaction tests.

### Ordered engine shutdown and reload admission — changed

**Owner:** [[submodule-server-agent]] session lifecycle, [[submodule-server-agent-mcp]] `sessionHost.ts`.
omp's `AgentSession.dispose()` emits `session_shutdown` exactly once and is idempotent
(`session/agent-session.ts:6187-6190`, :6334); extension shutdown handlers run in parallel under a 2 s
cap (`extensibility/extensions/runner.ts:157`, :1725-1736). It does not disconnect a supplied
`MCPManager` (`sdk.ts:4831`), and omp has no in-place reload. The host therefore owns MCP closure
(`shutdownEngine()` closes the load, aborts sign-ins and handshakes, `disconnectAll` — which aborts
handshakes, `mcp/manager.ts:1427` — and joins discovery; repeated calls share one promise), runs it before
`session.dispose()`, and keeps the replacement gate that admits a rebuilt session only after cleanup.
**Removal gate:** an omp lifecycle that closes a supplied MCP manager with the session and an in-place
reload with the same admission guarantees. Run `sessionShutdown.test.ts`, `reloadGate.test.ts` and the
MCP delete/reload/process-lifetime regressions in `mcpEngine.test.ts`.

### Exposure — changed

**Owner:** [[submodule-server-agent-mcp]]. omp has no MCP exposure modes, `tool_search` or codemode. The
host maps ThinkRail's file-level exposure onto omp's tool load modes: `direct` → `loadMode: "essential"`;
`deferred`, `codemode` and unset → omp's discoverable tools mounted under `xd://` (`tools/xdev.ts:87`);
`hidden` → withheld. Per-call confirmation moved from a `tool_call` handler into a host wrapper around
each MCP tool, because omp's `tool_call` handlers run under a 30 s budget that only omp-owned UI dialogs
pause. **Removal gate:** native per-tool exposure and a confirmation hook without that budget.

### Durable presentation details — retained

**Owner:** [[submodule-server-agent-mcp]] `results.ts`, [[submodule-web-chat]]. omp persists the raw MCP
`rawContent` (base64 included) and `structuredContent` in tool details unbounded (`mcp/tool-bridge.ts:290`,
:303), pruning them only when output spills (`tools/output-meta.ts:689`). The host strips them and stores
its bounded, base64-free summary under `details.thinkrail`. **Removal gate:** a bounded durable
representation from omp. Run `mcp/results.test.ts`, `mcpEngine.test.ts`, web MCP card tests and
`e2e/mcp-tool-cards.spec.ts`.

### MCP ownership guard — removed

pi let settings turn the built-in MCP off (`-builtin:mcp`), let an extension replace `/mcp`, and let
extensions register servers. omp has none of these: its MCP settings are `mcp.enableProjectConfig`,
`mcp.startupTimeoutMs`, `mcp.renderMarkdownResults`, `mcp.notifications`, `mcp.notificationDebounceMs`
(`mcp/settings.ts`); `builtin:mcp` and `registerMcpServer` do not exist; and the host's `/mcp` always wins
because discovered extensions load before the host's inline factories (`sdk.ts:2774-2875`) and the last
registration of a command wins (`runner.ts:1407-1440`). `mcpOwnershipGuard`, `MCP_HANDLED_ELSEWHERE`,
`handledElsewhere`, `registered` and the handled-elsewhere UI were deleted with the tests that exercised
only them; "an installed extension that registers /mcp neither replaces the host's command…" stays.

## Other engine-sensitive host seams

- **Registry-tool reconcile at attach — retained, changed.** [[submodule-server-agent]],
  `agentSessionManager.ts`. A resumed chat's recorded tool selection still keeps a tool withheld while its
  registry extension was off, so attach re-applies the host's tool selection. Ownership is now per chat:
  `registryToolOwner` is a process-wide name map (`extensions/inline.ts:69`), so a tool counts as the
  registry's only when this chat loaded that extension; otherwise a same-name package tool was withheld in
  every chat created with ours off. **Removal gate:** a public omp way to keep host-withheld tools apart
  from the recorded selection. Run the restart and toggle-cycle tests in `agentSessionManager.test.ts`.
- **Registry tool precedence — removed.** [[submodule-server-extensions]]. pi gave a tool name to its
  first registration and loaded path extensions before inline factories, so the host reordered the loader
  result (`preferRegistryTools`). omp also loads discovered extension paths before inline factories
  (`sdk.ts:2774-2875`) but resolves a tool name to its **last** registration
  (`extensibility/extensions/runner.ts:1201-1208`, `getRegisteredTool`), so a ThinkRail registry tool wins
  over a user package's same-name tool (rpiv's `ask_user_question`) with no host ordering. Run the
  collision tests in `agentSessionManager.test.ts` (same-name questionnaire before and after reload, and a
  chat created with ours off that re-enables it over the package).
- **Image-only queued input (pi #8612) — removed.** omp's queue is message-identity based: the displayed
  queue is derived from the real queues (`getQueuedMessages`, `session/agent-session.ts:10346`),
  `clearQueue` returns images (:10281), `dropQueuedMessages` removes exactly the reported group (:10393),
  and `onPromptQueued` reports the queued messages (`session/agent-session-types.ts:477`). The host's text
  mirror and stuck-empty compensation are deleted; it keys the user's raw text and images by queued
  message identity, because omp's own restore text is the expanded prompt, or `[Image]` for an image-only
  one (`session/queued-messages.ts`, `queueChipText`). Abort-with-restore withdraws live-steered input with
  `clearQueue({ forInterrupt: true })`. Run the queue tests in `agentSessionManager.test.ts`.
- **Queue clearing on dispose — retained.** omp's `beginDispose` clears only its yield queue
  (`session/agent-session.ts:6150-6172`), so the host still takes the user's queued prompts back before a
  chat is torn down.
- **Bundled extension loading — changed.** [[module-cli]], [[module-desktop]], `buildSupport.ts`.
  - The forced Jiti transform is gone: omp's loader parses and rewrites extensions itself and switches to
    bundled mode when `isCompiledBinary() || PI_BUNDLED` (`extensibility/plugins/legacy-pi-compat.ts:21`).
  - Virtual-module identity changed: the build supplies omp's `omp-legacy-pi-modules` virtual module
    (imported at `legacy-pi-compat.ts:754`; package-root overrides at :1037-1059) for both artifacts.
  - Static OAuth/Bedrock registration is gone: omp's provider code has no variable-specifier dynamic
    imports (`check:seams`), and the binary's OAuth-URL probe passes.
  - The artifact probe that value-imported `pi-ai/models` now value-imports
    `@oh-my-pi/pi-ai/utils/event-stream` and asserts it is the same module instance as the root.
  Run `check:seams`, `build:binary`, `smoke:binary` and the desktop runtime probes.
- **Image-resize override — removed.** pi's photon/WASM resizer could not be bundled, so the host forced
  `images.autoResize:false`. omp resizes with `Bun.Image` (`utils/image-resize.ts:115`, :307-336), which
  works in both artifacts; the setting now governs only `read`, `gh` and `@file` mentions
  (`tools/read.ts:1491`, `tools/gh.ts:264`, `session/agent-session.ts:8830`), and prompt images are always
  normalized at the provider boundary (`session/session-provider-boundary.ts:295`). The user's own
  setting applies. `imageGuard` stays (below).
- **Oversized-image guard — retained.** omp normalizes images without the host's per-image, count-aware
  and request-wide limits (`utils/image-loading.ts:257-288`). Run `imageGuard.test.ts`.
- **Account-scoped model availability — ChatGPT rule removed, listing rule retained.**
  [[submodule-server-agent]], `modelAvailability.ts`. pi's `openai` provider had a "Sign in with ChatGPT"
  token-sharing flow that listed the whole API catalog; omp has no OAuth flow for `openai` (ChatGPT sign-in
  is the separate `openai-codex` provider with its own catalog, `pi-ai/src/registry/oauth/`), so the
  allowlist could never apply and is deleted, and the pi import does not carry such a sign-in over (the
  user signs in again). Central proxies still advertise a narrower catalog than omp's, so the host still
  intersects opaque providers with their `/models` listing. **Removal gate:** omp narrowing a rerouted
  provider's catalog to what its endpoint serves. Run `modelAvailability.test.ts` and
  `runtimeGenerations.test.ts`.
- **Default-model preference — removed.** omp exports its startup picker, `pickDefaultAvailableModel`
  (`config/model-resolver.ts:88`), which also prefers signed-in providers over ambient ones
  (`ModelRegistry.hasConcreteAuth`). `preferredDefaultModel` delegates to it and `listSettledModels`
  returns omp's pick, so new-chat, reviewer and one-shot defaults are omp's (for example
  `anthropic/claude-opus-5-5`, where pi's map said `claude-opus-4-8`).
- **Headless theme — retained.** [[submodule-server-agent]], `plainTextTheme`. omp's no-UI extension
  context returns pi-tui's global theme (`runner.ts:481`), which only omp's CLI commands initialize, never
  `sdk.ts`. Run `webUiContext.test.ts`.
- **Trust — changed.** omp has no project-trust gate: `ExtensionContext.isProjectTrusted()` is hard-wired
  `true`, any cwd contributes project settings, and capability discovery reads project rules, skills,
  `SYSTEM.md` and `SYSTEM_TEMPLATE.md` whatever the trust. The host enforces ThinkRail's grant itself:
  untrusted settings load only the user layer (`piSettings.ts`), extension and custom-tool discovery is
  off and replaced by trust-filtered paths, project skills are dropped, untrusted chats get user-level
  rules and the user's (or omp's bundled) system prompt in place of a project override (`extensions.ts`),
  and delegated children get the same prompt through the `childSystemPrompt` binding
  ([[module-pi-delegation]]). **Removal gate:** an omp trust gate covering every project-scoped capability.
  Run `projectTrust.test.ts`, `extensions.test.ts`, `delegation.test.ts`.
- **Session discovery and prompt templates — changed.** [[submodule-server-history]],
  [[submodule-server-templates]]. History now uses omp's public `SessionManager.getDefaultSessionDir`,
  `getSessionsDir` and the header `title`; templates use `@oh-my-pi/pi-utils` (`getProjectPromptsDir`,
  `parseFrontmatter`) with `<cwd>/.omp/prompts` and `<agentDir>/prompts`. The host still mirrors omp's
  template precedence and recursion for its editor; keep the parity tests in history, template and
  composer suites.
- **Subagent usage totals from child transcripts — retained, re-pointed.** `subagentUsage.ts` mirrors
  omp's `entryUsage` (`session/session-manager.ts:417-424`) for a bare transcript; the parity test now
  reconciles against omp's cumulative `getUsageStatistics()` (:3177), including off-branch spend. The
  only difference: omp's `taskUsageFrom` (:411) accepts any object as usage, the host's guard is stricter.
  **Removal gate:** an exported totals helper over entries or a file.
- **Rollback of a failed usage append — removed.** omp truncates a torn append (`session/session-storage.ts`
  `#writeNow`), keeps the entry in memory and rewrites the whole transcript on the next append
  (`session-manager.ts:1860-1866`, `#rewriteSynchronously`), adopting the file when the torn bytes cannot
  be truncated (:1216). An entry kept only in memory at close is not on disk (:2947-2995); the host's
  reconciliation on reopen covers it. `delegation.test.ts` pins these through fault injection on omp's
  real writer.
- **Detached result hold — retained, changed.** [[module-pi-subagents]] (Result delivery),
  [[module-pi-background-commands]]. omp's extension `sendMessage(..., { deliverAs: "aside" })` lands in a
  session-owned queue (`session/agent-session.ts:10084-10090`) that the loop drains at its step poll
  (`agent-session.ts:2366-2391`, pi-agent-core `agent-loop.ts:1805-1840`); extensions still cannot inspect
  or withdraw one queued message, so a pushed result could duplicate one the agent pulls before the poll.
  The owners keep holding outcomes and release them only at a boundary. That boundary moved: omp awaits
  extension `tool_result` handlers inside tool execution (`extensibility/extensions/wrapper.ts:521`) but
  only pushes `turn_end` and awaits its own `onTurnEnd` hook (`agent-loop.ts:780-800`,
  `agent-session.ts:2261`) before the poll, and runs extension session-event handlers after subscribers
  and unordered against the loop (`agent-session.ts:3815-3850`). A `turn_end` aside (pi's step boundary)
  therefore arrived one request late, so both owners release at the batch's last `tool_result`, tracking
  the batch from `tool_call` (emitted for the whole batch before dispatch, `agent-loop.ts:3090-3180`)
  rather than resetting it from late `turn_end`/`agent_end` handlers. The host gate admits delivery once
  a live question's response is accepted (`awaitsResponse`), not only after its `turn_end`, and the host
  no longer flushes from its `turn_end` subscriber. **Removal gate:** a per-message queue handle an
  extension can withdraw, delivered at the next step rather than at run end — even then, keep the
  claim-on-pull rule. Run the `pi-subagents` and `pi-background-commands` suites (the "joins the request
  right after its batch" cases) and `agent/chatResources.test.ts` ("waits for the live question's
  native turn_end").
- **Session repair — retained.** [[submodule-server-agent]], `sessionRepair.ts`. omp strips dangling tool
  calls from the model context (`session/session-context.ts:695`), which would delete a pending question
  instead of leaving it answerable, and its `session_exit` entry records `pendingToolCalls` on dispose
  (`session/agent-session.ts:3740-3775`) without writing an answer. The host still repairs a dangling
  question to an answerable ack on the next attach; the restart, ask-off repair and polite-shutdown ack
  tests in `agentSessionManager.test.ts` pass.
- **pi trust seed — removed.** omp keeps no per-project trust decision, so a newly added project starts
  untrusted; `setPiTrustSeed` / `piTrustsProjectPath` are deleted.
- **Login device id — removed.** omp's providers derive and persist their own installation identity
  (for example `pi-ai/src/registry/oauth/kimi.ts:32`, `providers/anthropic-identity.ts:93`). `piLoginOptions`
  remains the object every login receives, now empty.

## omp-only seams

- **Capability file cache.** omp's capability discovery caches file and directory reads for the life of
  the process (`capability/fs.ts`), which suits a run-per-process CLI. The host is long-lived, so it calls
  the capability module's public `reset()` before building a chat's resources and before listing skills.
  **Removal gate:** omp invalidating on change or per session. Run `extensions.test.ts`
  ("project prompt files under trust").
- **Process postmortem.** Importing `@oh-my-pi/pi-utils` installs omp's process handlers for SIGINT,
  SIGTERM, SIGHUP, `uncaughtException` and `unhandledRejection`, which run registered cleanups and then
  exit (`postmortem.ts:688-777`). The host's graceful shutdown and crash report are therefore exit-only
  postmortem cleanups (`host/boot.ts`, `host/crashLog.ts`); a signal still ends the host with 0 once its
  shutdown finishes, and a fatal fault with 1. Run `processSignals.test.ts` and `crashLog.test.ts`.
- **Registered model lists replace.** `registerProvider(id, { models })` is documented as replacing the
  provider's models (`extensibility/extensions/types.ts:2003`, :2071), but omp filters the built-ins only
  when the registry already holds a full snapshot; any later static reload re-merges built-ins with the
  runtime overlays (`config/model-registry.ts` `#projectBaseModels`, :1208-1216). `ModelRuntime` serves only
  the registered ids for such providers. **Removal gate:** `modelRegistry.getProviderModels` returning only
  the registered ids after a reload. Run `piRuntime.test.ts` ("explicit model list"), which also asserts the
  merge as its drift canary.
- **Input-gated local refresh.** omp's offline `ModelRegistry.refresh` recomposes every catalog and
  `refreshProvider` (:718) adds a static reload plus all other runtime discoveries per call, so
  `ModelRuntime.refresh` reloads credentials every time and rebuilds the catalog only when the models config
  file or stored-credential rows changed. **Removal gate:** an omp refresh cheap enough for per-read
  `provider.status` polling. Run `piRuntime.test.ts` ("offline refresh rebuilds").
- **Agent directory snapshot.** omp resolves `PI_CODING_AGENT_DIR` when its modules load. The host
  refreshes omp's directories after applying the stored environment (`refreshDirsFromEnv`), and tests
  isolate the directory with `pi-faux`'s `isolateAgentDir`.
- **Import cost.** A cold `import("@oh-my-pi/pi-coding-agent")` takes about 2.5 s on a 2-CPU runner (pi
  1.4.0: about 0.7 s), so tests that spawn a process loading omp (crash log, process signals, pi-dag
  recovery workers) carry a 30 s budget rather than the default 5 s.
- **Display transcript.** omp's model context drops `error`/`aborted` assistant turns and retried attempts
  (`session/session-context.ts:753-786`, :421-427), which pi's resolver kept. Every host transcript read —
  live and shut-down chats, subagent transcripts and the history index — uses omp's display transcript
  (`AgentSession.buildTranscriptSessionContext`, or `buildSessionContext` with `transcript` and
  `collapseCompactedHistory`), so a reopened chat still shows its final failure and indexes stay aligned.
  Not a workaround; on upgrade, re-check that the collapsed display mode keeps those turns. Run
  `agentSessionManager.test.ts` ("a re-opened chat whose last turn failed") and `history/extract.test.ts`.
- **Lazy transcript writes.** omp writes a new transcript only at the first assistant message; delegated
  children call `ensureOnDisk()` before their first prompt so a running child has a transcript.
- **Artifact seams.** Native addons are embedded and extracted for the binary and copied beside the
  desktop runtime; omp's worker host (`subprocess/worker-client.ts:152,171`) re-enters the CLI binary with
  a selector. The desktop runtime declares no worker host: omp features that need workers (JS eval,
  browser, local models, TTS/STT, embeddings) are not in ThinkRail's tool set and fail closed there.
- **pi data import.** On first start the host copies a pi installation's chats (upgraded to omp's entry
  vocabulary, originals untouched), logins and user MCP servers into omp's agent directory once
  (`piMigration.ts`) — except a sign-in omp has no flow for (pi's ChatGPT token sharing for `openai`), which
  the report lists for the user to redo; a pi 1.x transcript opened later is upgraded in place with a `.pi-1.x` backup or
  fails with a logged `PiSessionFormatError`. A repository's `.pi/mcp.json` is not moved.

## Compaction and `length` recovery — changed (regression)

omp accepts a summary cut off by the output limit (`stopReason: "length"`) and persists it as a successful
compaction (`pi-agent-core/src/compaction/compaction.ts:1077` rejects only `error`; :1303-1311 accept
`length`), where pi rejected it. The host adds no summarizer of its own; `compactionEvents.test.ts` pins
omp's behaviour as an upstream canary. A failed method falls through to the next method and to other
authenticated models (`session/session-maintenance.ts:5494-5600`), and transient summarizer errors retry
(`oneshot-retry.ts:158`).

## Context-budget limitations

**Owner:** [[submodule-server-agent]]. Upstream limitations, not host adaptations. `findCutPoint` keeps
the newest group whole even when it alone exceeds the budget (`compaction.ts:518-560`), and the summary
input has no budget (omp adds rescue tiers only when there is nothing to summarize,
`session-maintenance.ts` ~5040). Bounded tool results therefore do not guarantee whole-request admission.
**Upgrade check:** inspect those functions for retained-batch and summary-input budgeting. Do not
compensate with host retries or compaction-default overrides.

## Not temporary SDK workarounds

Project-server approvals, private project/chat overrides, confirmation policy, credential masking,
wire capability checks and React presentation are deliberate ThinkRail behavior. Their owners are
[[submodule-server-agent-mcp]] and [[submodule-server-agent]]. An engine upgrade does not silently remove
or weaken them. Reusing an upstream policy is a separate compatibility/product decision, not an
assumption that similarly named APIs have identical semantics.
