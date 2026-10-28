---
id: submodule-server-agent-mcp
type: submodule-design
status: active
title: "agent/mcp — host-owned MCP layer: omp-schema config loader, writers, fingerprints, per-load MCP manager and session host"
parent: submodule-server-agent
depends-on: [module-contracts]
tags: [mcp, omp]
---

## Responsibility

What ThinkRail owns around omp's MCP client (`@oh-my-pi/pi-coding-agent/mcp`): at the configuration
layer, reading omp's two native `mcp.json` files under ThinkRail's policy, editing them safely from a
long-lived multi-client process, and the two host-only derivations — exposure (a ThinkRail key omp
ignores) and the per-entry fingerprint behind repo-server approvals; at the session layer, one omp
`MCPManager` per engine-session load that the host connects, closes and reports on, the host wrapper
around every MCP tool it hands the session (call confirmation, exposure, bounded result summary), the
chat's `/mcp` command, OAuth sign-in through omp's reauthorization engine, and the server log omp does
not keep. Transports, OAuth flows, credential storage (omp's `AuthStorage`) and tool bridging stay omp's.

Upgrade removal gates live in [[pi-compatibility]]; the contracts below own the implementation detail.

## omp facts (`@oh-my-pi/pi-coding-agent`, the catalog-pinned version)

- **Files and schema.** omp's native files are `getAgentDir()/mcp.json` (user) and
  `<cwd>/.omp/mcp.json` (project, `CONFIG_DIR_NAME` from `@oh-my-pi/pi-utils`). An entry is
  `{ type?: "stdio" | "http" | "sse", command, args, env, cwd | url, headers, enabled, timeout (ms),
  requestIdFormat, instructions, auth: { type: "oauth" | "apikey", credentialId, … }, oauth: { clientId,
  clientSecret, scope, redirectUri, callbackPort, callbackPath, prompt } }`; a `url` without `type` is
  HTTP. The user file may carry `disabledServers` (always wins) and `enabledServers` (overrides a file's
  `enabled: false`). omp also reads `.mcp.json`/`mcp.json` variants and other tools' configurations; the
  host reads only the two native files (repository configuration from other tools would otherwise run
  without an approval). omp's discovery collapses two definitions with the same transport into one;
  the host keeps both names.
- **Loader.** omp's public `loadAllMCPConfigs` is a multi-source capability loader: it silently drops
  invalid entries (logger warnings), offers no per-entry admission and returns only connectable,
  merged configs. `MCPManager`'s third constructor argument (`MCPConfigLoader`) lets the host supply its
  own; omp's `validateServerName` / `validateServerConfig` are public and the host's validator ends
  with them. The parity test runs every fixture through `loadAllMCPConfigs` (agent directory isolated):
  every server ThinkRail admits loads in omp with the same transport definition and source path, and
  every server omp loads that ThinkRail does not has a reported ThinkRail error. Re-run on every omp
  bump; a parity failure is a port bug.
- **Session wiring.** `createAgentSession({ enableMCP: true, mcpManager })` skips omp's own discovery and
  does not wire the manager's tool or prompt callbacks, does not disconnect it on `dispose()`, and makes
  it the process-global `MCPManager.instance()` (read by the `mcp://` resource handler). The host
  therefore connects servers itself after the session exists, delivers tools with
  `session.refreshMCPTools`, registers `setPendingMCPDiscovery` so the first turn waits
  (`MCP_DISCOVERY_TURN_WAIT_MS`), clears the global instance again (several chats share the process), and
  closes the manager. `dispose()` itself emits `session_shutdown` (no `reason`) and runs handlers in
  parallel with a 2 s cap; MCP closure never depends on them.
- **Tools.** Minted `mcp__<server>_<tool>` (lowercase, `[^a-z0-9_]` → `_`, single separator, ≤ 64
  chars); `CustomTool` carries `mcpServerName`, `mcpToolName`, `mcpReadOnlyHint`. Results put the raw MCP
  content and `structuredContent` in `details` (`MCPToolDetails`, base64 included); omp's spill wrapper
  saves oversized text as a session artifact (`details.meta.truncation.artifactId`). A tool whose
  `loadMode` is `discoverable` (the default) is mounted under `xd://` while `tools.xdev` is on;
  `essential` stays top-level. There is no `tool_search`, codemode or resource tool.
- **Status and auth.** `MCPManager` has typed state (`getConnectionStatus`, `addConnectionStatusListener`
  events `connecting`/`connected`/`failed`/`reconnecting`, `reconnectServer(name, { manual })`,
  `waitForStartup`, `getTools`). OAuth runs through `reauthorizeMcpServer` (public subpath
  `mcp/oauth-reauth`) with `onAuth`, `onManualCodeInput`, an `AbortSignal` and a per-owner single
  flight; credentials are url-keyed rows in `AuthStorage`. omp writes no `mcp.log` and drops a stdio
  server's stderr.
- **tool_call budget.** An extension `tool_call` handler runs under a 30 s active-work budget that only
  omp-owned `ctx.ui` dialogs pause, so a confirmation through the host's anchored dialog would time out
  and block the call; confirmation therefore runs inside the host's tool wrapper.

## What's here

- `config.ts` — `validateMcpServerConfig(name, raw)`: omp's name rule, field typing for every key omp
  reads (a mistyped value is an error, where omp would ignore it with a warning), `command` xor `url`,
  ThinkRail's `exposure` / `toolExposure` / `description`, then omp's `validateServerConfig`; returns a
  typed `HostMcpServerConfig` (omp's `MCPServerConfig` plus the host keys, `type` always set).
  `loadMcpConfigFiles()` reads the two files (one leading BOM ignored; omp tolerates it too) and returns
  `servers` (admitted, merged, with `disabledServers` / `enabledServers` applied), `errors`, `entries`
  (every named value as written, with file, scope and whether it is an override) and `fileErrors`
  (unparsable JSON, `mcpServers` not an object, a mistyped server list). Project rules: an entry
  without `command`/`url`/`type` is a ThinkRail override of `enabled` / `exposure` / `toolExposure` of
  the same-named user server (omp's CLI honours only `{ "enabled": false }` there — any other override
  shadows the user server in omp and is documented as such); `auth` is refused in the project file (a
  repository entry could otherwise point a stored credential at its own URL); names whose tool prefixes
  collide (`mcpNamespace`) are refused. `loadHostMcpConfig()` admits project entries only at their
  approved fingerprint, applies record overrides, then the chat-local disabled set, and normalizes
  exposure. `fingerprintMcpEntry` = SHA-256 over the name and canonical JSON of the raw entry
  (`toolExposure` order kept). `mcpTargetOf` hashes `command`+`args` or `url` for tool grants;
  `mcpToolLabel` strips `mcp__<namespace>_`. `ompServerConfig` drops the host keys before a config
  reaches omp. `toolExposureOf(config, tool)` resolves exact name, then `*` patterns, then the server.
- **Exposure.** omp has no exposure: unset and `codemode` read as `deferred` (the tool stays
  `discoverable`, mounted under `xd://`), `direct` makes the host wrapper report `loadMode: "essential"`
  (declared top-level), `hidden` withholds the tool from the session entirely.
- `engine.ts` — `McpEngineLoad`, one per engine-session load: an `MCPManager(cwd, null, loader)` whose
  loader returns the load's enabled servers (env-expanded with omp's `expandEnvVarsDeep`, source = the
  defining file) and nothing once the load is closed. `attach(session, deliver)` sets the session's
  `AuthStorage`, clears the global instance, subscribes to connection status (into the tracker), tool
  changes and `notifications/message` (into the log), then runs omp's own deferred sequence:
  `discoverAndConnect`, deliver, `waitForStartup(MCP_DISCOVERY_TURN_WAIT_MS)`, deliver again, all
  guarded by the closed flag and `session.isDisposed`, and registers it with `setPendingMCPDiscovery`.
  `close()` marks the load closed synchronously, aborts its sign-ins, unsubscribes, `disconnectAll()`
  (which also aborts in-flight handshakes) and joins the discovery, whose `finally` disconnects again if
  a connect started after closure; repeated calls join the one cleanup promise. omp's stdio close sends
  SIGTERM then SIGKILL.
- `sessionHost.ts` — `createMcpSessionHost({ cwd, policy, projectTrusted, onCommandSettled?,
  askForToolCall, grantTool })`, one per parent session. `sessionOptions()` (called once per load)
  closes a previous unclosed load, reads `loadHostMcpConfig` with the host-supplied trust (omp's
  `ctx.isProjectTrusted()` is always true), records `loaded()` and returns `{ enableMCP: true,
  mcpManager }`, or `{ enableMCP: false }` when no server is enabled. `attach(session)` starts the load;
  `shutdownEngine()` closes it; `registered()` is the load's per-server runtime status;
  `reconnect(name)` and
  `startup()` serve `mcpSessions`. Every delivered tool is a `Proxy` of omp's tool overriding `execute`
  and, for `direct`, `loadMode`. `execute` first confirms: a tool with `mcpReadOnlyHint`, one allowed in
  this chat, or one holding a valid project grant runs; with no UI the call is blocked; otherwise
  `askForToolCall(toolCallId, input, title, options, signal)` with **Deny · Allow once · Allow in this
  chat · Always allow** (the title's second line states Always allow's scope). Anything but an
  affirmative answer returns an error result with the reason (denied, cancelled, or dismissed / replied
  in the chat). Then it runs omp's tool and rewrites `details`: omp's raw `rawContent` and
  `structuredContent` are dropped, `server` / `tool` (the wire's `McpToolDetails`) and `thinkrail`
  (`summarizeMcpResult` of the raw result, before omp's spill wrapper prunes it) are added. The
  extension factory registers `/mcp` (status list; `login` / `logout` / `reconnect <server>`, each under
  the sign-in lock where relevant, each calling `onCommandSettled`) and a `tool_result` handler that sets
  `details.fullOutputPath` to the spilled artifact's path (`artifact://<id>` for an in-memory session).
  Chat login shows the address as a notice and asks for the paste-back through `ctx.ui.input`;
  dismissing it cancels the flow.
- `auth.ts` — `signInMcpServer` (omp's `reauthorizeMcpServer` with `acpOwned: true`, so omp never
  rewrites a ThinkRail-managed file; a per-server flow owner so two servers do not cancel each other),
  `signOutMcpServer` (removes the `auth.credentialId` row and the url-keyed rows) and
  `testMcpConnection` (a throwaway `MCPManager` connect: connected with its tool count, needs sign-in by
  omp's `analyzeAuthError`, or failed with the reason).
- `status.ts` — `McpRuntimeTracker` turns omp's connection events and per-server connection state into
  `McpRuntimeStatus` (`starting` before attach or while connecting, `connected` with its tool count,
  `needs-sign-in` for an HTTP auth failure, `failed` with the reason, `disconnected`, `disabled`);
  `reportMcpRuntime` redacts it into the derivation input; `formatMcpRuntime` is the `/mcp` text;
  `deriveMcpServerStatuses` merges it with configuration (disabled in chat / project, pending approval,
  invalid config, pending reload).
- `log.ts` — the host appends every `notifications/message` to `mcp.log` in omp's agent directory in
  pi's former format (`<ISO time> [<server>] <level>[ <logger>:] <text>`, continuation lines indented
  four spaces, rotated to `mcp.log.1` past 5 MiB); `readMcpServerLog(name)` returns the server's latest
  200 lines from both files, masked.
- `results.ts` — `summarizeMcpResult()`: block kinds, URIs, MIME types and sizes, never data, plus the
  server's `structuredContent`, within one 64 KiB budget; `mcpCallResultOf(details)` rebuilds the call
  result from omp's `MCPToolDetails`.
- `redact.ts`, `summaries.ts`, `management.ts`, `writers.ts`, `signInLock.ts` — unchanged contracts on the
  new schema: masking of every host DTO, Settings rows (unset exposure reads `deferred`; OAuth applies to
  HTTP/SSE servers without an `Authorization` header whose `auth` is absent or `oauth`), raw-entry
  writes with containment (`.omp` must be a real directory, `mcp.json` a regular file), stale-write
  fingerprints, add-vs-update occupancy, `__proto__` safety, BOM handling, mode-preserving atomic
  rename and user-file symlink preservation; the writer drops a global server's default `enabled: true`
  and `exposure: "deferred"`. omp's async writers (`addMCPServer` …) are not used: they add `$schema`,
  rewrite formatting and permissions and replace symlinks. The sign-in lock is keyed by
  `mcpNamespace`.
- `fixtures/` — a stdio server, an OAuth HTTP server and the session-test harness (faux provider,
  isolated agent directory, in-memory credentials).

## Boundary

- **Public surface (barrel):** `index.ts` — the config, writer, management, status, results, log,
  auth and session-host exports listed there.
- **Allowed deps:** `@oh-my-pi/pi-coding-agent` (root types, `getAgentDir`, `MCP_DISCOVERY_TURN_WAIT_MS`)
  and its `mcp`, `mcp/oauth-reauth`, `mcp/oauth-credentials`, `mcp/startup-events`,
  `discovery/helpers` and `capability/types` subpaths; `@oh-my-pi/pi-utils` (`CONFIG_DIR_NAME`);
  `@thinkrail/contracts`; `@thinkrail/shared/codedError`; Node `fs`/`path`/`crypto`.
- **Forbidden:** `host`, `projects`, the web; no transport or OAuth protocol code of its own.
