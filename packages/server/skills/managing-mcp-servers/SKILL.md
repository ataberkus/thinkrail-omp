---
name: managing-mcp-servers
description: Use when the user asks to add, change, remove, enable or disable an MCP server, or when an MCP tool is missing, needs sign-in, fails, or was blocked. ThinkRail runs omp in-process, so there is no `omp` command to call.
---

# Managing MCP servers in ThinkRail

ThinkRail connects MCP servers through omp's MCP client but has no `omp` executable. Never run
`omp mcp add`, `/mcp reauth` or other `omp` commands; edit the configuration files and point the user at
**Settings › MCP servers** for everything that needs them.

## Where servers are configured

- **User level** — omp's agent directory, usually `~/.omp/agent/mcp.json`: available in every project.
- **This repository** — `.omp/mcp.json` in the worktree, tracked in git. A server defined here does not
  run until the user approves it in Settings, and any later change to its entry needs approval again.
  It only loads when the user trusts the project.

Both files use omp's format (ThinkRail reads only these two files, not `.mcp.json` or other tools'
configurations):

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp" },
    "browser": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.83"] }
  }
}
```

- Pin package versions in `args`; never `@latest`.
- `type` is `stdio` (a `command`), `http` (a `url`, the default for one) or `sse` for servers that only
  offer the legacy SSE transport. `timeout` is in milliseconds.
- Never write a secret into either file. Reference it as `${ENV_VAR}` (from the host's environment) or
  `!command` (the command's output, for example `!gh auth token`), or let the user sign in. An `auth`
  block is only accepted in the user-level file.
- `exposure` (ThinkRail's own key; omp ignores it): `deferred` (the default — the server's tools are
  listed under `xd://` and called by name), `direct` (a few always-useful tools, declared to the model
  directly), or `hidden` (not offered at all). `codemode` is treated as `deferred`. `toolExposure` sets it
  per tool; keys may use `*`.
- To turn a user-level server off for every client, set `"enabled": false` on its entry or list its name
  in `disabledServers` beside `mcpServers` in the user-level file.
- Prefer the user-level file for personal servers; only put a server in `.omp/mcp.json` when the user
  wants it shared with the repository.

## GitHub

GitHub is a recipe, not a preset: its hosted server, authenticated with the user's GitHub CLI sign-in.
Add it to the user-level file (Settings › MCP servers offers the same entry under Paste JSON):

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/readonly",
      "headers": { "Authorization": "!t=$(gh auth token) && echo \"Bearer $t\"" }
    }
  }
}
```

- `/readonly` is GitHub's documented read-only mode (same as an `X-MCP-Readonly: true` header). Use
  `https://api.githubcopilot.com/mcp/` only when the user asks for tools that change data.
- The header command runs each time a chat connects. While `gh` is logged out it fails instead of sending
  an empty token; the user runs `gh auth login` in a terminal.
- Unverified: whether GitHub accepts the GitHub CLI token's scopes for every toolset. If the server
  rejects it, ask the user for a token in an environment variable: `"Authorization": "Bearer ${GITHUB_TOKEN}"`.

## After editing

The host reloads idle chats on its own and a busy chat picks the change up when it is idle. Tell the user
when a step is theirs: approving a repository server, or **Sign in** for a server that uses OAuth (both in
Settings › MCP servers). Do not ask them to restart ThinkRail.

## Using MCP tools

- Tools are named `mcp__<server>_<tool>` (lowercase, other characters replaced by `_`). A `deferred`
  server's tools appear under `xd://`; call them by name.
- Subagents cannot call MCP tools: call them yourself and put what the subagent needs in its task.
- ThinkRail asks the user before a call that may change data. A denied or cancelled call is final for that
  call; do not retry it without asking the user first.
