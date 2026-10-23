import fs from "node:fs/promises"
import path from "node:path"
import { accountPath, configDir, configPath } from "./paths"
import type { KeybindConfig } from "./keybinds"
import type { ThemeConfig } from "./theme"
import type { LspConfig } from "./lsp"
import type { ProviderConfig } from "./providers"
import { permissionConfigFromRules, type PermissionRule } from "./permissions"

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
  scrollSpeed?: number
  scrollAcceleration?: number
  leader?: string
  sounds?: boolean
  notifications?: boolean
  mini?: boolean
}

export interface CliConfig {
  theme?: string | ThemeConfig
  cursor?: TuiConfig["cursor"]
  keybinds?: KeybindConfig
  leader?: string
  animations?: boolean
  diffStyle?: "auto" | "stacked"
  mouse?: boolean
  scrollSpeed?: number
  scrollAcceleration?: number
  sounds?: boolean
  notifications?: boolean
}

export interface Config {
  version: 1
  baseUrl: string
  apiKey?: string
  model?: string
  agent?: string
  permission?: import("./permissions").PermissionConfig
  permissions?: PermissionRule[]
  instructions?: string[]
  mcp?: Record<string, import("./mcp").McpServerConfig>
  formatter?: Record<string, string>
  keybinds?: KeybindConfig
  theme?: string | ThemeConfig
  lsp?: LspConfig
  plugins?: string[]
  server?: ServerConfig
  tui?: TuiConfig
  cli?: CliConfig
  references?: Record<string, string>
  providers?: Record<string, ProviderConfig>
  websearch?: { provider?: string; apiKeys?: Record<string, string> }
  warming?: { enabled?: boolean; interval?: number; duration?: number; model?: string }
  policies?: unknown
  experimental?: { policies?: unknown }
  compaction?: { auto?: boolean; keepTokens?: number }
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

async function loadCliConfig(): Promise<CliConfig | undefined> {
  const inline = process.env.ZELAI_CLI_CONFIG_CONTENT || process.env.OPENCODE_CLI_CONFIG_CONTENT
  if (inline) {
    try {
      return parseJsonc<CliConfig>(inline)
    } catch {
      return undefined
    }
  }
  const file = process.env.ZELAI_CLI_CONFIG || process.env.OPENCODE_CLI_CONFIG || path.join(configDir(), "cli.json")
  return readJson<CliConfig>(file)
}

function applyCliConfig(config: Config, cli: CliConfig | undefined) {
  if (!cli) return
  config.cli = cli
  if (config.theme === undefined && cli.theme !== undefined) config.theme = cli.theme
  const tui: TuiConfig = {
    ...(config.tui || {}),
    cursor: { ...(cli.cursor || {}), ...(config.tui?.cursor || {}) },
  }
  if (tui.leader === undefined) tui.leader = cli.leader
  if (tui.diffStyle === undefined) tui.diffStyle = cli.diffStyle
  if (tui.mouse === undefined) tui.mouse = cli.mouse
  if (tui.scrollSpeed === undefined) tui.scrollSpeed = cli.scrollSpeed
  if (tui.scrollAcceleration === undefined) tui.scrollAcceleration = cli.scrollAcceleration
  if (tui.sounds === undefined) tui.sounds = cli.sounds
  if (tui.notifications === undefined) tui.notifications = cli.notifications
  config.tui = tui
  config.keybinds = { ...(cli.keybinds || {}), ...(config.keybinds || {}) }
}

export async function loadConfig(): Promise<Config> {
  const stored = await readJson<Config>(configPath())
  const config: Config = {
    ...defaultConfig(),
    ...stored,
  }
  applyCliConfig(config, await loadCliConfig())
  const legacy = (stored as any)?.providers?.zelai?.settings
  if (!config.apiKey && legacy?.apiKey) config.apiKey = legacy.apiKey
  if (!(stored as any)?.baseUrl && legacy?.baseURL) config.baseUrl = normalizeBaseUrl(String(legacy.baseURL).replace(/\/v1$/, ""))
  if (process.env.ZELAI_BASE_URL) config.baseUrl = normalizeBaseUrl(process.env.ZELAI_BASE_URL)
  if (!config.apiKey && process.env.ZELAI_API_KEY) config.apiKey = process.env.ZELAI_API_KEY
  if (config.permissions?.length) config.permission = permissionConfigFromRules(config.permission, config.permissions)
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
  const merged: Config = {
    ...base,
    ...project,
    version: 1,
    baseUrl: normalizeBaseUrl(project.baseUrl || base.baseUrl),
    permission: {
      ...(base.permission || {}),
      ...(project.permission || {}),
    },
    permissions: [...(base.permissions || []), ...(project.permissions || [])],
    instructions: [...(base.instructions || []), ...(project.instructions || [])],
    mcp: { ...(base.mcp || {}), ...(project.mcp || {}) },
    formatter: { ...(base.formatter || {}), ...(project.formatter || {}) },
    keybinds: { ...(base.keybinds || {}), ...(project.keybinds || {}) },
    theme: project.theme ?? base.theme,
    lsp: mergeLsp(base.lsp, project.lsp),
    plugins: [...new Set([...(base.plugins || []), ...(project.plugins || [])])],
    server: { ...(base.server || {}), ...(project.server || {}) },
    tui: { ...(base.tui || {}), ...(project.tui || {}), cursor: { ...(base.tui?.cursor || {}), ...(project.tui?.cursor || {}) } },
    cli: { ...(base.cli || {}), ...(project.cli || {}) },
    references: { ...(base.references || {}), ...(project.references || {}) },
    providers: { ...(base.providers || {}), ...(project.providers || {}) },
    websearch: { ...(base.websearch || {}), ...(project.websearch || {}) },
    warming: { ...(base.warming || {}), ...(project.warming || {}) },
    policies: project.policies ?? base.policies,
    experimental: { ...(base.experimental || {}), ...(project.experimental || {}) },
    compaction: { ...(base.compaction || {}), ...(project.compaction || {}) },
    apiKey: base.apiKey,
  }
  if (merged.permissions?.length) merged.permission = permissionConfigFromRules(merged.permission, merged.permissions)
  return merged
}
