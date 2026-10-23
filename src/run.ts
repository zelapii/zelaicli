import { runTurn } from "./engine"
import type { Agent } from "./agents"
import { loadPolicies } from "./policy"
import { chatRoute } from "./modelroute"
import type { ModelPrice } from "./pricing"
import type { Config } from "./config"
import type { Session } from "./session"
import { commitRevert, saveSession } from "./session"
import { recordTurnStart } from "./undo"
import type { ApprovalRequest } from "./tools"
import type { McpManager } from "./mcp"
import type { Skill } from "./skills"
import type { PluginManager } from "./plugins"
import type { LspManager } from "./lsp"

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
  plugins?: PluginManager
  lsp?: LspManager
}

export interface RouteOptions {
  baseUrl: string
  apiKey: string
  model: string
  provider?: string
  providerHeaders?: Record<string, string>
  providerOptions?: Record<string, unknown>
  policies?: Awaited<ReturnType<typeof loadPolicies>>
  pricing?: Record<string, ModelPrice | { input: number; output: number }>
  websearch?: { provider?: string; apiKeys?: Record<string, string> }
}

export async function routeFor(config: Config, model: string): Promise<RouteOptions> {
  const route = await chatRoute(config, model)
  const policies = await loadPolicies({ config: config.policies })
  const websearch = config.websearch || {}
  const pricing: Record<string, ModelPrice | { input: number; output: number }> = {}
  for (const [name, provider] of Object.entries(config.providers || {})) {
    for (const entry of Object.values(provider.models || {})) {
      if (!entry.id || !entry.pricing) continue
      pricing[`${name}/${entry.id}`] = entry.pricing
    }
  }
  return {
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    provider: route.provider,
    providerHeaders: route.headers,
    providerOptions: route.extra,
    policies,
    pricing,
    websearch: { provider: websearch.provider, apiKeys: websearch.apiKeys },
  }
}

export async function runOnce(options: RunOptions) {
  const { config, session, agent, model, message } = options
  session.agent = agent.id
  session.model = model
  commitRevert(session)
  await recordTurnStart(session.id)
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
    const route = await routeFor(config, model)
    await runTurn({
      session,
      agent,
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      provider: route.provider,
      providerHeaders: route.providerHeaders,
      providerOptions: route.providerOptions,
      policies: route.policies,
      pricing: route.pricing,
      websearch: route.websearch,
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
      plugins: options.plugins,
      lsp: options.lsp,
      onEvent: (event) => {
        if (event.type === "text") {
          wrote = true
          if (options.json) process.stdout.write(JSON.stringify(event) + "\n")
          else process.stdout.write(event.text)
        }
        if (event.type === "reasoning" && options.json) {
          process.stdout.write(JSON.stringify(event) + "\n")
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
        if (event.type === "usage" && options.json) {
          process.stdout.write(JSON.stringify(event) + "\n")
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
