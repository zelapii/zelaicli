export interface WarmingTarget {
  baseUrl: string
  apiKey?: string
  model: string
  headers?: Record<string, string>
}

export interface WarmingOptions {
  targets: WarmingTarget[]
  intervalMs?: number
  durationMs?: number
  enabled?: boolean
  fetchImpl?: typeof fetch
}

export interface WarmingHandle {
  stop: () => void
}

export function startWarming(options: WarmingOptions): WarmingHandle {
  if (!options.enabled) return { stop: () => {} }
  const fetchImpl = options.fetchImpl ?? fetch
  const intervalMs = options.intervalMs ?? 240_000
  const durationMs = options.durationMs ?? 1_800_000
  let running = false
  let stopped = false

  const send = async (target: WarmingTarget): Promise<void> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      ...(target.headers ?? {}),
    }
    try {
      await fetchImpl(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {}
  }

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await Promise.all(options.targets.map((target) => send(target)))
    } finally {
      running = false
    }
  }

  const stop = (): void => {
    stopped = true
    if (interval !== undefined) clearInterval(interval)
    if (timeout !== undefined) clearTimeout(timeout)
  }

  void tick()
  const interval = setInterval(() => {
    void tick()
  }, intervalMs)
  const timeout = setTimeout(stop, durationMs)
  return { stop }
}
