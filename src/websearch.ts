export type WebsearchProvider = "exa" | "firecrawl" | "parallel" | "tavily" | "tinyfish"

export interface WebsearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebsearchOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface FailoverOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface FailoverResult {
  provider: WebsearchProvider
  results: WebsearchResult[]
}

const PROVIDERS: WebsearchProvider[] = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]
const COOLDOWN_MS = 60_000
const cooldowns = new Map<WebsearchProvider, number>()

class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function excerpts(value: unknown): string {
  return array(value)
    .map((entry) => text(entry) || text(object(entry).text) || text(object(entry).snippet))
    .filter(Boolean)
    .join(" ")
}

function toResults(items: unknown[], snippet: (item: Record<string, unknown>) => string): WebsearchResult[] {
  return items
    .map((entry) => {
      const item = object(entry)
      return { title: text(item.title), url: text(item.url), snippet: snippet(item) }
    })
    .filter((entry) => entry.url)
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new HttpError(
      `Search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status,
    )
  }
  return await response.json()
}

export function pickProvider(
  configured: WebsearchProvider | "random" | undefined,
  random: () => number = Math.random,
): WebsearchProvider {
  if (configured && configured !== "random") return configured
  if (configured === "random") {
    const index = Math.min(PROVIDERS.length - 1, Math.max(0, Math.floor(random() * PROVIDERS.length)))
    return PROVIDERS[index] ?? "exa"
  }
  return "exa"
}

export async function searchWeb(
  name: WebsearchProvider,
  query: string,
  options: WebsearchOptions,
): Promise<WebsearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  switch (name) {
    case "exa": {
      const root = object(
        await post(
          fetchImpl,
          "https://api.exa.ai/search",
          { "x-api-key": options.apiKey },
          { query, numResults: 8, contents: { text: { maxCharacters: 1500 } } },
          options.signal,
        ),
      )
      return toResults(array(root.results), (item) => {
        const highlights = array(item.highlights).map(text).filter(Boolean)
        return text(item.text) || text(item.summary) || highlights[0] || ""
      })
    }
    case "tavily": {
      const root = object(
        await post(
          fetchImpl,
          "https://api.tavily.com/search",
          { authorization: `Bearer ${options.apiKey}` },
          { query, max_results: 8 },
          options.signal,
        ),
      )
      return toResults(array(root.results), (item) => text(item.content) || text(item.snippet))
    }
    case "firecrawl": {
      const root = object(
        await post(
          fetchImpl,
          "https://api.firecrawl.dev/v1/search",
          { authorization: `Bearer ${options.apiKey}` },
          { query, limit: 8 },
          options.signal,
        ),
      )
      const items = array(root.data)
      return toResults(items.length ? items : array(object(root.data).web), (item) =>
        text(item.description) || text(item.markdown) || text(item.content),
      )
    }
    case "parallel": {
      const root = object(
        await post(
          fetchImpl,
          "https://api.parallel.ai/v1beta/search",
          { "x-api-key": options.apiKey },
          { objective: query, search_queries: [query], max_results: 8 },
          options.signal,
        ),
      )
      return toResults(
        array(root.results),
        (item) => excerpts(item.excerpts) || text(item.snippet) || text(item.text),
      )
    }
    case "tinyfish": {
      const root = object(
        await post(
          fetchImpl,
          "https://api.tinyfish.ai/v1/search",
          { authorization: `Bearer ${options.apiKey}`, "x-api-key": options.apiKey },
          { query, max_results: 8 },
          options.signal,
        ),
      )
      const items = array(root.results)
      return toResults(items.length ? items : array(root.data), (item) =>
        text(item.snippet) || text(item.description) || text(item.content) || text(item.text),
      )
    }
  }
}

export function providerOrder(
  configured: WebsearchProvider | undefined,
  keys: Partial<Record<WebsearchProvider, string>>,
): WebsearchProvider[] {
  const available = PROVIDERS.filter((provider) => Boolean(keys[provider]))
  const preferred = configured && keys[configured] ? [configured] : []
  return [...new Set([...preferred, ...available])]
}

export function providerFromEnv(env: Record<string, string | undefined>): Partial<Record<WebsearchProvider, string>> {
  const keys: Partial<Record<WebsearchProvider, string>> = {}
  for (const provider of PROVIDERS) {
    const value = env[`${provider.toUpperCase()}_API_KEY`]
    if (value) keys[provider] = value
  }
  return keys
}

export async function searchWithFailover(
  order: WebsearchProvider[],
  query: string,
  keys: Partial<Record<WebsearchProvider, string>>,
  opts?: FailoverOptions,
): Promise<FailoverResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  let lastError: unknown
  for (const provider of order) {
    const until = cooldowns.get(provider) ?? 0
    if (until > Date.now()) {
      lastError = new Error(`${provider} is cooling down`)
      continue
    }
    const apiKey = keys[provider]
    if (!apiKey) {
      lastError = new Error(`Missing API key for ${provider}`)
      continue
    }
    try {
      const results = await searchWeb(provider, query, { apiKey, fetchImpl, signal: opts?.signal })
      return { provider, results }
    } catch (error) {
      lastError = error
      if (error instanceof HttpError && (error.status === 429 || (error.status ?? 0) >= 500)) {
        cooldowns.set(provider, Date.now() + COOLDOWN_MS)
      }
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error("All websearch providers failed")
}
