import fs from "node:fs/promises"
import path from "node:path"
import { unifiedDiff } from "./diff"
import { sessionsDir } from "./paths"

export interface Snapshot {
  path: string
  before: string | null
  after?: string | null
  at: number
  turn?: number
  messageId?: string
}

interface UndoState {
  stack: Snapshot[]
  redo?: Snapshot[]
  turn?: number
  messageId?: string
}

function fileFor(sessionId: string) {
  return path.join(sessionsDir(), `${sessionId}.undo.json`)
}

async function read(sessionId: string): Promise<UndoState> {
  try {
    const value = JSON.parse(await fs.readFile(fileFor(sessionId), "utf8"))
    if (Array.isArray(value?.stack)) {
      return {
        stack: value.stack,
        redo: Array.isArray(value.redo) ? value.redo : [],
        turn: typeof value.turn === "number" ? value.turn : 0,
        ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
      }
    }
  } catch {}
  return { stack: [], redo: [], turn: 0 }
}

async function write(sessionId: string, state: UndoState) {
  await fs.mkdir(sessionsDir(), { recursive: true })
  await fs.writeFile(fileFor(sessionId), JSON.stringify(state, null, 2) + "\n")
}

async function apply(snapshot: Snapshot, before: string | null) {
  if (before === null) {
    await fs.rm(snapshot.path, { force: true })
    return
  }
  await fs.mkdir(path.dirname(snapshot.path), { recursive: true })
  await fs.writeFile(snapshot.path, before)
}

export async function recordTurnStart(sessionId: string, messageId?: string) {
  if (!sessionId) return
  const state = await read(sessionId)
  state.turn = (state.turn || 0) + 1
  if (messageId) state.messageId = messageId
  else delete state.messageId
  await write(sessionId, state)
}

export async function recordSnapshot(
  sessionId: string,
  file: string,
  before: string | null,
  after?: string | null,
  messageId?: string,
) {
  if (!sessionId) return
  const state = await read(sessionId)
  const snapshot: Snapshot = { path: file, before, at: Date.now(), turn: state.turn || 0 }
  if (after !== undefined) snapshot.after = after
  const id = messageId ?? state.messageId
  if (id) snapshot.messageId = id
  state.stack.push(snapshot)
  state.redo = []
  if (state.stack.length > 100) state.stack = state.stack.slice(-100)
  await write(sessionId, state)
}

export async function undoLast(sessionId: string) {
  const state = await read(sessionId)
  const snapshot = state.stack.pop()
  if (!snapshot) return undefined
  const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
  await apply(snapshot, snapshot.before)
  const redo: Snapshot = { path: snapshot.path, before: current, at: Date.now(), turn: snapshot.turn }
  if (snapshot.messageId) redo.messageId = snapshot.messageId
  ;(state.redo ||= []).push(redo)
  await write(sessionId, state)
  return snapshot.path
}

export async function redoLast(sessionId: string) {
  const state = await read(sessionId)
  const snapshot = state.redo?.pop()
  if (!snapshot) return undefined
  const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
  await apply(snapshot, snapshot.before)
  const restored: Snapshot = {
    path: snapshot.path,
    before: current,
    after: snapshot.before,
    at: Date.now(),
    turn: snapshot.turn,
  }
  if (snapshot.messageId) restored.messageId = snapshot.messageId
  state.stack.push(restored)
  await write(sessionId, state)
  return snapshot.path
}

function lastTurn(entries: Snapshot[]) {
  if (!entries.length) return undefined
  return entries[entries.length - 1].turn ?? 0
}

export async function undoLastTurn(sessionId: string) {
  const state = await read(sessionId)
  const turn = lastTurn(state.stack)
  if (turn === undefined) return []
  const entries: Snapshot[] = []
  while (state.stack.length && (state.stack[state.stack.length - 1].turn ?? 0) === turn) {
    entries.push(state.stack.pop()!)
  }
  const paths: string[] = []
  const redo: Snapshot[] = []
  for (const snapshot of entries) {
    const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
    await apply(snapshot, snapshot.before)
    const entry: Snapshot = { path: snapshot.path, before: current, at: Date.now(), turn }
    if (snapshot.messageId) entry.messageId = snapshot.messageId
    redo.push(entry)
    paths.push(snapshot.path)
  }
  state.redo = [...(state.redo || []), ...redo]
  await write(sessionId, state)
  return paths
}

export async function redoLastTurn(sessionId: string) {
  const state = await read(sessionId)
  const redoState = state.redo || []
  const turn = lastTurn(redoState)
  if (turn === undefined) return []
  const entries: Snapshot[] = []
  while (state.redo?.length && (state.redo[state.redo.length - 1].turn ?? 0) === turn) {
    entries.push(state.redo.pop()!)
  }
  const paths: string[] = []
  for (const snapshot of entries) {
    const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
    await apply(snapshot, snapshot.before)
    const restored: Snapshot = {
      path: snapshot.path,
      before: current,
      after: snapshot.before,
      at: Date.now(),
      turn,
    }
    if (snapshot.messageId) restored.messageId = snapshot.messageId
    state.stack.push(restored)
    paths.push(snapshot.path)
  }
  await write(sessionId, state)
  return paths
}

export async function turnSnapshots(
  sessionId: string,
  opts?: { messageId?: string; turn?: number },
): Promise<Snapshot[]> {
  const state = await read(sessionId)
  const hasMessage = opts?.messageId !== undefined
  const hasTurn = opts?.turn !== undefined
  return state.stack.filter((snapshot) => {
    if (hasMessage && snapshot.messageId !== opts?.messageId) return false
    if (hasTurn && (snapshot.turn ?? 0) !== opts?.turn) return false
    if (!hasMessage && !hasTurn) return (snapshot.turn ?? 0) === (state.turn ?? 0)
    return true
  })
}

export async function diffForTurn(
  sessionId: string,
  opts?: { messageId?: string; turn?: number },
): Promise<{ path: string; patch: string }[]> {
  const snapshots = await turnSnapshots(sessionId, opts)
  const results: { path: string; patch: string }[] = []
  for (const snapshot of snapshots) {
    const before = snapshot.before ?? ""
    let after = snapshot.after
    if (after === undefined) after = await fs.readFile(snapshot.path, "utf8").catch(() => null)
    const patch = unifiedDiff(before, after ?? "", snapshot.path)
    if (patch) results.push({ path: snapshot.path, patch })
  }
  return results
}

export async function redoCount(sessionId: string) {
  return (await read(sessionId)).redo?.length || 0
}

export async function undoCount(sessionId: string) {
  return (await read(sessionId)).stack.length
}
