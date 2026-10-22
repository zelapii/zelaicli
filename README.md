# ZelAI CLI

Terminal coding agent for [ZelAI](https://ai.zelai.qzz.io), built with Bun, TypeScript, and OpenTUI.

ZelAI keeps the workflow people expect from a modern coding agent — an interactive TUI, plan/build/review agents, tool use, sessions, and a single model gateway — while the implementation here is its own codebase.

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
```

Inside the TUI:

- `/model [id]`, `/agent [name]`
- `/plan`, `/build`, `/review`
- `/new`, `/sessions`, `/resume <id>`
- `/help`, `/quit`

## Agents

- **build** — read, write, edit, and run commands
- **plan** — read-only investigation and plan output
- **review** — read-only review of the current change

Writes and shell commands require approval in the TUI. `zelai run --yolo` auto-approves tools.

## Layout

```
src/
  index.tsx    CLI entry and commands
  tui/app.tsx  OpenTUI interface
  engine.ts    streaming agent loop
  api.ts       OpenAI-compatible client
  tools.ts     read/write/edit/bash/glob/grep/list
  agents.ts    agent prompts and tool policies
  session.ts   local session store
  auth.ts      device login
  config.ts    config and account state
```
