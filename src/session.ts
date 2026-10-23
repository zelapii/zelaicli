import fs from "node:fs/promises"
import path from "node:path"
import type { ChatMessage } from "./api"
import { sessionsDir } from "./paths"
import { estimateCost, formatCost } from "./pricing"
import type { ModelPrice } from "./pricing"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export interface Todo {
  id?: string
  content: string
  status: TodoStatus
  priority?: "high" | "medium" | "low"
}

export interface RevertState {
  at: number
  messages: ChatMessage[]
  prompt?: string
  messageId?: string
}

export interface Session {
  id: string
  title: string
  agent: string
  model: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  messageIds?: string[]
  parentID?: string
  children?: string[]
  cost?: { input: number; output: number; total: number; currency: "USD" }
  summary?: string
  todos?: Todo[]
  tokens?: { prompt: number; completion: number }
  revert?: RevertState
}

function newMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function ensureMessageIds(session: Session): string[] {
  const count = session.messages.length
  const ids = Array.isArray(session.messageIds) ? session.messageIds.slice(0, count) : []
  while (ids.length < count) ids.push(newMessageId())
  for (let index = 0; index < ids.length; index += 1) {
    if (!ids[index]) ids[index] = newMessageId()
  }
  session.messageIds = ids
  return ids
}

export function visibleMessages(session: Session) {
  return session.revert ? session.messages.slice(0, session.revert.at) : session.messages
}

export function revertLastUser(session: Session, turns = 1) {
  const messages = visibleMessages(session)
  const indexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === "user") indexes.push(index)
  })
  if (!indexes.length) return undefined
  const target = indexes[Math.max(0, indexes.length - Math.max(1, turns))]
  const content = messages[target].content
  const prompt: string | undefined = typeof content === "string" ? content : undefined
  const removed = messages.slice(target)
  const messageId = ensureMessageIds(session)[target]
  session.revert = { at: target, messages: removed, prompt, messageId }
  return { prompt, count: removed.length }
}

export function revertAtMessage(
  session: Session,
  idOrIndex: string | number,
  options?: { turns?: number },
): { prompt?: string; count: number; index: number; messageId?: string } | undefined {
  const messages = visibleMessages(session)
  if (!messages.length) return undefined
  const ids = ensureMessageIds(session)
  let index = -1
  if (typeof idOrIndex === "number") {
    if (!Number.isFinite(idOrIndex)) return undefined
    index = Math.trunc(idOrIndex)
  } else {
    index = ids.findIndex((id) => id === idOrIndex)
  }
  if (index < 0 || index >= messages.length) return undefined

  let userIndex = -1
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") {
      userIndex = cursor
      break
    }
  }
  if (userIndex < 0) return undefined

  const turns = Math.max(1, Math.trunc(options?.turns ?? 1))
  let target = userIndex
  let remaining = turns - 1
  for (let cursor = userIndex - 1; cursor >= 0 && remaining > 0; cursor -= 1) {
    if (messages[cursor].role === "user") {
      target = cursor
      remaining -= 1
    }
  }

  const content = messages[target].content
  const prompt: string | undefined = typeof content === "string" ? content : undefined
  const removed = messages.slice(target)
  const messageId: string | undefined = ids[target]
  session.revert = { at: target, messages: removed, prompt, messageId }
  return { prompt, count: removed.length, index: target, messageId }
}

export function revertedIds(session: Session): string[] {
  if (!session.revert) return []
  const ids = ensureMessageIds(session)
  return session.revert.messages
    .map((_, offset) => ids[session.revert!.at + offset])
    .filter((id): id is string => Boolean(id))
}

export function unrevert(session: Session) {
  if (!session.revert) return false
  delete session.revert
  return true
}

export function commitRevert(session: Session) {
  if (!session.revert) return false
  session.messages = session.messages.slice(0, session.revert.at)
  if (Array.isArray(session.messageIds)) session.messageIds = session.messageIds.slice(0, session.revert.at)
  delete session.revert
  return true
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

export function createChildSession(parent: Session, agent: string, model: string): Session {
  const child = createSession(agent, model)
  child.parentID = parent.id
  child.title = `child of ${parent.id}`
  parent.children = [...(parent.children || []), child.id]
  return child
}

export function addCost(
  session: Session,
  model: string,
  usage: { prompt: number; completion: number },
  overrides?: Record<string, ModelPrice | { input: number; output: number }>,
) {
  const estimate = estimateCost(model, usage, overrides)
  if (!estimate) return undefined
  const current = session.cost ?? { input: 0, output: 0, total: 0, currency: "USD" as const }
  session.cost = {
    input: current.input + estimate.input,
    output: current.output + estimate.output,
    total: current.total + estimate.total,
    currency: "USD",
  }
  return session.cost
}

export async function saveSession(session: Session) {
  ensureMessageIds(session)
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

export async function forkSession(session: Session, title?: string, keep?: number) {
  const ids = ensureMessageIds(session)
  const copy = JSON.parse(JSON.stringify(session)) as Session
  const messages = visibleMessages(session)
  copy.id = newId()
  copy.messages = keep === undefined ? messages : messages.slice(0, Math.max(0, keep))
  copy.messageIds = copy.messages.map((_, index) => ids[index] ?? newMessageId())
  copy.title = title || `${session.title} (fork)`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  delete copy.revert
  await saveSession(copy)
  return copy
}

export async function deleteSession(id: string) {
  await fs.rm(fileFor(id), { force: true })
  await fs.rm(path.join(sessionsDir(), `${id}.undo.json`), { force: true })
}

export function exportMarkdown(session: Session) {
  const lines = [
    `# ${session.title}`,
    "",
    `- id: ${session.id}`,
    `- agent: ${session.agent}`,
    `- model: ${session.model}`,
    `- updated: ${new Date(session.updatedAt).toISOString()}`,
  ]
  if (session.cost) lines.push(`- cost: ${formatCost(session.cost)}`)
  lines.push("")
  if (session.summary) lines.push("## Summary", "", session.summary, "")
  for (const message of visibleMessages(session)) {
    if (message.role === "user") lines.push("## User", "", message.content || "", "")
    if (message.role === "assistant") {
      lines.push("## Assistant", "", message.content || "", "")
      for (const call of message.tool_calls || []) lines.push(`Tool: ${call.function.name}(${call.function.arguments})`, "")
    }
    if (message.role === "tool") lines.push(`### Tool result: ${message.name || ""}`, "", "```", message.content || "", "```", "")
  }
  return lines.join("\n")
}

export async function importSession(file: string) {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Session
  if (!raw?.id || !Array.isArray(raw.messages)) throw new Error("Not a ZelAI session file")
  const existing = await loadSession(raw.id)
  const session: Session = existing
    ? { ...existing, ...raw, updatedAt: Date.now() }
    : { ...raw, updatedAt: Date.now() }
  await saveSession(session)
  return session
}
