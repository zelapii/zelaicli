import { runTurn } from "./engine"
import type { Agent } from "./agents"
import type { Config } from "./config"
import type { Session } from "./session"
import { saveSession } from "./session"
import type { ApprovalRequest } from "./tools"
import type { McpManager } from "./mcp"
import type { Skill } from "./skills"

export interface RunOptions {
  config: Config
  session: Session
  agent: Agent
  model: string
  message: string
  json: boolean
  yolo: boolean
  cwd: string
  instructions?: string
  agents?: Agent[]
  mcp?: McpManager
  skills?: Skill[]
}

export async function runOnce(options: RunOptions) {
  const { config, session, agent, model, message } = options
  session.agent = agent.id
  session.model = model
  session.messages.push({ role: "user", content: message })
  await saveSession(session)

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ type: "session", sessionID: session.id, agent: agent.id, model }) + "\n",
    )
  }

  let wrote = false
  const approve = async (request: ApprovalRequest) => {
    if (options.yolo) return true
    process.stderr.write(`\n[approval required] ${request.title}\n${request.detail.slice(0, 400)}\n`)
    process.stderr.write("[denied] non-interactive run; re-run with --yolo to allow tools\n")
    return false
  }

  try {
    await runTurn({
      session,
      agent,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey!,
      model,
      cwd: options.cwd,
      approve,
      autoApprove: options.yolo,
      permission: config.permission,
      always: new Set(),
      agents: options.agents,
      instructions: options.instructions,
      mcp: options.mcp,
      skills: options.skills,
      formatter: config.formatter,
      onEvent: (event) => {
        if (event.type === "text") {
          wrote = true
          if (options.json) process.stdout.write(JSON.stringify(event) + "\n")
          else process.stdout.write(event.text)
        }
        if (event.type === "tool_start") {
          if (options.json) process.stdout.write(JSON.stringify(event) + "\n")
          else process.stderr.write(`\n[tool] ${event.name} ${event.args.slice(0, 120)}\n`)
        }
        if (event.type === "tool_end") {
          if (options.json) process.stdout.write(JSON.stringify(event) + "\n")
          else {
            const line = event.output.split("\n").slice(0, 3).join("\n")
            process.stderr.write(`[${event.ok ? "ok" : "failed"}] ${line}\n`)
          }
        }
        if (event.type === "error") {
          if (options.json) process.stdout.write(JSON.stringify(event) + "\n")
          else process.stderr.write(`\n[error] ${event.message}\n`)
        }
      },
      onPersist: () => saveSession(session),
    })
    if (!options.json && wrote) process.stdout.write("\n")
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!options.json) process.stderr.write(`\n[error] ${message}\n`)
    else process.stdout.write(JSON.stringify({ type: "error", message }) + "\n")
    return 1
  }
}
