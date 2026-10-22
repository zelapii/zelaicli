import { chat, type ChatMessage, type ToolCall } from "./api"
import { agentContext, type Agent } from "./agents"
import { executeTool, toolDefinitions, type Approve } from "./tools"
import type { Session } from "./session"

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "assistant_start" }
  | { type: "tool_start"; id: string; name: string; args: string; description: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string }
  | { type: "step"; step: number }
  | { type: "error"; message: string }

export interface RunTurnOptions {
  session: Session
  agent: Agent
  baseUrl: string
  apiKey: string
  model: string
  cwd: string
  approve: Approve
  autoApprove?: boolean
  signal?: AbortSignal
  onEvent: (event: EngineEvent) => void
  onPersist?: () => Promise<void> | void
  maxSteps?: number
}

function toApiMessages(system: string, messages: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: system }, ...messages]
}

function parseArguments(raw: string) {
  try {
    return JSON.parse(raw || "{}")
  } catch {
    return {}
  }
}

export async function runTurn(options: RunTurnOptions) {
  const maxSteps = options.maxSteps ?? 16
  const system = agentContext(options.agent, options.cwd)
  const tools = toolDefinitions(options.agent)

  for (let step = 1; step <= maxSteps; step += 1) {
    if (options.signal?.aborted) throw new Error("Cancelled")
    options.onEvent({ type: "step", step })
    options.onEvent({ type: "assistant_start" })

    const result = await chat({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      messages: toApiMessages(system, options.session.messages),
      tools,
      signal: options.signal,
      onText: (text) => options.onEvent({ type: "text", text }),
    })

    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content || null,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
    }
    options.session.messages.push(assistant)

    if (!result.toolCalls.length) {
      await options.onPersist?.()
      return
    }

    for (const call of result.toolCalls) {
      const name = call.function.name
      const args = call.function.arguments || "{}"
      options.onEvent({ type: "tool_start", id: call.id, name, args, description: "" })
      const outcome = await executeTool(name, args, {
        cwd: options.cwd,
        approve: options.approve,
        autoApprove: options.autoApprove,
        signal: options.signal,
      })
      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: outcome.output,
      }
      options.session.messages.push(toolMessage)
      options.onEvent({ type: "tool_end", id: call.id, name, ok: outcome.ok, output: outcome.output })
    }

    await options.onPersist?.()
  }

  const message = `Stopped after ${maxSteps} steps without a final answer.`
  options.onEvent({ type: "error", message })
  throw new Error(message)
}

export function summarizeToolCall(call: ToolCall) {
  return `${call.function.name} ${call.function.arguments.slice(0, 100)}`
}

export function initialMessages(messages: ChatMessage[]) {
  return messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
}

export function extractDiff(input: string, limit = 20_000) {
  const trimmed = input.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n... [truncated]` : trimmed
}

export function toolArgs(call: ToolCall) {
  const args = parseArguments(call.function.arguments)
  return args
}
