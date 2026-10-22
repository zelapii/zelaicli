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
zelai agent list               # list agents
zelai agent create docs        # create a custom agent
zelai models                   # list models
zelai sessions                 # list saved sessions
zelai session show <id>        # print a saved session
zelai session export <id> [f]  # export markdown
zelai session import <file>    # import session json
zelai session delete <id>      # delete a session
zelai session fork <id> "name" # fork a session
zelai commands                 # list custom commands
zelai skills                   # list skills
zelai mcp                      # list MCP servers and tools
zelai mcp add docs <cmd|url>   # add an MCP server to config
zelai undo [session]           # revert the last file change
zelai redo [session]           # redo the last undone change
zelai init                     # create or update AGENTS.md
zelai stats                    # session and tool statistics
zelai compact [session]        # summarize older context
zelai --fork -c                # fork the latest session
zelai run -f src/app.ts "review this file"
```

Inside the TUI:

- `/model [id]`, `/agent [name]`, `/plan`, `/build`, `/review`
- `/new`, `/sessions`, `/resume <id>`, `/fork <id>`
- `/undo`, `/redo`, `/compact`, `/details`, `/init`
- `/commands`, `/skills`, `/mcp`, `/help`, `/quit`
- `@path` completes project files; Tab inserts the highlighted file
- `@agent` switches agent for one prompt
- `!command` runs a shell command and adds the output to the conversation
- Tab with an empty prompt cycles primary agents

Writes and shell commands can be approved once or always. Todos from the model appear above the prompt, and `question` prompts show an inline choice dialog.

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
    "task": "ask",
    "read": "allow",
    "webfetch": "allow",
    "websearch": "ask",
    "skill": "allow",
    "external_directory": "ask"
  }
}
```

Supported keys: `edit`, `bash`, `task`, `mcp`, `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `skill`, `external_directory`, and `question`. `zelai run --yolo` auto-approves tools.

## Project files

- `AGENTS.md`, `.zelai/AGENTS.md` — project instructions
- `.zelai/zelai.json` — project config, merged over global config
- `.zelai/agent/*.md` — custom agents (frontmatter: `description`, `mode`, `tools`, `subagents`, `model`, `temperature`, `top_p`, `steps`, `permission`, `hidden`)
- `.zelai/command/*.md` — custom slash commands; `$ARGUMENTS` is replaced with the typed text
- `.zelai/skills/<name>/SKILL.md` — project skills loaded on demand
- Global equivalents live under `~/.config/zelai/`

Both config files accept JSONC (comments and trailing commas). Built-in agents are `build`, `plan`, `review`, plus `explore`, `scout`, and `general` subagents.

Agents can call `task` to delegate a focused job to a subagent and `todowrite` to maintain the visible todo list. Every write/edit is snapshotted so `/undo` and `/redo` can move file changes forward and back.

## Tools

The model can use `read`, `write`, `edit`, `bash`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `apply_patch`, `skill`, `task`, `todowrite`, `question`, and connected MCP tools. File discovery and search honor `.gitignore` and `.ignore`.

Optional formatters run after `write`/`edit`:

```jsonc
{
  // key is a glob, value is a shell command
  "formatter": {
    "*.ts": "bunx prettier --write $FILE",
    "*.go": "gofmt -w $FILE"
  }
}
```

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
  tools.ts        read/write/edit/bash/glob/grep/list/web/apply_patch/skill/task/todowrite
  agents.ts       agent prompts, custom agents, subagents
  session.ts      local session store, export/import
  permissions.ts  allow/ask/deny rules with bash patterns
  undo.ts         file snapshots per session
  commands.ts     custom slash commands
  instructions.ts AGENTS.md loader
  compact.ts      context compaction
  mcp.ts          MCP stdio/HTTP client and tool bridge
  files.ts        project file index, @references, attachments
  ignore.ts       .gitignore/.ignore matcher
  skills.ts       skill discovery
  formatters.ts   post-edit formatter runner
  stats.ts        local session statistics
  config.ts       config, JSONC parsing, and account state
  auth.ts         device login
```
