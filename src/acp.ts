import path from "node:path"
import { loadAgents, findAgent } from "./agents"
import type { Config } from "./config"
import { runTurn, type EngineEvent } from "./engine"
import { loadInstructions } from "./instructions"
import { createMcpManager, type McpManager, type McpServerConfig } from "./mcp"
import { defaultModel, models } from "./models"
import { createSession, loadSession, saveSession, type Session } from "./session"
import { loadSkills } from "./skills"
import { PluginManager } from "./plugins"
import { LspManager } from "./lsp"
import { apiKey } from "./config"
import { VERSION } from "./paths"
import type { ApprovalRequest } from "./tools"
import type { Todo } from "./session"

interface Rpc {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

interface ActiveSession {
  session: Session
  cwd: string
  agent: ReturnType<typeof findAgent>
  model: string
  mcp?: McpManager
  plugins?: PluginManager
  lsp?: LspManager
  abort?: AbortController
}

interface PermissionOption {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

const TOOL_KINDS: Record<string, string> = {
  read: "read",
  glob: "read",
  grep: "read",
  list: "read",
  lsp_diagnostics: "read",
  lsp_definition: "read",
  lsp_references: "read",
  lsp_hover: "read",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  bash: "execute",
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  git_commit: "edit",
  webfetch: "fetch",
  websearch: "search",
  task: "think",
  todowrite: "think",
  skill: "read",
  question: "think",
}

export class AcpAgent {
  private config: Config
  private sessions = new Map<string, ActiveSession>()
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private nextId = 1
  private buffer = ""
  private closed = false

  constructor(config: Config) {
    this.config = config
  }

  async run() {
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    try {
      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let index = this.buffer.indexOf("\n")
        while (index !== -1) {
          const line = this.buffer.slice(0, index).trim()
          this.buffer = this.buffer.slice(index + 1)
          if (line) this.receive(line)
          index = this.buffer.indexOf("\n")
        }
      }
    } finally {
      await this.close()
    }
  }

  private send(message: Rpc) {
    process.stdout.write(JSON.stringify(message) + "\n")
  }

  private respond(id: number | string | undefined, result: unknown) {
    if (id === undefined) return
    this.send({ jsonrpc: "2.0", id, result })
  }

  private fail(id: number | string | undefined, code: number, message: string) {
    if (id === undefined) return
    this.send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  private update(sessionId: string, update: Record<string, unknown>) {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
  }

  private receive(raw: string) {
    let message: Rpc
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      this.pending.delete(Number(message.id))
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method && message.id === undefined) {
      if (message.method === "session/cancel") {
        const id = String(message.params?.sessionId || "")
        this.sessions.get(id)?.abort?.abort()
      }
      return
    }
    if (message.method) {
      this.handle(message).catch((error) => {
        this.fail(message.id, -32603, error instanceof Error ? error.message : String(error))
      })
    }
  }

