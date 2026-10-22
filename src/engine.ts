import { chat, type ChatMessage, type ToolCall } from "./api"
import { AGENTS, agentContext, findAgent, type Agent } from "./agents"
import { executeTool, toolDefinitions, type Approve } from "./tools"
import { createSession, type Session, type Todo } from "./session"

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "assistant_start" }
  | { type: "tool_start"; id: string; name: string; args: string; description: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string }
  | { type: "step"; step: number }
  | { type: "todos"; todos: Todo[] }
  | { type: "error"; message: string }

export interface RunTurnOptions {
  session: Session
  agent: Agent
  baseUrl: string
  apiKey: string
  model: string
  cwd: string
  instructions?: string
  permission?: import("./permissions").PermissionConfig
  always?: Set<string>
  approve: Approve
  autoApprove?: boolean
  signal?: AbortSignal
  onEvent: (event: EngineEvent) => void
  onPersist?: () => Promise<void> | void
  maxSteps?: number
  agents?: Agent[]
  runSubagent?: (agent: string, prompt: string) => Promise<string>
  subagents?: boolean
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
  const system = agentContext(options.agent, options.cwd, options.instructions || "", options.session.summary || "")
  const runSubagent =
    options.subagents === false
      ? undefined
      : options.runSubagent ||
        (async (agentId: string, prompt: string) => {
          const sub = findAgent(agentId, options.agents || AGENTS)
          const nested = createSession(sub.id, options.model)
          nested.messages.push({ role: "user", content: prompt })
          let final = ""
          await runTurn({
            ...options,
            session: nested,
            agent: sub,
            subagents: false,
            maxSteps: 10,
            onEvent: (event) => {
              if (event.type === "text") final += event.text
            },
            onPersist: undefined,
          })
          return final || "(subagent returned no text)"
        })
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
      let outcome
      if (name === "todowrite") {
        const parsed = parseArguments(args)
        const todos: Todo[] = Array.isArray(parsed.todos) ? parsed.todos : []
        options.session.todos = todos
        options.onEvent({ type: "todos", todos })
        outcome = { ok: true, output: `Updated ${todos.length} todo${todos.length === 1 ? "" : "s"}` }
      } else {
        outcome = await executeTool(name, args, {
          cwd: options.cwd,
          sessionId: options.session.id,
          approve: options.approve,
          permission: options.permission,
          always: options.always,
          autoApprove: options.autoApprove,
          signal: options.signal,
          runSubagent,
        })
      }
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
