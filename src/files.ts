import fs from "node:fs/promises"
import path from "node:path"
import type { Agent } from "./agents"

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "target", "vendor"])
const MAX_FILES = 5000
const MAX_ATTACH = 5
const MAX_BYTES = 40_000

export async function listProjectFiles(cwd: string) {
  const files: string[] = []
  try {
    for await (const file of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true })) {
      if (file.split("/").some((part) => SKIP.has(part))) continue
      files.push(file)
      if (files.length >= MAX_FILES) break
    }
  } catch {}
  return files.sort()
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

async function readFile(cwd: string, file: string) {
  const absolute = path.resolve(cwd, file)
  const stat = await fs.stat(absolute).catch(() => undefined)
  if (!stat || !stat.isFile() || stat.size > MAX_BYTES) return undefined
  const content = await fs.readFile(absolute, "utf8").catch(() => undefined)
  if (content === undefined || content.includes("\u0000")) return undefined
  return content
}

export function formatAttachments(entries: { path: string; content: string }[]) {
  if (!entries.length) return ""
  return entries
    .map((entry) => `File: ${entry.path}\n\`\`\`\n${entry.content}\n\`\`\``)
    .join("\n\n")
}

export async function expandReferences(text: string, cwd: string, agents: Agent[]) {
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
    const content = await readFile(cwd, token)
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
