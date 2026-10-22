import fs from "node:fs/promises"
import path from "node:path"
import type { Agent } from "./agents"

function home() {
  return process.env.HOME || ""
}

function expandHome(value: string) {
  if (value === "~") return home()
  if (value.startsWith("~/")) return path.join(home(), value.slice(2))
  return value
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "target", "vendor"])
const MAX_FILES = 5000
const MAX_ATTACH = 5
const MAX_BYTES = 40_000

async function listFilesAt(root: string) {
  const files: string[] = []
  try {
    for await (const file of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
      if (file.split("/").some((part) => SKIP.has(part))) continue
      files.push(file)
      if (files.length >= MAX_FILES) break
    }
  } catch {}
  return files.sort()
}

export async function listProjectFiles(cwd: string) {
  return listFilesAt(cwd)
}

export function referenceRoots(cwd: string, references?: Record<string, string>) {
  const roots = new Map<string, string>()
  for (const [alias, value] of Object.entries(references || {})) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) continue
    roots.set(alias, path.resolve(cwd, expandHome(value)))
  }
  return roots
}

export async function listReferenceFiles(cwd: string, references?: Record<string, string>) {
  const files = new Set(await listProjectFiles(cwd))
  for (const [alias, root] of referenceRoots(cwd, references)) {
    for (const file of await listFilesAt(root)) files.add(`${alias}/${file}`)
  }
  return [...files].sort()
}

function resolveAlias(token: string, cwd: string, references?: Record<string, string>) {
  const roots = referenceRoots(cwd, references)
  if (roots.has(token)) return { root: roots.get(token)!, file: "" }
  const slash = token.indexOf("/")
  if (slash <= 0) return undefined
  const alias = token.slice(0, slash)
  const root = roots.get(alias)
  if (!root) return undefined
  return { root, file: token.slice(slash + 1) }
}

function fuzzyScore(file: string, query: string) {
  const target = file.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  const base = target.split("/").pop() || target
  if (base.startsWith(q)) return 1000 - base.length
  if (base.includes(q)) return 800 - base.indexOf(q)
  if (target.startsWith(q)) return 700 - target.length
  if (target.includes(q)) return 600 - target.indexOf(q)
  let index = 0
  let score = 0
  for (const char of q) {
    const found = target.indexOf(char, index)
    if (found === -1) return -1
    if (found === index) score += 4
    index = found + 1
  }
  return 100 + score
}

export function matchFiles(files: string[], query: string, limit = 8) {
  return files
    .map((file) => ({ file, score: fuzzyScore(file, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    .slice(0, limit)
    .map((entry) => entry.file)
}

export function activeReference(draft: string) {
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return undefined
  const start = draft.length - match[2].length - 1
  return { start, query: match[2] }
}

export function replaceReference(draft: string, start: number, value: string) {
  return `${draft.slice(0, start)}@${value} `
}

async function readAbsolute(absolute: string) {
  const stat = await fs.stat(absolute).catch(() => undefined)
  if (!stat || !stat.isFile() || stat.size > MAX_BYTES) return undefined
  const content = await fs.readFile(absolute, "utf8").catch(() => undefined)
  if (content === undefined || content.includes("\u0000")) return undefined
  return content
}

async function readFile(cwd: string, file: string) {
  return readAbsolute(path.resolve(cwd, file))
}

function sliceLines(content: string, range: string) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(range)
  if (!match) return content
  const start = Math.max(1, Number(match[1]))
  const end = match[2] ? Math.max(start, Number(match[2])) : start
  const lines = content.split("\n")
  if (start > lines.length) return ""
  return lines.slice(start - 1, end).join("\n")
}

function splitRange(token: string) {
  const hash = token.lastIndexOf("#")
  if (hash <= 0) return { token, range: undefined as string | undefined }
  const range = token.slice(hash + 1)
  if (!/^\d+(-\d+)?$/.test(range)) return { token, range: undefined }
  return { token: token.slice(0, hash), range }
}

async function readReference(raw: string, cwd: string, references?: Record<string, string>) {
  const { token, range } = splitRange(raw)
  const resolved = resolveAlias(token, cwd, references)
  const content = !resolved
    ? await readFile(cwd, token)
    : !resolved.file
      ? await (async () => {
          const listing = await listFilesAt(resolved.root)
          if (!listing.length) return undefined
          const clipped = listing.slice(0, 200)
          return clipped.join("\n") + (listing.length > clipped.length ? `\n... ${listing.length - clipped.length} more files` : "")
        })()
      : await (async () => {
          const absolute = path.resolve(resolved.root, resolved.file)
          const relative = path.relative(resolved.root, absolute)
          if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
          return readAbsolute(absolute)
        })()
  if (content === undefined) return undefined
  return range ? sliceLines(content, range) : content
}

export function formatAttachments(entries: { path: string; content: string }[]) {
  if (!entries.length) return ""
  return entries
    .map((entry) => `File: ${entry.path}\n\`\`\`\n${entry.content}\n\`\`\``)
    .join("\n\n")
}

export async function expandReferences(
  text: string,
  cwd: string,
  agents: Agent[],
  references?: Record<string, string>,
) {
  const ids = new Set(agents.map((agent) => agent.id))
  let agent: string | undefined
  const attached: { path: string; content: string }[] = []
  const seen = new Set<string>()
  const matches = [...text.matchAll(/(^|\s)@([^\s@]+)/g)]
  for (const match of matches) {
    const token = match[2]
    if (ids.has(token)) {
      agent = token
      text = text.replace(`${match[1]}@${token}`, match[1])
      continue
    }
    if (attached.length >= MAX_ATTACH || seen.has(token)) continue
    const content = await readReference(token, cwd, references)
    if (!content) continue
    seen.add(token)
    attached.push({ path: token, content })
    text = text.replace(`${match[1]}@${token}`, match[1])
  }
  const body = formatAttachments(attached)
  return { text: body ? `${text.trim()}\n\n${body}`.trim() : text.trim(), agent }
}

export async function fileAttachments(files: string[], cwd: string) {
  const entries: { path: string; content: string }[] = []
  for (const file of files) {
    const content = await readFile(cwd, file)
    if (content) entries.push({ path: file, content })
  }
  return formatAttachments(entries)
}
