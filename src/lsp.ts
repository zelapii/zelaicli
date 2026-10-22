import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ToolDefinition } from "./api"

export interface LspServerConfig {
  command?: string[]
  extensions?: string[]
  env?: Record<string, string>
  initialization?: Record<string, unknown>
  disabled?: boolean
  protocol?: "lsp" | "tsserver"
}

export type LspConfig = boolean | Record<string, LspServerConfig>

export interface LspServerInfo {
  name: string
  extensions: string[]
  command: string[]
  running: boolean
}

interface RpcMessage {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Diagnostic {
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  message?: string
  source?: string
  code?: string | number
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
}

function normalizeExtensions(value: string[] | undefined) {
  return (value || []).map((extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase())
}

function languageId(file: string) {
  return LANGUAGE_IDS[path.extname(file).toLowerCase()] || "plaintext"
}

function uriFor(file: string) {
  return pathToFileURL(file).href
}

function displayLocation(location: any) {
  const uri = location?.uri || location?.targetUri
  const range = location?.range || location?.targetSelectionRange || location?.targetRange
  if (!uri) return ""
  let file = uri
  try {
    file = fileURLToPath(uri)
  } catch {}
  const line = (range?.start?.line ?? 0) + 1
  const character = (range?.start?.character ?? 0) + 1
  return `${file}:${line}:${character}`
}

function hoverText(contents: any): string {
  if (!contents) return ""
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n")
  if (typeof contents.value === "string") return contents.value
  if (typeof contents.language === "string" && typeof contents.value === "string") return contents.value
  return JSON.stringify(contents)
}

class LspClient {
  readonly name: string
  readonly config: LspServerConfig
  readonly root: string
  private proc: any
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, Pending>()
  private nextId = 1
  private initialized = false
  private opening?: Promise<void>
  private diagnostics = new Map<string, Diagnostic[]>()
  private diagnosticWaiters = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>()
  private openFiles = new Map<string, { version: number; content: string }>()
  private stderr: string[] = []
  private closed = false

  constructor(name: string, config: LspServerConfig, root: string) {
    this.name = name
    this.config = config
    this.root = root
  }

  private tail() {
    return this.stderr.length ? `: ${this.stderr.slice(-3).join(" | ")}` : ""
  }

  async start() {
    if (!this.config.command?.length) throw new Error("LSP server has no command")
    this.proc = Bun.spawn(this.config.command, {
      cwd: this.root,
      env: { ...process.env, ...(this.config.env || {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.pump(this.proc.stdout)
    this.readStderr(this.proc.stderr)
    this.proc.exited.then((code: number) => {
      if (this.closed) return
      this.failAll(new Error(`LSP ${this.name} exited with code ${code}${this.tail()}`))
    })
    const rootUri = uriFor(this.root)
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "zelai", version: "0.1.0" },
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
          publishDiagnostics: { relatedInformation: true },
          diagnostic: {},
        },
      },
      initializationOptions: this.config.initialization || {},
    })
    this.notify("initialized", {})
    this.initialized = true
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
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

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer = Buffer.concat([this.buffer, Buffer.from(value)])
        this.drain()
      }
    } catch {}
  }

