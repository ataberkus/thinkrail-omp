---
id: module-pi-background-commands
type: module-design
status: active
title: pi-background-commands — explicit, session-owned background commands
parent: architecture
tags: [pi-extension, background-commands, public-surface-checked]
---

## Responsibility

An explicit background-command capability for Pi: start a noninteractive command without holding
the agent turn, inspect its recent output, and stop that exact command. Ordinary `bash` is unchanged.
The user-approved scope is log-only commands; no PTY, terminal tabs, automatic handoff, stdin,
restart/rerun, daemon discovery, or arbitrary-process management.

## Boundary

- **Owns:** one session-bound command service, its opaque command identities, admission, runtime
  snapshots, bounded output, cancellation and completion-delivery bookkeeping; the
  `background_command` Pi tool and a default vanilla-Pi extension entry.
- **Public surface:** `BACKGROUND_COMMAND_COMPLETION_MESSAGE`, `BackgroundCommandInput`,
  `BackgroundCommandsExtensionOptions`, `CompletionDelivery`, `createBackgroundCommandsExtension`,
  `createBackgroundCommands`, `default`, `BackgroundCommandCompletion`,
  `BackgroundCommandCompletionBinding`, `BackgroundCommandContext`, `BackgroundCommandFlush`,
  `BackgroundCommandHandle`, `BackgroundCommandOutput`, `BackgroundCommandSnapshot`,
  `BackgroundCommandStart`, `BackgroundCommandStatus`, `BackgroundCommands`,
  `BackgroundCommandsBinding`, `BackgroundCommandsOptions`.
- **Allowed deps:** public omp SDK APIs (`@oh-my-pi/pi-coding-agent` root, plus its
  `exec/bash-executor` feature subpath) as a peer; Node standard libraries. Execution delegates to the
  engine's `executeBash`, the executor behind omp's own `bash` tool, not a copied spawn runner.
- **Forbidden:** ThinkRail packages, web/TUI widget ownership, Pi private imports, delegation
  ownership, workspace PTYs, and generic resource-provider/plugin machinery. Wire DTOs are mirrored
  in contracts, never imported from or re-exported through this package.

## Session binding and execution

The root `index.ts` is the only import surface; `src/` is private implementation. A service exposes
start/list/find/change-subscription/dispose, plus completion binding and replay; a command handle
exposes its snapshot, output, idempotent stop and `claimCompletion()`. Controllers and subprocess
details stay private.

The embedder binds one service to one immutable session identity and supplies current session
context plus any command prefix it applies. The standalone extension supplies the equivalent binding
from omp's public extension context. Cwd, command prefix and `PI_SESSION_*`/model/reasoning
environment follow the current session values at command launch; user-provided environment overrides
and host-selected cwd are not additional tool inputs.

