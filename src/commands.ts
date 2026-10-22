import { readMarkdownDir } from "./markdown"
import { globalCommandDirs, projectCommandDirs } from "./project"

export interface CustomCommand {
  name: string
  description: string
  agent?: string
  model?: string
  template: string
  source: "global" | "project"
}

async function loadDir(directory: string, source: "global" | "project"): Promise<CustomCommand[]> {
  const files = await readMarkdownDir(directory)
  return files.map((file) => ({
    name: file.name,
    description: file.data.description || file.body.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 120) || file.name,
    ...(file.data.agent ? { agent: file.data.agent } : {}),
    ...(file.data.model ? { model: file.data.model } : {}),
    template: file.body,
    source,
  }))
}

export async function loadCommands(cwd: string) {
  const commands = new Map<string, CustomCommand>()
  for (const directory of await globalCommandDirs()) {
    for (const command of await loadDir(directory, "global")) commands.set(command.name, command)
  }
  for (const directory of await projectCommandDirs(cwd)) {
    for (const command of await loadDir(directory, "project")) commands.set(command.name, command)
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function expandCommand(command: CustomCommand, args: string) {
  const template = command.template || ""
  let expanded = template.split("$ARGUMENTS").join(args)
  for (const [index, value] of args.split(/\s+/).entries()) {
    expanded = expanded.split(`$${index + 1}`).join(value)
  }
  return expanded.trim() || args
}
