import fs from "node:fs/promises"
import path from "node:path"
import { projectRoot } from "./project"

interface Rule {
  regex: RegExp
  negate: boolean
  dirOnly: boolean
}

function toRule(line: string): Rule | undefined {
  let value = line.trim()
  if (!value || value.startsWith("#")) return undefined
  const negate = value.startsWith("!")
  if (negate) value = value.slice(1)
  const dirOnly = value.endsWith("/")
  value = value.replace(/\/+$/, "")
  if (!value) return undefined
  if (value.startsWith("/")) value = value.slice(1)
  const hasSlash = value.includes("/")
  let source = value
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*")
  const regex = new RegExp(hasSlash ? `^${source}(/|$)` : `(^|/)${source}(/|$)`)
  return { regex, negate, dirOnly }
}

export async function loadIgnore(cwd: string) {
  const root = await projectRoot(cwd)
  const rules: Rule[] = []
  for (const file of [".gitignore", ".ignore"]) {
    const raw = await fs.readFile(path.join(root, file), "utf8").catch(() => undefined)
    if (!raw) continue
    for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
      const rule = toRule(line)
      if (rule) rules.push(rule)
    }
  }
  return (file: string) => {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "")
    let ignored = false
    for (const rule of rules) {
      if (!rule.regex.test(normalized)) continue
      ignored = !rule.negate
    }
    return ignored
  }
}
