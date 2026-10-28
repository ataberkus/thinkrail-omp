---
id: submodule-server-assist
type: submodule-design
status: active
title: assist — ad-hoc one-shot tasks
parent: module-server
depends-on: [submodule-server-agent]
tags: [pi, oneshot, public-surface-checked]
---

## Responsibility

Small, **best-effort** agentic helpers — mostly a single cheap-model completion, the "ad-hoc one-shot
task service." Each task owns its prompt, output parsing/guards, and graceful-degrade fallback; it never
blocks or crashes its caller. The current task drafts a completed plan's summary when the agent wrote
none. Naming chats and workspaces is **not** an assist task: the main agent names them through
`set_title` (see [[submodule-server-agent]]), because every helper-model naming scheme produced names
users wanted to fix. PR descriptions are the second task; rewriting a message-box draft into a complete
prompt (`prompt.enhance`) is the third. The tasks are a **library surface** — assist owns no wire method;
`host` composes the methods that expose them.

## Boundary

- **Owns:**
  - The task catalog + their prompts, output guards, and fallbacks. Always time-boxed
    (`AbortSignal.timeout`) and bounded (`maxTokens`, or a lookup cap for the read-only run).
  - `setOneShotRunner(fn)` / `setReadOnlyRunner(fn)` — test seams swapping the one-shot runner (default
    `agent.completeOnce`) and the read-only agent runner (default `agent.runReadOnlyAgent`) so tasks
    unit-test against a fake with no pi/auth/network.
  - `suggestPlanSummary(steps)` \u2192 a short **Markdown** handoff note for a COMPLETED plan, drafted from its
    finished steps (`{ title, summary?, verification? }[]`, built by the caller \u2014 assist reads no store),
    through the same tool-free cheap-model path, or `null` (best-effort: `null`, never throws, on no auth /
    timeout / no usable steps / empty output). `toPlanSummary(raw)` is the pure output guard (strip a code
    fence and a leading `Summary:` label, clamp length, then reshape into `## Summary` / `## Changes` /
    `## Testing` — a missing section gets a placeholder, and a missing Summary takes the text before the
    first heading; `null` when empty). The host persists the result
    only when non-null; it never overwrites an agent-authored `plan.summary`.
  - `suggestPrDescription(input)` → a Markdown PR/MR description drafted from the caller-built input
    (`{ branch, base, commits, diffStat, plan?, template? }`, already bounded by `pr`), or `null` on the same
    best-effort terms. With a `template` the draft keeps the template's headings and checklist and fills
    their bodies; `toPrDescription(raw)` is the output guard (strip a code fence, clamp length, `null` when
    empty).
  - `suggestPromptEnhancement({ sessionId, draft, conversation?, images?, signal?, onStep? })` → the
    message box's ✨ Enhance rewrite: the draft expanded into an engineering prompt grounded in the chat's
    repository (Request / Inferred requirements / Assumptions / Done when, by intent; a question stays a
    question) in the draft's language, or `null` on the same best-effort terms, on cancel, for a gone chat,
    and for an empty or over-20 000-character draft. The input is the draft plus at most the last 6
    `user`/`assistant` turns (the latest assistant reply clipped to 6 000 characters, older turns to 1 500,
    both ends kept), wrapped in `<conversation>` / `<draft>` with tag lookalikes defused so quoted text
    cannot close them; attached images ride along. It ports omp-companion's enhancer whole: one
    `agent.runReadOnlyAgent` run on the chat's own model and thinking level in the chat's folder, at most
    12 read/grep/glob lookups, 180 s; `onStep` reports each lookup. `toEnhancedPrompt(raw)` is the output
    guard (unwrap a fence around the whole prompt, not one that merely opens it; `null` when empty).
- **Public surface (barrel):** `setOneShotRunner`, `setReadOnlyRunner`, `suggestPlanSummary`,
  `toPlanSummary`, `suggestPrDescription`, `toPrDescription`, `suggestPromptEnhancement`,
  `toEnhancedPrompt`, `OneShotRunner`, `ReadOnlyRunner`, `PlanSummaryStep`, `PrDescriptionInput`,
  `PromptEnhanceInput`, `PromptEnhanceMessage`.
- **Allowed deps:** `agent` (the `completeOnce`/`OneShotRequest`/`OneShotResult` and
  `runReadOnlyAgent`/`ReadOnlyAgentRequest`/`ReadOnlyAgentStep` primitives, via its barrel); Node.
- **Forbidden:** `host`; **`@oh-my-pi/pi-ai` / `pi-coding-agent` directly** (model access + dispatch
  belong to `agent`); reaching into another feature's internals.

## Get right

- Every task **degrades to `null`** — a failure must never block its caller or surface as an error. Wrap
  the runner call; the caller decides what (if anything) to write instead.
- Never trust model formatting: cap `maxTokens`, then normalize/clamp the text yourself.
- These are stateless and side-effect-free — the one-shots are tool-free `fetch`es, the read-only run
  only reads inside the chat's folder and persists nothing — safe to run in parallel; no manager/registry
  needed.
