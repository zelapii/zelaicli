import fs from "node:fs/promises"
import path from "node:path"
import { accountPath, configPath } from "./paths"
import type { KeybindConfig } from "./keybinds"
import type { ThemeConfig } from "./theme"
import type { LspConfig } from "./lsp"

export interface ServerConfig {
  host?: string
  port?: number
  password?: string
  cors?: boolean | string[]
}

export interface TuiConfig {
  mouse?: boolean
  diffStyle?: "auto" | "stacked"
  cursor?: {
    style?: "block" | "line" | "underline" | "default"
    blinking?: boolean
  }
}

export interface Config {
  version: 1
  baseUrl: string
  apiKey?: string
  model?: string
  agent?: string
  permission?: import("./permissions").PermissionConfig
  instructions?: string[]
  mcp?: Record<string, import("./mcp").McpServerConfig>
  formatter?: Record<string, string>
  keybinds?: KeybindConfig
  theme?: string | ThemeConfig
  lsp?: LspConfig
  plugins?: string[]
  server?: ServerConfig
  tui?: TuiConfig
  references?: Record<string, string>
}

export interface Account {
  id?: string
  email?: string | null
  name?: string | null
  plan?: string | null
}

const DEFAULT_BASE_URL = "https://ai.zelai.qzz.io"

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

export function defaultConfig(): Config {
  return {
    version: 1,
    baseUrl: normalizeBaseUrl(process.env.ZELAI_BASE_URL || DEFAULT_BASE_URL),
  }
}

export function parseJsonc<T = unknown>(raw: string): T {
  let output = ""
  let string = false
  let escape = false
  let line = false
  let block = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    const next = raw[index + 1]
    if (line) {
      if (char === "\n") {
        line = false
        output += char
      }
      continue
    }
    if (block) {
      if (char === "*" && next === "/") {
        block = false
        index += 1
      }
      continue
    }
    if (string) {
      output += char
      if (escape) escape = false
      else if (char === "\\") escape = true
      else if (char === '"') string = false
      continue
    }
    if (char === "/" && next === "/") {
      line = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      block = true
      index += 1
      continue
    }
    if (char === '"') string = true
    output += char
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1")) as T
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return parseJsonc<T>(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

export async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => {})
}

export async function loadConfig(): Promise<Config> {
  const stored = await readJson<Config>(configPath())
  const config: Config = {
    ...defaultConfig(),
    ...stored,
  }
  const legacy = (stored as any)?.providers?.zelai?.settings
  if (!config.apiKey && legacy?.apiKey) config.apiKey = legacy.apiKey
  if (!(stored as any)?.baseUrl && legacy?.baseURL) config.baseUrl = normalizeBaseUrl(String(legacy.baseURL).replace(/\/v1$/, ""))
  if (process.env.ZELAI_BASE_URL) config.baseUrl = normalizeBaseUrl(process.env.ZELAI_BASE_URL)
  if (!config.apiKey && process.env.ZELAI_API_KEY) config.apiKey = process.env.ZELAI_API_KEY
  return config
}

export async function saveConfig(config: Config) {
  await writePrivateJson(configPath(), config)
}

export async function loadAccount(): Promise<Account | undefined> {
  return readJson<Account>(accountPath())
}

export async function saveAccount(account: Account) {
  await writePrivateJson(accountPath(), account)
}

export async function clearAccount() {
  await fs.rm(accountPath(), { force: true })
}

export function maskKey(key: string | undefined) {
  if (!key) return undefined
  return key.length <= 16 ? `${key.slice(0, 4)}...` : `${key.slice(0, 12)}...`
}

export function apiKey(config: Config) {
  return config.apiKey || process.env.ZELAI_API_KEY
}

function mergeLsp(base: Config["lsp"], project: Config["lsp"]): Config["lsp"] {
  if (project === undefined) return base
  if (project === false) return false
  if (project === true) return true
  if (base === true || base === undefined || base === false) return project
  return { ...(base as Record<string, unknown>), ...(project as Record<string, unknown>) } as Config["lsp"]
}

export function mergeConfig(base: Config, project: Partial<Config>): Config {
  return {
    ...base,
    ...project,
    version: 1,
    baseUrl: normalizeBaseUrl(project.baseUrl || base.baseUrl),
    permission: {
      ...(base.permission || {}),
      ...(project.permission || {}),
    },
    instructions: [...(base.instructions || []), ...(project.instructions || [])],
    mcp: { ...(base.mcp || {}), ...(project.mcp || {}) },
    formatter: { ...(base.formatter || {}), ...(project.formatter || {}) },
    keybinds: { ...(base.keybinds || {}), ...(project.keybinds || {}) },
    theme: project.theme ?? base.theme,
    lsp: mergeLsp(base.lsp, project.lsp),
    plugins: [...new Set([...(base.plugins || []), ...(project.plugins || [])])],
    server: { ...(base.server || {}), ...(project.server || {}) },
    tui: { ...(base.tui || {}), ...(project.tui || {}), cursor: { ...(base.tui?.cursor || {}), ...(project.tui?.cursor || {}) } },
    references: { ...(base.references || {}), ...(project.references || {}) },
    apiKey: base.apiKey,
  }
}
