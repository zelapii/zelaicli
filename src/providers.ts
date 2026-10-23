export interface ModelPricing {
  input: number
  output: number
}

export interface ModelMeta {
  id: string
  name?: string
  context?: number
  output?: number
  pricing?: ModelPricing
  tools?: boolean
  reasoning?: boolean
  variants?: Record<string, unknown>
}

export interface ProviderConfig {
  name: string
  npm?: string
  api?: string
  baseUrl?: string
  apiKey?: string
  env?: string[]
  headers?: Record<string, string>
  options?: Record<string, unknown>
  models?: Record<string, ModelMeta>
  local?: boolean
  disabled?: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function parseModelRef(ref: string): { provider?: string; model: string; variant?: string } {
  const value = ref.trim()
  const hash = value.indexOf("#")
  const base = hash >= 0 ? value.slice(0, hash) : value
  const variant = hash >= 0 ? value.slice(hash + 1).trim() || undefined : undefined
  const slash = base.indexOf("/")
  if (slash > 0 && slash < base.length - 1) {
    return { provider: base.slice(0, slash), model: base.slice(slash + 1), variant }
  }
  return { model: base, variant }
}

export function variantOptions(variant?: string): Record<string, unknown> {
  switch (variant) {
    case "high":
    case "medium":
    case "low":
    case "minimal":
      return { reasoning_effort: variant }
    default:
      return {}
  }
}

function findModelMeta(provider: ProviderConfig, model: string): ModelMeta | undefined {
  const models = provider.models
  if (!models) return undefined
  return models[model] ?? Object.values(models).find((entry) => entry.id === model)
}

function mergedOptions(provider: ProviderConfig, meta: ModelMeta | undefined, variant?: string): Record<string, unknown> {
  const modelVariant = variant && meta?.variants ? asRecord(meta.variants[variant]) : {}
  return { ...(provider.options ?? {}), ...modelVariant, ...variantOptions(variant) }
}

export function resolveProvider(
  providers: Record<string, ProviderConfig>,
  ref: string,
): { provider?: string; model: string; baseUrl?: string; apiKey?: string; headers?: Record<string, string>; options: Record<string, unknown> } | undefined {
  const parsed = parseModelRef(ref)
  const base = ref.trim().replace(/#.*$/, "")
  const explicit = parsed.provider ? providers[parsed.provider] : undefined
  if (parsed.provider && explicit && !explicit.disabled) {
    const meta = findModelMeta(explicit, parsed.model) ?? findModelMeta(explicit, base)
    return {
      provider: parsed.provider,
      model: parsed.model,
      baseUrl: explicit.baseUrl,
      apiKey: explicit.apiKey,
      headers: explicit.headers,
      options: mergedOptions(explicit, meta, parsed.variant),
    }
  }
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.disabled) continue
    const meta = findModelMeta(provider, parsed.model) ?? findModelMeta(provider, base)
    if (!meta) continue
    return {
      provider: name,
      model: parsed.model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.headers,
      options: mergedOptions(provider, meta, parsed.variant),
    }
  }
  return undefined
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return JSON.parse(JSON.stringify(provider)) as ProviderConfig
}

function injectKey(provider: ProviderConfig, env: Record<string, string | undefined>): void {
  if (provider.apiKey) return
  const name = provider.env?.find((entry) => Boolean(env[entry]))
  if (name) provider.apiKey = env[name]
}

export async function loadProviders(options: {
  config?: Record<string, ProviderConfig>
  env?: Record<string, string | undefined>
}): Promise<Record<string, ProviderConfig>> {
  const env = options.env ?? process.env
  const result: Record<string, ProviderConfig> = {}
  const disabled = new Set<string>()
  for (const [name, provider] of Object.entries(options.config ?? {})) {
    if (provider.disabled) {
      disabled.add(name)
      continue
    }
    const copy = cloneProvider(provider)
    copy.name = copy.name || name
    injectKey(copy, env)
    result[name] = copy
  }
  const add = (name: string, envName: string, baseUrl: string, api?: string): void => {
    if (disabled.has(name)) return
    const existing = result[name]
    if (existing) {
      if (!existing.apiKey) existing.apiKey = env[envName]
      return
    }
    const apiKey = env[envName]
    if (!apiKey) return
    result[name] = { name, baseUrl, apiKey, ...(api ? { api } : {}) }
  }
  add("openai", "OPENAI_API_KEY", "https://api.openai.com/v1")
  add("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1")
  add("anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1", "anthropic")
  return result
}

async function probe(
  name: string,
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ProviderConfig | undefined> {
  try {
    const headers: Record<string, string> = { accept: "application/json" }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(800),
    })
    if (!response.ok) return undefined
    const root = asRecord(await response.json())
    const data: unknown[] = Array.isArray(root.data) ? root.data : []
    const models: Record<string, ModelMeta> = {}
    for (const entry of data) {
      const record = asRecord(entry)
      const id = typeof entry === "string" ? entry : typeof record.id === "string" ? record.id : ""
      if (id) models[id] = { id }
    }
    return { name, baseUrl, apiKey, local: true, models }
  } catch {
    return undefined
  }
}

export async function discoverLocal(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderConfig[]> {
  const found = await Promise.all([
    probe("ollama", "http://127.0.0.1:11434/v1", env.OLLAMA_API_KEY || "ollama", fetchImpl),
    probe("lmstudio", "http://127.0.0.1:1234/v1", env.LMSTUDIO_API_KEY || "lmstudio", fetchImpl),
  ])
  return found.filter((provider): provider is ProviderConfig => provider !== undefined)
}

export function isDisabledFreeModels(env: Record<string, string | undefined> = process.env): boolean {
  return [env.ZELAI_DISABLE_FREE_MODELS, env.OPENCODE_DISABLE_FREE_MODELS].some((value) => {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return normalized !== "0" && normalized !== "false" && normalized !== "no"
  })
}

export function modelPricing(
  providers: Record<string, ProviderConfig>,
  modelRef: string,
): ModelPricing | undefined {
  const parsed = parseModelRef(modelRef)
  const base = modelRef.trim().replace(/#.*$/, "")
  const explicit = parsed.provider ? providers[parsed.provider] : undefined
  if (explicit && !explicit.disabled) {
    const meta = findModelMeta(explicit, parsed.model) ?? findModelMeta(explicit, base)
    return meta?.pricing
  }
  for (const provider of Object.values(providers)) {
    if (provider.disabled) continue
    const meta = findModelMeta(provider, parsed.model) ?? findModelMeta(provider, base)
    if (meta?.pricing) return meta.pricing
  }
  return undefined
}
