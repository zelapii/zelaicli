#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createCliRenderer, type CliRendererConfig } from "@opentui/core"
import { render } from "@opentui/solid"
import { type Agent, findAgent, loadAgents } from "./agents"
import { deviceLogin, logout, whoami } from "./auth"
import { apiKey, loadAccount, loadConfig, maskKey, mergeConfig, saveConfig, type Config } from "./config"
import { loadCommands } from "./commands"
import { compactSession } from "./compact"
import { expandReferences, fileAttachments } from "./files"
import { loadInstructions } from "./instructions"
import { createMcpManager } from "./mcp"
import { defaultModel, fetchModels, findModel, models } from "./models"
import { VERSION, configPath, dataDir } from "./paths"
import { loadProjectConfig } from "./project"
import { runOnce } from "./run"
import {
  createSession,
  deleteSession,
  forkSession,
  exportMarkdown,
  importSession,
  latestSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "./session"
import { redoLast, undoLast } from "./undo"
import { loadSkills } from "./skills"
import { loadThemes } from "./theme"
import { PluginManager } from "./plugins"
import { LspManager } from "./lsp"
import { git, gitCommit, gitDiff, gitLog, gitStatus } from "./git"
import { collectStats } from "./stats"
import { App } from "./tui/app"

const COMMANDS = new Set([
  "run",
  "plan",
  "build",
  "review",
  "agent",
  "models",
  "auth",
  "login",
  "logout",
  "whoami",
  "sessions",
  "session",
  "commands",
  "mcp",
  "undo",
  "compact",
  "redo",
  "init",
  "stats",
  "skills",
  "themes",
  "plugins",
  "lsp",
  "git",
  "resume",
  "completion",
  "config",
  "doctor",
  "acp",
  "serve",
  "attach",
  "upgrade",
  "help",
])

interface Flags {
  command?: string
  args: string[]
  agent?: string
  model?: string
  session?: string
  continue: boolean
  json: boolean
  yolo: boolean
  fork: boolean
  files: string[]
  title?: string
  format?: string
  port?: number
  host?: string
  password?: string
  cors?: string
  insecure: boolean
  debug: boolean
  message?: string
  help: boolean
  version: boolean
}

function parse(argv: string[]): Flags {
  const flags: Flags = {
    args: [],
    continue: false,
    json: false,
    yolo: false,
    fork: false,
    files: [],
    insecure: false,
    debug: false,
    help: false,
    version: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--") {
      flags.args.push(...argv.slice(index + 1))
      break
    }
    if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--version" || arg === "-v") flags.version = true
    else if (arg === "--continue" || arg === "-c") flags.continue = true
    else if (arg === "--json") flags.json = true
    else if (arg === "--yolo" || arg === "--auto") flags.yolo = true
    else if (arg === "--debug") flags.debug = true
    else if (arg === "--fork") {
      flags.fork = true
      const next = argv[index + 1]
      if (next && !next.startsWith("-") && !COMMANDS.has(next)) flags.session = argv[++index]
    }
    else if ((arg === "--file" || arg === "-f") && argv[index + 1]) flags.files.push(argv[++index])
    else if (arg === "--title" && argv[index + 1]) flags.title = argv[++index]
    else if ((arg === "--message" || arg === "-m") && argv[index + 1]) flags.message = argv[++index]
    else if ((arg === "--port" || arg === "-p") && argv[index + 1]) flags.port = Number(argv[++index])
    else if (arg === "--host" && argv[index + 1]) flags.host = argv[++index]
    else if (arg === "--password" && argv[index + 1]) flags.password = argv[++index]
    else if (arg === "--cors" && argv[index + 1]) flags.cors = argv[++index]
    else if (arg === "--insecure") flags.insecure = true
    else if (arg === "--format" && argv[index + 1]) {
      flags.format = argv[++index]
      if (flags.format === "json") flags.json = true
    }
    else if ((arg === "--model" || arg === "-m") && argv[index + 1]) flags.model = argv[++index]
    else if (arg === "--agent" && argv[index + 1]) flags.agent = argv[++index]
    else if ((arg === "--session" || arg === "-s") && argv[index + 1]) flags.session = argv[++index]
    else if (!flags.command && !arg.startsWith("-") && COMMANDS.has(arg)) flags.command = arg
    else flags.args.push(arg)
  }
  return flags
}

