#!/usr/bin/env bun
import { createCliRenderer, type CliRendererConfig } from "@opentui/core"
import { render } from "@opentui/solid"
import { AGENTS, findAgent } from "./agents"
import { deviceLogin, logout, whoami } from "./auth"
import { apiKey, loadAccount, loadConfig, maskKey, type Config } from "./config"
import { defaultModel, fetchModels, findModel, models } from "./models"
import { VERSION } from "./paths"
import { createSession, latestSession, loadSession } from "./session"
import { runOnce } from "./run"
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
  help: boolean
  version: boolean
}

function parse(argv: string[]): Flags {
  const flags: Flags = {
    args: [],
    continue: false,
    json: false,
    yolo: false,
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
  zelai models                   list available models
  zelai auth login               device login with your ZelAI account
  zelai auth logout              remove the saved key
  zelai auth whoami              show the current account
  zelai sessions                 list saved sessions
  zelai upgrade                  upgrade instructions

Flags:
  -m, --model <id>      model for this run
      --agent <name>    agent for this run (build, plan, review)
  -c, --continue        continue the most recent session
  -s, --session <id>    continue a specific session
      --json            stream JSON events (run only)
      --yolo            auto-approve write and shell tools
  -h, --help            show this help
  -v, --version         show version
`)
}

function agentFor(flags: Flags) {
  if (flags.command === "plan" || flags.command === "build" || flags.command === "review") {
    return findAgent(flags.command)
  }
  if (flags.agent) return findAgent(flags.agent)
  if (flags.command === "agent") {
    const name = flags.args[0]
    return findAgent(name || "build")
  }
  return findAgent("build")
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

process.stdout.on("error", (error: any) => {
  if (error?.code === "EPIPE") process.exit(0)
})
process.stderr.on("error", (error: any) => {
  if (error?.code === "EPIPE") process.exit(0)
})

async function main() {
  const flags = parse(process.argv.slice(2))
  if (flags.version) {
    process.stdout.write(`zelai ${VERSION}\n`)
    return
  }
  if (flags.help || flags.command === "help") {
    help()
    return
  }

  const config = await loadConfig()
  const command = flags.command

  if (command === "auth" || command === "login" || command === "logout" || command === "whoami") {
    const action = command === "auth" ? flags.args[0] || "whoami" : command
    if (action === "login") {
      const result = await deviceLogin(config, (info) => {
        process.stdout.write(`\nOpen this URL to approve ZelAI CLI:\n  ${info.url}\n\nCode: ${info.userCode}\nWaiting for approval...\n`)
      })
      const who = result.account?.email || result.account?.name || "your ZelAI account"
      await fetchModels(config.baseUrl).catch(() => [])
      process.stdout.write(`\nLogged in as ${who}. Key saved to ${config.baseUrl ? "~/.config/zelai/zelai.json" : ""}\n`)
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
    const sessions = await import("./session")
    const list = await sessions.listSessions()
    for (const session of list.slice(0, 30)) {
      process.stdout.write(`${session.id}  ${new Date(session.updatedAt).toISOString()}  ${session.title}\n`)
    }
    return
  }

  if (command === "upgrade") {
    process.stdout.write("Upgrade with: npm install -g @zelapii/cli\n")
    return
  }

  if (!apiKey(config)) {
    process.stderr.write("Not logged in. Run: zelai auth login\n")
    process.exit(1)
  }

  let catalog = await models(config.baseUrl)
  if (!catalog.length) catalog = await fetchModels(config.baseUrl).catch(() => [])
  const agent = agentFor(flags)
  const model = await chooseModel(config, flags, catalog)
  let message: string

  if (command === "agent") {
    flags.args.shift()
    message = flags.args.join(" ").trim()
  } else if (command === "run" || command === "plan" || command === "build" || command === "review") {
    message = flags.args.join(" ").trim()
  } else {
    message = ""
  }

  if (agent.id === "review" && !message) message = await reviewPrompt("")

  const piped = await readPipedStdin()
  if (piped) message = message ? `${message}\n\n${piped}` : piped

  const session = await resolveSession(flags, agent.id, model)
  const tty = process.stdin.isTTY && process.stdout.isTTY

  if (command === "run" || flags.json || !tty) {
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
      cwd: process.cwd(),
    })
    process.exit(code)
  }

  if (agent.id === "review" && message === "") message = await reviewPrompt("")
  if (agent.tools === "readonly" && command !== "plan" && command !== "review" && flags.command === "agent") {
    // named readonly agents still work; nothing to adjust
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    autoFocus: false,
    useMouse: false,
    targetFps: 30,
    gatherStats: false,
  } satisfies CliRendererConfig)

  await render(
    () => (
      <App
        config={config}
        session={session}
        models={catalog}
        prompt={message || undefined}
        cwd={process.cwd()}
      />
    ),
    renderer,
  )

  await new Promise<void>((resolve) => {
    if (renderer.isDestroyed) resolve()
    renderer.once("destroy", () => resolve())
  })
}

main().catch((error) => {
  process.stderr.write(`zelai: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
