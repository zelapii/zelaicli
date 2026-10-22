import { chat } from "./api"
import type { Session } from "./session"

export function estimateTokens(session: Session) {
  let characters = (session.summary || "").length
  for (const message of session.messages) characters += (message.content || "").length + JSON.stringify(message.tool_calls || "").length
  return Math.ceil(characters / 4)
}

export function shouldCompact(session: Session, context: number | undefined) {
  if (!context) return false
  return estimateTokens(session) > context * 0.75
}

export async function compactSession(
  session: Session,
  options: { baseUrl: string; apiKey: string; model: string },
) {
  const keep = 4
  if (session.messages.length <= keep + 1) return false
  const old = session.messages.slice(0, -keep)
  const recent = session.messages.slice(-keep)
  const transcript = old
    .map((message) => {
      const tool = message.tool_calls?.map((call) => `tool ${call.function.name}(${call.function.arguments})`).join("\n")
      return `${message.role}: ${message.content || ""}${tool ? `\n${tool}` : ""}`
    })
    .join("\n\n")
  const clipped = transcript.length > 60_000 ? `${transcript.slice(-60_000)}` : transcript

  const result = await chat({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    messages: [
      {
        role: "system",
        content:
          "Summarize the conversation for a coding agent. Keep decisions, file paths, commands, errors, and unfinished work. Be compact but specific.",
      },
      { role: "user", content: clipped || "(empty)" },
    ],
  })

  if (!result.content.trim()) return false
  const combined = [session.summary, result.content.trim()].filter(Boolean).join("\n\n")
  session.summary = combined.length > 8_000 ? combined.slice(-8_000) : combined
  session.messages = recent
  return true
}