function help() {
  process.stdout.write(`ZelAI ${VERSION}

Usage:
  zelai                          start the interactive TUI
  zelai run <message...>         run one prompt and print the answer
  zelai plan [message...]        start in plan mode (read-only)
  zelai build [message...]       start in build mode
  zelai review [message...]      review current changes
  zelai agent <name> [message]   use a named agent
  zelai agent list               list agents
  zelai agent create <name>      create a custom agent file
  zelai models                   list available models
  zelai auth login               device login with your ZelAI account
  zelai auth logout              remove the saved key
  zelai auth whoami              show the current account
  zelai sessions                 list saved sessions
  zelai session show <id>        print a session
  zelai session export <id> [f]  export a session as markdown
  zelai session import <file>    import a session json file
  zelai session delete <id>      delete a session
  zelai session fork <id> [t]    fork a session with a new title
  zelai resume [id]               continue a session (latest when omitted)
  zelai completion bash|zsh|fish  print shell completion
  zelai commands                 list custom commands
  zelai mcp                      list configured MCP servers and tools
  zelai mcp add <name> <cmd|url> add an MCP server to config
  zelai mcp remove <name>        remove an MCP server
  zelai undo [session]           revert the last file change
  zelai redo [session]           redo the last undone change
  zelai init                     create or update AGENTS.md
  zelai stats                    show local session statistics
  zelai skills                   list global and project skills
  zelai themes                   list available themes
  zelai plugins                  list custom tools and hooks
  zelai lsp                      list configured LSP servers
  zelai git <action>             status, diff, log, or commit
  zelai config [get|set|unset]   read or change configuration
  zelai doctor                   check the local setup
  zelai acp                      run as an ACP agent over stdio
  zelai serve [--port 4096]      start the local HTTP/SSE server
  zelai attach <url> <message>   send a prompt to a running server
  zelai compact [session]        summarize older session context
  zelai upgrade                  upgrade instructions

Flags:
  -m, --model <id>      model for this run
      --agent <name>    agent for this run
  -c, --continue        continue the most recent session
  -s, --session <id>    continue a specific session
      --fork [id]       fork a session before continuing
  -f, --file <path>     attach a file to the prompt
      --title <text>    set the session title
  -m, --message <text> message for --resume or --attach
      --format <fmt>    output format: text or json
  -p, --port <port>    server port (default 4096)
      --host <host>    server host (default 127.0.0.1)
      --password <pw>  server password (or ZELAI_SERVER_PASSWORD)
      --cors <list>    allowed CORS origins, comma separated, or *
      --insecure       allow a non-loopback host without a password
      --json            stream JSON events (run only)
      --debug           log model requests to stderr
      --yolo            auto-approve write and shell tools
  -h, --help            show this help
  -v, --version         show version

Project files:
  .zelai/zelai.json     project config (model, agent, permission, instructions)
  AGENTS.md             project instructions
  .zelai/agent/*.md     custom agents
  .zelai/command/*.md   custom slash commands
`)
}

const SECRET_KEYS = new Set(["apikey", "api_key", "token", "secret", "password", "authorization"])

function maskSecrets(value: any, key = ""): any {
  if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry, key))
  if (value && typeof value === "object") {
    const out: Record<string, any> = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = SECRET_KEYS.has(entryKey.toLowerCase()) ? maskSecrets(String(entryValue), entryKey) : maskSecrets(entryValue, entryKey)
    }
    return out
  }
  if (typeof value === "string" && (SECRET_KEYS.has(key.toLowerCase()) || /^zelai_[A-Za-z0-9]/.test(value))) {
    return maskKey(value)
  }
  return value
}

function agentFor(flags: Flags, agents: Agent[]) {
  if (flags.command === "plan" || flags.command === "build" || flags.command === "review") {
    return findAgent(flags.command, agents)
  }
  if (flags.agent) return findAgent(flags.agent, agents)
  if (flags.command === "agent") {
    const name = flags.args[0]
    return findAgent(name || "build", agents)
  }
  return findAgent("build", agents)
}

