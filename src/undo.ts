import fs from "node:fs/promises"
import path from "node:path"
import { sessionsDir } from "./paths"

export interface Snapshot {
  path: string
  before: string | null
  at: number
  turn?: number
}

interface UndoState {
  stack: Snapshot[]
  redo?: Snapshot[]
  turn?: number
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

export async function recordTurnStart(sessionId: string) {
  if (!sessionId) return
  const state = await read(sessionId)
  state.turn = (state.turn || 0) + 1
  await write(sessionId, state)
}

export async function recordSnapshot(sessionId: string, file: string, before: string | null) {
  if (!sessionId) return
  const state = await read(sessionId)
  state.stack.push({ path: file, before, at: Date.now(), turn: state.turn || 0 })
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
  ;(state.redo ||= []).push({ path: snapshot.path, before: current, at: Date.now(), turn: snapshot.turn })
  await write(sessionId, state)
  return snapshot.path
}

export async function redoLast(sessionId: string) {
  const state = await read(sessionId)
  const snapshot = state.redo?.pop()
  if (!snapshot) return undefined
  const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
  await apply(snapshot, snapshot.before)
  state.stack.push({ path: snapshot.path, before: current, at: Date.now(), turn: snapshot.turn })
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
    redo.push({ path: snapshot.path, before: current, at: Date.now(), turn })
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
    state.stack.push({ path: snapshot.path, before: current, at: Date.now(), turn })
    paths.push(snapshot.path)
  }
  await write(sessionId, state)
  return paths
}

export async function redoCount(sessionId: string) {
  return (await read(sessionId)).redo?.length || 0
}

export async function undoCount(sessionId: string) {
  return (await read(sessionId)).stack.length
}