`createBackgroundCommands({ sessionId, getContext, canDeliverCompletion? })` captures the immutable
identity; synchronous `getContext()` is evaluated for every accepted launch. Its projection carries
`cwd`, optional `sessionFile`, `model` (provider/id), `thinkingLevel`, `commandPrefix`, and
`exposeSessionEnvironment` (default true). Standalone omp reads cwd, session file and model from the
latest extension context and the live thinking level from `pi.getThinkingLevel()`; it applies no
command prefix, because omp's own `bash` has no prefix setting (the legacy `shellCommandPrefix` key is
honoured only by omp's pi-compat shim) and omp has no project-trust gate. The shell, its rc snapshot,
the engine shell prefix and the base environment come from the engine's settings exactly as for omp's
`bash`; omp takes no per-call shell path, so the context carries none. The launch passes an
environment overlay: `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL` are always set, blank when absent or unexposed, because an overlay cannot unset a
stale inherited marker (omp's `bash` blanks its two session keys the same way). omp's `bash` adds no
managed-bin PATH entry, so neither does this package. Tests compare an environment digest against
omp's native `bash` tool. An optional second factory argument, `createOperations`, is an
executor-construction seam for external-boundary tests, defaulting to the engine executor.

The shell command itself stays foreground; backgrounding means the tool does not await its outcome.
Each command owns an AbortController independent of the parent turn. The engine executor supplies
sanitized output chunks (unthrottled), exit status and termination of the embedded shell's processes;
each launch uses its own `…:async:<uuid>` shell-session key so jobs never share or queue behind a
persistent shell. A timeout is optional and means terminate, never switch execution modes. No default
timeout is imposed on intentionally long-lived commands: an absent timeout passes `0`, which disables
the executor's 300-second default deadline.

`background_command` has four actions: `start` (command, optional display name and timeout),
`list`, `output` (command id), and `stop` (command id). Starts acknowledge acceptance with the opaque
id and current snapshot. The id field is `id` on output/stop; action-specific extra fields are
rejected, including path, cwd, env, PID and stdin controls. Every other action is scoped to the bound
session; command ids are not PIDs, paths, or authorization tokens. Repeating stop is safe, and stop never creates a command.
Tool prompt guidance requires managed commands to avoid shell detachment such as `&`/`nohup`;
this is not a shell sandbox and does not promise to recover descendants that escape supervision.

## Runtime and retention

Command states are `running`, `stopping`, `completed`, `error`, and `stopped`. Only executor
settlement establishes a terminal state: exit zero is completed, a nonzero exit or unsignalled null
exit is error, and a requested cancellation is stopped after settlement. A stop request alone is
not proof the process exited. Error text is bounded to 4 KiB, and failed launch remains inspectable.
Timeouts are executor errors (natural failure notifications), not user-stop requests.

A session admits at most eight active commands and retains its newest twenty terminal records;
excess starts fail explicitly rather than queue. Active/stopping work is never evicted. Display
names are bounded to 200 characters and commands to 64 KiB. Each output record retains only the
latest 2,000 lines or 50 KiB, whichever is reached first, with UTF-8-safe trimming and an explicit
truncation indication. Reads are non-consuming, and output snapshots REPLACE earlier snapshots.
Line counting includes an empty final line after a trailing newline. Incremental UTF-8 decoding
preserves characters split between executor chunks; invalid/incomplete terminal bytes use normal
UTF-8 replacement decoding. This intentionally provides recent logs, not an archive: there are no
uncapped temporary files or second durable command index. Eviction releases the output even when a
caller still holds an old handle.

Records/output survive browser reloads, client disconnection, chat placement closure and parent-turn
Stop while the owning host/session remains live. They are lost on host restart; historical Pi
acknowledgements never recreate active records. Completed command notices in Pi's transcript retain
a bounded diagnostic excerpt, not the full log. Missing/evicted output reports unavailable.

Actual session disposal closes admission, disables completion wake-ups, signals every active command
before awaiting any one, and participates in the embedder's bounded shutdown. Workspace archive and
chat deletion use that same lifetime path. No idle timer kills quiet work. Abrupt host death and
escaped daemon descendants cannot be promised cleanly terminated or recoverable; never reconstruct
control authority from a persisted PID.

`list()` returns snapshot copies; `find(id)` returns this service's handle or undefined. `stop()` is
synchronous and returns the post-request snapshot; it does not await or manufacture settlement.
`output` is a non-consuming `{ text, truncated }` snapshot, or undefined after eviction.
`onChange(listener)` returns an unsubscribe and reports admission, stopping and terminal/eviction
changes, never byte updates. Observer errors cannot interrupt command cleanup.
`dispose({ timeoutMs? })` closes admission immediately and shares one promise across concurrent
callers. Its default wait budget is 5 seconds; a host can select a shorter nonnegative budget. Expiry
ends waiting, not execution authority: unsettled commands remain `stopping`, and any eventual executor
settlement still establishes `stopped`. All active commands are signalled before awaiting any one.

An injected service belongs to the embedder, not an extension instance: resource reload rebinds
completion delivery without dropping its jobs. omp binds extension instances for a session's
lifetime, so a host reload disposes the session (a `session_shutdown`) and reopens it from its file
with a fresh extension instance bound to the same service. The standalone extension disposes its own
service on session shutdown. Completion claims live with the retained records so rebind cannot
deliver the same outcome twice or silently lose a retained completion during the reload gap; only
injected services have an owner outside that extension lifetime.

`bindCompletion({ deliver, canDeliverCompletion? })` replaces the current synchronous delivery
binding, immediately replays pending retained outcomes, and returns an identity-safe unbind function.
`flushCompletions(flush?)` retries pending outcomes against the current binding without polling; the
optional `{ atTurnEnd }` flag passes through to the binding. A flush claims every pending outcome and
hands them to the binding as one batch — `deliver(batch, flush)` returns the completions it actually
handed to Pi, and every other one becomes pending again — so the binding owns order and wake choice
for the whole batch, decided once. Both the service binding's and the delivery binding's optional
predicates must permit delivery. The records are the only hold: a record stays pending until it is
actually sent, and `claimCompletion()` (the tool's `output` read of a finished command, never a UI
read) clears it so a result the agent already read is never pushed. A host closes
its predicate during a provisional deletion tombstone, then calls `flushCompletions()` after rollback;
confirmed deletion calls `dispose()`. A resource-reload gap has no delivery binding and is replayed
on the next bind. Claims are made before synchronous send to prevent reentrant duplication; an
unaccepted or thrown send keeps the record pending. A successful send means acceptance by omp's
fire-and-forget `pi.sendMessage` (its asynchronous failures surface only through the host's
send-error reporter),
not confirmation of an eventual provider response. Eviction also removes a pending claim: there is no
unbounded second notification queue.

## Completion and controls

A finished command reaches the agent once, at its next step, under the same delivery rule as
detached subagents ([[module-pi-subagents]] Result delivery). The extension lets the service release
pending records only at a step boundary — the last `tool_result` of a tool batch, or an eligible
extension `turn_end` (assistant `stopReason` `stop`/`toolUse`) as the fallback — to an idle parent as
one batch that starts at most one run, or through an embedder's `flushCompletions({ atTurnEnd: true })`
while an eligible turn end is current. At a boundary every released record is sent with
`deliverAs: "aside"`: omp injects asides at the next step boundary without interrupting a tool batch,
and an aside drained where the loop would stop continues the same run, so omp needs neither pi's
`agent_before_settle` nor a `{ continue: true }` turn-end result. The batch's last `tool_result` is
the primary boundary because it is the only one omp awaits before its step poll: extension
`tool_result` handlers run inside tool execution (`extensibility/extensions/wrapper.ts:521`), while
`turn_end` is pushed onto the event stream and the loop awaits only the session's own `onTurnEnd`
hook (pi-agent-core `agent-loop.ts:780-800`, `session/agent-session.ts:2261`) before polling asides
(`agent-loop.ts:1805-1809`); extension handlers of session events run after subscribers
(`agent-session.ts:3815-3850`) and are unordered against the loop, so a `turn_end` aside can miss the
very request it was meant for. A batch is the `tool_call` ids seen since the batch's first result
(omp emits every `tool_call` of a batch in its prepare phase before dispatch, `agent-loop.ts:3090-3180`);
the next `tool_call` after a result starts a new batch, never a `turn_end`/`agent_end` handler, which
may run in the middle of the next batch. A blocked call never produces a `tool_result`, so its batch
(and at most the next) falls back to `turn_end`. A completion that becomes deliverable while a batch
runs — finished during it, or held by the embedder's gate until a tool returns — therefore reaches the
request right after that batch. A batch with no waking completion at a final turn (no tool calls) is
held for the idle path instead, because an aside there would force a model call. An aside that lands
after the loop's last poll is woken by omp's stranded-aside drain, or folded into context without a
run after a user interrupt.
Idle batches append every completion but the carrier (`triggerTurn: false`) and send the carrier with
`triggerTurn: true`. omp has no `agent_settled`: after a terminal extension `agent_end`
(`willContinue` unset) and after `session_compact`, `auto_compaction_end` or `session_tree`, the
extension schedules an idle flush that re-checks every 10 ms only while no run is active and
`ctx.isIdle()` is still false (omp reports `agent_end` before the prompt's in-flight bracket drains).
Each message is one displayed custom message with a bounded result excerpt and a
`delivery` marker (`wake` | `run` | `appended`). The exported `BACKGROUND_COMMAND_COMPLETION_MESSAGE`
is `background-command-completion`; message details omit the full command and retain only a
40-line/4-KiB diagnostic output excerpt plus bounded snapshot metadata. The tool guidance tells the
agent the report arrives on its own, so it ends its turn to wait instead of polling; `output` of a
finished command starts with its status, exit code and error, because a read that claims the
completion must not hide what the push would have said.

The tool registers at extension load with `loadMode: "essential"` (omp otherwise hides extension
tools behind tool search) and carries pi's prompt guidelines in its description. Its schema is
`passthrough`: omp's argument validation silently drops unknown keys from a closed object schema,
which would hide the cwd/env/path/PID extras the tool must reject, so `execute` rejects them itself.

Stopped commands never wake the parent; neither do commands that had finished when the parent's run
was aborted (an `aborted` assistant `turn_end` in the run) — remembered per service until that
service's next user prompt (`before_agent_start` with reason `prompt`, which omp fires only for user
input, never for an agent-initiated custom message), so one factory serving several sessions cannot
clear another session's Stop. In an idle batch the turn is triggered by the
last waking completion, sent last: if that send fails, the completion stays pending and still carries
the wake on retry. An explicit user/tool stop
records the cancellation without starting an idle parent; it does not abort a parent already running.
Actual session shutdown suppresses delivery into the dying session.

The tool and the host UI call the same handles. A service change subscription reports catalog or
lifecycle changes, not every byte of output; output is read separately while inspected. Native
`tool_execution_update` stops being a delivery path once the start acknowledgement resolves.

## Verification obligations

Exercise admission and eviction, bounded multibyte output, natural/nonzero/null exits, launch errors,
per-job stop isolation, parent-abort independence, duplicate stop, notification/reload races and
bounded disposal, plus delivery: next-step delivery within one run (also when the embedder's gate
opens only as a tool returns and `turn_end` handlers lag the loop), one run per idle batch, a read
finished output never pushed again while a host read never claims, and no wake after a parent stop.
Integration checks use real local commands and the engine executor; provider-driven coverage verifies
tool use and completion through a real omp session. Windows CI runs the package
suite natively, including the descendant marker used by shutdown/process-tree coverage; visible-console
behavior still needs a native visual probe rather than a Unix-only claim. The package suite uses Bun
tests, controlled executor settlement, real local shell commands, and omp `createAgentSession`
sessions (extensions started through `modes/runtime-init`'s `initializeExtensions`) driven by the
workspace `pi-faux` provider. Live-provider host E2E remains the embedder's acceptance check, distinct from
these in-package tests.
