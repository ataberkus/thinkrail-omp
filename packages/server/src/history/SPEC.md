---
id: submodule-server-history
type: submodule-design
status: active
title: history — chat-history search index
parent: module-server
depends-on: [module-contracts]
tags: [history]
---

## Responsibility
The `history.search` backend: a **lazy in-memory index** over pi's session JSONL files (prompt recall +
full-conversation matches). Enumerates and reads session files **itself** (async `readdir`/`stat`/
`readFile`, replicating pi's pinned discovery layout below) — it must **never call
`SessionManager.listAll()`** on any search/refresh path: `listAll` reads and JSON-parses *every session
file in full* just to build its `SessionInfo`s (`messageCount`/`allMessagesText` we never use), so an
index refresh through it costs the whole corpus even when nothing changed, on the event loop every live
session shares. **Never writes** session files. Because discovery walks every pi session on disk, the
host handler's `all` scope (`host/historyScope.ts`'s `filter = () => true`) deliberately surfaces pi-CLI
sessions outside any registered ThinkRail workspace too — a bit more than `session.getMessages` itself
ever exposes for a single session, but consistent with an owner-scoped host (no multi-tenant isolation
to preserve).

## Design
- `extract.ts` — pure JSONL→`ExtractedSession | null` (`extractSession`): the session's identity
  (`id`/`cwd` from the header, mirroring pi's own rejection rule — the first parseable entry must be a
  `type: "session"` header with a string `id`, else `null`), its `title` (omp's header `title`, which
  `parseSessionEntries` folds from the fixed-width title slot on the file's first line — a cleared slot
  clears it; a pi 1.x transcript that has no header title falls back to its **latest** `session_info`
  name, explicit clears included, pi's own rule), and its
  `HistoryEntry[]` — all from **one parse**, so the index never needs a second source (`listAll`) for
  metadata. Pi session files are **trees** (abandoned branches) that compaction rewrites, so it resolves
  the file the way pi does before the client renders it — `parseSessionEntries` →
  `migrateSessionEntries` → `buildSessionContext` in omp's display-transcript mode (`transcript`,
  `collapseCompactedHistory`: follow the current leaf, apply the latest compaction with its summary where
  it fired, drop summarized/abandoned entries) — then indexes the resolved messages, filtered through contracts'
  **`isTranscriptMessageRole`**, the very guard `getSessionMessages` sends by (one policy, not a local copy
  of it). So `messageIndex` matches the client's `turnIdByMessageIndex` exactly
  (no raw-file-order drift), and abandoned/summarized text never becomes a hit — the compaction summary is
  sent (it renders the client's compaction marker), so it consumes an index slot without being searchable.
  The internal
  `TODO_NUDGE_PREFIX` control message (hidden from the transcript on hydrate) is skipped after its index
  slot is consumed, so alignment holds; a **superseded auto-retry attempt** (the shared
  `isRetriedAttempt` reading from contracts — an errored assistant immediately followed by another
  assistant, the adjacent shape pi's `_prepareRetry` produces,
  which hydration renders as no turn / null anchor) is skipped the same way, so a
  failed partial's text never becomes a hit that could only resolve to "couldn't locate the message".
  omp's default (model-context) mode would drop every `error`/`aborted` assistant turn and retried
  attempt; the display mode keeps them, as pi's resolver did, and is the view `getSessionMessages` sends,
  so a terminal failure stays searchable and indexes stay aligned. Entry text is **full, never truncated** — a hit's `text` is what
  recall inserts and what the overlay's preview presents as the whole prompt, so a cap would silently
  corrupt recall of long pasted-log prompts and make terms past the cutoff unsearchable (the memory
  precedent is pi itself: `SessionInfo.allMessagesText` holds every session's full text in memory). Tool
  results/thinking are not indexed.
- `historyIndex.ts` — `HistoryIndex`: cold build on first search (async per-file IO yields the event loop;
  blocks the search up to a budget, then returns partial with `indexing: true`). Discovery is its own
  async enumeration (see "omp file format" below for the pinned layout): a custom `sessionDir` is a flat,
  non-recursive dir of `.jsonl` files; the default root is pi-utils `getSessionsDir()` (`<agentDir>/sessions`,
  or the XDG data dir when omp uses one) resolved **per refresh** — holding one
  level of per-cwd directories, including top-level symlinks Pi treats as candidate directories. Broken
  or non-directory symlinks degrade to the same unreadable-directory empty result as Pi. Freshness = `(mtime, size)`
  revalidation throttled to ~2 s (pi appends live messages to the file, so the file IS the live feed — no
  agent-module hook; size is compared alongside mtime so an append landing in the same coarse mtime tick
  still reloads); only a **new or changed** file is read (once, `readFile`) and re-parsed — an unchanged
  corpus costs one `readdir` walk + one `stat` per file, no reads, no parses. A warm revalidation runs in
  the **background** — a bulk change (first refresh after restart, a git checkout) can still mean many
  parses, so a search never blocks on it; results are at most one cycle stale, and the background
  refresh swallows its own errors (an unhandled rejection could crash the in-process host). `indexing` is
  reported whenever any build is in flight (cold OR a background revalidation), so the client's retry loop
  polls until a just-written session lands — read-your-writes without blocking the search. Matching:
  case-insensitive substring AND over whitespace terms (query length + result `limit` clamped to the
  protocol caps, `MAX_HISTORY_QUERY_LENGTH`/`MAX_HISTORY_LIMIT`, at both the handler and `search()`);
  strict recency order; prompts deduped by normalized text keeping newest; caps + true totals.
  The messages section (and `messageTotal`) is filtered to `role === "assistant"` only — a user-role hit
  is always a textual duplicate of its own prompt entry (user text IS a prompt in this extraction), so it
  would add no text, only a location; that location moves onto the prompt hit instead, via the two
  fields below.
- Jump anchors are drift-tolerant: hits carry `anchorText` (message-text prefix) the client validates.
  Every prompt hit now also carries its kept-newest occurrence's `messageIndex`/`anchorText` —
  the same two fields `MessageHit` always had — making the prompt row itself jumpable. Both fields are
  optional on `PromptHit` (absent only when the host predates this feature).
- `testFixtures.ts` — test-only session-file builders (pinned by A5): `writeFixtureSession` writes a
  minimal but real omp-shaped JSONL (a `name` becomes the header `title`), one flat file per session, that
  `historyIndex` tests, the e2e fixture seeder, and its own format-pinning test (`testFixtures.test.ts`)
  drive against; `defaultSessionDirFor` is omp's public `SessionManager.getDefaultSessionDir(cwd, agentDir)`
  so fixtures land where a real no-arg `listAll()` looks.

## On-disk JSONL structure (omp session files)
- **`message` entries:** `{ type: "message", ..., message: { role: "user"|"assistant"|"toolResult"|…, content: string|array, timestamp: ms-number } }`.
  omp persists no system message: the system prompt is recorded once in a `session_init` entry
  (`systemPrompt: string[]`), which is not a context message and consumes no `messageIndex` slot.
- **`model_usage` entries:** `{ type: "model_usage", ..., purpose, api, provider, model, usage, stopReason }`; hidden from
  the conversation tree and context (pi 1.x wrote these as `usage`).
- **`custom_message` entries:** `{ type: "custom_message", customType: string, content: string|array, timestamp: ISO-string, display: boolean, ... }`.
  They have no `message` wrapper and become role `custom` context messages.
- **Titles:** the title slot plus header `title`; each change also appends a `title_change` audit entry.

## omp file format (`@oh-my-pi/pi-coding-agent`, the catalog-pinned version)
Verified against the installed `src/session/{session-loader,session-paths,session-entries}.ts`. Re-verify these facts on a pi bump;
`testFixtures.ts` and `historyIndex.ts` both depend on the discovery layout.
- **Header:** omp writes a fixed-width title slot line (`{ type: "title", v: 1, title, source?, updatedAt, pad }`)
  first, then `{ type: "session", version: 3, id, title?, titleSource?, timestamp, cwd, … }`; `CURRENT_SESSION_VERSION = 3`.
  omp stores `cwd` **as handed to the `SessionManager`, unresolved** (`<dir>/./` stays `<dir>/./`) where pi
  resolved it; stored directories rely on a resolved spelling to compare by `===` (architecture
  Decision 22), so `testFixtures.test.ts`'s pin of pi's resolution fails until the host resolves before
  handing a cwd to omp.
  Readers require the first *parseable* entry to be a session header with a string `id` (not necessarily physical line 1).
  `cwd` is recovered from that header; a missing/invalid header rejects the file.
- **Naming and custom directories:** discovery only considers direct children whose names end in `.jsonl`; pi writes
  `<ISO timestamp with ':' and '.' replaced by '-'>_<sessionId>.jsonl`, but the filename otherwise has no meaning.
  `list(cwd, sessionDir)` and `listAll(sessionDir)` use a flat, non-recursive custom directory; custom-list filtering
  still compares the header `cwd` with `cwd`. Subdirectory placement is invisible.
- **Default layout:** no-argument `listAll()` scans the sessions root one level deep, considering child directories
  and symlinks, then their direct `.jsonl` children. Unreadable or broken symlink targets contribute no files. Each cwd
  directory is named relative to the temp root (`-tmp-<rest>`) or home (`-<rest>`), else pi's legacy
  `--<absolute path>--`, with `/`, `\` and `:` replaced by `-`; `SessionManager.getDefaultSessionDir` is public.
- **When a file appears:** a new session's file is first written once it holds a user or assistant message
  (setup-only sessions leave no file), so a prompt whose first turn never completes is still on disk.
- **Environment:** omp snapshots `PI_CODING_AGENT_DIR` when pi-utils loads; changing it later takes effect only through
  `setAgentDir` / `refreshDirsFromEnv` (tests use `pi-faux`'s `isolateAgentDir`).

## Boundary
- **Public surface (`index.ts`):** `HistoryIndex`, `getHistoryIndex()`, `matchesTerms`, `makeSnippet`,
  `clampLimit`, `extractSession`, types. **No test helpers** — `writeFixtureSession`/`defaultSessionDirFor`
  are disk-writing test-only builders and must not enter the runtime module graph; they're reachable only
  through the server package's dedicated **`@thinkrail/server/history-test-fixtures`** subpath export
  (package.json), the sanctioned test boundary — same pattern as `@thinkrail/server/agent`. In-package
  tests import them relatively (`./testFixtures`); the e2e seeder imports the subpath.
- **Allowed deps:** `@oh-my-pi/pi-utils` (`getSessionsDir` — the default sessions root),
  `@oh-my-pi/pi-coding-agent` (the exported session-tree helpers `parseSessionEntries`/`migrateSessionEntries`/`buildSessionContext`
  used by `extract.ts`; **not `SessionManager`** in production code — see Responsibility. Tests may use
  `SessionManager` to *pin* layout/format facts against the real thing), `@thinkrail/contracts`,
  `node:fs`, `node:fs/promises`, `node:path`.
- **Forbidden:** importing `agent`/`workspaces`/`projects` (scope mapping is injected by the host handler
  via the `filter`/`labels` callbacks passed into `search()`); writing anything to disk (`writeFixtureSession`
  is test-only, never called from production code paths).
