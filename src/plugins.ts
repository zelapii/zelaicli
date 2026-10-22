import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolDefinition } from "./api"
import type { Config } from "./config"
import { configDir } from "./paths"
import { projectRoot } from "./project"

export interface PluginToolContext {
  cwd: string
  directory: string
  worktree: string
  sessionId: string
  agent: string
  signal?: AbortSignal
}

export interface PluginTool {
  description?: string
  parameters?: Record<string, unknown>
  execute: (args: any, context: PluginToolContext) => unknown
}

interface LoadedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: PluginTool["execute"]
  source: string
}

type Hook = (input: any, output: any) => unknown | Promise<unknown>

export interface PluginModule {
  name?: string
  tools?: Record<string, PluginTool>
  hooks?: Record<string, Hook | Hook[]>
  event?: Hook
}

export interface PluginInfo {
  name: string
  file: string
  tools: string[]
  hooks: string[]
}

const TOOL_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"])

function isTool(value: any): value is PluginTool {
  return !!value && typeof value === "object" && typeof value.execute === "function"
}

function toolParameters(value: PluginTool) {
  return value.parameters && typeof value.parameters === "object"
    ? value.parameters
    : { type: "object", properties: {} }
}

function normalizeResult(value: unknown) {
  if (value && typeof value === "object") {
    const object = value as any
    if (typeof object.output === "string") return { ok: object.ok !== false, output: object.output }
    if (typeof object.text === "string") return { ok: object.ok !== false, output: object.text }
    return { ok: true, output: JSON.stringify(value, null, 2) }
  }
  return { ok: true, output: value === undefined ? "(no output)" : String(value) }
}

async function loadModule(file: string) {
  const stat = await fs.stat(file)
  return import(`${pathToFileURL(file).href}?v=${stat.mtimeMs}`)
}

export class PluginManager {
  readonly warnings: string[] = []
  readonly info: PluginInfo[] = []
  private tools = new Map<string, LoadedTool>()
  private hooks = new Map<string, Hook[]>()
  private cwd: string

  private constructor(cwd: string) {
    this.cwd = cwd
  }

  static async create(cwd: string, config?: Config) {
    const manager = new PluginManager(cwd)
    await manager.load(config)
    return manager
  }

  private async load(config?: Config) {
    const root = await projectRoot(this.cwd)
    const dirs = [
      path.join(configDir(), "tool"),
      path.join(configDir(), "tools"),
      path.join(configDir(), "plugin"),
      path.join(configDir(), "plugins"),
      path.join(root, ".zelai", "tool"),
      path.join(root, ".zelai", "tools"),
      path.join(root, ".zelai", "plugin"),
      path.join(root, ".zelai", "plugins"),
    ]
    for (const dir of dirs) await this.loadDir(dir)

    for (const entry of config?.plugins || []) {
      const target = path.isAbsolute(entry) ? entry : path.resolve(root, entry)
      const stat = await fs.stat(target).catch(() => undefined)
      if (stat?.isFile()) {
        await this.loadFile(target)
        continue
      }
      if (stat?.isDirectory()) {
        await this.loadDir(target)
        continue
      }
      try {
        const module = await import(entry)
        await this.register(module, entry, path.basename(entry))
      } catch (error) {
        this.warnings.push(`plugin ${entry}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  private async loadDir(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !TOOL_EXTENSIONS.has(path.extname(entry.name))) continue
      await this.loadFile(path.join(directory, entry.name))
    }
  }

  private async loadFile(file: string) {
    try {
      const module = await loadModule(file)
      await this.register(module, file, path.basename(file, path.extname(file)))
    } catch (error) {
      this.warnings.push(`plugin ${path.basename(file)}: ${error instanceof Error ? error.message : error}`)
    }
  }

  private async register(module: any, file: string, fallbackName: string) {
    let value = module?.default ?? module
    const name = String(value?.name || fallbackName)

    if (typeof value === "function") {
      value = await value({
        cwd: this.cwd,
        directory: this.cwd,
        worktree: this.cwd,
        $: Bun.$,
      })
    }

    const toolNames: string[] = []
    const hookNames: string[] = []
    const addTool = (toolName: string, tool: PluginTool) => {
      if (!isTool(tool)) return
      this.tools.set(toolName, {
        name: toolName,
        description: tool.description || `Custom tool ${toolName}`,
        parameters: toolParameters(tool),
        execute: tool.execute,
        source: file,
      })
      toolNames.push(toolName)
    }
    const addHooks = (hooks: Record<string, Hook | Hook[]> | undefined) => {
      for (const [event, handler] of Object.entries(hooks || {})) {
        const list = Array.isArray(handler) ? handler : [handler]
        const existing = this.hooks.get(event) || []
        this.hooks.set(event, [...existing, ...list.filter((item) => typeof item === "function")])
        if (!hookNames.includes(event)) hookNames.push(event)
      }
    }

    if (value && typeof value === "object") {
      if (isTool(value)) addTool(fallbackName, value)
      if (value.tools && typeof value.tools === "object") {
        for (const [toolName, tool] of Object.entries(value.tools)) addTool(toolName, tool as PluginTool)
      }
      if (value.hooks && typeof value.hooks === "object") addHooks(value.hooks)
      if (typeof value.event === "function") addHooks({ event: value.event })
    }

    for (const [key, exported] of Object.entries(module || {})) {
      if (key === "default") continue
      if (key === "tools" && exported && typeof exported === "object") {
        for (const [toolName, tool] of Object.entries(exported)) addTool(toolName, tool as PluginTool)
        continue
      }
      if (key === "hooks" && exported && typeof exported === "object") {
        addHooks(exported as Record<string, Hook>)
        continue
      }
      if (key.includes(".") && typeof exported === "function") {
        addHooks({ [key]: exported as Hook })
        continue
      }
      if (isTool(exported)) addTool(`${fallbackName}_${key}`, exported)
    }

    if (toolNames.length || hookNames.length) {
      this.info.push({ name, file, tools: toolNames, hooks: hookNames })
    }
  }

  toolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }

  has(name: string) {
    return this.tools.has(name)
  }

  async execute(name: string, args: unknown, context: PluginToolContext) {
    const tool = this.tools.get(name)
    if (!tool) return { ok: false, output: `Unknown custom tool: ${name}` }
    try {
      return normalizeResult(await tool.execute(args, context))
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  async before(name: string, args: any) {
    const output: { args: any } = { args }
    for (const hook of this.hooks.get("tool.execute.before") || []) {
      await hook({ tool: name }, output)
    }
    return output.args
  }

  async after(name: string, args: any, result: { ok: boolean; output: string }) {
    const output: any = { ...result }
    for (const hook of this.hooks.get("tool.execute.after") || []) {
      await hook({ tool: name, args }, output)
    }
    return { ok: output.ok !== false, output: typeof output.output === "string" ? output.output : String(output.output) }
  }

  async event(type: string, payload: unknown) {
    const output: any = { ...(payload as any) }
    for (const hook of this.hooks.get("event") || []) {
      await hook({ event: { type, ...(payload as any) } }, output)
    }
  }
}
