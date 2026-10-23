import fs from "node:fs/promises"
import path from "node:path"
import { unifiedDiff } from "./diff"

export interface WorkspaceSnapshot {
  cwd: string
  gitRoot?: string
  files: { path: string; before: string | null; after?: string | null; binary?: boolean }[]
  at: number
}

export const workspaceSizeLimit = 2 * 1024 * 1024

interface GitResult {
  ok: boolean
  stdout: Buffer
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout: Buffer.from(stdout) }
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) }
  }
}

function splitPaths(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function readDisk(file: string): Promise<{ exists: boolean; text?: string }> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > workspaceSizeLimit) return { exists: true }
    const buffer = await fs.readFile(file)
    if (buffer.includes(0)) return { exists: true }
    return { exists: true, text: buffer.toString("utf8") }
  } catch {
    return { exists: false }
  }
}

async function readHead(root: string, relative: string): Promise<{ found: boolean; text?: string }> {
  const result = await git(root, ["show", `HEAD:${relative}`])
  if (!result.ok) return { found: false }
  if (result.stdout.length > workspaceSizeLimit || result.stdout.includes(0)) return { found: true }
  return { found: true, text: result.stdout.toString("utf8") }
}

function displayPath(snapshot: WorkspaceSnapshot, target: string): string {
  const root = snapshot.gitRoot ?? snapshot.cwd
  const relative = path.relative(root, target)
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/")
  }
  return target
}

export async function captureWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const absolute = path.resolve(cwd)
  const at = Date.now()
  const top = await git(absolute, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return { cwd: absolute, files: [], at }
  const root = path.resolve(top.stdout.toString("utf8").trim())
  if (!root) return { cwd: absolute, files: [], at }

  const tracked = await git(root, ["diff", "--name-only", "-z"])
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  const trackedPaths = tracked.ok ? splitPaths(tracked.stdout) : []
  const untrackedPaths = untracked.ok ? splitPaths(untracked.stdout) : []

  const files: WorkspaceSnapshot["files"] = []
  const seen = new Set<string>()
  const groups: [string[], boolean][] = [
    [trackedPaths, true],
    [untrackedPaths, false],
  ]

  for (const [entries, isTracked] of groups) {
    for (const entry of entries) {
      if (seen.has(entry)) continue
      seen.add(entry)
      const target = path.resolve(root, entry)
      if (!inside(root, target)) continue
      const disk = await readDisk(target)
      if (disk.exists && disk.text === undefined) continue
      if (!isTracked && !disk.exists) continue

      let before: string | null = null
      if (isTracked) {
        const head = await readHead(root, entry)
        if (head.found && head.text === undefined) continue
        before = head.found ? head.text ?? null : null
      }

      files.push({
        path: target,
        before,
        after: disk.exists ? disk.text ?? null : null,
      })
    }
  }

  return { cwd: absolute, gitRoot: root, files, at }
}

export async function restoreWorkspace(snapshot: WorkspaceSnapshot): Promise<string[]> {
  const root = snapshot.gitRoot ?? snapshot.cwd
  const paths: string[] = []
  for (const file of snapshot.files) {
    const target = path.isAbsolute(file.path) ? file.path : path.resolve(root, file.path)
    if (file.before === null) {
      await fs.rm(target, { force: true })
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, file.before)
    }
    paths.push(target)
  }
  return paths
}

export async function workspaceDiff(snapshot: WorkspaceSnapshot): Promise<{ path: string; patch: string }[]> {
  const root = snapshot.gitRoot ?? snapshot.cwd
  const results: { path: string; patch: string }[] = []
  for (const file of snapshot.files) {
    const target = path.isAbsolute(file.path) ? file.path : path.resolve(root, file.path)
    const before = file.before ?? ""
    let after = file.after
    if (after === undefined) {
      const disk = await readDisk(target)
      after = disk.exists ? disk.text ?? null : null
    }
    const patch = unifiedDiff(before, after ?? "", displayPath(snapshot, target))
    if (patch) results.push({ path: file.path, patch })
  }
  return results
}
