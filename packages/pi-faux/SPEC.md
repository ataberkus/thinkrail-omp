---
id: module-pi-faux
type: module-design
status: active
title: pi-faux — scripted fake provider for engine tests
parent: architecture
references: [pi-compatibility]
tags: [pi, testing]
---

## Responsibility

`pi-faux` is the test-only provider every engine-level test streams through. oh-my-pi ships a
per-model mock (`@oh-my-pi/pi-ai/providers/mock`), but not the per-provider scripted core the
ThinkRail suites were written against (queued steps shared by every model of one provider, step
factories that see the request and call count, paced token deltas). This package supplies that
contract on omp's public stream types, so tests keep asserting engine behaviour instead of a
transport.

## Public surface (`index.ts`)

- `createFauxCore(options)` — one provider core: `api`, `provider`, `models`, `stream` /
  `streamSimple`, `state.callCount`, `setResponses` / `appendResponses` /
  `getPendingResponseCount`, `getModel(id?)`, and `providerConfig()` for
  `ModelRegistry.registerProvider`.
- `fauxProvider(options)` — the same core packaged as `{ id, name, config }` for hosts that
  register providers as one unit.
- `fauxAssistantMessage`, `fauxText`, `fauxThinking`, `fauxToolCall` — response builders.
- `createFauxModelRegistry(settings?)` — in-memory `AuthStorage` plus a `ModelRegistry` that ignores
  the user's local model configuration; `registerFaux(registry, faux)` registers a core and returns
  its first model as the registry resolves it.

## Semantics

- Each request consumes the next queued step; an empty queue answers with an `error` stop reason
  and the message `No more faux responses queued` — never a throw.
- Text, thinking and tool-call arguments stream as several deltas sized by `tokenSize`, paced by
  `tokensPerSecond` (microtasks when unset). Abort ends the stream with an `aborted` error.
- Usage is estimated from prompt and reply length (4 characters per token). With a `sessionId`,
  the shared prompt prefix with that session's previous request is reported as `cacheRead`.
- Deferred (poll-later) responses are not modelled; omp has no deferred-handle transport.

## Boundary

Depends only on `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` public exports. Any package
may use it in tests; production code never imports it.
