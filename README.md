# ZelAI CLI

Terminal coding agent for [ZelAI](https://ai.zelai.qzz.io), built with Bun, TypeScript, and OpenTUI.

ZelAI keeps the workflow people expect from a modern coding agent — an interactive TUI, plan/build/review agents, subagents, todos, permissions, undo, custom commands, sessions, and a single model gateway — while the implementation here is its own codebase.

## Install

```sh
bun install
bun run dev
```

Or build a single binary:

```sh
bun run build
./dist/zelai --help
```

## Login

```sh
zelai auth login
```

This starts a device login: open the printed URL, approve it from your ZelAI account, and the CLI stores a key in `~/.config/zelai/zelai.json` with mode `600`.

Environment overrides:

- `ZELAI_BASE_URL` — gateway base URL, default `https://ai.zelai.qzz.io`
- `ZELAI_API_KEY` — use a key without writing config
- `ZELAI_CONFIG_DIR`, `ZELAI_DATA_DIR` — override storage locations

## Usage

```sh
zelai                          # interactive TUI
zelai run "fix the failing test"
zelai plan "add rate limiting" # read-only planning
zelai review                   # review the current diff
zelai agent review             # named agent
zelai models                   # list models
zelai sessions                 # list saved sessions
zelai session show <id>        # print a saved session
zelai session export <id> [f]  # export markdown
zelai session import <file>    # import session json
zelai session delete <id>      # delete a session
zelai commands                 # list custom commands
zelai mcp                      # list MCP servers and tools
zelai undo [session]           # revert the last file change
zelai compact [session]        # summarize older context
```

Inside the TUI:

- `/model [id]`, `/agent [name]`
- `/plan`, `/build`, `/review`
- `/new`, `/sessions`, `/resume <id>`
- `/undo`, `/compact`, `/commands`
- `/help`, `/quit`

Writes and shell commands can be approved once or always. Todos from the model appear above the prompt.

## Permissions

Writes and shell commands require approval by default. Configure it in `~/.config/zelai/zelai.json` or `.zelai/zelai.json`:

```json
{
  "model": "nemotron-3.5-lightning-free",
  "agent": "build",
  "instructions": ["CONTRIBUTING.md"],
  "permission": {
    "edit": "ask",
    "bash": { "git status": "allow", "git *": "ask", "rm *": "deny" },
    "task": "ask"
  }
}
```

`zelai run --yolo` auto-approves tools.

## Project files

- `AGENTS.md`, `.zelai/AGENTS.md` — project instructions
- `.zelai/zelai.json` — project config, merged over global config
- `.zelai/agent/*.md` — custom agents (frontmatter: `description`, `mode`, `tools`, `subagents`)
- `.zelai/command/*.md` — custom slash commands; `$ARGUMENTS` is replaced with the typed text
- Global equivalents live under `~/.config/zelai/`

Agents can call `task` to delegate a focused job to a subagent and `todowrite` to maintain the visible todo list. Every write/edit is snapshotted so `/undo` can revert it.

## MCP

Add Model Context Protocol servers under `mcp` in `~/.config/zelai/zelai.json` or `.zelai/zelai.json`:

```json
{
  "mcp": {
    "files": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "environment": {}
    },
    "docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

Local servers use stdio; remote servers use Streamable HTTP (JSON or SSE). Tools are exposed as `mcp__<server>__<tool>`. They follow `permission.mcp` (`allow`, `ask`, or `deny`) and default to `ask`. Failed servers are reported at startup and skipped.

## Layout

```
src/
  index.tsx       CLI entry and commands
  tui/app.tsx     OpenTUI interface
  engine.ts       streaming agent loop
  api.ts          OpenAI-compatible client with retries
  tools.ts        read/write/edit/bash/glob/grep/list/task/todowrite
  agents.ts       agent prompts, custom agents, subagents
  session.ts      local session store, export/import
  permissions.ts  allow/ask/deny rules with bash patterns
  undo.ts         file snapshots per session
  commands.ts     custom slash commands
  instructions.ts AGENTS.md loader
  compact.ts      context compaction
  mcp.ts          MCP stdio/HTTP client and tool bridge
  config.ts       config and account state
  auth.ts         device login
```
