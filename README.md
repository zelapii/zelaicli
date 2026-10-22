# ZelAI CLI

Terminal coding agent for [ZelAI](https://ai.zelai.qzz.io), built with Bun, TypeScript, and OpenTUI.

ZelAI keeps the workflow people expect from a modern coding agent — an interactive TUI, plan/build/review agents, subagents, todos, permissions, undo, custom commands, sessions, and a single model gateway — while the implementation here is its own codebase.

The opencode parity roadmap and upcoming features are tracked in [FITUR.md](FITUR.md).

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
zelai session rename <id> "t" # rename a session
zelai completion zsh           # print shell completion
zelai commands                 # list custom commands
zelai skills                   # list skills
zelai themes                   # list themes
zelai plugins                  # list custom tools and hooks
zelai lsp                      # list configured LSP servers
zelai git status               # git status through the CLI
zelai git diff --staged        # staged diff
zelai git commit "message"     # commit staged changes
zelai config                    # print the effective config (secrets masked)
zelai config set theme nord     # change a config value
zelai doctor                    # check the local setup
zelai acp                      # run as an ACP agent over stdio
zelai serve --port 4096        # local HTTP/SSE server
zelai attach http://127.0.0.1:4096 "hello"  # prompt a running server
zelai mcp                      # list MCP servers and tools
zelai mcp add docs <cmd|url>   # add an MCP server to config
zelai undo [session]           # revert the last file change
zelai redo [session]           # redo the last undone change
zelai init                     # create or update AGENTS.md
zelai stats                    # session, tool, and token statistics
zelai compact [session]        # summarize older context
zelai resume                   # continue the latest session (TUI)
zelai resume <id>              # continue a specific session
zelai resume -m "next step"    # continue latest and run one prompt
zelai run --debug "hi"         # log model requests to stderr
zelai --fork -c                # fork the latest session
zelai run -f src/app.ts "review this file"
```

Inside the TUI:

- `/model [id]`, `/agent [name]`, `/plan`, `/build`, `/review`
- `/new`, `/sessions`, `/resume <id>`, `/rename <title>`, `/delete`
- `/undo`, `/redo`, `/compact`, `/details`, `/init`
- `/commands`, `/skills`, `/mcp`, `/help`, `/quit`
- `/theme [name]`, `/keybinds`, `/plugins`, `/lsp`
- `/git status|diff|log|commit`, `/status` (session + git), `/diff`, `/commit <msg>`
- `/editor` composes the prompt in `$VISUAL`/`$EDITOR`; `/export` writes the session to `~/.local/share/zelai/exports/`; `/thinking` toggles reasoning blocks
- `ctrl+p` opens the command palette (slash commands and custom commands)
- `@path` completes project files; aliases from `references` complete as `@alias/...`; Tab inserts the highlighted file
- `/` completes slash commands; Tab inserts the highlighted command
- `/model`, `/agent`, and `/sessions` open a picker (up/down, enter, esc)
- Up and down arrow walk through prompt history
- The footer shows the agent, model, and last request context tokens
- `@agent` switches agent for one prompt
- `!command` runs a shell command and adds the output to the conversation
- Tab with an empty prompt cycles primary agents

Writes and shell commands can be approved once or always. Todos from the model appear above the prompt, and `question` prompts show an inline choice dialog. Edit results include a short before/after preview, and LSP diagnostics are appended automatically when a language server is configured.

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
    "git": "ask",
    "lsp": "allow",
    "external_directory": "ask"
  }
}
```

Supported keys: `edit`, `bash`, `task`, `mcp`, `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `skill`, `git`, `lsp`, `external_directory`, and `question`. Values accept `*`/`?` wildcards, tool names (including `mcp__server__tool` and custom tools), and `{ "pattern": "allow" }` maps. `zelai run --yolo` auto-approves tools.

## Project files

- `AGENTS.md`, `.zelai/AGENTS.md` — project instructions
- `.zelai/zelai.json` — project config, merged over global config
- `.zelai/agent/*.md` — custom agents (frontmatter: `description`, `mode`, `tools`, `subagents`, `model`, `temperature`, `top_p`, `steps`, `permission`, `hidden`)
- `.zelai/command/*.md` — custom slash commands; `$ARGUMENTS` is replaced with the typed text
- `.zelai/skills/<name>/SKILL.md` — project skills loaded on demand
- `.zelai/tools/*.ts` or `.zelai/plugins/*.ts` — custom tools and lifecycle hooks
- Global equivalents live under `~/.config/zelai/`

Both config files accept JSONC (comments and trailing commas). Built-in agents are `build`, `plan`, `review`, plus `explore`, `scout`, and `general` subagents.

Agents can call `task` to delegate a focused job to a subagent and `todowrite` to maintain the visible todo list. Every write/edit is snapshotted so `/undo` and `/redo` can move file changes forward and back.

## Tools

The model can use `read`, `write`, `edit`, `bash`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `apply_patch`, `skill`, `task`, `todowrite`, `question`, `git_status`, `git_diff`, `git_log`, `git_commit`, `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, and connected MCP or custom tools. File discovery and search honor `.gitignore` and `.ignore`.

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

## Themes and keybinds

Seven themes ship with the CLI: `dark`, `light`, `catppuccin`, `gruvbox`, `matrix`, `nord`, and `tokyonight`. Set `theme` to a name or an object with palette colors, or add JSON files under `~/.config/zelai/themes` and `.zelai/themes`. `/theme` cycles at runtime and saves the choice.

Keybinds can be overridden globally or per project:

```jsonc
{
  "keybinds": {
    "app_exit": ["ctrl+c"],
    "session_interrupt": ["escape"],
    "agent_cycle": ["tab"],
    "agent_cycle_reverse": ["shift+tab"],
    "details_toggle": ["ctrl+o"],
    "command_palette": ["ctrl+p"],
    "theme_cycle": ["ctrl+t"],
    "help_show": ["f1"],
    "session_new": ["ctrl+n"]
  },
  "tui": { "mouse": true }
}
```

Set `tui.mouse` to `true` to enable mouse clicks and scrolling in the TUI (off by default).

Named roots make files outside the project addressable from the prompt:

```jsonc
{
  "references": {
    "docs": "~/notes",
    "api": "/srv/api"
  }
}
```

`@docs/design.md` attaches that file; `@docs` attaches a listing (up to 200 entries) without leaving the project.

Run `/keybinds` or `zelai --help` for the effective bindings.

## Git

Repository-aware tools call local `git` without a shell and honor `permission.git`. `git_status` and `git_diff` are read-only; `git_commit` stages nothing unless you pass `--all`. The CLI also exposes `zelai git <status|diff|log|show|commit>`.

## LSP

Set `"lsp": true` to auto-detect installed language servers, or configure them explicitly:

```jsonc
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx"]
    }
  }
}
```

When `typescript` is installed but `typescript-language-server` is not, ZelAI falls back to the bundled `tsserver` protocol. Diagnostics are also requested automatically after file edits.

## Plugins and custom tools

Drop a module in `.zelai/tools` (or list paths in `plugins`):

```ts
export default {
  name: "team",
  tools: {
    ticket: {
      description: "Look up a ticket",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: (args) => `Ticket ${args.id}: example`,
    },
  },
  hooks: {
    "tool.execute.before": (input, output) => {
      // mutate output.args before a tool runs
    },
  },
  event: async ({ event, ...payload }) => {
    // event.type is session.start, session.idle, and so on
  },
}
```

Custom tool names are exposed directly to the model. Tool hooks are `tool.execute.before` and `tool.execute.after`; the `event` export receives lifecycle events such as `session.start` and `session.idle`.

## ACP and local server

`zelai acp` speaks the Agent Client Protocol over stdio using newline-delimited JSON-RPC 2.0. It supports `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, permission requests, streaming text, tool calls, and plans. Stdout carries ACP messages only.

`zelai serve` starts a local HTTP/SSE server (default `127.0.0.1:4096`):

- `GET /health` (public), `GET /app`, `GET /doc` (OpenAPI 3.1), `GET /models`
- `GET /sessions`, `POST /sessions` with `{ "agent", "model", "title" }`
- `GET /sessions/:id`, `DELETE /sessions/:id`, `GET /sessions/:id/messages`
- `POST /sessions/:id/prompt` with SSE events and optional `autoApprove`
- `POST /sessions/:id/cancel`, `POST /permissions/:id`

Set `server.password` in `zelai.json`, pass `--password`, or export `ZELAI_SERVER_PASSWORD` to require Basic or Bearer auth on every route except `/health`. A non-loopback `--host` is refused without a password unless `--insecure` is passed. CORS is disabled by default; enable specific origins with `--cors http://localhost:3000` or allow all with `--cors "*"`.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4096,
    "password": "change-me",
    "cors": ["http://localhost:3000"]
  }
}
```

`zelai attach <url> <message>` creates a session and streams the reply. Permission prompts are answered on the terminal; non-interactive clients can pass permission decisions through the HTTP API.

The SDK is exported from `@zelapii/cli/sdk`:

```ts
import { createZelaiClient } from "@zelapii/cli/sdk"

const client = createZelaiClient({ baseUrl: "http://127.0.0.1:4096", password: "change-me" })
const { session } = await client.sessions.create({ agent: "build" })
for await (const event of client.sessions.prompt(session.id, "summarize this repo")) {
  if (event.type === "text") process.stdout.write(event.text)
  if (event.type === "permission") await client.respondPermission(event.id, false)
}
```

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
  files.ts        project file index, @references and aliases, attachments
  editor.ts       $EDITOR/$VISUAL prompt composition
  ignore.ts       .gitignore/.ignore matcher
  skills.ts       skill discovery
  formatters.ts   post-edit formatter runner
  stats.ts        local session statistics
  theme.ts        built-in and custom themes
  keybinds.ts     default keybinds and matcher
  git.ts          git status/diff/log/commit tools
  lsp.ts          LSP and tsserver clients
  plugins.ts      custom tools and hooks
  acp.ts          Agent Client Protocol server
  server.ts       HTTP/SSE server and attach client
  sdk.ts          typed client for the server API
  config.ts       config, JSONC parsing, and account state
  auth.ts         device login
```
