import fs from "node:fs/promises"
import path from "node:path"
import { sessionsDir } from "./paths"

export interface Snapshot {
  path: string
  before: string | null
  at: number
}

interface UndoState {
  stack: Snapshot[]
  redo?: Snapshot[]
}

function fileFor(sessionId: string) {
  return path.join(sessionsDir(), `${sessionId}.undo.json`)
}

async function read(sessionId: string): Promise<UndoState> {
  try {
    const value = JSON.parse(await fs.readFile(fileFor(sessionId), "utf8"))
    if (Array.isArray(value?.stack)) return { stack: value.stack, redo: Array.isArray(value.redo) ? value.redo : [] }
  } catch {}
  return { stack: [], redo: [] }
}

async function write(sessionId: string, state: UndoState) {
  await fs.mkdir(sessionsDir(), { recursive: true })
  await fs.writeFile(fileFor(sessionId), JSON.stringify(state, null, 2) + "\n")
}

export async function recordSnapshot(sessionId: string, file: string, before: string | null) {
  if (!sessionId) return
  const state = await read(sessionId)
  state.stack.push({ path: file, before, at: Date.now() })
  state.redo = []
  if (state.stack.length > 100) state.stack = state.stack.slice(-100)
  await write(sessionId, state)
}

export async function undoLast(sessionId: string) {
  const state = await read(sessionId)
  const snapshot = state.stack.pop()
  if (!snapshot) return undefined
  const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
  if (snapshot.before === null) {
    await fs.rm(snapshot.path, { force: true })
  } else {
    await fs.mkdir(path.dirname(snapshot.path), { recursive: true })
    await fs.writeFile(snapshot.path, snapshot.before)
  }
  ;(state.redo ||= []).push({ path: snapshot.path, before: current, at: Date.now() })
  await write(sessionId, state)
  return snapshot.path
}

export async function redoLast(sessionId: string) {
  const state = await read(sessionId)
  const snapshot = state.redo?.pop()
  if (!snapshot) return undefined
  const current = await fs.readFile(snapshot.path, "utf8").catch(() => null)
  if (snapshot.before === null) {
    await fs.rm(snapshot.path, { force: true })
  } else {
    await fs.mkdir(path.dirname(snapshot.path), { recursive: true })
    await fs.writeFile(snapshot.path, snapshot.before)
  }
  state.stack.push({ path: snapshot.path, before: current, at: Date.now() })
  await write(sessionId, state)
  return snapshot.path
}

export async function redoCount(sessionId: string) {
  return (await read(sessionId)).redo?.length || 0
}

export async function undoCount(sessionId: string) {
  return (await read(sessionId)).stack.length
}
