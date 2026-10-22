import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./api"
import type { Agent } from "./agents"

export interface ApprovalRequest {
  kind: "write" | "edit" | "bash"
  title: string
  detail: string
}

export type Approve = (request: ApprovalRequest) => Promise<boolean>

export interface ToolContext {
  cwd: string
  approve: Approve
  signal?: AbortSignal
  autoApprove?: boolean
}

export interface ToolResult {
  ok: boolean
  output: string
}

const READ_LIMIT = 2000
const OUTPUT_LIMIT = 30_000

function truncate(value: string, limit = OUTPUT_LIMIT) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n... [truncated ${value.length - limit} characters]`
}

function resolve(context: ToolContext, file: string) {
  return path.isAbsolute(file) ? file : path.resolve(context.cwd, file)
}

async function approved(context: ToolContext, request: ApprovalRequest) {
  if (context.autoApprove) return true
  return context.approve(request)
}

const readTool: ToolDefinition = {
  type: "function",
  function: {
    name: "read",
    description: "Read a text file. Returns line-numbered content. Use offset and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        offset: { type: "number", description: "1-based line to start from" },
        limit: { type: "number", description: "Maximum number of lines" },
      },
      required: ["path"],
    },
  },
}

const writeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
}

const editTool: ToolDefinition = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace an exact string in a file. Fails if old_string is missing or ambiguous.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
}

const bashTool: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command in the working directory and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Timeout in milliseconds, default 120000" },
      },
      required: ["command"],
    },
  },
}

const globTool: ToolDefinition = {
  type: "function",
  function: {
    name: "glob",
    description: "Find files matching a glob pattern, for example **/*.ts.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search, defaults to the working directory" },
      },
      required: ["pattern"],
    },
  },
}

const grepTool: ToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents with a JavaScript regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string", description: "Glob filter such as **/*.ts" },
      },
      required: ["pattern"],
    },
  },
}

const listTool: ToolDefinition = {
  type: "function",
  function: {
    name: "list",
    description: "List entries in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path, defaults to the working directory" },
      },
    },
  },
}

const ALL_TOOLS = [readTool, writeTool, editTool, bashTool, globTool, grepTool, listTool]

export function toolDefinitions(agent: Agent): ToolDefinition[] {
  if (agent.tools === "all") return ALL_TOOLS
  return [readTool, globTool, grepTool, listTool]
}

async function read(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  const content = await fs.readFile(file, "utf8")
  const lines = content.split("\n")
  const offset = Math.max(1, Number(args.offset) || 1)
  const limit = Math.min(READ_LIMIT, Math.max(1, Number(args.limit) || READ_LIMIT))
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const width = String(offset + slice.length - 1).length
  const output = slice
    .map((line, index) => `${String(offset + index).padStart(width, "0")}| ${line}`)
    .join("\n")
  return { ok: true, output: truncate(output) }
}

async function write(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  const content = String(args.content ?? "")
  const ok = await approved(context, {
    kind: "write",
    title: `Write ${file}`,
    detail: `${content.length} characters\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n..." : ""}`,
  })
  if (!ok) return { ok: false, output: "Denied by the user." }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return { ok: true, output: `Wrote ${file} (${content.length} characters)` }
}

async function edit(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  const oldString = String(args.old_string ?? "")
  const newString = String(args.new_string ?? "")
  if (!oldString) return { ok: false, output: "old_string must not be empty" }
  const content = await fs.readFile(file, "utf8")
  const count = content.split(oldString).length - 1
  if (count === 0) return { ok: false, output: `old_string was not found in ${file}` }
  if (count > 1 && !args.replace_all) {
    return { ok: false, output: `old_string appears ${count} times in ${file}; provide more context or set replace_all` }
  }
  const ok = await approved(context, {
    kind: "edit",
    title: `Edit ${file}`,
    detail: `- ${oldString.slice(0, 600)}\n+ ${newString.slice(0, 600)}`,
  })
  if (!ok) return { ok: false, output: "Denied by the user." }
  const next = args.replace_all ? content.split(oldString).join(newString) : content.replace(oldString, newString)
  await fs.writeFile(file, next)
  return { ok: true, output: `Edited ${file} (${count} replacement${count === 1 ? "" : "s"})` }
}

