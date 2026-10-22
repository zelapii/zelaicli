import fs from "node:fs/promises"
import path from "node:path"
import type { ChatMessage } from "./api"
import { sessionsDir } from "./paths"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export interface Todo {
  id?: string
  content: string
  status: TodoStatus
  priority?: "high" | "medium" | "low"
}

export interface Session {
  id: string
  title: string
  agent: string
  model: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  summary?: string
  todos?: Todo[]
}

function fileFor(id: string) {
  return path.join(sessionsDir(), `${id}.json`)
}

function newId() {
  return `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function titleFrom(messages: ChatMessage[]) {
  const first = messages.find((message) => message.role === "user" && message.content)
  const text = (first?.content || "New session").replace(/\s+/g, " ").trim()
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

export function createSession(agent: string, model: string): Session {
  const now = Date.now()
  return {
    id: newId(),
    title: "New session",
    agent,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
}

export async function saveSession(session: Session) {
  session.updatedAt = Date.now()
  if (session.title === "New session" && session.messages.length) session.title = titleFrom(session.messages)
  await fs.mkdir(sessionsDir(), { recursive: true })
  const target = fileFor(session.id)
  const temp = `${target}.tmp`
  await fs.writeFile(temp, JSON.stringify(session, null, 2) + "\n")
  await fs.rename(temp, target)
}

export async function loadSession(id: string): Promise<Session | undefined> {
  try {
    const session = JSON.parse(await fs.readFile(fileFor(id), "utf8")) as Session
    if (!session?.id) return undefined
    return session
  } catch {
    return undefined
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    const files = await fs.readdir(sessionsDir())
    const sessions = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => loadSession(file.slice(0, -5))),
    )
    return sessions
      .filter((session): session is Session => !!session)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function latestSession(): Promise<Session | undefined> {
  return (await listSessions())[0]
}

export async function forkSession(session: Session, title?: string) {
  const copy = JSON.parse(JSON.stringify(session)) as Session
  copy.id = newId()
  copy.title = title || `${session.title} (fork)`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  await saveSession(copy)
  return copy
}

export async function deleteSession(id: string) {
  await fs.rm(fileFor(id), { force: true })
  await fs.rm(path.join(sessionsDir(), `${id}.undo.json`), { force: true })
}

export function exportMarkdown(session: Session) {
  const lines = [`# ${session.title}`, '', `- id: ${session.id}`, `- agent: ${session.agent}`, `- model: ${session.model}`, `- updated: ${new Date(session.updatedAt).toISOString()}`, '']
  if (session.summary) lines.push('## Summary', '', session.summary, '')
  for (const message of session.messages) {
    if (message.role === 'user') lines.push('## User', '', message.content || '', '')
    if (message.role === 'assistant') {
      lines.push('## Assistant', '', message.content || '', '')
      for (const call of message.tool_calls || []) lines.push(`Tool: ${call.function.name}(${call.function.arguments})`, '')
    }
    if (message.role === 'tool') lines.push(`### Tool result: ${message.name || ''}`, '', '```', message.content || '', '```', '')
  }
  return lines.join('\n')
}

export async function importSession(file: string) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Session
  if (!raw?.id || !Array.isArray(raw.messages)) throw new Error('Not a ZelAI session file')
  const existing = await loadSession(raw.id)
  const session: Session = existing
    ? { ...existing, ...raw, updatedAt: Date.now() }
    : { ...raw, updatedAt: Date.now() }
  await saveSession(session)
  return session
}
