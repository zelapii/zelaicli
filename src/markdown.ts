import fs from "node:fs/promises"
import path from "node:path"

export interface MarkdownFile {
  name: string
  data: Record<string, string>
  body: string
  file: string
}

export function parseMarkdown(raw: string, file = "") {
  const text = raw.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return { data: {} as Record<string, string>, body: text.trim(), file }
  const end = text.indexOf("\n---", 4)
  if (end === -1) return { data: {} as Record<string, string>, body: text.trim(), file }
  const header = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n/, "").trim()
  const data: Record<string, string> = {}
  for (const line of header.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
    if (key) data[key] = value
  }
  return { data, body, file }
}

export async function readMarkdownDir(directory: string): Promise<MarkdownFile[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: MarkdownFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const file = path.join(directory, entry.name)
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const parsed = parseMarkdown(raw, file)
    files.push({
      name: entry.name.slice(0, -3),
      data: parsed.data,
      body: parsed.body,
      file,
    })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

export function listValue(value: string | undefined) {
  if (!value) return undefined
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items : undefined
}
