import fs from "node:fs/promises"
import path from "node:path"
import { accountPath, configPath } from "./paths"

export interface Config {
  version: 1
  baseUrl: string
  apiKey?: string
  model?: string
  agent?: string
  permission?: import("./permissions").PermissionConfig
  instructions?: string[]
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

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
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
    apiKey: base.apiKey,
  }
}
