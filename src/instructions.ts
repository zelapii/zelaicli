import fs from "node:fs/promises"
import path from "node:path"
import type { Config } from "./config"
import { globalInstructionFiles, projectInstructionFiles, projectRoot } from "./project"

const LIMIT = 24_000

export async function loadInstructions(cwd: string, config: Config) {
  const root = await projectRoot(cwd)
  const candidates = new Set<string>([
    ...(await globalInstructionFiles()),
    ...(await projectInstructionFiles(cwd)),
    ...(config.instructions || []).map((file) => (path.isAbsolute(file) ? file : path.join(root, file))),
  ])
  const parts: string[] = []
  for (const file of candidates) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!content?.trim()) continue
    parts.push(`# ${path.relative(root, file) || file}\n${content.trim()}`)
  }
  const text = parts.join("\n\n")
  if (!text) return ""
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n... [instructions truncated]` : text
}