async function bash(context: ToolContext, args: any): Promise<ToolResult> {
  const command = String(args.command || "")
  if (!command.trim()) return { ok: false, output: "command must not be empty" }
  const ok = await approved(context, { kind: "bash", title: "Run command", detail: command })
  if (!ok) return { ok: false, output: "Denied by the user." }

  const timeout = Math.min(600_000, Math.max(1_000, Number(args.timeout) || 120_000))
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: context.cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), timeout)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const parts = []
  if (stdout.trim()) parts.push(stdout.trimEnd())
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`)
  parts.push(`[exit ${code}]`)
  return { ok: code === 0, output: truncate(parts.join("\n")) }
}

async function glob(context: ToolContext, args: any): Promise<ToolResult> {
  const pattern = String(args.pattern || "")
  const root = resolve(context, String(args.path || "."))
  const results: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    if (file.includes("node_modules/") || file.startsWith(".git/")) continue
    results.push(path.relative(context.cwd, path.resolve(root, file)) || file)
    if (results.length >= 300) break
  }
  return { ok: true, output: results.length ? results.join("\n") : "No files matched." }
}

async function grep(context: ToolContext, args: any): Promise<ToolResult> {
  const pattern = String(args.pattern || "")
  const root = resolve(context, String(args.path || "."))
  const include = String(args.include || "**/*")
  let expression: RegExp
  try {
    expression = new RegExp(pattern)
  } catch (error) {
    return { ok: false, output: `Invalid regular expression: ${error instanceof Error ? error.message : error}` }
  }
  const hits: string[] = []
  let scanned = 0
  for await (const file of new Bun.Glob(include).scan({ cwd: root, onlyFiles: true })) {
    if (file.includes("node_modules/") || file.startsWith(".git/")) continue
    const absolute = path.resolve(root, file)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat || stat.size > 1_000_000) continue
    const content = await fs.readFile(absolute, "utf8").catch(() => undefined)
    if (content === undefined || content.includes("\u0000")) continue
    scanned += 1
    for (const [index, line] of content.split("\n").entries()) {
      if (!expression.test(line)) continue
      hits.push(`${path.relative(context.cwd, absolute) || file}:${index + 1}: ${line.trim().slice(0, 300)}`)
      if (hits.length >= 200) break
    }
    if (hits.length >= 200 || scanned >= 3000) break
  }
  return { ok: true, output: hits.length ? hits.join("\n") : "No matches." }
}

async function list(context: ToolContext, args: any): Promise<ToolResult> {
  const root = resolve(context, String(args.path || "."))
  const entries = await fs.readdir(root, { withFileTypes: true })
  const output = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 500)
    .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
    .join("\n")
  return { ok: true, output: output || "Empty directory." }
}

export async function executeTool(name: string, rawArgs: string, context: ToolContext): Promise<ToolResult> {
  let args: any = {}
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, output: `Invalid JSON arguments for ${name}: ${rawArgs.slice(0, 200)}` }
  }
  try {
    switch (name) {
      case "read":
        return await read(context, args)
      case "write":
        return await write(context, args)
      case "edit":
        return await edit(context, args)
      case "bash":
        return await bash(context, args)
      case "glob":
        return await glob(context, args)
      case "grep":
        return await grep(context, args)
      case "list":
        return await list(context, args)
      default:
        return { ok: false, output: `Unknown tool: ${name}` }
    }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

export function describeTool(name: string, rawArgs: string) {
  try {
    const args = JSON.parse(rawArgs || "{}")
    if (name === "bash") return String(args.command || "").split("\n")[0]
    if (args.path) return String(args.path)
    if (args.pattern) return String(args.pattern)
  } catch {}
  return ""
}
