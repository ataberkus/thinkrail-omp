---
id: submodule-server-agent
type: submodule-design
status: active
title: agent — in-process pi sessions
parent: module-server
depends-on: [module-contracts, module-pi-delegation, module-pi-subagents, module-pi-background-commands]
references: [module-spec-graph, central-integration, submodule-server-extensions]
tags: [pi]
---

## Responsibility

The in-process `pi` engine: a current shared model/auth runtime generation for pre-session work and future
chats, the lifecycle of `AgentSession`s (one per chat tab, rooted in a workspace's worktree and retaining the
runtime generation they were created with), Pi resource/skill loading (including portable
cross-agent skill discovery + a pre-session skill catalog), the **extension-UI bridge** that turns pi's
in-process `uiContext` dialog calls into WS frames, the **`ask_user_question`** answer mailbox and
answer-injection path behind the ask-user-question extension, and the **restart repair** that keeps
re-opened transcripts provider-valid.

## Boundary

- **Owns:**
  - `piRuntime` (the current shared `ModelRuntime` generation — pi's canonical model/auth facade for
    catalogs, credentials, availability, login/logout, request dispatch, and **`usageLimits(force)`**: omp's
    `authStorage.usage.reports` (force invalidates omp's usage cache first) normalized by the pure
    `toProviderUsage` into the wire `ProviderUsageProvider[]` — reports grouped per provider, empty reports
    dropped, omp's `resolveUsedFraction` for the amount, and identical routing-copy limits deduplicated). Sibling consumers use the
    `usePiRuntime()` callback to capture the current generation rather than receiving a mutable singleton;
    host boot initializes it before any model work, while later Central artifact changes prepare and atomically
    activate a fresh generation. Tests configure the factory before initialization. Every runtime is created
    with **ambient network OFF** (`allowModelNetwork: false`: the registry loads offline from builtins,
    `models.yml` and omp's model cache), because a network refresh awaits remote catalog fetches with no
    timeout — on the `provider.status` and host-boot paths that stalls wherever egress is slow or
    blocked. The one deliberate opt-in to
    live catalogs is the single-flighted **`refreshCatalogs(runtime)`** (issue #98) behind two triggers: a detached task from `model.list` only
    (`listAvailableModels` fires it, then serves the current snapshot — the picker read never awaits the
    network; broader triggers — `model.default`, new-chat default resolution, host boot — were considered
    and declined, so those read the snapshot through `listSettledModels`) and
    **awaited** via `model.refresh` (`refreshAvailableModels`, the picker's freshness affordance: await
    the refresh, then serve the post-refresh snapshot **with `complete`** — `refreshCatalogs` resolves a
    `CatalogRefreshOutcome` saying whether the pass it waited on settled, and that verdict travels to the
    client as `RefreshedModels.complete`, because a capped wait can only promise a *current* list, not a
    settled one, and catalog authority must key on the difference). Per-call `refresh({ allowNetwork: true, force })`,
    where **`force` is the caller's intent, not a constant**: an *implicit* trigger (`model.list`, opening
    the picker) leaves it off and omp's `online-if-uncached` strategy fetches only providers without a
    fresh cached catalog (24h), while a *user-initiated* refresh (the picker's Refresh row →
    `model.refresh({force:true})`) uses omp's `online` strategy, so an explicit refresh always fetches.
    **Single-flight per runtime instance keyed with the kind**: an implicit caller joins any pass, a
    forced caller never joins an unforced one (it would inherit the cache hit) and instead queues behind
    it. The **15s budget** is applied **twice**, both on **unref'd** timers (must not hold a
    shutting-down host or a test process open): as the refresh's **abort** signal (a hung refresh must
    self-expire or single-flight would wedge) *and* as the ceiling on what a **caller awaits**, because
    omp's registry refresh takes no signal (the abort only ends the wait) and the signal does not bound a
    forced pass queued behind an unforced one — without it one slow provider leaves every picker's
    refresh row spinning. A timed-out caller serves the registry as it stands (reporting
    `completed: false`) while single-flight keeps tracking the unbounded pass (so it cannot start a second concurrent refresh); failures emit only a closed generic/count warn log (never provider ids or errors) + are swallowed, never the picker's problem; **`PI_OFFLINE`**
    — a host-only switch omp does not read — keeps `refreshCatalogs` and `ModelRuntime.refresh` offline,
    resolving as a *completed* pass, since with nothing fetchable the registry as it stands is the settled
    answer; the e2e webServer env and the manager's unit suite set it for hermeticity. The **provider-credential surface** over this runtime —
    `provider.status` + in-app login — lives in the sibling `auth` module (which consumes the shared
    `usePiRuntime` callback), **not** here.

    Candidate preparation takes only the reviewed opaque Central path set, builds a fresh runtime, applies the
    composition root's invariant generation initializer (the source-mode e2e host uses it for its gated fake
    providers), records that pre-opaque provider-id allowlist for `provider.status` together with each id's
    display name at that moment, and then applies the opaque
    extensions once through omp's public headless `loadExtensions`. The generation separately records ids introduced
    or replaced by that loader (`opaqueProviderIds`) through opaque registration-identity comparison, never
    configuration values. The allowlist stays the full pre-opaque set: a novel Central id was never in it
    and so never becomes a row, while a replaced built-in (`anthropic`, `openai`, …) stays visible and
    auth attributes it to Central by intersecting the two sets. (Subtracting the opaque set from the allowlist
    — briefly done for analytics attribution — made every Central-routed provider vanish from the Providers
    section; the two facts must stay separate.) Thus auth never inspects or emits Central's provider
    configuration, while an add/remove/replace can never drop process-local provider registrations. The
    initializer must be configured before the first generation and runs for every candidate. The path is the
    only artifact fact this module receives;
    it never reads, parses, hashes, snapshots, logs, copies, or serves the file. Initializer/extension/loader/
    provider failures discard the candidate and collapse to a closed `load-failed` outcome; raw diagnostics
    never reach `pi.extensionUi`, the wire, logs, analytics, persistence, or snapshots. Auth owns file watching,
    coalescing, and stale-candidate rejection; agent only prepares and activates a generation.

    `getSessionRuntimeGeneration` exposes a live session's retained generation for synchronous host metadata
    reads. Activation changes the current pointer for pre-session reads and future session creation; it never
    mutates, drains, or recreates existing sessions. A live session keeps its original runtime generation. A disk session
    attached after activation keeps its saved model when that model is available in the current runtime.
    If it is unavailable, Pi chooses its settings default, then its ordered provider defaults, then the
    first available model; this need not match ThinkRail's AppConfig default or the saved provider.
    The exception is a model pi still lists but the account does not serve (`modelAvailability` filtered
    it), which pi would otherwise restore verbatim; the host passes `preferredDefaultModel` instead.
    Opening does not change the saved model. An ordinary physical-model fallback becomes durable when
    Pi appends an assistant response, not at send acceptance; explicit model selection persists at once.
    Merely opening a chat preserves its original model for when that provider returns. The host exposes
    the replacement in normal session state but discards the SDK's `modelFallbackMessage`, so there is
    no separate fallback warning. With no available model, the transcript remains readable and no
    placeholder model is persisted as a replacement.

    Every models **read** goes through **`settledAvailableModels(runtime)`** — `getAvailableSnapshot()`
    (omp's synchronous `ModelRegistry.getAvailable()`: a configured-auth check over the current catalog,
    with no token refresh or network) narrowed by `modelAvailability` — so `model.list`, `model.default`
    and every inbound model-ref check answer without waiting, and the picker, default and model resolution
    agree within a generation.
  - `modelAvailability` — narrows that snapshot to what the **connection** serves; omp's catalogs are
    per-provider, not per-account, so a provider omp calls configured can still 400 on most of its catalog.
    One rule, scoped by `baseUrl` so custom or rerouted models are untouched (pi's ChatGPT-sign-in
    allowlist is gone, [[pi-compatibility]]): an
    **opaque (Central) provider** keeps the ids its proxy advertises on `GET /models` (OpenAI wire) or
    `GET /v1/models` (Anthropic wire), an alias matching a listed `-YYYYMMDD` / `-YYYY-MM-DD` dated id
    (the proxy resolves `gpt-4o` to `gpt-4o-2024-11-20`). Listings are read with omp's resolved auth beside
    `refreshCatalogs` (detached on `model.list`, awaited and forced on `model.refresh`), single-flighted,
    5s-bounded end to end (one deadline covers credential resolution and the fetch, so a stalled OAuth
    refresh cannot wedge the single flight), throttled to 60s per runtime, and a change publishes
    `provider.changed` so the picker re-reads; an unknown wire or a never-read listing filters nothing,
    and a failed re-read keeps the last listing. Failures log only a closed count, never provider ids or
    the provider's error text. Direct API keys and subscriptions keep omp's catalog: no listing was verified to
    agree with omp's aliases there.
  - `modelDefaults` — `preferredDefaultModel(available, hasConcreteAuth?)` delegates to omp's exported
    startup picker `pickDefaultAvailableModel` (an account or provider default first, signed-in providers
    ahead of ambient ones, else the first model), so new-chat, reviewer and one-shot fallbacks are omp's
    own pick.
  - `modelRuntime` provider metadata the host derives because omp does not carry it: API-key entry is
    offered for a builtin provider with an env-key fallback (`listProvidersWithEnvKey`) unless that
    fallback is an OAuth access token (`*_OAUTH_TOKEN`, e.g. `openai-codex`) or the provider authenticates
    without a key (`allowsMissingApiKey`, e.g. `bedrock-mantle`); **subscription** sign-ins are the
    host's `SUBSCRIPTION_SIGN_INS` (pi's `isSubscription` providers under their omp ids: `anthropic`,
    `openai-codex`, `github-copilot`, `kimi-code`, `xai-oauth`, `muse-code`), which feed
    `HostProvider.auth.oauth.isSubscription` and `isUsingSubscription`. A `NativeProvider` with only a
    key-entry flow is registered with that flow as its omp `oauth.login` (returning the key, which omp
    stores as an API-key credential): omp otherwise demands `apiKey` or `oauth` for a provider with
    models, and a configured `apiKey` reference shadows the stored key. The synthetic login is not
    reported as an OAuth sign-in.

    **Local refresh is input-gated.** `refresh()` always reloads stored credentials (an external omp login
    becomes visible), but runs omp's registry `refresh` offline only when the models config file's identity
    (path, inode, size, mtime) or the stored-credential rows changed since the last rebuild, or when the
    caller forces or allows the network. omp's offline rebuild recomposes every catalog (hundreds of ms), and
    its per-provider `refreshProvider` repeats a static reload plus every other runtime discovery per call.
    `provider.status` revalidates on every read and the Central card polls it every 500 ms while
    `configuring`; the pi-era per-provider loop cost seconds per read under omp, starved the host and kept
    the rebuild drain from settling ([[central-integration]] post-mortem).

    **A registered model list replaces the provider's catalog.** For a provider registered with an explicit
    `models` list (no `fetchDynamicModels`, no OAuth `modifyModels`), every host read (`getModels`,
    `getModel`, `getAvailableSnapshot`, `getAvailable`, `getAuth`) serves exactly those ids. omp documents
    that contract but applies it only when its registry holds a full snapshot at registration time; any later
    static reload re-merges the built-in catalog with the registered overlays, which would surface built-ins
    beside a Central replacement with the replacement's key installed for the provider ([[pi-compatibility]]).
  - `modelContext` — a narrow settings adapter for the `contextWindow` override in omp's shared models
    config, not a second model registry. The file is the one the runtime's registry reads:
    `ModelRuntime.modelsConfigPath` (`<agentDir>/models.yml` unless a path was given) resolved through
    omp's own `ModelsConfigFile.relocate(path).path()` — `models.yml`, else an existing `models.yaml`;
    omp migrates a pi-era `models.json` into `models.yml` on its first load, and every read and save
    refreshes the runtime first, so the JSON file is never edited. A runtime that ignores local model
    configuration (`modelsPath: null`) refuses both. It lists the OpenAI Responses / Codex
    Responses models from `settledAvailableModels` whose effective budget still equals the contracts'
    272K editing minimum (the cap this setting exists to lift), plus any model that already carries an
    override so it can always be reverted; each entry pairs pi's effective `contextWindow` with the
    file's explicit `override` (`null` = pi default). Eligibility is derived from pi's catalog, never
    from a model-id list, so catalog defaults above 1M stay untouched by a bulk save. A save validates
    the contracts' 272K–1M range first, patches `providers.<p>.modelOverrides.<id>.contextWindow` for the
    target — or, for `available`, every eligible pair the contracts' `isSharedModelContextTarget` admits, so
    a shared save never rewrites an override outside the range that only a targeted save can touch — on a
    `yaml` `Document` so comments, a BOM and unrelated configuration survive (the document is re-rendered,
    so spacing and quoting may normalize; values and comments do not change), prunes override objects it
    empties (never `providers`), refuses YAML that does not parse to a mapping or a read-only file rather
    than patching it, then writes a temp file beside the resolved target with
    the original's mode (`0o600` for a new file) and renames it into place — following a symlinked
    models file to its target, and creating a dangling link's target rather than replacing the link. Saves are serialized in-process; a changed file is followed by one
    network-disabled `runtime.refresh` on the current generation and the host's `provider.changed`
    signal; a no-op save does neither. Every read also refreshes locally first so external pi CLI edits
    appear. Live sessions keep the model they were created with; new chats resolve the updated metadata.
    pi owns schema validation and the effective value; error messages are generic and never carry file
    contents. Accepted gap: a Central rebuild whose runtime loaded the file before a save and activated
    after its refresh serves the old budget until the next read refreshes it.
  - `agentSessionManager` — sessions keyed by `session.sessionId` (each `Entry` also tracks its
    `workspaceId`), `createSession({ cwd, workspaceId, model?, thinkingLevel? })` → `createAgentSession(...)`
    with a per-session `SessionManager`, the chat's omp `Settings` from **`buildSessionSettings(cwd,
    projectTrusted)`** (`loadHostSettings` in `piSettings`: the user layer, plus the project layer only
    when trusted; `isolatedHostSettings` serves probes and catalogues) and the resources
    `buildSessionResources` builds (see `extensions`). The user's `images.autoResize` applies (omp resizes
    with `Bun.Image` in every artifact); the web UI downsizes attached images itself (`apps/web`'s
    `chat/imageAttachment`, long edge 1568px) and `imageGuard` is the in-context second line of defense.
    Delegated children run on the same settings: `delegation` binds `buildSessionSettings` as the
    core's `buildChildSettings`, which receives the trust the parent context's `isProjectTrusted`
    answers (`liveParentContext`; pi-delegation decision #31, issue #604), and binds `childSystemPrompt`
    so a child without its own prompt in an untrusted project gets the same user-level system prompt as
    its parent (see `extensions`). A shared `registerSession`
    publishes each event
    tagged with its id + `initializeExtensions(session, { mode:'rpc', uiContext, … })`. The event projection retains the
    final `agent_end` assistant's reported terminal metadata and attaches it to `agent_settled`, so the
    wire has one authoritative automatic-work terminal even when compaction/retry happens between those
    events; it forwards rather than re-derives pi's result. omp has no settle event: the host emits
    `agent_settled` once omp's `waitForSessionSettlement` holds, checked two macrotasks after the
    subscriber `agent_end` or idle run state (as omp's RPC settle checker does), because omp flushes the
    deferred `agent_end` while the prompt's admission is still unwinding. A `compaction_end` is separately projected to
    a **fresh allowlisted event**: its `result` carries only `tokensBefore` and optional
    `estimatedTokensAfter`, never pi's summary, entry id, usage, or extension details. Tool
    `tool_execution_end` / `tool_execution_update` frames drop `structuredContent` from the (partial)
    result: pi's value for programmatic callers (bash puts up to 1 MiB of raw output there), never
    persisted and never rendered, so forwarding it would only grow every live frame and the browser
    store. `entry_appended` is projected to `{ entryType }` only: extension and pi-internal entry payloads
    never cross the wire. The live entry retains
    that settlement in `SessionSummary.lastSettlement` for reconnect after Pi removed a failed attempt from its rebuilt
    context; a new `agent_start` exposes explicit `null` (no current terminal) so an older persisted failure
    cannot reappear mid-run, while disk sessions remain transcript-authoritative. A live summary also
    carries omp's queue snapshot (`SessionQueueState`, only when non-empty): `queue_update` fires only on
    changes, so this is the read-side seed that lets a client attaching mid-run render messages queued
    before it connected. Lanes are derived from omp's own queues (`peekLiveSteeredMessages` +
    `peekSteeringQueue`, `peekFollowUpQueue`) filtered by `isUserAuthoredQueuedMessage`; the host keeps no
    mirror of their membership or order. `queuePrompt` only records, per queued `AgentMessage` that omp
    reports through `onPromptQueued`, the text and images the user submitted (`queuedPrompts`, a
    `WeakMap`), because omp's queued message carries the expanded prompt (or "[Image]" for an image-only
    one). Removal drops a message group by identity (`dropQueuedMessages`), and Stop's restore uses
    `clearQueue({ forInterrupt: true })`, which also withdraws input a live-steered response already took.
    The host projects only a conservative `hasImages` aggregate into summaries/events, so image bytes do
    not ride the ordinary read stream. Image-only queued messages need no compensation (omp's queue is
    identity based); the image-only steer/follow-up tests pin that.

    **Prompts settle before they resolve.** pi's `prompt()` resolved after its `agent_settled`; omp's
    resolves at the end of the run, and the host reports `agent_settled` itself. `promptSession` and an
    idle `followUpSession` therefore wait for the run they started to settle (and for the tool selection
    that settlement applies), so a caller's next prompt sees settle-time effects (deferred tool policy,
    pending reloads, the completion record). Disposal releases the wait. An idle prompt also waits for a
    pending tool selection before it starts.

    **The extension `input` event is the host's.** omp emits it only from its own front ends (its rpc mode
    calls `emitInput` before every prompt, steer and follow-up), never from `prompt`/`steer`/`followUp`.
    The host runs it for every user send (`promptSession`, `steerSession`, `followUpSession`, queued
    nudges) with source `rpc`, skipping extension commands as pi did; `handled` drops the message before
    it reaches omp, so nothing is queued, no dialog is dismissed and no question is superseded. Re-queues
    inside `removeQueuedSession` do not run it again.

    **Chat lifecycle on omp.** `createSession` resolves `cwd` before building the chat's `SessionManager`:
    omp records a transcript's `cwd` verbatim (pi resolved it), and stored directories, listing and
    deletion compare that recorded spelling with resolved workspace paths (architecture Decision 22). Each
    chat registers in omp's process-wide agent registry under its own session id (`agentId`); omp's
    default id `Main` would make two chats created or reloaded concurrently replace each other's
    registration ("Agent \"Main\" was replaced during session initialization"). Registration re-checks
    project trust after `session_start` and reloads into the current grant before the chat is returned.
    Reattaching a chat (`getSessionMessages`, `ensureSessionAttached`) first awaits a teardown still
    running for that id, so a closing engine finishes its transcript writes before a new one opens the
    file; resource reads (`withSessionResources`) instead fail closed while that teardown runs. A
    transcript read while a reload has shut the old engine down and not yet adopted its replacement reads
    the transcript file, because omp releases a disposed session's entries. **Closing is split from engine shutdown**: `closeSessionResources` closes commands,
    subagents, hidden children and the MCP load, and `shutdownEngine` disposes the engine session once the
    children have closed (omp's `dispose()` is the only way to emit `session_shutdown`, and it aborts the
    run). Removal, archive and deletion close resources first, run Stop's accepted-answer grace and abort,
    then shut the engine down; polite `settleSessionsForShutdown` shuts down every engine whose run has
    stopped (after `waitForIdle`) but leaves one with a preserved question (`expected`/`waiting`) running
    and unanswered for restart repair. Completion delivery is held while a manual or automatic compaction
    runs and released at its end. Background commands receive the chat's current `shellCommandPrefix`
    (omp registers it for extensions and does not apply it to its own shell) and `off` for a model without
    reasoning. A registry tool counts as a disabled extension's only in a chat that loaded that
    extension, so a same-name package tool in a chat created with ours off stays active. omp only drains
    its queues inside a run; when a prompt or follow-up queues while omp is preparing an idle drain (busy,
    no run started) or a queue edit cancels that drain, the host waits for the drain to resolve and
    prompts whatever it left parked (`deliverStrandedQueue`). A reload whose chat starts closing while the new engine session is being built or is in
    `session_start` rejects with "The chat is closing." and shuts that session (MCP first) down; the
    chat's own closing cascade covers the session it adopted. A preparation that fails before an entry
    exists shuts down the MCP load it created and then the engine session; one whose entry was never
    registered is abandoned through the entry's own closing cascade.

  - **Normalized session state** is one host projection over orthogonal facts, never a second agent runtime.
    Live derivation reads Pi execution/queue state, the question phase registry's exact expected/waiting id,
    the extension-dialog registry, final settlement, and explicit-Stop intent. Needs-input outranks working
    for presentation while the underlying execution may remain running. Only `agent_settled` creates a
    normal completion; one terminal classifier distinguishes success, error, length, abort, and missing work.
    Explicit Stop records its current run id as cancelled before abort and stays quiet; an unfinished run
    found after restart becomes interrupted.

    **Background work holds unread.** While an idle chat still owns a running/stopping background command
    or a queued/running delegation child, its completion is reported but `completionUnread` stays false,
    so neither the attention dot nor an out-of-app notification fires while the agent's work is still in
    flight; needs-input is never held. The command change listener and the delegation lifecycle listener
    republish the parent's state on a coalesced `setImmediate`, after the same-tick completion delivery
    that wakes the parent has already flipped it to running — so the last finishing child never flashes
    the dot before the woken turn. A completion that does not wake the parent (user stop) releases the hold
    on that republish; a delivery gated by a reload or trash hold also releases first, and its later wake
    clears the unread again. Disk-only sessions have no live work and never hold. The same fact is published as
    `backgroundWork`, so clients show the idle chat as working (contracts' `isSessionWorking`) instead of
    quietly finished.

    State ids come from Pi's active session-entry chain: run/interruption from the latest user entry,
    completion from the decisive assistant entry, questions/dialogs from their interaction ids. A question
    needs input from the live mailbox; without a live phase, an attached session reads it from the
    transcript only as an acknowledged call (repair ack), while disk state still reads an unanswered
    dangling call, which attach-time repair will ack. Disk state
    is reconstructed from the complete active branch; a file read/parse failure fails the all-workspace
    snapshot rather than omitting a row. Receipt initialization runs unless both metadata files load (first
    install, or a file persistence set aside as unreadable, which is logged): it marks existing completion
    ids handled but never suppresses unresolved input. Because it runs before serving, it is the one
    best-effort reader: an unreadable transcript or session directory is logged and left unbaselined
    instead of blocking host startup, while the later snapshot keeps failing until the file is repaired.
    Receipt writes are serialized and atomic.
    Sessions publish full state records on semantic change. Pending extension dialogs retain their
    full request so reconnecting clients can render and answer the exact blocker rather than seeing an
    unusable needs-input marker.

    `listSessionStates` returns every top-level live/disk session; `acknowledgeCompletion`
    compare-and-sets only the current exact unread completion; `markWorkspaceUnread` drops the receipt of
    the workspace's most recently active session (latest branch-entry timestamp) that
    `canMarkCompletionUnread` admits — idle, unblocked, background-free, a non-cancelled read result —
    and `markWorkspaceRead` receipts every unread completion in the workspace; both cover disk-only sessions
    and publish each changed record. The shared collector awaits disk discovery *first* and then assembles
    live and disk sources in one synchronous pass (live wins by id), so a chat that attaches mid-scan is
    counted once instead of slipping between the two lists — the same holds for `listSessionStates`; `nudgeSession` atomically skips needs-input,
    queues while running, or prompts while idle. `SessionSummary.state` and `session.state` use the same
    derivation, so a client proves the exact rendered completion by id rather than inventing lifecycle.

    New-session and pre-session entrypoints capture the current generation; operations on a live session use
    that session's retained runtime. `abort` remains available as the cancellation control path.
    `prompt`/`steer`/`followUp` (with images) /
    — **both `promptSession` and `followUpSession` resolve the delivery mode against the session's
    LIVE `isStreaming`, never the caller's belief about it**: `prompt()` throws mid-turn (so it falls
    back to `steer`), and pi's `followUp()` only *enqueues* into a queue that a run already in flight
    drains (so on an idle session it falls back to `prompt`, else the message parks forever — the way a
    `review.sendBatch` into a re-attached review chat marked its comments sent to an agent that never
    saw them) / **`clearQueueSession`** (returns each user-queued message's submitted text + images,
    read through `queuedPrompts` before omp's `clearQueue()` empties both lanes; omp emits the emptying
    `queue_update`). Its optional text-only precondition rejects before
    touching Pi whenever either tracked lane has queued images; manual compaction uses that guard, while
    **`abortSession(..., true)`** synchronously claims the Stop and drains the queue in one manager operation.
    If an accepted question result is still persisting, Stop grants it a bounded grace period before signalling
    Pi's abort; this prevents an async post-tool hook from deadlocking Stop while still preserving the normal
    fast path. It drains once more immediately before abort and appends those late arrivals to their original
    lanes; it then waits for idle and returns the complete ordered queue, so deferred Stop cannot race a
    continuation or lose images /
    **`removeQueuedSession(sessionId, kind, index)`** — per-item queue removal: omp's
    `dropQueuedMessages` removes exactly that displayed message's group (out-of-range, or input a
    live-steered response already took → `removed: null`). **No-loss guarantee:** if the run settled during
    the operation the keepers would park forever (omp's queues only drain inside a run), so
    `deliverStrandedQueue` prompts what is left through the same idle-delivery fallback as
    `followUpSession`; delivery timing may degrade across that race window, content is never lost
    (pinned by the idle-fallback unit test) —
    `setModel` / `setThinkingLevel` / **manual `compact` guarded per session** (a second overlapping request
    is rejected before Pi can overwrite its one compaction controller; an active Pi compaction also blocks
    entry) / `getSessionStats` (+ contextUsage) / `getSessionCommands` /
    `listAvailableModels` / `listSettledModels` (the same snapshot without starting a refresh) / **`clampThinkingForModel`** (pi's `clampThinkingLevel` for a `{model, level}`
    pair — `model.clampThinking`; the host uses it so defaults and live-session effort changes follow Pi).
    Earlier, #394 showed ThinkRail's `available[0]` differed from Pi's pick and hit a proxy 400. ThinkRail
    now resolves new-chat defaults host-side from `AppConfig`, falling back to `preferredDefaultModel`
    (omp's startup pick) when the saved default is unavailable,
    without rewriting that setting. `available[0]` alone was catalog order — `openai/gpt-4`, an 8K-context
    model, for a fresh OpenAI connection. An explicitly requested unavailable model is rejected rather
    than silently substituted. The host passes the chosen model explicitly so the UI and session agree.
    Plan review uses this same `resolveNewChatModel({})` for unset reviewer overrides: AppConfig
    `defaultModel`/`defaultEffort`, with the preferred model and `medium` effort as fallbacks.

    **Models cross the wire as `WireModel` (never pi's raw `Model`):** `toWireModel` projects a
    `Model` onto the wire's **allowlist** (see `WireModel`) — so `baseUrl`, `headers`, extension/provider
    routing data, and any other field are excluded by
    default — and the inbound side re-resolves the ref by `{provider,id}` via `resolveWireModel` against
    **`settledAvailableModels`**: `createSession` uses the current generation, while `setModel` uses that live
    session's retained runtime. Therefore a model newly shown in the global picker can be unavailable to an
    older live chat and fails with a closed model-unavailable error rather than crossing generations. Pi uses
    `Model.baseUrl` verbatim, so a client's baseUrl
    is never trusted (blocks disclosure *and* arbitrary-URL injection). The **hydration read side** —
    `listSessions(workspaceId, cwd)` (live sessions
    **unioned with on-disk** ones pi persisted under `cwd`, live winning on id → `SessionSummary[]` tagged
    `live`; before treating the **detached** disk list as authoritative it strictly scans every transcript
    header and verifies pi returned every file, so an unreadable/malformed/skipped transcript rejects the
    read rather than masquerading as absent and being tombstoned by reconnect reconciliation. A `.jsonl`
    whose first parsed entry is not a session header is not a transcript — pi's own listing skips those
    files, and extensions keep sidecar logs there (e.g. pi-automode's `<session>-pi-automode.jsonl`) — but a
    file with no parsed entry at all still rejects. A registered live
    session's own exact `SessionManager.getSessionFile()` path is excluded from that disk preflight: its
    in-memory entry is already authoritative, and pi may truncate/rewrite that path while the host lists,
    so treating the transient physical state as a detached corrupt chat would blank every chat on reload) +
    `getSessionMessages(sessionId, workspaceId, cwd)` (re-opens a disk session into the manager if
    not live, first resolving any model named by the transcript in the active process runtime,
    retrying pi's renamed providers under their current ids; when
    that model is unavailable, PI selects the current default without persisting a model change on open;
    PI records the replacement when the user sends a message. Legacy transcripts with no persisted model
    reference also use PI's model resolver—then returns `{ summary, messages }` —
    `TranscriptMessage[]` from omp's display transcript (`buildTranscriptSessionContext` collapsed to the
    latest compaction, in-flight calls kept while streaming), never the agent's model context, which drops
    `error`/`aborted` turns and would hide a final failure (and its Try again) once the chat is reopened:
    the pi-canonical subset **plus
    `custom` messages**, which carry the `tool-response` replies (and the retired `ask-user-answers` form in
    older transcripts) an interactive tool's card pairs by tool call id, **plus `compactionSummary`**, pi's durable marker for the messages compaction summarized away —
    kept precisely because pi's resolved transcript is all that survives, so dropping it would hand the
    client a chat that starts mid-conversation with nothing to explain the gap. Which roles those are is
    **not decided here**: the filter is contracts' `isTranscriptMessageRole`, shared with `history`'s index
    so the two cannot drift and shift `messageIndex`), plus **`ensureSessionAttached(sessionId, workspaceId, cwd)`** — the same single-flighted
    re-open with no transcript read, for a caller that only needs the session *promptable* again (the
    review send's follow-up into an existing chat). It answers **`false` only when the id names no transcript
    in that cwd** — the sole case a caller may recover from by starting a new chat — and **throws** on
    every other re-open failure, so a merely-unreadable session can never be mistaken for an absent one
    and silently forked; the disk half is what survives a host **restart** — and re-attaching runs
    **`repairDanglingToolCalls` (the `sessionRepair` sibling) BEFORE `createAgentSession` seeds its
    context**: a host death mid-tool leaves the final replayable assistant tool batch unpaired, every
    provider rejects such a leaf (the chat would brick), and appending behind a live session would desync
    its in-memory state — so the missing results are paired at the one choke point every post-restart
    session passes. Repair is **tail-only and replay-aware**: pi positionally closes a pending tool batch
    before examining the next assistant message, then drops `error` / `aborted` / `length` attempts. Pi never
    executes tool calls from a length-truncated response because their arguments may be incomplete; those
    calls therefore repair with ordinary error results, never an answerable ask ack. Failed attempts
    never contribute candidates but still close an older one; any later user, custom,
    compaction, or assistant message makes that gap ineligible for a persisted leaf append. Only unique
    results whose call id **and tool name** match the final candidate batch may follow it, and parallel
    calls already carrying valid results are left alone. This prevents a late result from surviving
    without its omitted call and permanently poisoning OpenAI replay. Generic
    missing calls get pi's abort convention (`isError` "Operation aborted (host restarted…)"); a dangling
    ask gets the canonical ack (`details {kind:"ack"}`), so its card remains answerable while the transcript
    is provider-valid;
    **`respondToTool(sessionId, toolCallId, response)`** — the interactive-tool reply path (see the
    `toolResponses` bullet); **`settleSessionsForShutdown(timeoutMs)`** — the polite half of shutdown:
    synchronously close every command service and subagent completion owner and start every hidden-child
    cascade before aborting any streaming parent. Preserve parents with a recoverable live ask phase
    (`expected`, `waiting`, or `answer-accepted-uncommitted`); dispose every hidden child (including those
    whose parent is idle), include cascades already pending from concurrent removal, and wait for all under the one
    bound. Shutdown atomically closes answer admission before it snapshots phases: an expected/waiting ask
    stays dangling for ack repair, while an already accepted answer reaches its native persisted result and
    then the continuation is aborted. A reply racing after that snapshot is rejected rather than accepted and
    lost during disposal. Destructive teardown drains both Pi input queues before abort/disposal, including
    recoverable chat deletion, workspace archive, polite shutdown and emergency disposal. Pi's
    `abort()` only signals the current core run and waits for session idle; post-run handling can continue
    queued input with a fresh abort controller, so abort alone can restart work and strand disposal.
    Removal/archive/deletion reuse Stop's entry-based drain and bounded accepted-answer grace, draining
    again immediately before abort to discard input queued during that grace. Public commands retain their
    deletion guard; captured-entry teardown bypasses it so archive still settles tombstoned parents.
    Polite shutdown instead preserves unanswered asks for restart repair, drains again at an accepted
    result's persistence boundary, and retains its existing shared shutdown budget. Synchronous disposal
    (including failed preparation) clears queues before disconnecting Pi, after the host unsubscribes so
    disposal does not publish an extra queue event.
    Explicit user Stop synchronously claims an unanswered ask before signalling Pi; when
    Submit already won it gives that exact result boundary a bounded grace period, then signals abort even if
    persistence is still pending. The answer RPC resolves only when `turn_end` contains the accepted native
    result; a replaced or missing result rejects it. Every disposal path abandons the registry before
    unsubscribing so accepted-answer promises cannot strand.
    `abandon()` is process-disposal plumbing, not semantic cancellation: it unblocks the in-memory tool only
    immediately before synchronous session disposal, and real-`SessionManager` restart coverage pins that its
    returned result is not persisted ahead of attach-time repair. `disposeAllSessions` remains the synchronous
    emergency stop, but registers its best-effort child cascades
    in the same pending set; `getSessionWorkspaceId(sessionId)` (the live session→workspace
    lookup the host's `set_title` handler keys on); `removeSession`/`disposeAllSessions`;
    **`removeWorkspaceSessions(workspaceId, cwd?)`** (the **archive teardown**: close session admission for
    the workspace before its first await, capture every registered parent, synchronously close its resource
    owners, and start parent abort/removal while concurrently draining preparations from the retired
    workspace generation. A preparation that finishes afterward disposes its unregistered owners/session
    instead of publishing into the archived workspace. An unanswered question is not preserved for restart
    during destructive removal. After both barriers settle, dispose every live session for the workspace
    **unconditionally** — bypassing the per-chat delete
    guard that `removeSession` enforces, so a chat whose recoverable delete is mid-trash cannot abort the
    teardown loop and strand its siblings — then delete pi's on-disk transcripts rooted at
    the worktree `cwd` — pi's `SessionManager` is append-only, so purge = `list(cwd)` then `rm` the files
    whose recorded `cwd` matches, never `rm -rf` the encoded dir since pi's cwd→dir encoding can alias
    distinct cwds; `cwd` omitted on a double-archive skips only the disk purge);
    **`deleteSession(sessionId, workspaceId, cwd)`** (mark it deleted before any await so an in-flight disk
    attach cannot register afterward; that tombstone also makes a retained live entry non-addressable to
    **every session command, including `session.dispose`, for the full delete transaction**, so another
    client cannot append a turn behind the pending trash move or destroy the rollback target. **The
    transaction is single-flighted per session id**: a concurrent second trash click (another tab/client)
    for the same chat joins the running transaction (or is rejected as unknown when a foreign workspace
    names the id) rather than starting a rival one — two owners of the shared tombstone would let the
    loser's failure roll it back mid-move and briefly re-open the chat — and **only the transaction that
    installed the tombstone clears it on failure**, so an earlier successful deletion's permanent tombstone
    survives a later spurious re-delete. Abort a live turn if needed, resolve a live transcript from that
    session's own `SessionManager` (never a lossy directory listing), otherwise use the same strict disk
    lookup above; flush the live chat's pending transcript writes and await any teardown already in flight
    for the id, move the exact matching-cwd transcript to the OS trash via `trashFile`, then **seal** the
    live chat's `SessionManager` before disposing the entry and publish `SessionDeletedPayload` for client
    convergence. omp's `dispose()` appends a `session_exit` entry and flushes, so without the seal the
    trashed transcript would be recreated at its old path; sealing turns that write into a no-op. A newly
    created empty live chat whose reserved JSONL path has not materialized has nothing recoverable to trash
    and is only disposed. Any lookup or trash failure throws, rolls back the tombstone it installed,
    restores command access to the same transcript/live entry (still running, with its background work),
    and publishes nothing; there is deliberately no permanent-unlink fallback behind a recoverable UI
    action);
    `setSessionPublisher` + `setSessionCreatedPublisher` (broadcast the initial `SessionSummary` after
    `createSession` registers a new host-owned session—not when an existing transcript reattaches—so peer
    frontends discover it without inheriting placement) +
    `setSessionDeletedPublisher` + `setSessionManagerFactory` seams.
  - `oneshot` — one-shot LLM completions **without** an `AgentSession` (no tools/extensions/disk):
    `completeOnce(request)` picks a model from the shared runtime's authenticated set and dispatches a
    single `runtime.completeSimple()` (the system text travels as omp's one-block `systemPrompt: string[]`)
    — the provider-agnostic request path, which resolves
    the model's auth itself (OAuth refresh included) and also serves providers that only implement
    `streamSimple` (extension-registered ones). `pickModel(tier)` = the model choice: `cheap` prefers a
    curated small/fast allowlist ∩ the authenticated set, else the cheapest priced model by per-token cost (an unpriced catalog entry is a free, preview,
    or stealth tier that rate-limits or disappears), else the `default` pick; `default`
    = `preferredDefaultModel`; `null` when nothing is authenticated. This is the primitive the `assist` tasks
    (plan summaries, PR drafting) run on — the only place model **dispatch** happens outside a session.
  - `readOnlyAgent` — `runReadOnlyAgent(request)`: one **ephemeral** `createAgentSession` borrowing a live
    chat's folder, settings and runtime generation (`sessionRunSnapshot`) and its model and thinking level
    unless `request.modelRole` resolves (`resolveRoleSelection` over the chat's settings) to an available
    model, which then runs at that role's thinking level, with
    `SessionManager.inMemory`, `restrictToolNames` to read/grep/glob, no MCP/LSP/extension discovery/skills/
    rules/context files, `hasUI: false` and the caller's system prompt; always disposed, never touches the
    chat's transcript. Its guard is the `agent.beforeToolCall` hook (restricted sessions drop inline
    extensions), chained to any prior hook: `lookupBlockReason` refuses URIs, `~`, `..`, absolute or
    symlinked escapes from the folder, `.env` secrets and `gitignore: false` greps; every call, blocked
    ones included, counts toward `maxLookups`, past which calls are refused ("write the rewritten prompt now
    from what you have"). Accepted
    lookups go to `onStep`, the model's display name to `onModel` once before the run; the signal aborts
    the session. ✨ Enhance (`assist`) is its only caller.
  - `webUiContext` — `createWebUiContext(sessionId, currentToolCall?)` builds the `ExtensionUIContext` pi
    calls (dialogs round-trip to the browser, fire-and-forget methods push). A dialog names the tool call
    it is about (`toolCallId`) so the web asks on that call's card: a dialog anchors only while **exactly
    one** tool call of the latest response is outstanding (the common gate-before-a-tool case; parallel
    calls stay unanchored rather than guess). Outstanding means running (`agent.state.pendingToolCalls`) or
    named by the latest assistant message (including omp's `streamMessage`, since omp runs `tool_call`
    hooks before that message ends and before `tool_execution_start`) without a result yet; and
    `selectForToolCall` anchors explicitly and carries the call's `toolInput` (the MCP guard). `setExtUiPublisher`
    (server→client push seam; an optional `ExtUiAudience` narrows a push to clients below a protocol
    version), `resolveExtUi` (browser reply), `cancelExtUiForSession` (on dispose, and once omp accepts a
    user message — a steer or follow-up omp reports queued through `onPromptQueued`, or an idle prompt
    omp admits through `onPromptAdmitted`, except an extension command — which then answers every pending
    dialog of that chat; a message the host's `input` run marks handled, or one omp rejects (no model, no
    credentials), leaves the dialog open, and the queue's own re-queuing in `removeQueuedSession` cancels
    nothing),
    `notifyExtUi`, `notifyExtensionError` (pi's `ExtensionError` → one client-visible `error` notify
    carrying extension + event + cause — the cause capped at 500 chars because `error.error` is
    remote-shaped, and the extension named by its **directory** when its file is an anonymous
    entrypoint (`SKILL.md`, `index.ts`), never "Extension SKILL.md failed"; a bare
    "An extension failed." is what made #277 unreadable from the UI alone). The manager's
    `initializeExtensions({ reportRuntimeError, reportSendError })` wraps it in `reportExtensionError`, which does **two** things the notify
    cannot: for a live entry, it writes one `warn` to the rotated host log carrying the **full**
    `extensionPath` and the extension's own `stack` (rehydrated onto an `Error` so it lands in the structured `err` field — the
    chat gets the short name, the log gets the unambiguous one, and a crash stays findable after the tab
    is closed), and it **gates the client push** on `entry.registered`, the explicit flag
    `registerSession` sets when it puts the entry in the map. The event path's `sessions.get(id) === entry`
    cannot be reused: `initializeExtensions` runs inside `attachEngineSession`, *before* registration, so the
    stricter form would suppress the `session_start` failure #277 is about. Nor can *absence* from the map
    stand in for "not registered yet" — `disposeSession` deletes without leaving a tombstone, so a disposed
    entry is indistinguishable from an unregistered one, and a late error would be pushed at a client that
    can never drain it. The log is never gated for a live entry, but an entry the host has **disposed**
    (`entry.disposed`, set before `session.dispose()` in every teardown path) downgrades the report to a
    single `debug` line with no stack and no client push: reports dispatched into a runner the host has
    just invalidated (pi's `finishTurn` hook outlived `dispose()` this way) are echoes of our own teardown,
    not extension crashes. For a live entry, it attaches an `Error` **only when the engine supplied a
    stack**: several engine `emitError` sites omit it, and synthesising one there would record the
    *host's* stack — pointing the reader at
    `prepareSessionEntry` instead of the extension, which is the opposite of why the line exists.
    **Members split three ways, not two.** *Untranslatable* ones are inert no-ops and rightly so — they take a
    TUI `Component` factory a web host cannot render (`setFooter`, `setHeader`, `setEditorComponent`,
    `custom`, `setWidget`'s factory overload; the string-array overload **is** rendered).
    *Translatable* ones must behave: **`theme` is a real `Theme`** (`plainTextTheme`) whose every
    decorator returns its input unchanged, and `select` offers each `ExtensionUISelectItem` by its label
    (the wire's options are strings, so an item's `description` is not shown) and answers with that label,
    as omp's contract requires. *Translatable but unimplemented* is the third group and is named
    here so the split does not read as exhaustive: `setEditorText` / `pasteToEditor` are forwarded to the
    host by omp's own rpc mode and a web composer could honour them; ours stay inert until something needs
    them. What separates the theme from that group is the cost of being inert — an unimplemented editor
    call loses one feature, an unimplemented theme kills the whole extension on its first line. `getAllThemes` resolving `[]` /
    `getTheme` resolving `undefined` match omp's own rpc mode; `setTheme`'s `{success:true}` is a known lie, tracked separately — a web host has no TUI
    theme to switch to, so omp's rpc-mode form (`{success:false}`) is the honest answer.
    `plainTextTheme` subclasses omp's `Theme` (pi-tui) and overrides every member that turns a colour into
    an escape: `fg`/`fgResolved`/`bg`/`bgFill`/`fgOnBg`/`bold`/`italic`/`underline`/`inverse`/
    `strikethrough`/`getFgAnsi`/`getBgAnsi`/`getFgOnBgAnsi`/`getContrastFgAnsi`/`getLangIconStyled`;
    `getThinkingBorderColor` / `getBashModeBorderColor` / `getPythonModeBorderColor` / `styledSymbol` stay
    plain only because omp routes them through `this.fg` — an inherited guarantee, so
    `webUiContext.test.ts` calls **every** prototype method (the test fails when omp adds one it does not
    call) and reads every getter, rejecting any escape byte. **Some inherited members still answer for
    the terminal, as data rather than escapes:** `getColorMode` (`truecolor`, from the constructor — omp's
    `ColorMode` is `"truecolor" | "256color"` with no "renders no colour" value), and the hex accessors
    (`getColorHex`, `getBgHex`, `getAllThemeColorHexes`, `getMajorThemeColorHexes`, `getAccentColorHex`,
    `isLight`, `accentSurfaceLuminance`, `sessionAccentInputs`), which resolve every `""` token to omp's
    default terminal colours (for example `getColorHex("accent")` is `#e5e5e7`). No honest plain
    answer exists for any of them. They cost nothing while an extension colours *through* the theme —
    every such path returns plain text — and only bite one that reads a mode or colour and then emits ANSI
    on its own, which is the unsanitised-bridge gap tracked outside this module. Its colour table exists
    **only** to satisfy the constructor signature: every method that would turn a colour into an escape is
    overridden, and the members that still answer for the terminal read the constructor's *mode* or omp's
    default colours, never an escape. An omp
    bump that changes the palette breaks the build as a *notice that the theme surface moved*, not as a
    defect.
    **Rejected alternatives** (the one place these decisions are recorded): (1) `{} as
    ExtensionUIContext["theme"]` — the #277 bug itself. It assumed the TUI members are unreachable in
    `rpc` mode, but `ctx.ui.theme` is called by the **extension**, not by the engine's renderer, and omp's own rpc
    mode hands out a live theme. (2) An object literal implementing `Theme` structurally — impossible
    without a cast: `Theme` carries private fields. (3) A real `Theme` built from blank colours, no
    overrides — omp maps `""` to the *default-colour* escape (`\x1b[39m`), not to nothing, so status text
    would reach the browser as literal escape bytes. (4) Forwarding omp's exported `theme` binding (what
    its rpc mode and its no-UI runner context hand out) — it stays `undefined` until `initTheme()` /
    `initThemeSync()` runs, which only omp's CLI entrypoints do, never `createAgentSession`; and an
    initialized terminal theme would emit escapes anyway.
  - `toolResponses` — the host half of **interactive tools** (tools whose `execute` waits for the person):
    the per-session response mailbox (`ToolResponseWaiters`), respondability, restart repair support and
    late responses. The mailbox is **tool-agnostic**: every entry is keyed by `toolCallId`, the response is
    an opaque value, and the only tool knowledge the host holds is the enabled registry extensions'
    `interactiveTools` map (`extensions/interactive`) — which names wait for a person, and how a late
    response reads to the model. `ask_user_question` is the first client ([[module-pi-ask-user-question]]
    composed by [[module-ext-ask-user-question]]):
    - The package owns the schema, validation, the `message_end` normalizer that keeps the first ask as
      the response's sole tool call, the sequential `execute` and the result envelope.
    - Its registry entry registers the tool through `sessionExtensions` and declares it in
      `interactiveTools`.
    - New and reopened parent sessions create one mailbox in `createParentSession`, and
      `toolResponseSessionServices(waiters)` hands it to that seam as `expectToolResponse(toolCallId)`
      and `awaitToolResponse(toolCallId, signal)`. A call enters the mailbox only when the extension
      announces it, never by tool name: with the extension off, an `ask_user_question` call (the model
      calling the absent tool, or a same-name package's tool) raises no needs-input, holds no completion
      delivery, and its response RPC fails as not awaiting. The mailbox outlives resource reloads and the
      extension switch: a question asked after re-enabling answers through the same mailbox, and a chat
      created with the extension off adopts it through the one reload the toggle requests, ahead of any
      same-name package.
    - Response → `response`, supersede → `deferred` (the tool returns the pending marker and ends the
      turn; pi still drains the queued composer message), dispose → `abandoned`. Stop rejections pass
      through as the host's stopped error.
    - `agent` imports nothing from an extension: the pending marker and its guard are `contracts`', the
      pending and stopped texts are the host's own, and the late-response wording comes from the
      descriptor's `describeResponse` (else a generic preface plus the response as JSON).
    - A same-name tool from a user package loses to ours with no host ordering: omp loads discovered
      extension paths before the host's inline factories and resolves a tool name to its last
      registration ([[pi-compatibility]]). That keeps the structured
      card and its answer channel paired: an installed terminal questionnaire must not replace execution
      with `ui.input` while the web client renders our card. Its other tools, commands and hooks stay
      available.

    An eligible live call is **sequential and blocking**: after validation its `execute` waits for
    `session.respondToTool`, then returns the person's real response through the tool's own envelope as
    the native tool result. Eligibility is shared: an assistant stopped by `error`, `aborted`, or `length`
    cannot execute an interactive call. Questions that depend on an open answer wait for a later round;
    the multi-round interview norm itself lives in the workflow family's `asking-user-questions` concept
    skill ([[submodule-workflow-skills]]).

    The registry tracks `expected` (eligible call announced), `waiting`, `response-accepted-uncommitted`,
    and `stopped` through `turn_end`. This includes Pi's real asynchronous gap from `tool_execution_start`
    through pre-tool hooks to `execute`: graceful shutdown freezes new response admission and preserves an
    expected call; a response accepted before that freeze remains authoritative and is persisted before
    shutdown/Stop aborts its continuation. Stop-first synchronously marks an expected/waiting call stopped,
    so a later response cannot reverse the winner. Semantic validation still gates execution: a response
    accepted in the pre-execute window is acknowledged only if the real tool returned and `turn_end`
    contains its result; a validation error (the tool's asker throws) or a missing result rejects the
    response RPC rather than hanging or claiming success. The proof needs no receipt from `execute`, which
    lives in the package. `persistTurn(toolResults)` matches results to waiters by `toolCallId` and
    accepts only a non-error result whose `details` deep-equal the accepted response: `details` is the
    response itself, so the proof never depends on the wording the tool gives the model. A post-tool hook
    that rewrites only the content is acknowledged, since the response did persist; one that replaces
    `details` or turns the result into an error rejects the RPC. Rejected: comparing the rebuilt envelope
    too (it tied the host to the tool's text and reported a persisted answer as lost whenever another
    extension rewrote tool output). Every expected call Pi does not execute is cleared at `turn_end`. The
    response RPC resolves the phase and acknowledges only after the matching result reaches the persisted
    `turn_end` boundary. Explicit Stop drains the queue and aborts an unanswered phase with a stable
    stopped error; after Submit wins, Stop defers Pi abort until the response persists and then ends only
    the continuation. Either ordering leaves one terminal provider-valid result.

    **Typing instead of answering supersedes the live card, exactly as after a restart.** `steerSession`
    and a streaming-time `promptSession` queue the text in Pi's steering lane first and, only when `steer()`
    reports the `queued` disposition (an extension `input` handler that returns `handled` queues nothing, so
    no user turn would follow the ack), `supersede()` every expected/waiting call: the tool returns the same
    pending marker (`details {kind:"ack"}`) the restart repair writes, with `terminate: true` so Pi skips
    the tool batch's own model request. Pi drains the steering message as the next user turn, and the card
    derives `superseded` from the transcript through the one shape it already understands (pending marker
    + later user message). A later response RPC fails with the `superseded` respondability error; a call
    already in `response-accepted-uncommitted` is never superseded (the response wins and the steering
    delivers after it). Scope is deliberately narrow: only the user's own composer send supersedes — the
    follow-up lane (Cmd+Enter), steering queued *before* the card appeared, `removeQueuedSession`'s internal
    re-queue, and nudges (which already stop at `needsInput`) all leave the card open.

    A process restart deliberately changes only the continuation mechanism: attach-time repair writes the
    pending marker (`details {kind:"ack"}`, the host's `TOOL_RESPONSE_PENDING_TEXT`) for an eligible
    dangling call whose tool name is in the enabled `interactiveTools` map before `createAgentSession`;
    respondability likewise reports a call of any other tool as unknown, leaving the card answerable but the
    session idle. No argument-shape check: while ours is enabled it wins the name, and a disabled
    extension's tool is simply not interactive, so a foreign same-name call gets the ordinary error repair.
    A length-truncated call receives the same error repair as any other non-executable tool call. With no
    live phase, `respondToTool` injects a `tool-response` custom message (content from `describeResponse`,
    `details { toolCallId, response }`) through `sendCustomMessage({triggerTurn:true})`. Thus the question
    survives without restoring a JavaScript promise or calling low-level `Agent.continue`; an uncommitted
    Submit simply appears again. Queue entries remain Pi-owned and live-only by explicit scope. The card
    derives both forms from the transcript (native live result versus pending marker + custom response).

    Rejected alternatives: immediate ack on every live call lets Pi drain input queued *before* the card
    and supersede it unseen; restoring a dangling invocation exactly requires a lifecycle-safe resume API Pi
    does not expose; a durable host queue/SQLite outbox is unnecessary when only the question must survive;
    a client-side "skip then steer" pair races the answer path and leaves a decline in the transcript
    where the restored path leaves an ack; keying the mailbox on the tool name (the seam would be generic in
    type only — a second interactive tool, or a third party's, could announce a call the web could never
    answer).
  - `sessionRepair` — `repairDanglingToolCalls(sessionManager, interactiveTools)`: the restart safety net (rationale under
    the manager bullet above). Pure over omp's `SessionManager` (compaction-aware via
    `buildSessionContext`; idempotent; appends only missing results from the active tail batch) —
    unit-tested against `SessionManager.inMemory`, including failed-attempt and historical-gap replay.
    omp's `buildSessionContext` strips every tool call with no paired result from the rebuilt context, so
    the repair passes the latest assistant's call ids as `inFlightToolCallIds` to see the tail batch at all;
    without the repair a reopened chat silently loses an unanswered ask instead of bricking. omp's own exit
    recovery (`createInterruptedToolResults` on open, `restoreInterruptedTurn`) needs a recorded
    `session_exit` or re-runs the turn, so it covers neither a host crash nor the answerable-ask ack.
  - `imageGuard` — the oversized-image guard: an inline extension (`oversizedImageGuard`, one of
    `buildSessionResources`' shared factories and the whole delegated-child base set) hooked on omp's
    **`context` event** (fired before every LLM
    call, live sessions included). It reads the active model from `ctx.model`, which omp only supplies once
    the session's extensions are initialized (`initializeExtensions`, as the manager and pi-delegation do);
    an unbound runner reports no model and the guard passes everything through. omp's `anthropic-messages`
    provider now clamps over-cap images itself by re-encoding them (`prepareAnthropicImageContext`: 8000px,
    2000px past 20 images, a 10MB base64 block), but only after extension `context` hooks run and only on
    that wire; the guard still runs first, so a too-large image is replaced by a note rather than resized,
    and it remains the only cover for unsupported media types, the request-wide budget and Claude behind
    other wires. **Anthropic-family only**: the caps are Anthropic's model-level rules,
    so the handler gates on the context's active model (`isAnthropicFamilyModel` — native
    `anthropic`/`anthropic-messages`, or a Claude model id through Bedrock/Vertex/aggregators; unknown
    model ⇒ no-op) and every other provider's image context passes through untouched. It sniffs each image block's pixel dimensions straight from the base64
    header bytes (PNG/JPEG/GIF/WebP — no codec, never strips what it can't sniff; **bounded work per
    pass**: only a 256KiB decoded prefix is ever materialized — a JPEG whose SOF lies beyond it sniffs as
    unknown, not stripped — and each block is sniffed exactly once per pass) and replaces any block
    violating a provider rule with a text note naming the violated rule plus a re-attach hint. Five
    rules, in order: the **provider-accepted media types** (`ACCEPTED_IMAGE_TYPES`, shared with the
    composer via `contracts` — pi forwards an image's media type verbatim, so a legacy `image/heic`
    block 400s the whole request; stripping it heals sessions poisoned before the composer refused such
    files); the **4.5MB encoded-base64 payload ceiling** (`IMAGE_MAX_BASE64_BYTES`, shared
    with the composer via `contracts` — pi's own headroom under Anthropic's 5MB API limit, compared
    against `data.length` since the wire carries base64, so it applies even to unsniffable formats); the **8000px per-side hard cap**; the **count-aware 2000px cap** once the
    whole context carries more than 20 images — stripping changes the very count that selects that cap,
    so 2000px violators are stripped **largest-first only until the survivors fit back under the
    threshold** (18 small + 3 at 2500px ⇒ one stripped, the other two stay legal under 8000px); and the
    **request-wide `REQUEST_IMAGE_BASE64_BUDGET`** (24MB of base64, headroom under Anthropic's 32MB
    per-request cap — several per-image-legal blocks can still overflow the whole request), enforced by
    stripping survivors **largest-first until the aggregate fits**. This is what un-bricks a session poisoned by an oversized image
    (history is re-sent every turn, so one bad image 400s forever): sessions are append-only and the guard
    carries no image codec, so it transforms the **outgoing context
    only** — session file and transcript stay untouched, and a stuck chat recovers on its very next
    message. The count-aware cap also degrades a >2000px `read`-tool image (sent unresized when the user
    turned `images.autoResize` off) to a note instead of a brick once a session crosses 21 images. Pure core (`guardOversizedImages`, `imageDimensions`)
    unit-tested with hand-built header bytes.
  - `delegation` — ThinkRail's embedding of the portable **`pi-delegation`** core +
    **`pi-subagents`** layer ([[module-pi-delegation]], [[module-pi-subagents]]): binds what only
    the host knows — the delegation root under the data dir (`<dataDir>/delegation`),
    `scope = workspaceId`, and the manager's `liveParentContext` projection (`ParentContext`, core
    decision #23), including the exact `ModelRegistry` retained by that parent session (`modelRegistry`). Existing
    parents and their children therefore stay on their runtime generation across a Central change,
    while parents created afterward project the new generation. The host-wide `getPiRuntime` resolver
    is passed as the core's dynamic fallback rather than captured at service creation. One
    `DelegationService` per workspace is cached (`delegationServiceFor`, synchronous — nothing awaits
    at bind time). A parented run's spend is appended to the live parent as omp `model_usage` entries
    (`purpose: "subagent:<child session id>"` via `usagePurpose`; only the cost total is known), each
    publishing `entry_appended { entryType: "model_usage" }`: every `run-progress` (after each child response or tool
    start) appends the increment of the run's usage delta over a per-run watermark, and `run-terminal`
    appends the remainder, so the toolbar follows a running subagent and pi's own session totals include
    delegated spend for every outcome and consumer (Agent, `request_review`), independent of completion
    delivery. The watermark (`subagentUsage`'s run recorder) is in-memory, lives from a run's first record
    until its `run-terminal`, and advances whenever pi took the increment into its session (even if
    persisting it failed), so a write is never counted twice; an increment pi did not take is carried by
    the next one, but one dropped
    at `run-terminal` is not carried into the child's next run — reconciliation recovers it. Increments
    record any positive token count or a cost above 1e-9. Progress events skip the listener's
    resource/state publishes (resource summaries carry status, not usage). Progress only freshens the
    readout; crash recovery still comes from child transcripts and reconciliation. This is
    delegated spend's only accounting channel: delegation tools must never return `AgentToolResult.usage`,
    which pi would sum a second time. The write is best-effort, like pi's cache warmer: a failed append is
    logged and never fails the child run. `recordSessionUsage` reports only whether pi took the usage into
    its session; persistence stays uncertain. omp owns failed writes: its writer truncates a torn
    append back (`FileSessionStorageWriter#writeNow`), keeps the entry in memory, and the next append
    rewrites the whole transcript, so a failed usage write never cuts the reopened history and is
    restored by the next successful write (tests inject the fault through `fs.writeSync`). A usage entry
    omp kept only in memory when the chat closed is restored by reconciliation after it is reopened.
    omp's `dispose()` seals the transcript and drops later appends while still returning an id, so
    `recordSessionUsage` checks the entry landed, and a closing chat disposes its engine session only
    after its children settle (bounded by the shutdown budget when one is given). Closing
    a chat keeps its entry writable until its teardown cascade settles, so runs that cascade stops are
    still recorded; attach is refused during teardown, so the transcript keeps one writer. A deletion
    tombstone suppresses the write, because pi's append would recreate the trashed file. Graceful host
    shutdown records within its budget; emergency disposal (`disposeAllSessions`) revokes the teardown
    writers together with the tombstones, so a late record can never recreate a trashed transcript, and
    records it drops are recovered when the chat is next attached. Children cannot spawn children (`RECURSION_GUARD_TOOLS`), so deltas
    never nest. **`subagentUsage`** makes the transcript, not the event, authoritative: every attach, and
    a deletion rolled back after its tombstone suppressed a terminal write, asynchronously totals each
    fresh child file without a queued or running run under the parent's delegation directory and appends
    the shortfall against the parent's `subagent` entries for that child. This recovers runs a
    crash or kill never finished, back-fills chats from before parent recording, and picks up child spend
    outside runs. Parsed child totals are cached per process by file path, mtime and size, so an unchanged
    child file version is read once (overlapping scans may repeat it); every reconciliation compares those
    totals with the parent's current records, with no record-timestamp shortcut, so a record lost after a
    reopen is recovered even when a later record of the same child survived. The shortfall is recomputed
    from the live entries immediately before appending, so overlapping reconciliations cannot
    double-count; it is appended only when no token count is negative and tokens or cost (above 1e-9, to
    ignore floating-point noise) are missing, never as a negative correction. Forked children
    (header `parentSession`) are skipped because their copied history carries the parent's own spend.
    A host-injected `setSubagentConcurrencyResolver` supplies each service's per-chat
    limit at creation, and `refreshSubagentConcurrency(workspaceId?)` re-resolves and live-resizes the
    cached services (core `setMaxConcurrentPerParent`) after a global or workspace limit change; `subagentsFor(workspaceId, isEnabled, canDeliverCompletion)` creates one retained portable
    `Subagents` owner per parent; its extension is injected on every resource load. A host-injected
    `setSubagentsEnabledResolver` maps that
    workspace id to its current effective policy without creating an `agent` → settings/workspaces edge.
    The predicate reaches the extension's launch-time guard and initial/reload activation. For live
    policy changes, `refreshSubagentTools(workspaceId?)` removes/adds `Agent` +
    `get_subagent_result` through pi's active-tool API: idle sessions update synchronously, streaming
    sessions retain only a pending reevaluation applied at `agent_settled`, and repeated changes resolve
    the latest policy then. Session registration re-resolves once after async extension binding and before
    creation is published, so a policy mutation cannot fall into the bind-before-registry gap. Policy changes never replace the retained
    owner, so already-running detached children finish and retain completion delivery; a disabled launch is still rejected immediately by the live
    predicate even before a streaming parent's tool set can be refreshed.
    The plan-review `request_review` tool follows the same live-toggle shape: it is always registered, but
    `setAgentReviewEnabledResolver` (host-injected, global — no `agent` → settings edge) decides whether it
    stays in a session's active set, and `refreshAgentReviewTool(workspaceId?)` applies a change idle-sync /
    streaming-deferred to `agent_settled`, exactly like the subagent tools. omp's `ToolDefinition` has no
    `promptGuidelines`, so the review policy guidance is part of the tool's description (registered with
    `loadMode: "essential"`, a full top-level schema) and leaves the request with the tool. Only
    the tool is gated — the `startPlanReview` button path is a separate host seam. See `submodule-server-host-plan-review`.
    **Registry extensions** follow the same shape, keyed by extension name instead of workspace. A
    host-injected `setDisabledExtensionsResolver(() => ReadonlySet<string>)` (global — no `agent` →
    settings edge; a throwing resolver means nothing disabled) is snapshotted by `buildSessionResources`
    on **every engine-session build**, so the gated registry factories skip a disabled extension — new
    parents never load it — and by `childExtensionFactories()` when a hidden child's resources are built.
    `refreshExtensionTools()` updates live sessions: tools a disabled registry extension registered in
    this chat (`registryToolOwner`, counted only when the chat loaded that extension) leave the active set
    (remembered per entry so re-enabling restores exactly the withheld tools, never ones that were inactive
    by default) idle-sync / streaming-deferred to `agent_settled`, latest policy wins, and
    `setActiveToolsByName` drops their guidance with them. Hooks of a disabled extension keep running in an
    open session until its next resource reload — omp cannot unload an extension, and reloading on every
    disable would bust the prompt cache. The reverse is the one reload: an enabled extension the session
    never loaded (created while it was off) and that did not fail to load triggers a gated
    `requestSessionReload`. An extension counts as loadable when it has static or per-session parent
    factories. Registration applies the same reconciliation, and a completed reload reapplies
    it without requesting another reload, so a toggle that lands mid-reload converges. Settings are the
    source of truth across restarts: attach re-applies the host's tool selection, so a registry tool
    withheld before a restart returns once its extension is enabled and stays withheld while it is off
    (registry-tool reconcile, [[pi-compatibility]]).
    The **`set_title`** tool (`titleTool.ts`) is how chats and workspaces get named: the main agent calls it
    with `chat_title?` / `workspace_name?` / `branch?` (English kebab slug). It is always registered and
    active as an `essential` tool (omp's extension default, `discoverable`, would hide it behind tool
    search); toggling it off after naming would rebuild the system prompt mid-session and bust the prompt
    cache. omp has no `promptSnippet`/`promptGuidelines`, so its description carries the naming rules: once per
    conversation, as the **first action** of the first turn with a concrete task, even for a one-line answer
    (or right after reading a linked PR/issue/ticket). Names are in the user's language, and a PR/issue/ticket
    uses `<Verb> #<n> <title verbatim>`. Guidelines alone proved too weak (live e2e, Claude Opus: named 1 of
    3 real-task turns; 0 of 3 when the prompt asked for a one-sentence answer). So while the chat (omp session
    name) or its workspace is still unnamed, a `before_agent_start` hook appends a state-specific
    **pending-naming** block to that turn's system prompt (omp's per-turn override, dropped after the turn;
    omp does not run the hook for custom-message turns, which never need naming) ("this chat has no title yet … call set_title with chat_title
    before your other tool calls … otherwise ignore this note"); with it the same real-task turn named 3 of 3.
    The section and the guidelines name the fields still missing (`workspace_name` and `branch` while the
    workspace is unnamed) because "once" alone let a call name only the chat. Its wording is
    deliberately low-pressure: an earlier "first action … even when the answer is one sentence" made the model
    add narration preambles on unrelated tool-only turns. The section disappears once both are named, which
    costs one prompt-cache miss per chat, early in it. The write policy and the workspace half of that state are
    not here: the host injects both through `setTitleToolHost({ apply, workspaceNeedsName })`, because naming
    composes `agent` + `workspaces`.
    Cascades: `removeSession`/`disposeAllSessions` fire
    `disposeSessionChildren` — `removeSession` returns that cascade, the **delete transaction
    awaits it before `publishDeleted`/resolving** (safe: the cascade carries its own swallow, so a
    failing child abort can never fail a delete whose transcript is already trashed), and workspace
    archival **awaits it per session** — plus every **pending cascade registered for the
    workspace** (`disposeSession` removes the entry from `sessions` at cascade *start*, so a
    concurrent archive would otherwise see no parent to await while a delete's or remove's child
    cascade is still running; every `disposeSession` cascade registers in a per-workspace registry
    the archive drains — PR #303 review finding + the concurrent half found in the same sweep,
    both test-pinned via a test-gated child turn, deterministic in both directions: red because a
    pre-fix archive `rm -rf`s in its synchronous prefix while the gate is provably closed, green
    because the archive's completion is await-chained behind the cascade. Deliberately **cascades,
    not delete transactions**: archival must stay unblocked by a delete wedged mid-trash — the
    recycle-bin step has unbounded latency and never touches the store; that independence is its
    own pinned behavior) — before `removeWorkspaceDelegation` (drops the service + deletes
    `delegation/<workspaceId>`), so the store is never deleted under a live child — hidden
    children never outlive their workspace.
    `readChildTranscript` serves `subagent.getTranscript` from the store by
    `(workspaceId, parentSessionId, childSessionId)` — the ids are wire strings that become path
    segments, so it rejects path-like values (separators, `..`; the handler additionally validates
    the workspace like every sibling read) — and returns the run's current registry `status`
    alongside the messages, built from the raw entries via pi's canonical projection
    (`buildSessionContext` — the same entry→message path a live `session.messages` takes) and
    filtered through contracts' shared `isTranscriptMessageRole` exactly like `getSessionMessages`
    (a private message-entry loop here once drifted: compaction is an entry *type*, not a message
    role, so a compacted child's transcript lost its `compactionSummary` marker — PR #303 review
    finding, test-pinned; absent after restart/dispose; wire meaning: [[module-contracts]]).
    omp writes the first transcript file lazily; `pi-delegation` materializes a child's at its first
    prompt. A registered child belonging to the requested parent
    therefore returns an empty message list with its authoritative status until that file exists;
    queued/running remains pollable, including before the first provider reply. This is not a
    reconstruction from task text. A missing file without that owned handle throws
    `CodedError("SUBAGENT_TRANSCRIPT_NOT_FOUND")` — the **permanent**
    miss the web dialog stops polling on, named on the wire instead of pattern-matched from the
    message ([[module-contracts]] owns the code set; this uses the agent module's narrow
    `@thinkrail/shared/codedError` edge, shared with Chat Resources and mirroring `git`'s use).
    Children opting into extensions
    (`extensions: true` in their definition) get the **curated child set**
    (`childExtensionFactories` in `extensions`): `pi-spec-graph` + every registry extension's
    `childExtensions` (named inline, from [[submodule-server-extensions]]; none today) — deliberately not
    the parent's full set (rationale + the listed-children carve-out: core decision #25). **Every** child,
    opted in or not, also loads the core's base set (`childBaseExtensionFactories`, same decision): just
    `oversizedImageGuard`, since a child's `read` sends images under the same settings as its parent.
  - `extensions` — the chat's engine resources. Candidate generation loads the reviewed external Central
    path once through omp's headless `loadExtensions` and registers the providers it queued, without
    inspecting it. **`buildSessionResources`** then builds everything else a chat loads and hands it
    straight to `createAgentSession`, with omp's own discovery off (`disableExtensionDiscovery`), because
    omp has no project-trust gate ([[pi-compatibility]] "Trust"):
    - **Paths:** omp's normal extension set (`discoverSessionExtensionPaths` over the chat's settings) and
      custom tools (`discoverCustomToolPaths`), minus the generation's Central identity and, in an untrusted
      project, every project-scoped path (`preloadedExtensionPaths` / `preloadedCustomToolPaths`). Sessions
      use the provider objects their retained generation already owns, so arbitrary Central
      factory/errors/UI cannot reach `pi.extensionUi`; the Central identity is excluded even if the global
      artifact changes, so a session cannot mutate its generation.
    - **Factories:** the three bundled pi packages (paths in source mode, see below) — **`pi-spec-graph`** (the `spec_*` tools + its
      `before_agent_start` rule), **`pi-thinkrail-workflow`** (the workflow-router rule + workflow skills)
      and **`pi-todos`** (the `todo_*` tools + its skill) — the **ThinkRail extensions from the server
      registry** ([[submodule-server-extensions]]; today `visualize`, whose server half injects the strict
      mermaid validator) as named inline factories, the host's review, `request_review` and `set_title`
      tools, `oversizedImageGuard`, and the caller's `extraFactories` (per-session bindings: the
      workspace-bound subagents extension, background commands, the MCP host's `/mcp` command; its
      `MCPManager` goes through `createAgentSession`'s options — see [MCP servers](#mcp-servers)). omp loads
      inline factories after paths and resolves a tool name to its last registration, so a registry tool
      beats a user package's same-name tool with no host ordering.
    - **Tools and prompt:** `toolNames` is the host's built-in selection (`HOST_BUILTIN_TOOL_NAMES`; web
      search is omp's own `web_search`); LSP, IRC and the Python preflight are off; `systemPrompt` seeds the
      bundled packages' rule blocks (`HOST_RULE_BLOCKS`) so turns omp starts without `before_agent_start`
      (custom-message turns) carry them, and the handlers skip a seeded block.
    - **Skills, templates, rules:** admitted skills (below); omp's prompt templates, project ones only when
      trusted; and, in an untrusted project, only user-level `rules` and the user's own system-prompt
      override (or omp's bundled template) in place of a project `SYSTEM.md` / `SYSTEM_TEMPLATE.md`, which
      omp would otherwise read whatever the trust. `childSystemPrompt` gives a delegated child the same.
    omp caches capability file reads for the life of the process; the host calls the capability module's
    `reset()` before every build and skill listing so a changed file is seen. Nothing reloads in place: a
    reload replaces the engine session (`replaceEngineSession`), rebuilding settings and resources with the
    current trust, admission and disabled-extension set. The **portable cross-agent skill aliases**
    complete the skill set. Existing personal aliases are Claude
    (`${CLAUDE_CONFIG_DIR:-~/.claude}/skills`), Codex (`${CODEX_HOME:-~/.codex}/skills`), Copilot
    (`~/.copilot/skills`), and Gemini (`${GEMINI_CLI_HOME:-~}/.gemini/skills`), **plus each installed Claude
    plugin's `skills/` dir** (read from `~/.claude/plugins/installed_plugins.json` — the resolved `installPath`,
    never a cache sweep, so stale versions and transitive `node_modules/**/skills` are excluded); project-root
    aliases are `.claude/skills`, `.github/skills`, and `.gemini/skills`. The pure
    **`isProjectSkillPath(relativePath)`** predicate is the one server-side definition used by the worktree
    watcher (injected through `host`): it recognizes those aliases plus omp's `.omp/skills` and `.agents/skills`,
    so capped filesystem batches carry truthful skill-change evidence without making
    `watch` depend on `agent`. The alias roots (and the installed-plugin list) are recomputed on every
    build, so a reload picks up a root a branch switch / pull / clone creates mid-session or a plugin
    installed since; classification still only counts dirs that actually exist. Still never arbitrary
    dot-directory scanning, plugin caches, commands, or nested downward discovery. omp remains the parser:
    vendor-only macros/hooks/models/subagents/metadata are not emulated. First-name-wins precedence is
    omp native (`.omp` / `.agents` discovery and configured `skills.customDirectories`; omp's own reading
    of other agents' roots is left out so each alias root is read once, with ThinkRail's provider and
    scope) → ThinkRail-bundled → personal aliases → project aliases, so a repo can
    never shadow your own or ThinkRail's skills; source metadata preserves truthful `project` / `user` scope.
    **Admission gate (`skillAdmission`):** committed **project-scoped** aliases are attacker-controlled for a
    clone and injected into the system prompt, so per-skill they resolve to `load` / `untrusted` /
    `pending-ack` / `disabled` from an **admission context** — the project's `trusted` + `acknowledgedSkills`
    (granting trust acknowledges only what's present, so a later pull/branch skill is `pending-ack` until
    confirmed) + `disabledSkills` / **`disabledGroups`** baselines (a group key = a plugin name, a source tier
    `project`/`personal`/`bundled`/`pi`, or the special `@plugins` — assigned per skill by `skillGroup`, matching
    `SkillCatalogEntry.group`), layered with the workspace's per-skill `skillOverrides` (the trust gate is
    checked before the toggle layer, so an "on" override can never un-gate an untrusted alias, and a per-skill
    `on` beats a group disable). Only `load` skills reach the system prompt / `/skill:` list.
    The host resolves the context via the **`setSkillAdmissionResolver`** seam (keyed by `workspaceId`, fails
    closed); every build re-resolves **both** the admission context **and** the compatibility source set, so a
    reload picks up a mid-session trust grant, skill/group toggle, **or a newly-appeared alias
    dir** — and a late-appearing project alias is still classified + trust-gated, never slipping through as an
    unclassified load. Personal and bundled resources are never trust-gated (only the enable/disable layer), and
    this gate is scoped to the compatibility aliases. omp-native project resources (`.omp/` settings,
    extensions, hooks, tools, skills, prompts, rules, `SYSTEM.md`, ancestor `.agents/skills`) follow the
    project's resource trust (`Project.piResourceTrust`) instead, which the host itself enforces —
    `loadHostSettings` for settings, `buildSessionResources` for the rest — on every build (MCP servers › Trust).
    `listSkillCommands(cwd, admission)` reuses the same admitted skill discovery (no model/session/transcript,
    no extension factories) for pre-workspace
    autocomplete, cached briefly per `(cwd, admission)`; **`listSkillCatalog(cwd, admission)`** is the Skills
    manager's unfiltered variant (every discovered skill + its `group` + `decision`) — driven with a workspace
    (via `skills.state`) or a project (via `project.skills`, current checkout, no overrides) — and
    **`listProjectAliasSkillNames`** is the notice's present-alias count. The bundled pi packages load in
    **two modes**:
    - **Run-from-source (default):** `preloadedExtensionPaths` begins with the pi packages' raw `.ts`
      entries (omp's extension loader imports them — no value-import into our typecheck graph), resolved
      **lazily on first use** (never at module load: the resolve requires `node_modules`, which a
      compiled binary lacks). Their `skills/` dirs (`pi-spec-graph`, `pi-thinkrail-workflow`, `pi-todos`), the
      host's own skills (`packages/server/skills`: ThinkRail-only guidance such as
      `managing-mcp-servers`, which would be wrong under vanilla omp and so cannot live in a portable
      package) plus the registry extensions' owner-resolved skill roots are read as bundled skill roots;
      `build-support`'s `skillRoots` lists the same host root for both bundles.
      Registry extensions themselves are never path-loaded: they are the same named inline factories in
      both modes (one composition mode; `{ name, factory }` keeps `<inline:visualize>` in diagnostics).
    - **Bundled launchers (compiled CLI binary and packaged desktop runtime):** the launcher awaits the
      **`registerBundledRuntime({ factories, skillsDir, trashHelpers })` seam** before the first session — the same three pi packages as
      **value-imported default-export factories** (what's lost against path loading — file-relative
      `baseDir`, per-reload re-evaluation — none of them use) plus a staged on-disk
      skills dir (omp reads `SKILL.md` from the real filesystem; the
      bundled runtime uses **only** this staged root — it never resolves an extension-owned package from
      the host's `createRequire`). Registry extensions need no seam field: `@thinkrail/server`'s static
      import of each `@thinkrail/ext-*/server` carries them into the binary and the desktop bundle. Chat trash has two
      artifact seams behind the same registration, both owned by the `trash` module: the procfs parser it
      statically installs, and the `trashHelpers` the launcher stages and `registerBundledRuntime` injects
      through `setBundledTrashHelpers` (rationale: [[submodule-server-trash]]). No platform degrades to
      permanent unlink.
    Both artifacts are built with omp's bundled-mode define (`PI_COMPILED` for the binary, `PI_BUNDLED` for
    the desktop bundle) and the build-supplied `omp-legacy-pi-modules` virtual module (`buildSupport.ts`),
    so an external extension's `@oh-my-pi/*` imports resolve to the bundled engine instance
    ([[pi-compatibility]] "Bundled extension loading"). In every mode, the optional Central artifact
    remains an external filesystem path loaded by omp's extension loader; it is never bundled, staged, or
    copied into ThinkRail. `buildSessionResources` stays internal; the seam + its types are on the barrel.
- **Public surface (barrel):** the manager operations (incl. `respondToTool` +
  `settleSessionsForShutdown`) + `CreateSessionInput`/`CreateSessionResult` + `SessionEventPayload`;
  the runtime-generation facade (`usePiRuntime`, candidate prepare/activate, current generation id, and the
  closed `load-failed` outcome—no manager internals) plus `configurePiRuntime`/factory test seams and the
  pre-bootstrap `configurePiRuntimeGenerationInitializer` composition seam; `listModelContextSettings` /
  `setModelContextWindow` / `setModelContextPublisher` (the `modelContext` adapter and its
  `provider.changed` seam); `piLoginOptions` (the options every `auth` login receives — empty, since omp's
  providers derive their own installation identity); `migratePiAgentDataOnBoot` (the one-time pi data
  import `host` boot runs, `piMigration.ts`: a pi installation's chats, logins and user MCP servers copied
  into omp's agent dir; [[pi-compatibility]] "pi data import");
  `completeOnce`/`pickModel` + `runReadOnlyAgent`/`lookupBlockReason` +
  `ReadOnlyAgentRequest`/`ReadOnlyAgentStep`/`ReadOnlyTool` + `sessionRunSnapshot`/`SessionRunSnapshot` +
  `OneShotRequest`/`OneShotResult`/`ModelTier`; the `webUiContext` seams; the `toolResponses` mailbox
  and pure helpers (`createToolResponseWaiters`/`toolResponseSessionServices`/`assessRespondability`/
  `describeToolResponse`/`buildToolResponseMessage`/`awaitingToolCallId`); normalized-state operations
  (`listSessionStates`/`acknowledgeCompletion`/`markWorkspaceUnread`/`markWorkspaceRead`/`nudgeSession` +
  publisher/project seams);
  `repairDanglingToolCalls`; `liveParentContext` + `readChildTranscript`
  (the delegation embedding); the skill catalog helpers
  `listSkillCommands(cwd, admission)` (filtered, pre-session autocomplete) / `listSkillCatalog(cwd, admission)`
  (unfiltered, the manager's `skills.state`) / `listProjectAliasSkillNames(cwd)` (present-alias count) /
  `isProjectSkillPath(relativePath)` (watch-classification predicate);
  `reloadSessionResources(sessionId)` (active-chat reload; throws while the reload gate is blocked) +
  `requestSessionReload(sessionId)` (the deferring variant: `"reloaded"` now or `"deferred"` until the gate
  opens — settlement, the release of an admitted prompt, or a compaction's end; requests coalesce); the **`setSkillAdmissionResolver`** seam (host
  wires `workspaceId` → the admission context, derived once by `admissionContextFor(project, overrides)`);
  the **`setMcpPolicyResolver`** seam (host wires `workspaceId` → the project's MCP approvals, overrides
  and tool grants, derived by `mcpPolicyOf(project)`) and its writer twin **`setMcpToolGrantWriter`**; the MCP management surface — `listMcpServers`, `refreshMcpStatus`,
  `setMcpStatusPublisher`, `mcpSessionView` / `liveSessionIdsOf`, `dispatchSessionMcpCommand` (with an
  optional `notify` that takes the dispatch's notifications instead of the chat), `reconnectMcpServer`,
  `readMcpServerLog` (one server's masked lines from the host-written `mcp.log` in omp's agent dir),
  `setSessionMcpServerEnabled` (the chat-local disable, applied through the reload gate), the config
  effective-config read `effectiveMcpServerConfig` and the config
  writers `writeMcpServerEntry` / `removeMcpServerEntry` / `mcpEntryFingerprint` /
  `shareMcpOverrideWithRepo` (omp-schema validation, `MCP_CONFIG_INVALID` / `MCP_PATH_UNSAFE`) and the
  sign-in probe (`startMcpProbe`, `replyMcpProbe`, `cancelMcpProbe`, `cancelMcpProbesOwnedBy`,
  `cancelAllMcpProbes`, `setMcpLoginPublisher`, `isMcpLoginId`);
  the pi-level trust surface — `applyPiResourceTrust(workspaceIds)`
  (gated reload of every live session whose trust is stale; omp records no per-project trust decision and
  its `isProjectTrusted()` is hard-wired `true`, so ThinkRail's grant is the only trust) and
  `projectTrustSummary(cwd)` (the trust notice's facts: alias names and the `ProjectResourceKind`s present —
  the project `.omp/` entries omp's native discovery loads (`extensions`, plus `hooks` and `tools`, which
  load as code and so report as `extensions`; `settings.json` / `config.yml` as `settings`; `skills`;
  `prompts`; `SYSTEM.md` / `SYSTEM_TEMPLATE.md` / `RULES.md` / `rules/` as `systemPrompt`), ancestor
  `.agents/skills` and `.omp/skills`, and project definitions from `pi-subagents`' `discoverAgentDefinitions`.
  omp has no project themes or `APPEND_SYSTEM.md` outside its CLI, so `themes` is never reported. The list
  mirrors omp's builtin discovery provider (`discovery/builtin.ts`), minus `mcp.json`, whose entries are
  counted separately as `mcpServers` because each also needs its own approval; `projectTrust.test.ts` checks
  every entry against omp's own capability loader, so an omp upgrade that moves one fails there);
  the subagent-policy seams
  **`setSubagentsEnabledResolver`** + **`refreshSubagentTools`** (host resolves the effective global default
  plus workspace override; manager owns live-session activation timing) and the concurrency seams
  **`setSubagentConcurrencyResolver`** + **`refreshSubagentConcurrency`** (same split; `delegation` owns
  applying the limit to its cached services);
  the extension on/off seams **`setDisabledExtensionsResolver`** + **`refreshExtensionTools`** (host owns the
  set; this module owns compose-time filtering and live activation timing);
  the `set_title` seam (`setTitleToolHost` + `TitleToolHost`/`SET_TITLE_TOOL_NAME`/`SetTitleParams`);
  the bundled-artifact seam (`registerBundledRuntime` +
  `BundledExtensions`/`BundledExtensionFactory`).
- **Allowed deps:** `@oh-my-pi/pi-coding-agent` (runtime); `@oh-my-pi/pi-ai` (types + test
  fixtures + **pure catalog helpers value-imported from the package root** — today exactly
  `getSupportedThinkingLevels` + `clampThinkingLevel`, data-only projections over `Model`; *dispatch*
  still goes through the shared `ModelRuntime`, never pi-ai's stream/complete);
  `pi-delegation` + `pi-subagents` (the portable delegation runtime and Agent-tool composition,
  value-imported by the host embedding); `pi-background-commands` (the session-bound command
  capability, likewise value-imported by its host embedding); `pi-spec-graph` +
  `pi-thinkrail-workflow` + `pi-todos` (the bundled pi packages — parent sessions load the set through
  extension paths or launcher factories, and `extensions` value-imports their rule blocks; delegated
  children value-import `pi-spec-graph`); the sibling `extensions` registry module (the ThinkRail extensions' inline factories and
  skill roots — `agent` never imports an `@thinkrail/ext-*` package or its pi package directly); `typebox` (the host tools' parameter schemas); `yaml` (targeted
  `models.yml` edits in `modelContext`); `trash` (reached only through the
  sibling **`trash` module** — see [[submodule-server-trash]]: one path, globbing disabled, allowed to
  throw, never degraded to `unlink`; the launcher's staged-helper and procfs-parser seams live there too,
  because `changes`' whole-file revert needs the same primitive);
  `contracts` (`PiEvent`/`Model`/`ThinkingLevel`/`ImageContent`/`SessionStats`/`SessionSummary`/
  `Session*Payload`/`SlashCommandInfo`/`ExtUi*`/`AskUserQuestion*`/`ProviderStatus*`); `log` (diagnostics +
  session-lifecycle debug traces); `persistence` (`dataDir` for delegation plus the narrow session
  receipt stores); `trash` (the recoverable-delete primitive); Node.
- **Forbidden:** `host`; sibling features other than `log`, `trash` and those narrow persistence surfaces (session
  worktree `cwd` remains an input, never a workspace-registry lookup); Central process/filesystem knowledge—the
  caller supplies only the desired opaque extension paths for a candidate.

## Tool output and context recovery

Portable tools own bounded model-facing output ([[submodule-spec-graph-tools]],
[[submodule-pi-todos-tools]]); the host does not wrap every tool or rewrite user input. Pi's native
read/bash/MCP limits remain authoritative. Structured result details are presentation metadata;
measure model-facing content, not the serialized transcript or SDK context object.

The engine (omp) owns aggregate budgeting, compaction and recovery; bounded tool output does not guarantee
whole-request admission. The host adds no compaction overrides or retry loop. omp recovers a context
overflow, and a `length` stop whose prompt exhausted the window, by compacting and retrying once; a
recurrence ends the run with a warning notice instead of looping (`piLengthRecovery.test.ts` pins both on
omp's session). A restored length-truncated call is replayed with its paired error result rather than
omitted. Known upstream context-budget limitations and their upgrade checks live in [[pi-compatibility]].

`compactionEvents.test.ts` is the engine canary for the lifecycle the host projects. omp compacts a
completed turn before its terminal `agent_end` (start/end after `turn_end`; the host's `agent_settled`
follows), its end event carries no `reason` or `estimatedTokensAfter` (post-compaction size is
`getContextUsage()`), and a manual `compact()` emits no events. With the default `compaction.asyncEnabled`
an over-threshold turn is handed to a silent background speculation spliced in at the next boundary, and
the default method order (`remote`, `snapcompact`, `handoff`, `shake`, `soft`) emits one start/end pair per
attempted method and falls back to other authenticated models. The canary therefore pins `soft`, disables
async and mid-turn maintenance, disables ambient env-credential providers, and grows the context with one
large tool result (a lone reply stays in the kept tail and cannot create headroom). omp accepts a
`length`-stopped summary as a successful compaction; its canary stays red until the engine rejects it.

## Session titles

`agentSessionManager` is the only durable chat-title writer. Its `renameSession(sessionId,
workspaceId, cwd, title, { onlyIfUnnamed? })` validates one non-blank, single-line title within contracts'
length limit, resolves the session strictly inside the supplied workspace/cwd, and avoids an append when the
normalized title is already current. A live session writes through `AgentSession.setSessionName`; a disk-only
session opens its exact transcript with `SessionManager.open(...).appendSessionInfo(...)` without attaching an
agent or resolving a model. Both paths publish the same `session_info_changed` Pi event, while
`SessionSummary.title` remains the hydration projection.

The guarded write remains authoritative across the async race. `onlyIfUnnamed` performs the check immediately
beside the append and is the compare-and-set the `set_title` handler uses (its `false` return is how the
handler learns the chat was already named); the manual wire mutation is unconditional. So an agent title can
never overwrite a durable name, and the first name is final. No generated/manual provenance or title sidecar
belongs here: the absent-vs-present pi name is sufficient. The architecture's accepted no-cross-process
coordination rule still applies.

**First prompt beside the title.** Every `SessionSummary` and `SessionStateRecord` the manager projects
(`summaryOf`, the disk rows of `listSessions`, the state publishes and `listSessionStates` sources) also
carries `firstPrompt` — contracts' `firstPromptHead` of the transcript's first user message that has text
and is not a control message — so clients can label a chat the agent has not named. One derivation,
`firstPromptOf(entries)`, reads the **full** `SessionManager.getEntries()` for live and disk sessions alike:
`AgentSession.messages` is the compaction-aware projection, whose first user message after a compaction
is no longer the chat's first prompt, and pi's `SessionInfo.firstMessage` substitutes a placeholder string
when no text exists. A live entry caches the answer either way — found or absent — and re-reads only the
entries appended since its last scan, and only when `getEntryCount()` grew, so the per-event state publish
never rescans a transcript whose user turns are all packages or images. The value is
read-only: no write path accepts it, `renameSession` and `onlyIfUnnamed` are untouched, and a named chat
still carries it so a client can show the title and keep the prompt as a tooltip.

## Chat Resources integration

The manager retains one [[module-pi-background-commands]] service per parent chat alongside its Pi
session and injects its extension among `buildSessionResources`' per-session factories. The same binding supplies
live session context, effective shell settings and lifecycle in source and packaged hosts. The
first version loads this capability into parent chats only, not the curated hidden-child extension
set; ordinary child Bash remains visible in its transcript.

A small agent-barrel facade serves the resource snapshot, command output/stop and subagent
stop/stop-all operations defined in [[module-contracts]]. It projects command services plus
`DelegationService.childrenOf(parent)`; no aggregate registry owns copies of their lifecycles.
Subagent summaries include direct foreground and background children and omit handles with no run
snapshot yet. Keep all active children and the latest twenty terminal children by record creation order,
without disposing older handles or transcripts. Task and role summaries are capped at 2,000 and 200
characters. One lifecycle subscription per workspace service and each command service's change subscription
publish scoped invalidations through a host-injected publisher; no per-token/output broadcast is added.

Each operation validates actual workspace/session membership, child lineage and the manager's deletion
gate before touching a handle. Persisted parents use the existing single-flighted attachment path;
unknown parents never masquerade as empty catalogs. Missing/foreign/evicted resources share the
`RESOURCE_UNAVAILABLE` path (command output alone returns `available:false` after parent validation).
Resource control never depends on the UI having seen a tool event or on starting/restarting a provider turn. Natural completion and requested cancellation remain source
outcomes; stopped state is not synthesized from an acknowledged RPC.

User subagent controls supply the `"user"` cancellation reason defined by [[module-pi-delegation]];
completion delivery belongs to [[module-pi-subagents]], not a host suppression set. Stop-all signals
all captured active children before returning its target count; individual and bulk controls acknowledge
intent without awaiting provider/tool settlement. Their detached abort promises always carry rejection
handlers, lifecycle invalidations remain terminal authority, and neither control uses `disposeChildrenOf`
as a substitute.

Command services outlive view placement and parent-turn cancellation. Actual session disposal and
workspace archive close command admission and signal command/child work before awaiting teardown
under the existing host shutdown budget. A per-session teardown tombstone prevents a persisted parent
from reattaching until its previous resource cascade settles. Workspace archive closes a generation and
awaits in-flight parent preparation before removing delegation/transcript storage, so stale preparation
cannot register after teardown. Resource closure runs for every captured workspace parent before
any parent abort is awaited; individual removal likewise signals resources before waiting for the main turn.
Streaming destructive removal reuses the manager's queue-draining Stop path, discarding the drained
input while retaining the same bounded accepted-answer persistence grace before the parent is disposed.
Main-turn Stop alone never closes Resource owners.
Command and detached-subagent completion delivery respect pending session deletion and its rollback;
no notice may append or wake the parent behind a transcript being moved to trash. The tombstone is
temporary and does not dispose either owner. Resource reload retains the command service and portable
`Subagents` owner and rebinds their completion senders. The manager stores no completion queue. The
SessionManager exists before SDK session creation, giving the service its immutable identity. Its
context reads the current session's
cwd/model/thinking/session file and the shell command prefix from the chat's omp `Settings` at launch. Completion
requires that exact registered owner, no deletion tombstone, no resource closure and no live question
still awaiting its response (`awaitsResponse`: an expected or waiting call). A non-waking user-stop
notice must not append behind an unanswered tool call and break tail-only restart repair. Once the
response is accepted the gate opens: the call's result is then the tool's own return, and the owners
only send asides from the batch's last `tool_result` (or a later boundary), which omp injects after
every result of the batch, so the notice follows the answer in the request right after the batch.
Waiting for the native `turn_end` instead was one request late on omp: the host's `turn_end`
subscriber and extension `turn_end` handlers run after omp's step poll may already have run
(`agent-loop.ts:780-800`, `1805-1809`; `agent-session.ts:3815-3850`), so the host no longer flushes
there; `turn_end` only settles the question phase (`persistTurn`). Resource inspection and cancellation
remain available while delivery waits in the existing portable owners. `compaction_end` flushes both
owners once pi is no longer compacting, as do registration, resource reload and deletion rollback;
while the parent is busy those flushes are no-ops, because the owners deliver at step boundaries
([[module-pi-subagents]] Result delivery). `closeSessionResources` synchronously disposes
the subagent owner before child cancellation or any await, including preparation failures. Permanent
closure survives shutdown-budget expiry and suppresses late outcomes; omp's `dispose()` emits
`session_shutdown` once, after the synchronous owner disposal and MCP closure (see
[MCP servers](#mcp-servers)). The existing cached resource cascade remains the sole teardown owner. Both
SDK creation and entry preparation failures close the owners. A failure after registration also
removes that exact entry through the normal teardown path, rather than leaving a disposed session
advertised as live.
A restarted host has no control handles or retained command output to reconstruct from history.

`getSessionResources`, `readBackgroundCommandOutput`, `stopBackgroundCommand`, `stopSubagent`,
`stopAllSubagents` and `setSessionResourcesPublisher` are public only through this module's barrel.
`stopBackgroundCommand` acknowledges before settlement, so a test that stops a command waits for `stopped`
before it ends, and a test publisher (process-global) ignores other chats' notices and keeps any read it
starts handled: a late `stopped` notice once reached the next test's publisher, whose rejected read became
an unhandled rejection that bun charged to every following test while that publisher stayed installed.
Tests hold or fail the attach window through `fixtures/extensionBinding.ts`, which wraps omp's
`initializeExtensions` with `mock.module`. omp
settles an aborted run without waiting for the provider stream (`agent-loop.ts` races the stream against
the abort), so a gated child is already `aborted` when shutdown returns; a teardown that must stay open is
held by a `session_shutdown` handler instead. A child's first request no longer precedes its parent's next
one, so scripted replies for a parent and its child route by request content, not queue order.
Its only new external dependency is `pi-background-commands`; there is no `agent` → `terminal`, `subprocess`,
settings or workspaces edge. The owning parent graph records this package dependency.

## MCP servers

omp's MCP client (`@oh-my-pi/pi-coding-agent/mcp`) does the protocol work — transports, OAuth flows,
credential rows in `AuthStorage`, tool bridging, result truncation; ThinkRail owns which servers a chat
loads, their lifecycle, the call guard, status, sign-in and the server log
([[submodule-server-agent-mcp]]).

- **Registration.** Per parent session only, `createMcpSessionHost({ cwd, policy, projectTrusted,
  onCommandSettled, askForToolCall, grantTool })`. Every engine-session load spreads
  `mcpHost.sessionOptions()` into `createAgentSession` (a fresh omp `MCPManager` with the host loader, or
  `enableMCP: false` when no server is enabled) and adds `mcpHost.extensions` (the host's `/mcp` command
  and full-output marker); after `initializeExtensions` the manager calls `mcpHost.attach(session)`,
  which connects the servers and delivers their tools. The manager injects the guard's ports —
  `askForToolCall` (→ `selectForToolCall(sessionId, { toolCallId, toolInput }, …)`, anchored to its call
  and listing its input) and `grantTool` (→ the grant-writer seam) — and the workspace's project policy
  (`setMcpPolicyResolver` → `Project.mcpApprovals` / `mcpOverrides` / `mcpToolGrants`, fail-closed to
  none) and loaded trust (`projectTrusted`; omp's `ctx.isProjectTrusted()` is always true). Every other
  `createAgentSession` (children, probes) must pass `enableMCP: false`, or omp runs its own multi-source
  discovery without approvals. MCP is not a replaceable extension in omp: an installed extension that
  registers `/mcp` neither replaces the host's command (discovered extensions load before inline factories,
  and the runner resolves a command from the last extension that registered it) nor stops the host from
  managing servers; omp has no MCP-off setting, no `-builtin:mcp` and no `registerMcpServer`, so the host
  owns MCP in every chat and its management is never read-only.
- **Configuration** ([[submodule-server-agent-mcp]]). omp's native files are the source of truth
  (`~/.omp/agent/mcp.json`, trusted `.omp/mcp.json`), read by the host's loader under omp's schema with
  ThinkRail's `exposure` / `toolExposure` / `description` keys (omp ignores them), project overrides,
  approvals by fingerprint, record overrides and the chat-local disabled set; parity tests compare it
  with omp's own loader. Config writers are ThinkRail's (synchronous temp-file rename, unknown keys kept,
  only the defining file touched, no symlinked `.omp/` paths, secret literals masked in every UI). The
  one-time pi import (`migratePiAgentData`) converts `~/.pi/agent/mcp.json` into omp's user file when
  that file does not exist yet (`streamable-http` → `http`, seconds → milliseconds, `callbackUrl` →
  `redirectUri`, pi's provider `auth` dropped); repositories' `.pi/mcp.json` are not moved.
- **Trust.** omp has no project-trust gate (any cwd contributes project settings and
  `isProjectTrusted()` is hard-wired `true`), so the host enforces the project's resource trust
  (`Project.piResourceTrust`, [[submodule-server-projects]]) itself: an untrusted chat's omp `Settings`
  hold only the user layer (`loadHostSettings`), and `buildSessionResources` filters the rest (see
  `extensions`; [[pi-compatibility]] "Trust").
  - **Sites.** Sessions (`buildSessionSettings`), pre-session skill listings and child sessions
    (`buildChildSettings`, `childSystemPrompt`); probes and catalogues use `isolatedHostSettings`.
  - **Every load.** Every engine-session build reads the record's current trust, so any reload — a
    grant, a config change or a manual reload — loads exactly
    what the record allows. A grant or revoke therefore only asks the gate to reload the sessions whose
    trust is stale (`applyPiResourceTrust`: idle now, busy at settlement). A session still opening when
    trust changes is not in that scan, so registration re-checks its loaded trust against the record and
    reloads it before `createSession` returns.
  - **Children.** A child's trust comes from its parent context: `liveParentContext.isProjectTrusted`
    answers the parent's *loaded* trust AND the current record. A child therefore never holds more than
    its parent (a grant deferred on a busy parent does not reach its new children before the parent
    reloads) nor more than the record (a revoke reaches new children at once).
  - **Revoke.** A child captures its trust at creation and `pi-subagents` retains children across a
    parent reload, so a revoke also stops every live child of a stale parent (`stopSessionChildren`,
    reason `"user"`: the revoke is the user's own action, and the parent is told without being woken). It
    waits until those runs have actually ended — a child whose abort fails is disposed — before the
    parent's reload is requested. A **busy** parent is not interrupted: its current turn finishes with the
    resources it already loaded and it reloads at settlement (`"deferred"`), which the Stop-trusting
    confirmation discloses ("open chats reload when idle"). So when `project.setTrust` returns, no child
    and no idle chat runs under the revoked trust, and a busy chat stops at the end of its turn.
  - **Failures.** A reload that fails is reported as `"failed"` in the returned dispositions, and
    `project.setTrust` then fails after persisting and publishing the record, naming the chats still on
    the previous trust. A deferred reload that fails later reaches the user as an `error` notify on that
    chat asking to close or reload it. A grant leaves running children alone, since they merely lack the
    project's resources.
  - **Consent.** The pi-level grant is its own consent, separate from alias trust: only
    `project.setTrust` with `resources: true`, sent by a surface that names what it loads, grants it
    ([[submodule-server-projects]]). Repo-defined MCP entries additionally need a per-entry approval
    keyed to a fingerprint of the whole original entry object (approval state in the project record).
    The trust notice is shown for alias skills, omp's project resources, project subagent
    definitions and project MCP entries alike.
- **Lifecycle.** A ThinkRail reload disposes the omp `AgentSession` and creates a new one on the same
  transcript; each load has its own `MCPManager` and per-load cleanup. Every teardown path
  (`closeSessionResources`: delete/remove, workspace archive/removal, quit, a preparation that fails after
  attach, and a gated reload) calls `mcpHost.shutdownEngine()` before `session.dispose()`: it marks the
  load closed synchronously, aborts its sign-ins and in-flight handshakes, disconnects every server (stdio:
  SIGTERM then SIGKILL) and joins the load's discovery, which disconnects again if a connect started after
  closure; repeated calls share one promise. omp's `dispose()` neither emits a `reason` nor disconnects a
  host-supplied manager, and runs `session_shutdown` handlers in parallel under a 2 s cap, so an unrelated
  hanging handler cannot keep a server alive or delay a reload's MCP cleanup. Retained sessions keep their
  servers; they appear as the third list of `SessionResources` (`mcpServers`: name, state, tool count,
  transport). "Disable in this chat" applies at the next idle reload (a deferred one shows the server
  `pending-reload` at once); `setSessionMcpServerEnabled` validates file provenance before both enable
  and disable, even for no-op requests, and refuses (`MCP_CONFIG_INVALID`) a name the chat did not load
  (or, after a failed reload, one the admitted configuration lacks). A failed reload never rolls back
  the chat-local intent; repeating the same value retries while its MCP reload failure remains. Config
  or trust changes reload only affected sessions: `McpSessionHost.loaded()` is the configuration each
  load was given and `reconcileMcpSessions` compares it with what the loader would produce now
  (`pendingMcpReload`). Reconciliation runs after every host mutation, when the user file changes
  (`watchUserMcpConfig`: one directory watcher on omp's agent dir, 300 ms debounce, created when missing,
  rearmed with capped backoff), when a workspace change nudge touches `.omp`, and at settlement. Every
  MCP-affecting gated reload shares one failure recorder in `mcpSessions` (logged and notified once,
  redacted; only a successful reload clears it and restarts status; closing entries never report).
- **Status** (`mcpSessions.ts`). Exposed, not recomputed: connection truth is omp's typed manager state
  (`McpSessionHost.registered()` → `McpSessionView.runtime`: connection status, tool count, connection
  events with their errors). A read caller waits a bounded time for the load's startup
  (`McpSessionView.startup()`), so a status read just after opening reports `connected` once omp has
  connected and `starting` until then; registration and every successful reload seed the snapshot from
  the new load. Each snapshot merges the runtime with configuration (`deriveMcpServerStatuses`), carries a
  per-session monotonic generation and is published on `mcp.status`; every `detail` passes `redactMcpText`.
  Mutating `/mcp` commands and every connection event invalidate the snapshot through `onCommandSettled`.
  Clients below `MCP_PROTOCOL_VERSION` are not subscribed to `mcp.status`, so a server that newly reaches
  `failed` or `needs-sign-in` also reaches them as one "MCP servers need attention" toast (`notifyExtUi`
  with an `ExtUiAudience`, details already masked). `reconnectMcpServer` calls the host's typed reconnect;
  its failure (masked) is the call's rejection. `dispatchSessionMcpCommand` runs the chat's `/mcp` with
  an optional notify capture (`notifyingCommandContext`), so a capture takes only its own dispatch's
  notices while the user's own `/mcp` prints in the chat. `listMcpServers` adds the files' file-level
  problems (`summarizeMcpConfigErrors`) as `configErrors`.
- **Calls.** The host wraps every MCP tool it delivers: before omp's `execute` it asks on the call's card
  (Deny · Allow once · Allow in this chat · Always allow) unless the tool declares `readOnlyHint`, was
  allowed in this chat or holds a valid project grant; anything but an affirmative answer is an error
  result with the reason, and a user message the session accepts answers the dialog like any other
  (`cancelExtUiForSession`). The question runs inside the tool, not in a `tool_call` handler, because
  omp's 30 s handler budget only pauses for omp-owned dialogs. "Allow in this chat" is host memory that
  survives reloads; "Always allow" is a project grant (`setMcpToolGrantWriter`, read back through the
  policy resolver on every call). Results carry `details.thinkrail` (`summarizeMcpResult`, bounded,
  base64-free), `details.server` / `details.tool`, and never omp's raw content; `readMcpToolOutput`
  serves `details.fullOutputPath` (omp's spilled artifact: a file path, or `artifact://<id>` resolved
  through the live session) up to 1 MiB, `unavailable` for a result that recorded none, `expired` once
  it is gone. Settings' *Show log* reads `readMcpServerLog`; the host writes that log itself, since omp
  keeps none. omp's `mcp://` resource reads are disabled in ThinkRail chats: omp resolves them through a
  process-global manager, which the host clears so one chat never reads another's servers.
- **Sign-in** (`mcpSignIn.ts`). `startMcpProbe({ action: login | test | logout })` needs no engine
  session: login runs omp's `reauthorizeMcpServer` for the admitted server (forced enabled), with the
  generation's `AuthStorage`, a per-probe `AbortSignal` and omp writing no config (`acpOwned`); test is a
  throwaway `MCPManager` connect; logout removes the server's credential rows. Frames ride the
  `provider.login` family with `target: { kind: "mcp" }` and `loginId` `mcplogin_*`, to the owning
  connection only (`setMcpLoginPublisher(push, ownerClientKey)`); replies and cancels from any other
  connection fail with `LOGIN_NOT_OWNER`. omp's `onAuth` supplies the `authUrl` frame (only `https:` or
  loopback `http:`); its manual-code request becomes the paste-back `prompt` frame. Every probe has a
  deadline (`PROBE_DEADLINE_MS`, 10 minutes; `deadlineMs` is the test seam) after which it ends like a
  cancel — `error` frame "Sign-in timed out.", the flow aborted (closing omp's loopback listener), lock
  released — and the host cancels the probes a client owned when it reaps that client. After a
  successful sign-in, the workspace's live chats that report the server as *needs sign-in* reconnect.
  Test connection is HTTP-only and reports *connected · N tools* or the masked reason. A live chat's own
  `/mcp login <name>` shows the address as a notice (never auto-opened) and asks for the paste-back in a
  dialog; dismissing it cancels the flow.
- **One sign-in per server, whoever runs it.** A probe holds the server's lock (`acquireMcpSignInLock`,
  keyed by its tool namespace) from its start until it ends and refuses with "already running" ("… in a
  chat" when a chat holds it); a chat's `/mcp login|logout <name>` holds the same lock for the command's
  duration and, while anything else holds it, says so in the chat instead of starting. omp's own single
  flight is per owner; the host uses one owner per server so sign-ins for different servers never cancel
  each other.

## Get right

- `prompt()` throws while a session is streaming → `promptSession` falls back to `steer()`.
- Errors arrive via the event stream + thrown methods, not a crash signal — wrap + forward.
- **A re-opened disk session is repaired before it is seeded** (`repairDanglingToolCalls` between
  `SessionManager.open` and `createAgentSession`) — never append to a session file behind a live
  `AgentSession`, its in-memory context would desync.
- **A live interactive call blocks only in its session-bound phase registry; restart state stays
  transcript-derived.** The registry is forgotten on disposal and never restored. Only a tool-executable
  dangling call of an enabled interactive tool is repaired to the pending marker before attach;
  `length`/`error`/`aborted` attempts are terminal. `assessRespondability` remains the one reply-validity
  authority; rejections fail the WS request loud.
- Share one **current** `ModelRuntime` for pre-session reads and new sessions. Every session receives and
  retains its generation as `createAgentSession`'s `modelRuntime`; give each its own `SessionManager` and
  `dispose()` it on removal. Old runtimes remain reachable only through old live sessions and become
  collectible with them; a resource reload rebuilds the engine session on the chat's retained
  generation and never changes it.
- **A `pi` `Model` must never cross the wire raw** — provider/extension configuration may carry secrets in
  `baseUrl`, headers, auth, or provider closures. Every model-bearing frame (`model.list`/`model.refresh`/`model.default`, the
  `session.create` result, `SessionSummary.model`) goes through `toWireModel` — the list paths share the
  one `readAvailableWireModels` read so the projection can't be bypassed by adding a caller; every inbound
  model ref (`session.create` /
  `session.setModel`) is **re-resolved** host-side by `{provider,id}` (`resolveWireModel`), never trusted.
  The wire type `WireModel = Pick<Model, id|name|provider|contextWindow|reasoning> + thinkingLevels +
  cost{input,output} + input + auth` is an
  **allowlist** — it fails closed, so a future `Model` field can't leak by default (a unit test pins the
  exact key set). `thinkingLevels` is a computed field: pi-ai's `getSupportedThinkingLevels(model)`
  mapped at the same choke point, so the effort picker renders pi's per-model support truth without the
  client re-deriving it. `cost` keeps only the two list prices (pi's `ModelCost` tiers and cache rates stay
  host-side) and `input` the modality list. **`auth`** is the per-provider connection kind projected onto
  each model (`providerAuth.ts` → `catalogProviderAuth`, from pi's synchronous `isUsingOAuth` /
  `getProviderAuthStatus` plus the generation's opaque Central ids) so the picker can say *plan* / *API key*
  / *env* / *JetBrains AI* without the `provider.status` refresh; `describeProviderAuth` is the one
  kind/detail mapping and `auth/providerStatus` reuses it, so the picker and Settings → Providers cannot
  disagree. `toWireModel(model, auth?)` takes the projection as a value: the catalog read computes it once
  per provider (`readAvailableWireModels`), the session result, summary and `setSessionModel` paths derive
  it from their own generation (`sessionWireModel`).
- A live slash-command list is derived from three engine sources
  (`extensionRunner.getRegisteredCommands()` + `session.promptTemplates` + `session.skills`). The
  pre-session catalog maps only the admitted skills through the same skill→command helper and
  applies the **same project-trust gate**, so New Workspace preview and a real session cannot disagree
  except for the accepted base-branch/current-checkout timing difference.
- Dialog promises honor abort/timeout and are settled (+ dismissed in the UI) on session disposal — a
  bridged `uiContext` call must never hang.
- Process exit belongs to omp's postmortem (installed by importing `@oh-my-pi/pi-utils`): the host's
  graceful shutdown, which calls `settleSessionsForShutdown`, and its crash report run as postmortem
  cleanups (`host/boot.ts`, `host/crashLog.ts`; the host SPEC owns them, [[pi-compatibility]]).
- **Prompt-template `/name` expansion** — typed-through references like `/name args` in a prompt ride
  the agent's default `expandPromptTemplates: true` (no agent code change). It expands from the
  session's **create-time template snapshot** — a template saved mid-session is **NOT** seen by an
  already-open session's typed-through path (pi passes unknown `/name` text through verbatim). The
  composer's `/` menu path is always fresh via `template.list` (see `templates/SPEC.md` freshness rule).
