---
id: submodule-server-templates
type: submodule-design
status: active
title: templates — file CRUD over pi's prompt-template dirs
parent: module-server
depends-on: [module-contracts]
tags: [templates, public-surface-checked]
---

## Responsibility

File CRUD over pi's two sanctioned prompt-template directories (global + project-scoped): list / get /
save / delete `.md` files, surfacing frontmatter `description` and `argument-hint` as metadata.
Consumed by the `template.*` host handlers; this module owns no WS surface itself — an optional `cwd` is
passed in by the caller after resolving either a live workspace or a pre-session project's current checkout,
never looked up here.

## omp facts (`@oh-my-pi/pi-coding-agent` + `@oh-my-pi/pi-utils`, the catalog-pinned version)

Verified by reading `config/prompt-templates.ts` (`loadPromptTemplates`, `loadTemplatesFromDir`),
`sdk.ts` (`discoverPromptTemplates`) and pi-utils `dirs.ts` / `frontmatter.ts`; re-verify on a bump.

- **Directories:** global = `join(agentDir, "prompts")` (`discoverPromptTemplates` passes
  `getAgentDir()`); project = pi-utils `getProjectPromptsDir(cwd)` = `<cwd>/.omp/prompts`
  (`CONFIG_DIR_NAME = ".omp"`). Both helpers and `parseFrontmatter` are public pi-utils root exports;
  omp's coding-agent root re-exports only `getAgentDir`. pi 1.x used `<cwd>/.pi/prompts`; this repo's
  own templates moved to `.omp/prompts/`.
- **Parsing:** omp reads a file with `Bun.file().text()` (one leading BOM dropped) and calls
  `parseFrontmatter(text, { source })` with its defaults: CRLF normalized, leading HTML comments before
  the fence dropped, kebab-case keys normalized to camelCase (`argument-hint` → `argumentHint`), and
  **malformed YAML never rejects the file** — after a quoting repair it falls back to a line-by-line
  `key: value` read and logs a warning. A block with no closing `\n---` is plain body.
- **What the loader reads:** `description` (any value, stringified) else the body's first non-empty line
  (60 chars + `...`), with the source label appended (`(user)`, `(project:<subdir>)`); it never reads
  `argument-hint`. Templates are rendered through omp's Handlebars-style `prompt.render`, so `{{…}}` in a
  body is template syntax.
- **Scan:** recursive `**/*` under each dir; the name is the basename minus `.md` (so `sub/foo.md` is
  `foo`), symlinks followed. Errors per file and per scan are logged and skipped.
- **Precedence:** `loadPromptTemplates` returns global then project with no dedup, and expansion takes
  the **first** name match — omp's `/name` prefers the global template.

## Design

- `templateDirs(cwd?, agentDir = getAgentDir())` → `{ globalDir, projectDir? }` — pure path arithmetic,
  no filesystem access. `agentDir`'s default is a **default-parameter expression**, evaluated at call
  time, not a module-level constant — omp's resolver snapshots `PI_CODING_AGENT_DIR` when pi-utils loads
  but is re-pointed at runtime (`setAgentDir`, `refreshDirsFromEnv` — host environment changes and test
  isolation use them), so caching the value here would miss that.
- `listTemplates` re-reads both directories **on every call** — no cache, anywhere in this module. This
  is the "/ menu freshness" rule (design spec §2.2): omp's own `session.promptTemplates` is the list the
  session was created with — a **create-time snapshot** that goes stale the moment a template is saved
  mid-session. A template saved through `template.save` must show
  up the next time any client asks (`template.list`, the web `/` menu, the Templates settings panel), so
  this module never memoizes; the cost is a couple of small `readdir`s per call, which is cheap enough.
