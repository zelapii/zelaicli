export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onText?: (delta: string) => void
}

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`
}

async function readError(response: Response) {
  const text = await response.text().catch(() => "")
  try {
    const body = JSON.parse(text)
    return body?.error?.message || body?.message || text || response.statusText
  } catch {
    return text || response.statusText
  }
}

function parseToolCalls(delta: any, state: Map<number, ToolCall>) {
  for (const part of delta?.tool_calls || []) {
    const index = Number(part.index ?? state.size)
    const current =
      state.get(index) ||
      ({
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      } satisfies ToolCall)
    if (part.id) current.id = part.id
    if (part.function?.name) current.function.name += part.function.name
    if (part.function?.arguments) current.function.arguments += part.function.arguments
    state.set(index, current)
  }
}

async function request(options: ChatOptions, includeTools: boolean) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${options.apiKey}`,
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (includeTools && options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = "auto"
  }

  const response = await fetch(endpoint(options.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!response.ok) throw new ApiError(await readError(response), response.status)
  return response
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  let response: Response
  try {
    response = await request(options, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.tools?.length && /tool|function|unsupported|unknown field/i.test(message)) {
      response = await request(options, false)
    } else {
      throw error
    }
  }

  if (!response.body) throw new ApiError("The model returned an empty response")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const toolState = new Map<number, ToolCall>()
  let buffer = ""
  let content = ""
  let finishReason: string | undefined
  let usage: ChatResult["usage"]

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let event: any
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    if (event.error) throw new ApiError(event.error.message || "The model returned an error")
    if (event.usage) usage = event.usage
    const choice = event.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || choice.message
    if (!delta) return
    if (typeof delta.content === "string" && delta.content.length) {
      content += delta.content
      options.onText?.(delta.content)
    }
    parseToolCalls(delta, toolState)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""
    for (const line of lines) handleLine(line)
  }
  buffer += decoder.decode()
  if (buffer) handleLine(buffer)

  return {
    content,
    toolCalls: [...toolState.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    finishReason,
    usage,
  }
}

export async function verifyKey(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "network" }
  if (response.ok) return { ok: true }
  return { ok: false, reason: String(response.status) }
}