  private drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString("utf8")
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      if (this.buffer.length < headerEnd + 4 + length) return
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")
      this.buffer = this.buffer.subarray(headerEnd + 4 + length)
      try {
        this.handle(JSON.parse(body))
      } catch {}
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
      let result: any = null
      if (message.method === "workspace/configuration") {
        result = (message.params?.items || []).map(() => null)
      } else if (message.method === "workspace/workspaceFolders") {
        result = [{ uri: uriFor(this.root), name: path.basename(this.root) }]
      } else if (message.method === "client/registerCapability" || message.method === "window/workDoneProgress/create") {
        result = null
      }
      if (result === null && !["workspace/configuration", "client/registerCapability", "window/workDoneProgress/create"].includes(message.method)) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported method ${message.method}` } })
        return
      }
      this.send({ jsonrpc: "2.0", id: message.id, result })
      return
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const uri = String(message.params?.uri || "")
      const diagnostics: Diagnostic[] = Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : []
      this.diagnostics.set(uri, diagnostics)
      const waiter = this.diagnosticWaiters.get(uri)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.diagnosticWaiters.delete(uri)
        waiter.resolve()
      }
    }
  }

  private send(payload: RpcMessage) {
    if (!this.proc || this.closed) throw new Error(`LSP ${this.name} is not running`)
    const body = Buffer.from(JSON.stringify(payload), "utf8")
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.proc.stdin.write(body)
    this.proc.stdin.flush?.()
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private request(method: string, params: unknown, timeout = 15_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP ${this.name} timed out on ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async sync(file: string) {
    const uri = uriFor(file)
    const content = await fs.readFile(file, "utf8")
    const current = this.openFiles.get(uri)
    if (!current) {
      this.openFiles.set(uri, { version: 1, content })
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(file), version: 1, text: content },
      })
      return true
    }
    if (current.content === content) return false
    current.version += 1
    current.content = content
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: current.version },
      contentChanges: [{ text: content }],
    })
    return true
  }

  private waitDiagnostics(uri: string, timeout = 5_000) {
    return new Promise<void>((resolve) => {
      const existing = this.diagnosticWaiters.get(uri)
      if (existing) clearTimeout(existing.timer)
      const timer = setTimeout(() => {
        this.diagnosticWaiters.delete(uri)
        resolve()
      }, timeout)
      this.diagnosticWaiters.set(uri, { resolve, timer })
    })
  }

  async diagnosticsFor(file: string) {
    await this.ensureStarted()
    const uri = uriFor(file)
    const waiter = this.waitDiagnostics(uri)
    const changed = await this.sync(file)
    const existing = this.diagnostics.get(uri)
    if (!changed && existing) {
      const pending = this.diagnosticWaiters.get(uri)
      if (pending) {
        clearTimeout(pending.timer)
        this.diagnosticWaiters.delete(uri)
      }
      return existing
    }
    await waiter
    return this.diagnostics.get(uri) || []
  }

  async definition(file: string, line: number, character: number) {
    await this.ensureStarted()
    await this.sync(file)
    return this.request("textDocument/definition", {
      textDocument: { uri: uriFor(file) },
      position: { line: line - 1, character: character - 1 },
    })
  }

  async references(file: string, line: number, character: number) {
    await this.ensureStarted()
    await this.sync(file)
    return this.request("textDocument/references", {
      textDocument: { uri: uriFor(file) },
      position: { line: line - 1, character: character - 1 },
      context: { includeDeclaration: true },
    })
  }

  async hover(file: string, line: number, character: number) {
    await this.ensureStarted()
    await this.sync(file)
    return this.request("textDocument/hover", {
      textDocument: { uri: uriFor(file) },
      position: { line: line - 1, character: character - 1 },
    })
  }

  private ensureStarted() {
    if (this.initialized) return Promise.resolve()
    if (!this.opening) {
      this.opening = this.start().catch((error) => {
        this.opening = undefined
        throw error
      })
    }
    return this.opening
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
    this.failAll(new Error(`LSP ${this.name} closed`))
    try {
      this.proc?.kill()
    } catch {}
  }
}

interface LanguageClient {
  readonly name: string
  diagnosticsFor(file: string): Promise<Diagnostic[]>
  definition(file: string, line: number, character: number): Promise<any>
  references(file: string, line: number, character: number): Promise<any>
  hover(file: string, line: number, character: number): Promise<any>
  close(): Promise<void>
}

interface TsPending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class TsServerClient implements LanguageClient {
  readonly name: string
  private config: LspServerConfig
  private root: string
  private proc: any
  private buffer = ""
  private pending = new Map<number, TsPending>()
  private nextSeq = 1
  private openFiles = new Map<string, string>()
  private stderr: string[] = []
  private closed = false
  private starting?: Promise<void>

  constructor(name: string, config: LspServerConfig, root: string) {
    this.name = name
    this.config = config
    this.root = root
  }

  private async start() {
    if (this.proc) return
    if (!this.config.command?.length) throw new Error("tsserver has no command")
    this.proc = Bun.spawn(this.config.command, {
      cwd: this.root,
      env: { ...process.env, ...(this.config.env || {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.pump(this.proc.stdout)
    this.readStderr(this.proc.stderr)
    this.proc.exited.then((code: number) => {
      if (!this.closed) this.failAll(new Error(`tsserver exited with code ${code}:${this.stderr.slice(-2).join(" | ")}`))
    })
  }

  private async ready() {
    if (!this.starting) this.starting = this.start()
    await this.starting
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (line.trim()) this.stderr.push(line.trim())
        }
        if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20)
      }
    } catch {}
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let index = this.buffer.indexOf("\n")
        while (index !== -1) {
          const line = this.buffer.slice(0, index).trim()
          this.buffer = this.buffer.slice(index + 1)
          if (line) {
            try {
              this.handle(JSON.parse(line))
            } catch {}
          }
          index = this.buffer.indexOf("\n")
        }
      }
    } catch {}
  }

  private handle(message: any) {
    if (message.type !== "response") return
    const pending = this.pending.get(Number(message.request_seq))
    if (!pending) return
    this.pending.delete(Number(message.request_seq))
    clearTimeout(pending.timer)
    if (message.success === false) {
      pending.reject(new Error(message.message || `tsserver ${message.command} failed`))
    } else {
      pending.resolve(message.body)
    }
  }

  private send(payload: unknown) {
    if (!this.proc || this.closed) throw new Error("tsserver is not running")
    this.proc.stdin.write(JSON.stringify(payload) + "\n")
    this.proc.stdin.flush?.()
  }

  private call(command: string, args: Record<string, unknown>, timeout = 15_000): Promise<any> {
    const seq = this.nextSeq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`tsserver timed out on ${command}`))
      }, timeout)
      this.pending.set(seq, { resolve, reject, timer })
      try {
        this.send({ seq, type: "request", command, arguments: args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(seq)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async prepare(file: string) {
    await this.ready()
    const content = await fs.readFile(file, "utf8")
    const previous = this.openFiles.get(file)
    if (previous === content) return
    if (previous !== undefined) {
      await this.call("close", { file }).catch(() => {})
      this.openFiles.delete(file)
    }
    await this.call("open", { file, projectRootPath: this.root })
    this.openFiles.set(file, content)
  }

  private range(start: any, end: any) {
    return {
      start: { line: Math.max(0, (start?.line || 1) - 1), character: Math.max(0, (start?.offset || 1) - 1) },
      end: { line: Math.max(0, (end?.line || 1) - 1), character: Math.max(0, (end?.offset || 1) - 1) },
    }
  }

  private diagnostic(entry: any): Diagnostic {
    return {
      range: this.range(entry.start, entry.end),
      severity: 1,
      message: entry.text || entry.message || "",
      source: "typescript",
      code: entry.code,
    }
  }

  async diagnosticsFor(file: string) {
    await this.prepare(file)
    const [syntactic, semantic, suggestion] = await Promise.all([
      this.call("syntacticDiagnosticsSync", { file }).catch(() => []),
      this.call("semanticDiagnosticsSync", { file }).catch(() => []),
      this.call("suggestionDiagnosticsSync", { file }).catch(() => []),
    ])
    return [...(syntactic || []), ...(semantic || []), ...(suggestion || [])].map((entry: any) => this.diagnostic(entry))
  }

  async definition(file: string, line: number, character: number) {
    await this.prepare(file)
    const body = (await this.call("definition", { file, line, offset: character })) || []
    return (Array.isArray(body) ? body : [body]).map((entry: any) => ({
      uri: pathToFileURL(entry.file).href,
      range: this.range(entry.start, entry.end),
    }))
  }

  async references(file: string, line: number, character: number) {
    await this.prepare(file)
    const body = (await this.call("references", { file, line, offset: character })) || []
    return (Array.isArray(body) ? body : [body]).map((entry: any) => ({
      uri: pathToFileURL(entry.file).href,
      range: this.range(entry.start, entry.end),
    }))
  }

  async hover(file: string, line: number, character: number) {
    await this.prepare(file)
    const body = await this.call("quickinfo", { file, line, offset: character })
    if (!body) return undefined
    const documentation = Array.isArray(body.documentation)
      ? body.documentation.map((entry: any) => entry.text || "").join("\n")
      : body.documentation?.text || body.documentation || ""
    const value = [body.displayString, documentation].filter(Boolean).join("\n\n")
    return { contents: { kind: "markdown", value } }
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
    this.failAll(new Error("tsserver closed"))
    try {
      this.proc?.kill()
    } catch {}
  }
}

function commandExists(command: string) {
  return Bun.which(command) || undefined
}

async function findTypeScriptServer(cwd: string) {
  const candidates = [
    path.join(cwd, "node_modules", "typescript", "lib", "tsserver.js"),
    path.join(cwd, "node_modules", "typescript", "lib", "typescript.js"),
  ]
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate
  }
  try {
    return Bun.resolveSync("typescript/lib/tsserver.js", cwd)
  } catch {
    return undefined
  }
}

async function builtinServers(cwd: string): Promise<Record<string, LspServerConfig>> {
  const servers: Record<string, LspServerConfig> = {}
  const node = commandExists("node") || process.execPath
  const typescript = await findTypeScriptServer(cwd)
  const tsLanguageServer =
    commandExists("typescript-language-server") ||
    (await fs.stat(path.join(cwd, "node_modules", ".bin", "typescript-language-server")).then(() => path.join(cwd, "node_modules", ".bin", "typescript-language-server")).catch(() => undefined))
  if (tsLanguageServer) {
    servers.typescript = {
      command: [tsLanguageServer, "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    }
  } else if (typescript) {
    servers.typescript = {
      command: [node, typescript, "--stdio", "--disableAutomaticTypingAcquisition"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      protocol: "tsserver",
    }
  }
  const add = (name: string, binary: string, extensions: string[], args: string[] = ["--stdio"]) => {
    const command = commandExists(binary)
    if (command) servers[name] = { command: [command, ...args], extensions }
  }
  add("gopls", "gopls", [".go"], [])
  add("rust", "rust-analyzer", [".rs"], [])
  add("pyright", "pyright-langserver", [".py", ".pyi"], ["--stdio"])
  add("clangd", "clangd", [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"], [])
  add("bash", "bash-language-server", [".sh", ".bash", ".zsh"], ["start"])
  add("lua", "lua-language-server", [".lua"], [])
  return servers
}

interface ServerEntry {
  name: string
  config: LspServerConfig
  extensions: string[]
  client?: LanguageClient
}

export class LspManager {
  readonly warnings: string[] = []
  private servers: ServerEntry[] = []
  private byExtension = new Map<string, ServerEntry>()
  private cache = new Map<string, { at: number; output: string }>()
  private cwd: string

  private constructor(cwd: string) {
    this.cwd = cwd
  }

  static async create(config: LspConfig | undefined, cwd: string) {
    if (!config) return undefined
    const manager = new LspManager(cwd)
    await manager.setup(config)
    return manager.servers.length ? manager : undefined
  }

  private async setup(config: LspConfig) {
    const builtins = await builtinServers(this.cwd)
    const configured = config === true ? {} : config
    const merged: Record<string, LspServerConfig> = { ...builtins, ...configured }
    for (const [name, server] of Object.entries(merged)) {
      if (!server || server.disabled || !server.command?.length) continue
      const extensions = normalizeExtensions(server.extensions)
      if (!extensions.length) {
        this.warnings.push(`LSP ${name} has no extensions`)
        continue
      }
      const entry: ServerEntry = { name, config: server, extensions }
      this.servers.push(entry)
      for (const extension of extensions) this.byExtension.set(extension, entry)
    }
    if (!this.servers.length) this.warnings.push("No usable LSP servers configured")
  }

  private serverFor(file: string) {
    return this.byExtension.get(path.extname(file).toLowerCase())
  }

  private async clientFor(file: string) {
    const entry = this.serverFor(file)
    if (!entry) throw new Error(`No LSP server for ${path.extname(file) || "this file type"}`)
    if (!entry.client) {
      entry.client = entry.config.protocol === "tsserver"
        ? new TsServerClient(entry.name, entry.config, this.cwd)
        : new LspClient(entry.name, entry.config, this.cwd)
    }
    return entry.client
  }

  status(): LspServerInfo[] {
    return this.servers.map((server) => ({
      name: server.name,
      extensions: server.extensions,
      command: server.config.command || [],
      running: Boolean(server.client),
    }))
  }

  supports(file: string) {
    return Boolean(this.serverFor(file))
  }

  async diagnostics(file: string, options: { force?: boolean } = {}) {
    const cached = this.cache.get(file)
    if (!options.force && cached && Date.now() - cached.at < 30_000) return cached.output
    const client = await this.clientFor(file)
    const diagnostics = await client.diagnosticsFor(file)
    const output = this.format(file, diagnostics)
    this.cache.set(file, { at: Date.now(), output })
    return output
  }

  async refresh(file: string) {
    try {
      await this.diagnostics(file, { force: true })
    } catch {}
  }

  private format(file: string, diagnostics: Diagnostic[]) {
    if (!diagnostics.length) return "No diagnostics."
    const severity = ["error", "warning", "info", "hint"]
    return diagnostics
      .map((diagnostic) => {
        const line = (diagnostic.range?.start.line ?? 0) + 1
        const character = (diagnostic.range?.start.character ?? 0) + 1
        const level = severity[(diagnostic.severity || 1) - 1] || "error"
        const source = diagnostic.source ? ` [${diagnostic.source}]` : ""
        return `${file}:${line}:${character} ${level}${source}: ${diagnostic.message || ""}`
      })
      .join("\n")
  }

  async definition(file: string, line: number, character: number) {
    const client = await this.clientFor(file)
    const result = await client.definition(file, line, character)
    const locations = Array.isArray(result) ? result : result ? [result] : []
    if (!locations.length) return "No definition found."
    return locations.map(displayLocation).filter(Boolean).join("\n")
  }

  async references(file: string, line: number, character: number) {
    const client = await this.clientFor(file)
    const result = await client.references(file, line, character)
    const locations = Array.isArray(result) ? result : []
    if (!locations.length) return "No references found."
    return locations.map(displayLocation).filter(Boolean).join("\n")
  }

  async hover(file: string, line: number, character: number) {
    const client = await this.clientFor(file)
    const result = await client.hover(file, line, character)
    return hoverText(result?.contents) || "No hover information."
  }

  async close() {
    this.cache.clear()
    await Promise.all(this.servers.map((server) => server.client?.close()))
    this.servers = []
    this.byExtension.clear()
  }
}

const diagnosticsTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lsp_diagnostics",
    description: "Get language-server diagnostics (errors and warnings) for a file after it has been read or edited.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  },
}

const definitionTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lsp_definition",
    description: "Find the definition of a symbol at a 1-based line and character position.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
}

const referencesTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lsp_references",
    description: "Find references to a symbol at a 1-based line and character position.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
}

const hoverTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lsp_hover",
    description: "Get type or documentation information for a symbol at a 1-based line and character position.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
}

export const LSP_TOOLS = [diagnosticsTool, definitionTool, referencesTool, hoverTool]