- `isValidTemplateName` is the **traversal gate**: applied to every caller-supplied `name` before it's
  `join()`-ed into a path, in `getTemplate`, `saveTemplate`, and `deleteTemplate` alike. Its job is
  path-traversal *safety*, not naming style, so it rejects only the shapes that are unsafe as a
  single filename segment — empty, a leading `.` (covers `.`, `..`, and `.hidden`-style dotfiles with
  one rule), a path separator anywhere in the name (`/` or `\`), an embedded NUL byte, or a colon
  (rejected on every OS, specifically the NTFS alternate-data-stream case: NTFS reads `a:b.md`
  as an alternate data stream of a file named `a`, so a colon-named template could not survive a
  Windows checkout) — and accepts everything else, including interior dots (`foo.bar`),
  uppercase, spaces, and unicode. A hand-placed colon-named file on Linux/macOS therefore disappears
  from `template.list` and is refused by get/save/delete; deliberate, since the name cannot survive a
  Windows checkout, and list/get parity holds because `listTemplates` filters through the same gate.
  This matters because pi's own loader performs **no sanitization at all** when deriving a name from a
  filename (see "omp facts" above), so a narrower rule breaks **list/get parity**: a name `listTemplates`
  can show but `getTemplate`/`saveTemplate`/`deleteTemplate` refuse is a user-visible bug, not a safety
  improvement.
  (This gate originally used an `/^[a-z0-9][a-z0-9-_]*$/i` allowlist regex — safe, but over-restrictive:
  it rejected any name with an interior dot, so a perfectly ordinary, pi-legal template named `foo.bar`
  would list but 404 on get/save/delete. Fixed once caught — the allowlist shape was solving the wrong
  problem, aesthetics instead of traversal.) `listTemplates` (via `listDir`) **does** filter by this
  exact gate — not to mirror pi (pi's own scanner has no such filter and would happily list a hand-placed
  `.hidden.md`), but so list/get parity holds *structurally*: reusing the very predicate that guards
  get/save/delete, rather than a hand-rolled dot-check that could quietly drift from it later, means any
  name the gate rejects is invisible to `listTemplates` too, not just un-fetchable through it. (This
  filter was itself a fix: an earlier version listed every `.md` file unconditionally, so a hand-placed
  `.hidden.md` would show up in `template.list` and then 404 on `template.get`.)
- **The no-follow gate (symlink containment):** the traversal gate above constrains the *name*; this one
  constrains what the name may *resolve to*. Every by-name operation `lstat`s the target (never
  following) and treats anything that isn't a regular file — a symlink first of all — as **not a
  template**: `getTemplate` reports it absent, `saveTemplate` refuses to write through it (loud error,
  nothing touched on disk), `deleteTemplate` reports it not-found; `listDir` already skips symlinks
  structurally (a symlink dirent's `isFile()` is false, and no follow-up `stat` is taken). This is a
  **deliberate divergence from pi's own scanner**, which explicitly follows a file symlink
  (`loadTemplatesFromDir` stats it and loads a file target — "omp facts" above): pi's loader is a
  read-only, local convenience, while this module is a *write-capable CRUD surface over the wire* —
  following `.omp/prompts/linked.md → ~/somewhere` would let `template.get` disclose the target and
  `template.save` overwrite it, so a checked-out repo could plant a link and turn a routine template
  edit into a file write outside the worktree. Cost: a legitimately symlinked individual template that
  pi's own `/` menu would offer doesn't appear in ThinkRail's — acceptable, and already the listing's
  behavior before this gate existed. The same rule applies **one level up**: a symlinked `<cwd>/.omp` or
  `<cwd>/.omp/prompts` *directory* (the repo controls those path components) makes the project dir
  untraversable for **every** project-scope operation — `listTemplates`/`getTemplate` treat it as having
  no templates (list and get share one predicate, `readableProjectDir`, so they can never disagree),
  while `saveTemplate`/`deleteTemplate` refuse loudly (a write must fail visibly, never silently no-op).
  Without the read half, `template.list`/`template.get` would still disclose the link target's `.md`
  files over the wire — the same escape the file-level gate closes. The **global** dir is exempt on
  purpose: `~/.omp/agent/prompts` is
  user-owned (an attacker writing there has already won) and dotfile managers routinely symlink it. The
  `lstat`-then-write gap is a TOCTOU race only a concurrent local process could exploit — out of scope
  for an owner-scoped host (such a process could write the target directly). Pinned by the symlink
  cases in `templates.test.ts`.
- **Bounded listing + the size cap:** `listTemplates` is **metadata-only** (`TemplateInfo`, no
  `content`) and does bounded work per file regardless of what a checkout dropped in the dir:
  `readTemplateMeta` reuses the no-follow `lstat` as a size gate (a file over **`MAX_TEMPLATE_BYTES`**,
  1 MiB, is silently skipped — list/get parity: neither surfaces it usefully) and reads only the first
  `FRONTMATTER_SCAN_BYTES` (8 KiB) of the head for the frontmatter — omp's `parseFrontmatter` treats a
  truncated block with no closing fence as plain content, so a pathological >8 KiB frontmatter degrades
  to "no metadata," never an error or a full-file read (the by-name path still sees such metadata — a
  documented asymmetry of the bounded listing, pinned in tests). The **full text** travels only on the
  by-name `template.get`/`template.save` path (`Template`), where an oversized file/payload fails
  **loudly** (read: before `readFileSync`; save: before anything touches disk) — a directly-named
  operation deserves a loud answer, the same loud-vs-skip asymmetry as malformed frontmatter. This is
  what keeps one huge checked-in `.omp/prompts/*.md` from blocking the shared in-process host on every
  `/`-menu open or bloating a single WS response with every file's body.
- Metadata uses omp's parse exactly (pi-utils `parseFrontmatter`, level `off` so a listing logs nothing):
  one leading BOM is dropped first, as omp's file read does, and a file whose YAML omp can only read
  through its line fallback lists and gets **with that fallback metadata** — omp still offers it, so
  hiding it here would break parity (pi 1.x skipped such a file in its listing and its `get` threw).
- Two layers of failure containment inside `listDir` (the directory scan `listTemplates` calls twice):
  **(1)** a per-file read failure (unreadable file) is caught and that one file is skipped, as omp's
  loader skips it. **(2)** the *directory scan
  itself* — the `readdirSync` call plus the loop around it — is also wrapped, so an unreadable directory
  (EACCES, or, deterministically, a path that turns out not to be a directory at all) returns whatever
  had already been collected instead of throwing out of `listTemplates` entirely — mirrors omp's
  `loadTemplatesFromDir`, whose try/catch wraps the *whole* scan. (Layer (2) was itself a fix: without
  it an unreadable directory could blank the *other* scope's results too.)
- `saveTemplate` validates the incoming `content`'s frontmatter *before* writing anything, with
  `parseFrontmatter` at level `fatal`: YAML omp could read only through its warning fallback is
  refused, so ThinkRail never writes a template whose metadata omp would have to guess. A rejected save
  is a no-op on the filesystem: nothing is written, `mkdirSync`/`writeFileSync` never run. The
  read-back after a successful write can in principle still fail, but only for a filesystem race at that
  point, not a content problem — an acceptable residual this function doesn't try to eliminate.
- Only each directory's top-level `.md` files are templates here; omp's scan also recurses into
  subdirectories (a `sub/foo.md` it names `foo`). A by-name `join(dir, name.md)` cannot address those
  files, so listing them would break list/get parity; they stay omp-only.
- `listTemplates`'s result is sorted by `name` — `readdir` order isn't guaranteed across platforms, and
  every consumer of a template *list* (the `/` menu, the Templates settings panel) wants a stable order
  more than it wants filesystem-arrival order.

## Boundary

- **Owns:** file CRUD in exactly the two sanctioned dirs (`TemplateDirs.globalDir` / `.projectDir`);
  name validation as the traversal gate; frontmatter → metadata extraction for `description` /
  `argumentHint`. Never touches any other path — no `resolvePath` / symlink-following of caller input,
  only `join(dir, \`${name}.md\`)` after `name` has passed `isValidTemplateName`.
- **Public surface (barrel):** `templateDirs`, `TemplateDirs`, `listTemplates`, `getTemplate`,
  `saveTemplate`, `deleteTemplate`, `isValidTemplateName`.
- **Allowed deps:** `@oh-my-pi/pi-utils` (`getAgentDir`, `getProjectPromptsDir`, `parseFrontmatter` —
  root exports only), `@thinkrail/contracts` (`TemplateInfo`, `TemplateScope`),
  `node:fs`, `node:path`.
- **Forbidden:** importing `workspaces` / `projects` — stays registry-free like `history`; the
  `template.*` handler resolves the read request's one optional `workspaceId` / `projectId` location to `cwd`
  and passes it into `templateDirs` itself. Both ids together are rejected; no location remains global-only.
  Caching the listing across calls. Writing or reading anything outside `globalDir` / `projectDir`.

## Get right

- **`content` is the full file text, not pi's parsed `body`.** `TemplateInfo.content` round-trips
  byte-for-byte through `saveTemplate` → disk → `getTemplate` / `listTemplates`, independent of
  `parseFrontmatter`'s trim/newline-normalization quirks — those only ever affect metadata extraction,
  never the `content` field.
- **Fresh read, every call.** No in-memory cache anywhere in this module (see "Design" above) — this is
  deliberate, not an oversight; don't add one without re-reading the freshness rationale it exists to
  satisfy.
- **List/get parity, both directions — structural, not a convention.** `isValidTemplateName` excludes
  only the shapes that are unsafe as a filename segment (empty, leading `.`, a separator, NUL)
  plus `:` (the NTFS alternate-data-stream case above), never an ordinary pi-legal name like
  `foo.bar` — so don't tighten it without checking it still admits everything pi's own loader would
  list (a narrower "clean slug" regex looks safe in review but silently breaks this; it did, once — see
  "Design" above). The reverse direction holds too, by construction: `listDir`
  filters every directory entry through this *exact same* gate function, not a partial or hand-rolled
  re-check, so a dot-leading file like a hand-placed `.hidden.md` is ignored by the scan entirely and
  never surfaces in `listTemplates` in the first place. The gate and the scan can't drift apart because
  they share one predicate — don't reintroduce a second, parallel check for either direction.
- **`deleteTemplate` throws when the target is already gone**, rather than treating a missing file as a
  successful no-op — this is the handler contract Task B3 should build on. A delete request only reaches
  this module because a caller's UI named one specific existing-as-far-as-it-knows template; if the file
  is already gone, that view is stale, and the `template.*` handler should surface that as an error (e.g.
  "already deleted, refresh") rather than reporting success for something that didn't happen. Loud beats
  silent for a stale UI.
