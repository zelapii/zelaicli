import fs from "node:fs/promises"
import path from "node:path"
import { configDir } from "./paths"
import { parseJsonc, type Config } from "./config"

async function exists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

export async function projectRoot(cwd: string) {
  let current = path.resolve(cwd)
  while (true) {
    if ((await exists(path.join(current, ".zelai"))) || (await exists(path.join(current, ".git")))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return parseJsonc<T>(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

export async function loadProjectConfig(cwd: string): Promise<Partial<Config>> {
  const root = await projectRoot(cwd)
  for (const file of [".zelai/zelai.json", ".zelai/config.json"]) {
    const value = await readJson<Partial<Config>>(path.join(root, file))
    if (value) return value
  }
  return {}
}

export async function globalAgentDirs() {
  return [path.join(configDir(), "agent"), path.join(configDir(), "agents")]
}

export async function projectAgentDirs(cwd: string) {
  const root = await projectRoot(cwd)
  return [path.join(root, ".zelai", "agent"), path.join(root, ".zelai", "agents")]
}

export async function globalCommandDirs() {
  return [path.join(configDir(), "command"), path.join(configDir(), "commands")]
}

export async function projectCommandDirs(cwd: string) {
  const root = await projectRoot(cwd)
  return [path.join(root, ".zelai", "command"), path.join(root, ".zelai", "commands")]
}

export async function globalInstructionFiles() {
  return [path.join(configDir(), "AGENTS.md")]
}

export async function projectInstructionFiles(cwd: string) {
  const root = await projectRoot(cwd)
  return [path.join(root, "AGENTS.md"), path.join(root, ".zelai", "AGENTS.md")]
}
