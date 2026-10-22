import { listSessions } from "./session"

export interface Stats {
  sessions: number
  messages: number
  user: number
  assistant: number
  toolCalls: number
  tools: { name: string; count: number }[]
  models: { name: string; count: number }[]
  agents: { name: string; count: number }[]
  characters: number
  tokens: { prompt: number; completion: number }
}

export async function collectStats(): Promise<Stats> {
  const sessions = await listSessions()
  const tools = new Map<string, number>()
  const models = new Map<string, number>()
  const agents = new Map<string, number>()
  let messages = 0
  let user = 0
  let assistant = 0
  let toolCalls = 0
  let characters = 0
  let promptTokens = 0
  let completionTokens = 0

  for (const session of sessions) {
    models.set(session.model, (models.get(session.model) || 0) + 1)
    agents.set(session.agent, (agents.get(session.agent) || 0) + 1)
    for (const message of session.messages) {
      messages += 1
      characters += (message.content || "").length
      if (message.role === "user") user += 1
      if (message.role === "assistant") assistant += 1
      for (const call of message.tool_calls || []) {
        toolCalls += 1
        const name = call.function.name
        tools.set(name, (tools.get(name) || 0) + 1)
      }
    }
    characters += (session.summary || "").length
    promptTokens += session.tokens?.prompt || 0
    completionTokens += session.tokens?.completion || 0
  }

  const sorted = (map: Map<string, number>) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)

  return {
    sessions: sessions.length,
    messages,
    user,
    assistant,
    toolCalls,
    tools: sorted(tools),
    models: sorted(models),
    agents: sorted(agents),
    characters,
    tokens: { prompt: promptTokens, completion: completionTokens },
  }
}
