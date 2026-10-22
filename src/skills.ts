import fs from "node:fs/promises"
import path from "node:path"
import { configDir } from "./paths"
import { projectRoot } from "./project"

export interface Skill {
  name: string
  description: string
  path: string
  content: string
}

async function loadDir(directory: string): Promise<Skill[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name, "SKILL.md")
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!content?.trim()) continue
    const first = content
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("---") && !line.includes(":"))
    skills.push({
      name: entry.name,
      description: (first || entry.name).replace(/^#+\s*/, "").trim().slice(0, 160),
      path: file,
      content: content.trim(),
    })
  }
  return skills
}

export async function loadSkills(cwd: string) {
  const skills = new Map<string, Skill>()
  for (const directory of [path.join(configDir(), "skills")]) {
    for (const skill of await loadDir(directory)) skills.set(skill.name, skill)
  }
  const root = await projectRoot(cwd)
  for (const directory of [path.join(root, ".zelai", "skills")]) {
    for (const skill of await loadDir(directory)) skills.set(skill.name, skill)
  }
  return [...skills.values()]
}

export function skillSummary(skills: Skill[]) {
  if (!skills.length) return ""
  return `Available skills (use the skill tool to load one):\n${skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n")}`
}