async function chooseModel(config: Config, flags: Flags, catalog?: Awaited<ReturnType<typeof fetchModels>>) {
  const list = catalog || (await models(config.baseUrl))
  const wanted = flags.model || config.model
  if (wanted) {
    const found = findModel(list, wanted)
    if (found) return found.id
  }
  return defaultModel(list) || wanted || "deepseek-chat"
}

async function resolveSession(flags: Flags, agent: string, model: string) {
  if (flags.session) {
    const loaded = await loadSession(flags.session)
    if (loaded) return loaded
    process.stderr.write(`Session not found: ${flags.session}\n`)
    process.exit(1)
  }
  if (flags.continue) {
    const loaded = await latestSession()
    if (loaded) return loaded
  }
  return createSession(agent, model)
}

async function readPipedStdin() {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8").trim()
}

async function reviewPrompt(message: string) {
  try {
    const diff = await new Response(Bun.spawn(["git", "diff", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout).text()
    const status = await new Response(Bun.spawn(["git", "status", "--short"], { stdout: "pipe", stderr: "ignore" }).stdout).text()
    const body = diff.trim() || status.trim()
    if (!body) return message || "Review the current repository state."
    const clipped = body.length > 30_000 ? `${body.slice(0, 30_000)}\n... [truncated]` : body
    return `${message ? `${message}\n\n` : ""}Current changes:\n\n\`\`\`diff\n${clipped}\n\`\`\``
  } catch {
    return message || "Review the current repository state."
  }
}

async function sessionCommand(action: string, args: string[]) {
  if (action === "list" || action === "ls") {
    const sessions = await listSessions()
    if (!sessions.length) {
      process.stdout.write("No sessions yet.\n")
      return
    }
    for (const session of sessions.slice(0, 30)) {
      process.stdout.write(`${session.id}  ${new Date(session.updatedAt).toISOString()}  ${session.title}\n`)
    }
    return
  }
  if (action === "show") {
    const id = args[0]
    const session = id ? await loadSession(id) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    process.stdout.write(exportMarkdown(session) + "\n")
    return
  }
  if (action === "export") {
    const id = args[0]
    const session = id ? await loadSession(id) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    const target = args[1]
    const markdown = exportMarkdown(session) + "\n"
    if (target) {
      await Bun.write(target, markdown)
      process.stdout.write(`Exported ${session.id} to ${target}\n`)
    } else process.stdout.write(markdown)
    return
  }
  if (action === "import") {
    const file = args[0]
    if (!file) {
      process.stderr.write("Usage: zelai session import <file>\n")
      process.exit(1)
    }
    const session = await importSession(file)
    process.stdout.write(`Imported ${session.id}\n`)
    return
  }
  if (action === "fork") {
    const id = args[0]
    const session = id ? await loadSession(id) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    const forked = await forkSession(session, args.slice(1).join(" ") || undefined)
    process.stdout.write(`Forked ${session.id} to ${forked.id}\n`)
    return
  }
  if (action === "rename") {
    const id = args[0]
    const title = args.slice(1).join(" ").trim()
    if (!id || !title) {
      process.stderr.write("Usage: zelai session rename <id> <title>\n")
      process.exit(1)
    }
    const session = await loadSession(id)
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    session.title = title
    await saveSession(session)
    process.stdout.write(`Renamed ${id} to ${title}\n`)
    return
  }
  if (action === "delete" || action === "rm") {
    const id = args[0]
    if (!id) {
      process.stderr.write("Usage: zelai session delete <id>\n")
      process.exit(1)
    }
    await deleteSession(id)
    process.stdout.write(`Deleted ${id}\n`)
    return
  }
  process.stderr.write(`Unknown session action: ${action}\n`)
  process.exit(1)
}

process.stdout.on("error", (error: any) => {
  if (error?.code === "EPIPE") process.exit(0)
})
process.stderr.on("error", (error: any) => {
  if (error?.code === "EPIPE") process.exit(0)
})

async function main() {
  const flags = parse(process.argv.slice(2))
  if (flags.debug) process.env.ZELAI_DEBUG = "1"
  if (flags.version) {
    process.stdout.write(`zelai ${VERSION}\n`)
    return
  }
  if (flags.help || flags.command === "help") {
    help()
    return
  }

  const cwd = process.cwd()
  let config = await loadConfig()
  config = mergeConfig(config, await loadProjectConfig(cwd))
  const agents = await loadAgents(cwd)
  const customCommands = await loadCommands(cwd)
  const instructions = await loadInstructions(cwd, config)
  const skills = await loadSkills(cwd)
  const themes = await loadThemes(cwd)
  const plugins = await PluginManager.create(cwd, config)
  for (const warning of plugins.warnings) process.stderr.write(`[plugin] ${warning}\n`)
  const command = flags.command

  if (command === "auth" || command === "login" || command === "logout" || command === "whoami") {
    const action = command === "auth" ? flags.args[0] || "whoami" : command
    if (action === "login") {
      const result = await deviceLogin(config, (info) => {
        process.stdout.write(`\nOpen this URL to approve ZelAI CLI:\n  ${info.url}\n\nCode: ${info.userCode}\nWaiting for approval...\n`)
      })
      const who = result.account?.email || result.account?.name || "your ZelAI account"
      await fetchModels(config.baseUrl).catch(() => [])
      process.stdout.write(`\nLogged in as ${who}. Key saved to ~/.config/zelai/zelai.json\n`)
      return
    }
    if (action === "logout") {
      await logout()
      process.stdout.write("Logged out. The saved API key was removed.\n")
      return
    }
    if (action === "whoami" || action === "list") {
      const result = await whoami()
      if (!result.loggedIn) {
        process.stdout.write("Not logged in. Run: zelai auth login\n")
        return
      }
      const account = await loadAccount()
      process.stdout.write(
        JSON.stringify(
          {
            account: account || null,
            baseUrl: result.config.baseUrl,
            key: maskKey(result.config.apiKey),
            valid: result.valid,
            reason: result.reason,
          },
          null,
          2,
        ) + "\n",
      )
      return
    }
    process.stderr.write(`Unknown auth action: ${action}\n`)
    process.exit(1)
  }

  if (command === "models") {
    const list = await models(config.baseUrl)
    if (!list.length) {
      process.stderr.write("Could not load the model catalog.\n")
      process.exit(1)
    }
    for (const entry of list) {
      const tags = [entry.tools ? "tools" : undefined, entry.context ? `${entry.context}` : undefined]
        .filter(Boolean)
        .join(", ")
      process.stdout.write(`${entry.id}${tags ? `  (${tags})` : ""}\n`)
    }
    return
  }

  if (command === "sessions") {
    await sessionCommand("list", flags.args)
    return
  }

  if (command === "resume") {
    const first = flags.args[0]
    const looksLikeId = !!first && /^ses_/.test(first)
    const id = looksLikeId ? first : (await latestSession())?.id
    if (!id) {
      process.stderr.write("No sessions yet.\n")
      process.exit(1)
    }
    const loaded = await loadSession(id)
    if (!loaded) {
      process.stderr.write(`Session not found: ${id}\n`)
      process.exit(1)
    }
    flags.session = loaded.id
    flags.continue = false
    if (looksLikeId) flags.args = flags.args.slice(1)
    if (!flags.agent) flags.agent = loaded.agent
    if (!flags.model) flags.model = loaded.model
    if (flags.message) flags.args = [flags.message, ...flags.args]
  }

  if (command === "session") {
    const action = flags.args[0] || "list"
    await sessionCommand(action, flags.args.slice(1))
    return
  }

  if (command === "themes") {
    const active = typeof config.theme === "string" ? config.theme : config.theme?.name || "dark"
    for (const name of Object.keys(themes).sort()) process.stdout.write(`${name === active ? "*" : " "} ${name}\n`)
    return
  }

  if (command === "plugins") {
    if (!plugins.info.length) {
      process.stdout.write("No plugins or custom tools. Add .zelai/tools/*.ts or .zelai/plugins/*.ts.\n")
      return
    }
    for (const item of plugins.info) {
      process.stdout.write(`${item.name}  ${item.file}\n`)
      if (item.tools.length) process.stdout.write(`  tools: ${item.tools.join(", ")}\n`)
      if (item.hooks.length) process.stdout.write(`  hooks: ${item.hooks.join(", ")}\n`)
    }
    return
  }

  if (command === "lsp") {
    const manager = await LspManager.create(config.lsp, cwd)
    for (const warning of manager?.warnings || []) process.stderr.write(`[lsp] ${warning}\n`)
    const status = manager?.status() || []
    if (!status.length) process.stdout.write("LSP is disabled. Set lsp to true or configure servers in zelai.json.\n")
    for (const server of status) {
      process.stdout.write(`${server.name}  ${server.extensions.join(" ")}  (${server.command.join(" ")})\n`)
    }
    await manager?.close()
    return
  }

  if (command === "git") {
    const [action = "status"] = flags.args
    let result
    if (action === "status") result = await gitStatus(cwd)
    else if (action === "diff") result = await gitDiff(cwd, flags.args.includes("--staged"))
    else if (action === "log") result = await gitLog(cwd, Number(flags.args[1]) || 10)
    else if (action === "commit") result = await gitCommit(cwd, flags.args.slice(1).join(" "), flags.args.includes("--all"))
    else if (action === "show") result = await git(cwd, ["show", "--stat", "--oneline", flags.args[1] || "HEAD"])
    else {
      process.stderr.write("Usage: zelai git <status|diff|log|show|commit> [args]\n")
      process.exit(1)
    }
    process.stdout.write(result.output + "\n")
    if (!result.ok) process.exit(1)
    return
  }

  if (command === "completion") {
    const shell = flags.args[0] || "bash"
    if (shell === "bash") {
      process.stdout.write(`_zelai() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="run plan build review agent models auth sessions session commands mcp undo redo compact init stats skills themes plugins lsp git resume config doctor completion acp serve attach upgrade help"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _zelai zelai
`)
      return
    }
    if (shell === "zsh") {
      process.stdout.write(`#compdef zelai
_zelai() {
  local -a cmds
  cmds=(run plan build review agent models auth sessions session commands mcp undo redo compact init stats skills themes plugins lsp git resume config doctor completion acp serve attach upgrade help)
  _describe 'command' cmds
}
compdef _zelai zelai
`)
      return
    }
    if (shell === "fish") {
      process.stdout.write("complete -c zelai -f -a \"run plan build review agent models auth sessions session commands mcp undo redo compact init stats skills themes plugins lsp git resume config doctor completion acp serve attach upgrade help\"\n")
      return
    }
    process.stderr.write("Usage: zelai completion bash|zsh|fish\n")
    process.exit(1)
  }

  if (command === "config") {
    const [action = "list", key, ...rest] = flags.args
    if (action === "list") {
      process.stdout.write(JSON.stringify(maskSecrets(config), null, 2) + "\n")
      return
    }
    if (!key) {
      process.stderr.write("Usage: zelai config get|set|unset <key> [value]\n")
      process.exit(1)
    }
    const pathParts = key.split(".")
    if (action === "get") {
      let current: any = config
      for (const part of pathParts) {
        if (current === undefined || current === null) break
        current = current[part]
      }
      if (current === undefined) {
        process.stderr.write(`Not set: ${key}\n`)
        process.exit(1)
      }
      const safe = maskSecrets(current, pathParts[pathParts.length - 1])
      process.stdout.write(typeof safe === "string" ? safe + "\n" : JSON.stringify(safe, null, 2) + "\n")
      return
    }
    if (action === "set") {
      const raw = rest.join(" ")
      let value: any = raw
      try {
        value = JSON.parse(raw)
      } catch {}
      let target: any = config
      for (const part of pathParts.slice(0, -1)) {
        if (typeof target[part] !== "object" || target[part] === null) target[part] = {}
        target = target[part]
      }
      target[pathParts[pathParts.length - 1]] = value
      await saveConfig(config)
      process.stdout.write(`${key} = ${typeof value === "string" ? value : JSON.stringify(value)}\n`)
      return
    }
    if (action === "unset") {
      let target: any = config
      for (const part of pathParts.slice(0, -1)) {
        if (typeof target[part] !== "object" || target[part] === null) break
        target = target[part]
      }
      if (typeof target === "object") delete target[pathParts[pathParts.length - 1]]
      await saveConfig(config)
      process.stdout.write(`Removed ${key}\n`)
      return
    }
    process.stderr.write("Usage: zelai config get|set|unset <key> [value]\n")
    process.exit(1)
  }

  if (command === "doctor") {
    const lines: string[] = []
    const file = configPath()
    lines.push(`config      ${file}`)
    const stat = await Bun.file(file).stat().catch(() => undefined)
    lines.push(`            ${stat ? `present (mode ${(stat.mode & 0o777).toString(8)})` : "missing"}`)
    lines.push(`base url    ${config.baseUrl}`)
    lines.push(`api key     ${apiKey(config) ? maskKey(apiKey(config)) : "not set (run zelai auth login)"}`)
    const catalog = await models(config.baseUrl).catch(() => [])
    lines.push(`models      ${catalog.length ? `${catalog.length} available, default ${defaultModel(catalog) || "none"}` : "unreachable"}`)
    const gitBin = Bun.which("git")
    lines.push(`git         ${gitBin ? gitBin : "not installed"}`)
    const gitRoot = gitBin ? await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined) : undefined
    if (gitRoot?.ok) lines.push(`            repo ${gitRoot.output.trim()}`)
    const lspManager = await LspManager.create(config.lsp, cwd)
    const servers = lspManager?.status() || []
    lines.push(`lsp         ${config.lsp ? (servers.length ? servers.map((server) => server.name).join(", ") : "no servers") : "disabled"}`)
    await lspManager?.close()
    const mcpManager = await createMcpManager(config.mcp, cwd)
    const mcpServers = mcpManager.summaries()
    lines.push(`mcp         ${mcpServers.length ? mcpServers.map((server) => server.name).join(", ") : "none"}`)
    await mcpManager.close()
    lines.push(`plugins     ${plugins.info.length ? plugins.info.map((item) => item.name).join(", ") : "none"}`)
    lines.push(`skills      ${skills.length ? skills.map((entry) => entry.name).join(", ") : "none"}`)
    lines.push(`data dir    ${dataDir()}`)
    process.stdout.write(lines.join("\n") + "\n")
    return
  }

  if (command === "stats") {
    const stats = await collectStats()
    process.stdout.write(`Sessions:   ${stats.sessions}
Messages:   ${stats.messages} (${stats.user} user, ${stats.assistant} assistant)
Tool calls: ${stats.toolCalls}
Characters: ${stats.characters}
Tokens:     ${stats.tokens.prompt} prompt, ${stats.tokens.completion} completion
`)
    if (stats.tools.length) process.stdout.write(`\nTools:\n${stats.tools.map((item) => `  ${item.name.padEnd(20)} ${item.count}`).join("\n")}
`)
    if (stats.models.length) process.stdout.write(`\nModels:\n${stats.models.map((item) => `  ${item.name.padEnd(32)} ${item.count}`).join("\n")}
`)
    if (stats.agents.length) process.stdout.write(`\nAgents:\n${stats.agents.map((item) => `  ${item.name.padEnd(20)} ${item.count}`).join("\n")}
`)
    return
  }

  if (command === "skills") {
    if (!skills.length) {
      process.stdout.write("No skills. Add .zelai/skills/<name>/SKILL.md.\n")
      return
    }
    for (const entry of skills) process.stdout.write(`${entry.name}  ${entry.description}  (${entry.path})\n`)
    return
  }

  if (command === "agent") {
    const action = flags.args[0]
    if (action === "list" || action === "ls") {
      for (const entry of agents) {
        process.stdout.write(`${entry.id}  [${entry.mode}]${entry.hidden ? " hidden" : ""}  ${entry.description}
`)
      }
      return
    }
    if (action === "create") {
      const name = flags.args[1]
      if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
        process.stderr.write("Usage: zelai agent create <name> [description]\n")
        process.exit(1)
      }
      const dir = join(cwd, ".zelai", "agent")
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${name}.md`)
      const description = flags.args.slice(2).join(" ") || `Custom ${name} agent`
      await Bun.write(file, `---
description: ${description}
mode: primary
---

You are the ${name} agent. Be concise and focused.
`)
      process.stdout.write(`Created ${file}
`)
      return
    }
  }

  if (command === "redo") {
    const session = flags.args[0] ? await loadSession(flags.args[0]) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    const redone = await redoLast(session.id)
    if (!redone) {
      process.stderr.write("Nothing to redo in this session.\n")
      process.exit(1)
    }
    process.stdout.write(`Redid ${redone}\n`)
    return
  }

  if (command === "commands") {
    if (!customCommands.length) {
      process.stdout.write("No custom commands. Add markdown files under .zelai/command/.\n")
      return
    }
    for (const item of customCommands) {
      process.stdout.write(`${item.name}  ${item.description}  (${item.source})\n`)
    }
    return
  }

  if (command === "undo") {
    const session = flags.args[0] ? await loadSession(flags.args[0]) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    const reverted = await undoLast(session.id)
    if (!reverted) {
      process.stderr.write("Nothing to undo in this session.\n")
      process.exit(1)
    }
    process.stdout.write(`Reverted ${reverted}\n`)
    return
  }

  if (command === "mcp" && (flags.args[0] === "add" || flags.args[0] === "remove")) {
    const action = flags.args[0]
    const name = flags.args[1]
    if (!name) {
      process.stderr.write(`Usage: zelai mcp ${action} <name> ...\n`)
      process.exit(1)
    }
    config.mcp = config.mcp || {}
    if (action === "remove") {
      delete config.mcp[name]
      await saveConfig(config)
      process.stdout.write(`Removed MCP server ${name}\n`)
      return
    }
    const target = flags.args[2]
    if (!target) {
      process.stderr.write("Usage: zelai mcp add <name> <command|url> [args...]\n")
      process.exit(1)
    }
    if (/^https?:\/\//.test(target)) {
      config.mcp[name] = { type: "remote", url: target }
    } else {
      config.mcp[name] = { type: "local", command: [target, ...flags.args.slice(3)] }
    }
    await saveConfig(config)
    process.stdout.write(`Added MCP server ${name} to ~/.config/zelai/zelai.json\n`)
    return
  }

  if (command === "mcp") {
    const mcp = await createMcpManager(config.mcp, cwd)
    for (const warning of mcp.warnings) process.stderr.write(`[mcp] ${warning}\n`)
    const summaries = mcp.summaries()
    if (!summaries.length) process.stdout.write("No MCP servers connected. Add them under mcp in zelai.json.\n")
    for (const server of summaries) {
      process.stdout.write(`${server.name}\n`)
      for (const tool of server.tools) process.stdout.write(`  mcp__${server.name}__${tool}\n`)
    }
    await mcp.close()
    return
  }

  if (command === "upgrade") {
    process.stdout.write("Upgrade with: npm install -g @zelapii/cli\n")
    return
  }

  if (command === "attach") {
    const [url, ...rest] = flags.args
    if (!url) {
      process.stderr.write("Usage: zelai attach <url> <message> [--session id]\n")
      process.exit(1)
    }
    const { attach } = await import("./server")
    await attach(url, rest.join(" ").trim(), {
      session: flags.session,
      agent: flags.agent,
      model: flags.model,
      password: flags.password ?? config.server?.password,
    })
    return
  }

  if (command === "acp") {
    const { runAcp } = await import("./acp")
    await runAcp(config)
    return
  }

  if (command === "serve") {
    const { startServer } = await import("./server")
    const cors = flags.cors
      ? flags.cors.trim() === "*"
        ? true
        : flags.cors.split(",").map((entry) => entry.trim()).filter(Boolean)
      : undefined
    const instance = await startServer(config, {
      host: flags.host,
      port: flags.port,
      cwd,
      password: flags.password,
      insecure: flags.insecure,
      cors,
    })
    const stop = async () => {
      await instance.close()
      process.exit(0)
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    await new Promise(() => {})
    return
  }

  if (!apiKey(config)) {
    process.stderr.write("Not logged in. Run: zelai auth login\n")
    process.exit(1)
  }

  let catalog = await models(config.baseUrl)
  if (!catalog.length) catalog = await fetchModels(config.baseUrl).catch(() => [])

  if (command === "compact") {
    const session = flags.args[0] ? await loadSession(flags.args[0]) : await latestSession()
    if (!session) {
      process.stderr.write("Session not found.\n")
      process.exit(1)
    }
    const model = await chooseModel(config, flags, catalog)
    const compacted = await compactSession(session, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey!,
      model,
    })
    if (!compacted) {
      process.stderr.write("Not enough history to compact.\n")
      process.exit(1)
    }
    await saveSession(session)
    process.stdout.write(`Compacted ${session.id}\n`)
    return
  }

  const mcp = await createMcpManager(config.mcp, cwd)
  for (const warning of mcp.warnings) process.stderr.write(`[mcp] ${warning}\n`)
  const lsp = await LspManager.create(config.lsp, cwd)
  for (const warning of lsp?.warnings || []) process.stderr.write(`[lsp] ${warning}\n`)

  let agent = agentFor(flags, agents)
  const model = agent.model || (await chooseModel(config, flags, catalog))
  let message: string

  if (command === "agent") {
    flags.args.shift()
    message = flags.args.join(" ").trim()
  } else if (command === "run" || command === "plan" || command === "build" || command === "review" || command === "resume") {
    message = flags.args.join(" ").trim()
  } else {
    message = ""
  }

  if (command === "init") {
    const initSession =
      flags.session || flags.continue ? await resolveSession(flags, "build", model) : await createSession("build", model)
    initSession.title = flags.title || "init"
    const code = await runOnce({
      config,
      session: initSession,
      agent: findAgent("build", agents),
      model,
      message:
        "Analyze this repository and create or update AGENTS.md with build/test commands, architecture, and coding conventions. Keep it concise and factual. Use the write tool to save it.",
      json: flags.json,
      yolo: true,
      cwd,
      instructions,
      agents,
      mcp,
      skills,
      plugins,
      lsp,
    })
    await mcp.close()
    await lsp?.close()
    process.exit(code)
  }

  if (message && (message.includes("@") || message.startsWith("@"))) {
    const expanded = await expandReferences(message, cwd, agents)
    message = expanded.text
    if (expanded.agent) agent = findAgent(expanded.agent, agents)
  }

  if (flags.files.length) {
    const attached = await fileAttachments(flags.files, cwd)
    if (attached) message = message ? `${message}

${attached}` : attached
  }

  if (agent.id === "review" && !message) message = await reviewPrompt("")

  const piped = await readPipedStdin()
  if (piped) message = message ? `${message}\n\n${piped}` : piped

  const session = await resolveSession(flags, agent.id, model)
  const tty = process.stdin.isTTY && process.stdout.isTTY

  if (command === "run" || (command === "resume" && message) || flags.json || !tty) {
    if (!message) {
      process.stderr.write("No message. Pass a prompt or pipe stdin.\n")
      process.exit(1)
    }
    const code = await runOnce({
      config,
      session,
      agent,
      model,
      message,
      json: flags.json,
      yolo: flags.yolo,
      cwd,
      instructions,
      agents,
      mcp,
      skills,
      plugins,
      lsp,
    })
    await mcp.close()
    await lsp?.close()
    process.exit(code)
  }

  if (agent.id === "review" && message === "") message = await reviewPrompt("")

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    autoFocus: false,
    useMouse: config.tui?.mouse ?? false,
    targetFps: 30,
    gatherStats: false,
  } satisfies CliRendererConfig)

  await render(
    () => (
      <App
        config={config}
        session={session}
        models={catalog}
        agents={agents}
        commands={customCommands}
        instructions={instructions}
        mcp={mcp}
        skills={skills}
        plugins={plugins}
        lsp={lsp}
        themes={themes}
        prompt={message || undefined}
        cwd={cwd}
      />
    ),
    renderer,
  )

  await new Promise<void>((resolve) => {
    if (renderer.isDestroyed) resolve()
    renderer.once("destroy", () => resolve())
  })

  await mcp.close()
  await lsp?.close()
}

main().catch((error) => {
  process.stderr.write(`zelai: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
