---
id: module-pi-ask-user-question
type: module-design
status: draft
title: "@thinkrail/pi-ask-user-question — the ask_user_question tool for vanilla omp"
parent: module-pi-extensions
tags: [pi-extension, questionnaire]
---

## Responsibility

The published, portable half of the structured-question capability: one tool, `ask_user_question`, that
pauses the run until a person answers multiple-choice questions and returns a model-facing envelope. It
knows nothing about ThinkRail. It asks in one of three ways: a terminal questionnaire (omp's interactive
mode), one dialog per question (RPC hosts such as VS Code or Zed), or an embedder's injected asker.
ThinkRail composes it through [[module-ext-ask-user-question]], injecting an asker backed by the host's
answer mailbox.

## Public surface

- **Default export**: the factory with the built-in asker, which `omp plugin install` loads through the
  `omp` manifest. The tool is registered with `loadMode: "essential"`.
- **`createAskUserQuestionExtension({ ask?, announce?, guidance? })`**:
  - `ask: AskUserQuestionAsker` replaces the built-in asking. The embedder is then the UI, so there is no
    `hasUI` gate.
  - `announce(toolCallId)` is called from the `assistant_message` hook, which omp awaits before tool
    dispatch, for the ask call the batch keeps, when the assistant's stop reason lets it execute
    (`executableAskCallIds`). An embedder that tracks calls
    outside `execute()` starts tracking here, so only calls this extension runs are tracked.
  - `guidance` replaces the description and `promptGuidelines`, for a host whose UI behaves differently,
    such as ThinkRail's composer supersede. omp tools have no prompt snippet or guidelines field: the
    guidelines are appended to the system prompt from `before_agent_start` while the tool is active.
- **`./core`**: no runtime imports. Exports the tool name, limits, reserved labels, result types and texts,
  plus `validateQuestionnaire`, `buildQuestionnaireResponse`, `outcomeResult`, `isAckDetails`,
  `isAskUserQuestionArgs`, `isAskUserQuestionResult`, `isolateAskUserQuestionBatch` and
  `executableAskCallIds`. These are what an embedder needs to repair or continue a question outside
  `execute()`.
- **The tool contract**, which renderers and embedders key on:
  - the name;
  - the argument shape: `questions[]` of `{ question, header, options[]{ label, description, preview?,
    recommendedReason? }, multiSelect? }`;
  - the result per outcome:

    | Outcome | `content` | `details` | `terminate` |
    | --- | --- | --- | --- |
    | `answered` (including partial and Skip) | `buildQuestionnaireResponse` | that builder's details | no |
    | `deferred` | the canonical ack, or the chat text for "Chat about this" | `{kind: "ack"}` | yes |
    | `abandoned` | the stopped text | cancelled | yes |
    | asker rejects | thrown, so omp records a tool error | — | — |

  The argument and result types are the one definition of the questionnaire shape: ThinkRail's card
  type-imports them from `./core`, and the deferral ack `{kind: "ack"}` doubles as the host's generic
  "response pending" marker ([[module-extension-api]]). Changing either breaks ThinkRail's card and its
  restart repair.

## Decisions

- **The asker owns the Stop/Submit race.** `execute()` never inspects the signal. The built-in askers keep
  an answer given before Stop and resolve `abandoned` otherwise: the stopped text with `terminate`. An
  embedder applies its own ordering; ThinkRail's mailbox lets an accepted Submit beat a later Stop.
- **Deferred ends the run through the host.** Under pi, `terminate: true` skipped the model request the
  tool batch would trigger while still draining queued steering, so a host that queued the user's own
  message (ThinkRail's composer supersede) continued with that message. omp's `AgentToolResult` has no
  `terminate`, and an extension cannot end a run: only the session's agent can, by aborting with
  pi-agent-core's `TERMINAL_TOOL_RESULT_ABORT_REASON` (what omp's own `yield` tool does), which stops
  before the next provider call without an aborted message and leaves queued steering for the next run.
  So the extension takes an optional `endRun(toolCallId)` and calls it before returning a terminal result;
  a host that owns the session passes one (ThinkRail does, through its session services). Results keep
  `terminate: true`. Without `endRun`, plain omp makes one more model request after a deferral, which the
  tool text already tells the model to end; `src/session.test.ts` pins both paths.
- **Built-in asking by mode:**
  - `ctx.mode === "tui"`: the terminal questionnaire through `ctx.ui.custom`. If `custom()` resolves
    `undefined`, it falls back to dialogs.
  - Any other mode with UI: the dialog walker.
  - No UI: "not available" without asking; the workflow skills then proceed on stated assumptions.
- **The terminal questionnaire matches ThinkRail's card.**
  - Same answer model: `src/questionnaire.ts` ports the card's `deriveAnswer` on purpose, because the card
    may not import an omp package.
  - Single-select: ↑↓ move and select. Multi-select: Space toggles.
  - Other opens an omp pi-tui `Editor`; typing on its row starts it. `n` adds a note.
  - The "Recommended" badge and the `Why:` line.
  - The selected option's markdown preview: beside the list from 100 columns, below it otherwise, capped
    at 24 lines.
  - A review page listing unanswered questions, Esc to skip, and a "Chat about this" row.
  - Known limit: no viewport for a questionnaire taller than the terminal.
- **The dialog walker trades richness for reach.**
  - One `select` per question, with "Other…" and "Chat about this".
  - Multi-select is a single `input` of "1,3; own text".
  - Previews go into the title (600 characters). No notes and no review page.
  - Dismissing any dialog declines the whole questionnaire.
- **One ask per batch.** The `assistant_message` hook keeps the first ask of a response, and a `tool_call`
  hook blocks every other call of that response with a reason telling the model to re-issue it after the
  answer. omp's `assistant_message` rewrite may only change text, so the blocked calls stay in the stored
  message with an error result rather than being removed as under pi. With its siblings blocked the ask
  runs alone, so it needs no per-tool sequential mode. The same `tool_call` hook blocks an ask that no
  model response issued, such as one from an `eval` script: the tool is model-only.
- **No cap on the number of questions; length limits are advisory.** The limits live in field descriptions
  only: a schema `maxLength` would reject the whole call and echo every argument back. Reserved labels
  ("Other", "Type something.", "Chat about this", "Next →") are rejected because the UIs add them.

## Boundary

- **Allowed deps:** peers `@oh-my-pi/pi-coding-agent` (including its `z` schema builder) and
  `@oh-my-pi/pi-tui`; test-only `pi-faux` (faux provider).
- **Forbidden:** anything from ThinkRail (`@thinkrail/*`, `apps/*`, `packages/server`) and Bun APIs in
  shipped code.

## Structure

- `index.ts`: exports and the default export.
- `src/core.ts`: the contract.
- `src/schema.ts`.
- `src/extension.ts`: the factory and default guidance.
- `src/dialogs.ts`.
- `src/questionnaire.ts`: the answer model.
- `src/tui.ts`: the questionnaire and transcript renderers.

## Verification

- Unit tests per module.
- `src/session.test.ts` runs the tool in a real omp `AgentSession` on the `pi-faux` provider, with UI
  bound through omp's `initializeExtensions`:
  - an answer continues the run;
  - "Chat about this" ends it after one model call (fails under omp, see above);
  - sibling tool calls are blocked and told to re-issue.
- The parity gate drives the terminal and dialog paths with a scripted UI against the packed tarball
  under Node.
- Before the first publish: a manual check in a real terminal (Ghostty or iTerm2, and inside tmux).