  private async handle(message: Rpc) {
    switch (message.method) {
      case "initialize":
        this.respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
          },
          agentInfo: { name: "zelai", title: "ZelAI", version: VERSION },
          authMethods: [],
        })
        return
      case "authenticate":
        this.respond(message.id, {})
        return
      case "session/new":
        await this.newSession(message)
        return
      case "session/load":
        await this.loadExisting(message)
        return
      case "session/prompt":
        await this.prompt(message)
        return
      case "session/set_mode":
        await this.setMode(message)
        return
      case "logout":
        this.respond(message.id, {})
        return
      default:
        this.fail(message.id, -32601, `Method not found: ${message.method}`)
    }
  }

  private async newSession(message: Rpc) {
    const cwd = path.resolve(String(message.params?.cwd || process.cwd()))
    const catalog = await models(this.config.baseUrl).catch(() => [])
    const model = this.config.model || defaultModel(catalog) || "deepseek-chat"
    const agents = await loadAgents(cwd)
    const agent = findAgent(this.config.agent || "build", agents)
    const session = createSession(agent.id, model)
    const active: ActiveSession = { session, cwd, agent, model }
    await this.attach(active, message.params?.mcpServers)
    this.sessions.set(session.id, active)
    await saveSession(session)
    this.respond(message.id, { sessionId: session.id })
    this.update(session.id, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "help", description: "Show ZelAI help" },
        { name: "compact", description: "Compact session context" },
      ],
    })
  }

  private async loadExisting(message: Rpc) {
    const sessionId = String(message.params?.sessionId || "")
    const session = await loadSession(sessionId)
    if (!session) {
      this.fail(message.id, -32000, `Session not found: ${sessionId}`)
      return
    }
    const cwd = path.resolve(String(message.params?.cwd || process.cwd()))
    const agents = await loadAgents(cwd)
    const active: ActiveSession = {
      session,
      cwd,
      agent: findAgent(session.agent, agents),
      model: session.model || this.config.model || "deepseek-chat",
    }
    await this.attach(active, message.params?.mcpServers)
    this.sessions.set(session.id, active)
    for (const entry of session.messages) {
      if (entry.role === "user" && entry.content) {
        this.update(session.id, {
          sessionUpdate: "user_message_chunk",
          messageId: `replay_${entry.role}_${Date.now()}`,
          content: { type: "text", text: entry.content },
        })
      }
      if (entry.role === "assistant" && entry.content) {
        this.update(session.id, {
          sessionUpdate: "agent_message_chunk",
          messageId: `replay_${entry.role}_${Date.now()}`,
          content: { type: "text", text: entry.content },
        })
      }
    }
    this.respond(message.id, {})
  }

  private async attach(active: ActiveSession, servers: any[] | undefined) {
    const mcpConfig: Record<string, McpServerConfig> = { ...(this.config.mcp || {}) }
    for (const server of servers || []) {
      const name = String(server?.name || "")
      if (!name) continue
      if (server?.command) {
        mcpConfig[name] = {
          type: "local",
          command: [String(server.command), ...(server.args || [])],
          environment: Object.fromEntries((server.env || []).map((entry: any) => [entry.name, entry.value])),
        }
      } else if (server?.url) {
        mcpConfig[name] = {
          type: "remote",
          url: String(server.url),
          headers: Object.fromEntries((server.headers || []).map((entry: any) => [entry.name, entry.value])),
        }
      }
    }
    active.mcp = await createMcpManager(mcpConfig, active.cwd)
    active.plugins = await PluginManager.create(active.cwd, this.config)
    active.lsp = await LspManager.create(this.config.lsp, active.cwd)
  }

  private async setMode(message: Rpc) {
    const active = this.sessions.get(String(message.params?.sessionId || ""))
    if (!active) {
      this.fail(message.id, -32000, "Session not found")
      return
    }
    const mode = String(message.params?.modeId || "build")
    active.agent = findAgent(mode, await loadAgents(active.cwd))
    active.session.agent = active.agent.id
    await saveSession(active.session)
    this.respond(message.id, {})
  }

  private async prompt(message: Rpc) {
    const active = this.sessions.get(String(message.params?.sessionId || ""))
    if (!active) {
      this.fail(message.id, -32000, "Session not found")
      return
    }
    if (!apiKey(this.config)) {
      this.fail(message.id, -32000, "Not logged in. Run zelai auth login")
      return
    }
    const text = this.promptText(message.params?.prompt)
    if (!text.trim()) {
      this.fail(message.id, -32602, "Prompt is empty")
      return
    }
    active.session.messages.push({ role: "user", content: text })
    this.update(active.session.id, {
      sessionUpdate: "user_message_chunk",
      messageId: `user_${Date.now()}`,
      content: { type: "text", text },
    })
    await saveSession(active.session)

    const controller = new AbortController()
    active.abort = controller
    const messageId = `agent_${Date.now()}`
    let failed: string | undefined
    try {
      await runTurn({
        session: active.session,
        agent: active.agent,
        baseUrl: this.config.baseUrl,
        apiKey: apiKey(this.config)!,
        model: active.model,
        cwd: active.cwd,
        instructions: await loadInstructions(active.cwd, this.config),
        permission: this.config.permission,
        always: new Set(),
        approve: (request) => this.requestPermission(active, request),
        autoApprove: false,
        agents: await loadAgents(active.cwd),
        mcp: active.mcp,
        skills: await loadSkills(active.cwd),
        formatter: this.config.formatter,
        plugins: active.plugins,
        lsp: active.lsp,
        signal: controller.signal,
        onPersist: () => saveSession(active.session),
        askQuestion: async () => "(interactive questions are not available in ACP mode)",
        onEvent: (event) => this.emit(active.session.id, messageId, event),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!/cancel/i.test(reason)) {
        failed = reason
        this.update(active.session.id, {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: `\n[error] ${reason}` },
        })
      }
    } finally {
      active.abort = undefined
      await saveSession(active.session)
    }
    if (controller.signal.aborted) this.respond(message.id, { stopReason: "cancelled" })
    else if (failed) this.fail(message.id, -32603, failed)
    else this.respond(message.id, { stopReason: "end_turn" })
  }

  private promptText(prompt: any): string {
    if (!Array.isArray(prompt)) return ""
    const parts: string[] = []
    for (const block of prompt) {
      if (block?.type === "text") parts.push(String(block.text || ""))
      else if (block?.type === "resource" && typeof block.resource?.text === "string") {
        parts.push(`File: ${block.resource.uri || "resource"}\n\`\`\`\n${block.resource.text}\n\`\`\``)
      } else if (block?.type === "resource_link") {
        parts.push(`Resource: ${block.uri || ""}`)
      }
    }
    return parts.join("\n\n")
  }

  private emit(sessionId: string, messageId: string, event: EngineEvent) {
    if (event.type === "text") {
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: event.text },
      })
      return
    }
    if (event.type === "tool_start") {
      let rawInput: unknown = {}
      try {
        rawInput = JSON.parse(event.args)
      } catch {}
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title: event.name,
        kind: TOOL_KINDS[event.name] || "other",
        status: "pending",
        rawInput,
      })
      return
    }
    if (event.type === "tool_end") {
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        status: event.ok ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: event.output.slice(0, 20_000) } }],
      })
      return
    }
    if (event.type === "todos") {
      this.update(sessionId, {
        sessionUpdate: "plan",
        entries: event.todos.map((todo: Todo) => ({
          content: todo.content,
          priority: todo.priority || "medium",
          status: todo.status,
        })),
      })
      return
    }
    if (event.type === "error") {
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `\n[error] ${event.message}` },
      })
    }
  }

  private async requestPermission(active: ActiveSession, request: ApprovalRequest): Promise<boolean> {
    const id = this.nextId++
    const options: PermissionOption[] = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ]
    const result = await new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
          sessionId: active.session.id,
          toolCall: {
            toolCallId: `permission_${id}`,
            title: request.title,
            kind: request.kind === "bash" ? "execute" : request.kind === "edit" || request.kind === "write" ? "edit" : "other",
            status: "pending",
            content: [{ type: "content", content: { type: "text", text: request.detail.slice(0, 4000) } }],
          },
          options,
        },
      })
    }).catch(() => undefined)
    const option = result?.outcome?.optionId || result?.outcome?.option
    return option === "allow_once" || option === "allow_always"
  }

  async close() {
    this.closed = true
    for (const active of this.sessions.values()) {
      active.abort?.abort()
      await active.mcp?.close()
      await active.lsp?.close()
    }
    this.sessions.clear()
  }
}

export async function runAcp(config: Config) {
  await new AcpAgent(config).run()
}
