import path from "node:path"
import { loadAgents, findAgent } from "./agents"
import { apiKey, type Config } from "./config"
import { runTurn, type EngineEvent } from "./engine"
import { loadInstructions } from "./instructions"
import { createMcpManager, type McpManager } from "./mcp"
import { defaultModel, models } from "./models"
import { VERSION } from "./paths"
import { createSession, listSessions, loadSession, saveSession, type Session } from "./session"
import { loadSkills, type Skill } from "./skills"
import { PluginManager } from "./plugins"
import { LspManager } from "./lsp"
import type { Agent } from "./agents"
import type { ApprovalRequest } from "./tools"

export interface ServerOptions {
  host?: string
  port?: number
  cwd?: string
  cors?: boolean
}

interface Running {
  abort: AbortController
  active: boolean
}

interface PendingPermission {
  sessionId: string
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface ServerState {
  config: Config
  cwd: string
  agents: Agent[]
  skills: Skill[]
  plugins: PluginManager
  lsp?: LspManager
  mcp: McpManager
  running: Map<string, Running>
  permissions: Map<string, PendingPermission>
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  })
}

async function body<T = any>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T
  } catch {
    return undefined
  }
}

function sse(stream: ReadableStream) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

export async function startServer(config: Config, options: ServerOptions = {}) {
  if (!apiKey(config)) throw new Error("Not logged in. Run: zelai auth login")
  const cwd = path.resolve(options.cwd || process.cwd())
  const agents = await loadAgents(cwd)
  const skills = await loadSkills(cwd)
  const plugins = await PluginManager.create(cwd, config)
  const lsp = await LspManager.create(config.lsp, cwd)
  const mcp = await createMcpManager(config.mcp, cwd)
  for (const warning of [...plugins.warnings, ...(lsp?.warnings || []), ...mcp.warnings]) {
    process.stderr.write(`[server] ${warning}\n`)
  }
  const state: ServerState = {
    config,
    cwd,
    agents,
    skills,
    plugins,
    lsp,
    mcp,
    running: new Map(),
    permissions: new Map(),
  }

  const server = Bun.serve({
    hostname: options.host || "127.0.0.1",
    port: options.port ?? 4096,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers: Record<string, string> = options.cors === false ? {} : { "access-control-allow-origin": "*" }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...headers,
            "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type,authorization",
          },
        })
      }

      if (url.pathname === "/health") {
        return json({ ok: true, name: "zelai", version: VERSION }, 200, headers)
      }

      if (url.pathname === "/models" && request.method === "GET") {
        const list = await models(config.baseUrl).catch(() => [])
        return json({ models: list, default: defaultModel(list) }, 200, headers)
      }

      if (url.pathname === "/sessions" && request.method === "GET") {
        const list = await listSessions()
        return json({ sessions: list }, 200, headers)
      }

      if (url.pathname === "/sessions" && request.method === "POST") {
        const input = (await body<{ agent?: string; model?: string; title?: string }>(request)) || {}
        const agent = findAgent(input.agent || config.agent || "build", agents)
        const catalog = await models(config.baseUrl).catch(() => [])
        const model = input.model || agent.model || config.model || defaultModel(catalog) || "deepseek-chat"
        const session = createSession(agent.id, model)
        if (input.title) session.title = input.title
        await saveSession(session)
        return json({ session }, 201, headers)
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (sessionMatch && request.method === "GET") {
        const session = await loadSession(decodeURIComponent(sessionMatch[1]))
        if (!session) return json({ error: "Session not found" }, 404, headers)
        return json({ session }, 200, headers)
      }

      const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && request.method === "POST") {
        const session = await loadSession(decodeURIComponent(promptMatch[1]))
        if (!session) return json({ error: "Session not found" }, 404, headers)
        const input = await body<{ message?: string; agent?: string; model?: string; autoApprove?: boolean }>(request)
        const message = String(input?.message || "").trim()
        if (!message) return json({ error: "message is required" }, 400, headers)
        if (state.running.get(session.id)?.active) return json({ error: "Session is busy" }, 409, headers)

        const agent = findAgent(input?.agent || session.agent, agents)
        const model = input?.model || session.model || agent.model || "deepseek-chat"
        const abort = new AbortController()
        state.running.set(session.id, { abort, active: true })

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            const write = (event: Record<string, unknown>) => {
              if (closed) return
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              } catch {
                closed = true
              }
            }
            const close = () => {
              if (closed) return
              closed = true
              try {
                controller.close()
              } catch {}
            }

            const emit = (event: EngineEvent) => {
              if (event.type === "text") write({ type: "text", text: event.text })
              else if (event.type === "tool_start") write({ type: "tool_start", id: event.id, name: event.name, args: event.args })
              else if (event.type === "tool_end") write({ type: "tool_end", id: event.id, name: event.name, ok: event.ok, output: event.output })
              else if (event.type === "todos") write({ type: "todos", todos: event.todos })
              else if (event.type === "error") write({ type: "error", message: event.message })
              else write({ type: event.type })
            }

            const approve = (approval: ApprovalRequest) =>
              new Promise<boolean>((resolve) => {
                if (input?.autoApprove) {
                  resolve(true)
                  return
                }
                const id = crypto.randomUUID()
                const timer = setTimeout(() => {
                  state.permissions.delete(id)
                  resolve(false)
                }, 120_000)
                state.permissions.set(id, {
                  sessionId: session.id,
                  resolve: (allow) => {
                    clearTimeout(timer)
                    state.permissions.delete(id)
                    resolve(allow)
                  },
                  timer,
                })
                write({
                  type: "permission",
                  id,
                  kind: approval.kind,
                  title: approval.title,
                  detail: approval.detail,
                })
              })

            ;(async () => {
              let failed: string | undefined
              try {
                session.messages.push({ role: "user", content: message })
                await saveSession(session)
                await runTurn({
                  session,
                  agent,
                  baseUrl: config.baseUrl,
                  apiKey: apiKey(config)!,
                  model,
                  cwd,
                  instructions: await loadInstructions(cwd, config),
                  permission: config.permission,
                  always: new Set(),
                  approve,
                  autoApprove: !!input?.autoApprove,
                  agents,
                  mcp,
                  skills,
                  formatter: config.formatter,
                  plugins,
                  lsp,
                  signal: abort.signal,
                  onPersist: () => saveSession(session),
                  askQuestion: async () => "(interactive questions are not available over HTTP)",
                  onEvent: emit,
                })
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                if (!/cancel/i.test(reason)) {
                  failed = reason
                  write({ type: "error", message: reason })
                }
              } finally {
                state.running.delete(session.id)
                for (const [id, pending] of state.permissions) {
                  if (pending.sessionId !== session.id) continue
                  clearTimeout(pending.timer)
                  pending.resolve(false)
                  state.permissions.delete(id)
                }
                await saveSession(session)
                write({ type: "done", sessionId: session.id, cancelled: abort.signal.aborted, error: failed })
                close()
              }
            })().catch((error) => {
              write({ type: "error", message: error instanceof Error ? error.message : String(error) })
              close()
            })
          },
          cancel() {
            abort.abort()
          },
        })
        return sse(stream)
      }

      const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/cancel$/)
      if (cancelMatch && request.method === "POST") {
        const id = decodeURIComponent(cancelMatch[1])
        const running = state.running.get(id)
        if (!running) return json({ ok: false, error: "Session is not running" }, 404, headers)
        running.abort.abort()
        return json({ ok: true }, 200, headers)
      }

      const permissionMatch = url.pathname.match(/^\/permissions\/([^/]+)$/)
      if (permissionMatch && request.method === "POST") {
        const id = decodeURIComponent(permissionMatch[1])
        const pending = state.permissions.get(id)
        if (!pending) return json({ ok: false, error: "Permission request not found" }, 404, headers)
        const input = await body<{ allow?: boolean }>(request)
        pending.resolve(!!input?.allow)
        return json({ ok: true }, 200, headers)
      }

      return json({ error: "Not found" }, 404, headers)
    },
  })

  process.stderr.write(`ZelAI server listening on http://${server.hostname}:${server.port}\n`)

  return {
    server,
    async close() {
      for (const running of state.running.values()) running.abort.abort()
      for (const pending of state.permissions.values()) {
        clearTimeout(pending.timer)
        pending.resolve(false)
      }
      await server.stop(true)
      await mcp.close()
      await lsp?.close()
    },
  }
}

