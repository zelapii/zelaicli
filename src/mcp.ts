import type { ToolDefinition } from "./api"
import { VERSION } from "./paths"

export interface McpServerConfig {
  type?: "local" | "remote"
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  url?: string
  headers?: Record<string, string>
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  schema: Record<string, unknown>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RpcMessage {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function sanitize(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_")
}

function isRemote(config: McpServerConfig) {
  return config.type === "remote" || (!config.command?.length && !!config.url)
}

class McpClient {
  readonly name: string
  readonly config: McpServerConfig
  readonly cwd: string
  tools: McpToolInfo[] = []
  private proc: any
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ""
  private sessionId?: string
  private stderr: string[] = []
  private closed = false

  constructor(name: string, config: McpServerConfig, cwd: string) {
    this.name = name
    this.config = config
    this.cwd = cwd
  }

  async start() {
    if (isRemote(this.config)) {
      if (!this.config.url) throw new Error("remote MCP server has no url")
    } else {
      if (!this.config.command?.length) throw new Error("local MCP server has no command")
      this.spawn()
    }

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "zelai", version: VERSION },
    })
    await this.notify("notifications/initialized", {})
    await this.refreshTools()
  }

  private spawn() {
    this.proc = Bun.spawn(this.config.command!, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.config.environment || {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.pump(this.proc.stdout)
    this.readStderr(this.proc.stderr)
    this.proc.exited.then((code: number) => {
      if (this.closed) return
      this.failAll(new Error(`MCP server ${this.name} exited with code ${code}${this.tail()}`))
    })
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        this.drain()
      }
    } catch {
      // process shutdown
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.trim()) continue
          this.stderr.push(line.trim())
          if (this.stderr.length > 20) this.stderr.shift()
        }
      }
    } catch {}
  }

  private tail() {
    return this.stderr.length ? `: ${this.stderr.slice(-3).join(" | ")}` : ""
  }

  private drain() {
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.handle(message)
    }
  }

  private handle(message: RpcMessage) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      this.pending.delete(Number(message.id))
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      const result = message.method === "ping" ? {} : message.method === "roots/list" ? { roots: [] } : undefined
      this.send(
        result
          ? { jsonrpc: "2.0", id: message.id, result }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } },
      ).catch(() => {})
    }
  }

  private async send(payload: RpcMessage) {
    const line = JSON.stringify(payload) + "\n"
    this.proc.stdin.write(line)
    await this.proc.stdin.flush?.()
  }

  private async request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const payload: RpcMessage = { jsonrpc: "2.0", id: this.nextId++, method, params }
    if (isRemote(this.config)) return this.post(payload, timeout)

    if (!this.proc) throw new Error("MCP server is not running")
    return new Promise((resolve, reject) => {
      const id = Number(payload.id)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.name} timed out on ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send(payload).catch((error) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  private async notify(method: string, params: unknown) {
    const payload: RpcMessage = { jsonrpc: "2.0", method, params }
    if (isRemote(this.config)) {
      await this.post(payload, 10_000, true)
      return
    }
    await this.send(payload)
  }

  private async post(payload: RpcMessage, timeout: number, notification = false): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.config.headers || {}),
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    const response = await fetch(this.config.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    })
    const session = response.headers.get("mcp-session-id")
    if (session) this.sessionId = session

    if (notification) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) throw new Error(await response.text())

    const type = response.headers.get("content-type") || ""
    if (type.includes("text/event-stream")) {
      const text = (await response.text()).replace(/\r\n/g, "\n")
      for (const block of text.split("\n\n")) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        try {
          const message = JSON.parse(data) as RpcMessage
          if (message.id !== undefined && String(message.id) === String(payload.id)) {
            if (message.error) throw new Error(message.error.message)
            return message.result
          }
        } catch (error) {
          if (error instanceof Error && error.message && !/JSON/i.test(error.message)) throw error
        }
      }
      throw new Error(`MCP ${this.name} returned no response for ${payload.method}`)
    }

    const message = (await response.json()) as RpcMessage
    if (message.error) throw new Error(message.error.message)
    return message.result
  }

  private async refreshTools() {
    let cursor: string | undefined
    const tools: McpToolInfo[] = []
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {})
      for (const tool of result?.tools || []) {
        tools.push({
          server: this.name,
          name: String(tool.name),
          description: String(tool.description || ""),
          schema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
        })
      }
      cursor = result?.nextCursor
    } while (cursor)
    this.tools = tools
  }

  async call(name: string, args: unknown) {
    return this.request(
      "tools/call",
      { name, arguments: args && typeof args === "object" ? args : {} },
      120_000,
    )
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  async close() {
    this.closed = true
    this.failAll(new Error(`MCP server ${this.name} closed`))
    try {
      this.proc?.kill()
    } catch {}
  }
}

function routeName(server: string, tool: string) {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`
}

export class McpManager {
  readonly warnings: string[] = []
  private clients: McpClient[] = []
  private routes = new Map<string, { client: McpClient; tool: McpToolInfo }>()

  static async create(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
    const manager = new McpManager()
    await manager.connect(servers, cwd)
    return manager
  }

  private async connect(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
    const entries = Object.entries(servers || {}).filter(([, config]) => config?.enabled !== false)
    const clients = entries.map(([name, config]) => new McpClient(name, config, cwd))
    const results = await Promise.allSettled(clients.map((client) => client.start()))
    results.forEach((result, index) => {
      const client = clients[index]
      if (result.status === "rejected") {
        managerWarning(this, client.name, result.reason)
        client.close().catch(() => {})
        return
      }
      this.clients.push(client)
      for (const tool of client.tools) {
        this.routes.set(routeName(client.name, tool.name), { client, tool })
      }
    })
  }

  get count() {
    return this.clients.length
  }

  get toolCount() {
    return this.routes.size
  }

  summaries() {
    return this.clients.map((client) => ({
      name: client.name,
      tools: client.tools.map((tool) => tool.name),
    }))
  }

  toolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = []
    for (const [name, route] of this.routes) {
      definitions.push({
        type: "function",
        function: {
          name,
          description: `[MCP ${route.client.name}] ${route.tool.description || route.tool.name}`,
          parameters: route.tool.schema as any,
        },
      })
    }
    return definitions
  }

  async call(name: string, args: unknown): Promise<{ ok: boolean; output: string }> {
    const route = this.routes.get(name)
    if (!route) return { ok: false, output: `Unknown MCP tool: ${name}` }
    try {
      const result: any = await route.client.call(route.tool.name, args)
      const parts: string[] = []
      for (const item of result?.content || []) {
        if (item?.type === "text") parts.push(String(item.text ?? ""))
        else if (item?.type === "resource") parts.push(JSON.stringify(item.resource ?? item))
        else parts.push(`[${item?.type || "content"}]`)
      }
      if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent))
      const output = parts.join("\n").trim() || "(no output)"
      return { ok: !result?.isError, output }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  async close() {
    await Promise.all(this.clients.map((client) => client.close()))
    this.clients = []
    this.routes.clear()
  }
}

function managerWarning(manager: McpManager, name: string, reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason)
  manager.warnings.push(`${name}: ${message}`)
}

export async function createMcpManager(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
  return McpManager.create(servers, cwd)
}
