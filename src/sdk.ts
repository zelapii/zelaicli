export interface ZelaiEvent {
  type: string
  [key: string]: any
}

export interface ZelaiClientOptions {
  baseUrl: string
  password?: string
  fetch?: typeof fetch
}

export interface PromptOptions {
  agent?: string
  model?: string
  autoApprove?: boolean
}

export class ZelaiApiError extends Error {
  status: number
  body: string

  constructor(status: number, body: string) {
    super(`ZelAI API error ${status}: ${body.slice(0, 200)}`)
    this.name = "ZelaiApiError"
    this.status = status
    this.body = body
  }
}

export function createZelaiClient(options: ZelaiClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "")
  const doFetch = options.fetch || fetch
  const password = options.password ?? process.env.ZELAI_SERVER_PASSWORD
  const auth: Record<string, string> = password ? { authorization: `Bearer ${password}` } : {}

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...auth,
        ...((init.headers as Record<string, string> | undefined) || {}),
      },
    })
    if (!response.ok) throw new ZelaiApiError(response.status, await response.text())
    return (await response.json()) as T
  }

  async function* prompt(sessionId: string, message: string, input: PromptOptions = {}): AsyncGenerator<ZelaiEvent> {
    const response = await doFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...auth },
      body: JSON.stringify({ message, ...input }),
    })
    if (!response.ok || !response.body) throw new ZelaiApiError(response.status, await response.text())
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) yield JSON.parse(data) as ZelaiEvent
        index = buffer.indexOf("\n\n")
      }
    }
  }

  return {
    health: () => request<{ ok: boolean; name: string; version: string; auth: boolean }>("/health"),
    app: () => request<Record<string, any>>("/app"),
    models: () => request<{ models: any[]; default?: string }>("/models"),
    doc: () => request<Record<string, any>>("/doc"),
    sessions: {
      list: () => request<{ sessions: any[] }>("/sessions"),
      create: (input: { agent?: string; model?: string; title?: string } = {}) =>
        request<{ session: any }>("/sessions", { method: "POST", body: JSON.stringify(input) }),
      get: (id: string) => request<{ session: any }>(`/sessions/${encodeURIComponent(id)}`),
      messages: (id: string) => request<{ messages: any[] }>(`/sessions/${encodeURIComponent(id)}/messages`),
      delete: (id: string) => request<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
      cancel: (id: string) =>
        request<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
      prompt,
    },
    respondPermission: (id: string, allow: boolean) =>
      request<{ ok: boolean }>(`/permissions/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ allow }),
      }),
  }
}

export type ZelaiClient = ReturnType<typeof createZelaiClient>