export async function attach(url: string, message: string, options: { session?: string; agent?: string; model?: string } = {}) {
  const base = url.replace(/\/+$/, "")
  let sessionId = options.session
  if (!sessionId) {
    const created = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: options.agent, model: options.model }),
    })
    if (!created.ok) throw new Error(`Failed to create session: ${created.status} ${await created.text()}`)
    const data = (await created.json()) as { session: Session }
    sessionId = data.session.id
    process.stderr.write(`session ${sessionId}\n`)
  }

  const response = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, agent: options.agent, model: options.model }),
  })
  if (!response.ok || !response.body) throw new Error(`Prompt failed: ${response.status} ${await response.text()}`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let done: Record<string, any> | undefined
  while (true) {
    const { done: finished, value } = await reader.read()
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
      if (data) {
        const event = JSON.parse(data)
        if (event.type === "text") process.stdout.write(event.text)
        else if (event.type === "tool_start") process.stderr.write(`\n[tool] ${event.name}\n`)
        else if (event.type === "tool_end" && !event.ok) process.stderr.write(`[tool failed] ${event.name}\n`)
        else if (event.type === "error") process.stderr.write(`[error] ${event.message}\n`)
        else if (event.type === "permission") {
          const allow = await askPermission(event)
          await fetch(`${base}/permissions/${encodeURIComponent(event.id)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ allow }),
          })
        } else if (event.type === "done") done = event
      }
      index = buffer.indexOf("\n\n")
    }
  }
  if (done?.error) process.exitCode = 1
  return done
}

async function askPermission(event: Record<string, any>): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`\n[permission] ${event.title}\n${String(event.detail || "").split("\n").slice(0, 10).join("\n")}\nAllow? [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}
