import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./api"
import type { Agent } from "./agents"
import { decisionFor, type PermissionConfig } from "./permissions"
import { recordSnapshot } from "./undo"
import type { Todo } from "./session"
import type { Skill } from "./skills"
import { loadIgnore } from "./ignore"
import { runFormatter } from "./formatters"
import { GIT_TOOLS, gitCommit, gitDiff, gitLog, gitStatus } from "./git"
import { LSP_TOOLS, type LspManager } from "./lsp"
import type { PluginManager } from "./plugins"

export interface ApprovalRequest {
  kind:
    | "write"
    | "edit"
    | "bash"
    | "task"
    | "mcp"
    | "read"
    | "glob"
    | "grep"
    | "list"
    | "webfetch"
    | "websearch"
    | "skill"
    | "external_directory"
    | "lsp"
    | "git"
  title: string
  detail: string
}

export type Approve = (request: ApprovalRequest) => Promise<boolean>

export interface ToolContext {
  cwd: string
  sessionId: string
  approve: Approve
  permission?: PermissionConfig
  always?: Set<string>
  signal?: AbortSignal
  autoApprove?: boolean
  runSubagent?: (agent: string, prompt: string) => Promise<string>
  callMcp?: (name: string, args: unknown) => Promise<{ ok: boolean; output: string }>
  skills?: Skill[]
  formatter?: Record<string, string>
  lsp?: LspManager
  plugins?: PluginManager
  agent?: string
  onTodos?: (todos: Todo[]) => void
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
  const decision = decisionFor(context.permission, request.kind, request.detail || request.title)
  if (decision === "allow") return true
  if (decision === "deny") return false
  if (context.always?.has(request.kind)) return true
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

const webfetchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "webfetch",
    description: "Fetch a URL and return its readable text content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http or https URL" },
        max_chars: { type: "number", description: "Maximum characters to return" },
      },
      required: ["url"],
    },
  },
}

const websearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "websearch",
    description: "Search the web and return titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        num: { type: "number", description: "Number of results, default 8" },
      },
      required: ["query"],
    },
  },
}

const applyPatchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Apply a unified diff patch inside the project using git apply.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff text" },
      },
      required: ["patch"],
    },
  },
}

const skillTool: ToolDefinition = {
  type: "function",
  function: {
    name: "skill",
    description: "Load a project or global skill (SKILL.md) by name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
}

const questionTool: ToolDefinition = {
  type: "function",
  function: {
    name: "question",
    description: "Ask the user a question with optional choices before continuing.",
    parameters: {
      type: "object",
      properties: {
        header: { type: "string", description: "Short label" },
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
          },
        },
        multiple: { type: "boolean" },
      },
      required: ["question"],
    },
  },
}

const todoTool: ToolDefinition = {
  type: "function",
  function: {
    name: "todowrite",
    description: "Replace the session todo list. Use for multi-step work.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
}

const taskTool: ToolDefinition = {
  type: "function",
  function: {
    name: "task",
    description:
      "Delegate a focused task to a subagent. The subagent works in the same directory and returns a compact result.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the task" },
        prompt: { type: "string", description: "Full instructions for the subagent" },
        agent: { type: "string", description: "Subagent id, defaults to general" },
      },
      required: ["description", "prompt"],
    },
  },
}

const GIT_READONLY = GIT_TOOLS.filter((tool) => tool.function.name !== "git_commit")
const READONLY_TOOLS = [readTool, globTool, grepTool, listTool, webfetchTool, websearchTool, skillTool, ...GIT_READONLY, ...LSP_TOOLS]
const ALL_TOOLS = [readTool, writeTool, editTool, bashTool, globTool, grepTool, listTool, webfetchTool, websearchTool, applyPatchTool, skillTool, ...GIT_TOOLS, ...LSP_TOOLS]

export function toolDefinitions(
  agent: Agent,
  mcpTools: ToolDefinition[] = [],
  pluginTools: ToolDefinition[] = [],
  options: { lsp?: boolean } = {},
): ToolDefinition[] {
  let list: ToolDefinition[]
  if (agent.tools === "all") list = [...ALL_TOOLS]
  else if (agent.tools === "readonly") list = [...READONLY_TOOLS]
  else list = ALL_TOOLS.filter((tool) => agent.tools.includes(tool.function.name))
  if (!options.lsp) list = list.filter((tool) => !tool.function.name.startsWith("lsp_"))
  if (agent.mode !== "subagent") list.push(taskTool)
  if (agent.tools !== "readonly") list.push(...mcpTools.filter((tool) => !list.some((entry) => entry.function.name === tool.function.name)))
  if (agent.tools !== "readonly") list.push(...pluginTools.filter((tool) => !list.some((entry) => entry.function.name === tool.function.name)))
  if (!list.some((tool) => tool.function.name === "todowrite")) list.push(todoTool)
  if (!list.some((tool) => tool.function.name === "question")) list.push(questionTool)
  return list
}

async function task(context: ToolContext, args: any): Promise<ToolResult> {
  const agent = String(args.agent || "general")
  const prompt = String(args.prompt || "")
  if (!prompt.trim()) return { ok: false, output: "prompt must not be empty" }
  const ok = await approved(context, {
    kind: "task",
    title: `Run ${agent} subagent`,
    detail: `${args.description || "task"}\n\n${prompt.slice(0, 1200)}`,
  })
  if (!ok) return { ok: false, output: "Denied by the user." }
  if (!context.runSubagent) return { ok: false, output: "Subagents are not available in this mode." }
  const output = await context.runSubagent(agent, prompt)
  return { ok: true, output: truncate(output) }
}

async function ensureAllowed(context: ToolContext, file: string) {
  const relative = path.relative(context.cwd, file)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true
  if (!relative) return true
  return approved(context, {
    kind: "external_directory",
    title: "Access outside the project",
    detail: file,
  })
}

async function read(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  if (!(await ensureAllowed(context, file))) return { ok: false, output: "Denied by the user." }
  if (!(await approved(context, { kind: "read", title: "Read file", detail: file }))) return { ok: false, output: "Denied by the user." }
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

async function lspNote(context: ToolContext, file: string) {
  if (!context.lsp) return ""
  try {
    const output = await Promise.race([
      context.lsp.diagnostics(file),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 8000)),
    ])
    if (!output || output === "No diagnostics.") return ""
    return `\n\nDiagnostics:\n${output}`
  } catch {
    return ""
  }
}

async function write(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  const content = String(args.content ?? "")
  if (!(await ensureAllowed(context, file))) return { ok: false, output: "Denied by the user." }
  const ok = await approved(context, {
    kind: "write",
    title: `Write ${file}`,
    detail: `${content.length} characters\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n..." : ""}`,
  })
  if (!ok) return { ok: false, output: "Denied by the user." }
  const before = await fs.readFile(file, "utf8").catch(() => null)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  const formatError = await runFormatter(file, context.formatter, context.cwd)
  await recordSnapshot(context.sessionId, file, before)
  const diagnostics = await lspNote(context, file)
  return { ok: true, output: `Wrote ${file} (${content.length} characters)${formatError ? `\n${formatError}` : ""}${diagnostics}` }
}

async function edit(context: ToolContext, args: any): Promise<ToolResult> {
  const file = resolve(context, String(args.path || ""))
  const oldString = String(args.old_string ?? "")
  const newString = String(args.new_string ?? "")
  if (!oldString) return { ok: false, output: "old_string must not be empty" }
  if (!(await ensureAllowed(context, file))) return { ok: false, output: "Denied by the user." }
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
  const formatError = await runFormatter(file, context.formatter, context.cwd)
  await recordSnapshot(context.sessionId, file, content)
  const diagnostics = await lspNote(context, file)
  const preview = [
    ...oldString.split("\n").slice(0, 6).map((line) => `- ${line}`),
    ...newString.split("\n").slice(0, 6).map((line) => `+ ${line}`),
  ].join("\n")
  return { ok: true, output: `Edited ${file} (${count} replacement${count === 1 ? "" : "s"})\n${preview}${formatError ? `\n${formatError}` : ""}${diagnostics}` }
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
  if (!(await ensureAllowed(context, root))) return { ok: false, output: "Denied by the user." }
  if (!(await approved(context, { kind: "glob", title: "Find files", detail: pattern }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const ignored = await loadIgnore(context.cwd)
  const results: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    if (file.includes("node_modules/") || file.startsWith(".git/")) continue
    const relative = path.relative(context.cwd, path.resolve(root, file)) || file
    if (ignored(relative)) continue
    results.push(relative)
    if (results.length >= 300) break
  }
  return { ok: true, output: results.length ? results.join("\n") : "No files matched." }
}

async function grep(context: ToolContext, args: any): Promise<ToolResult> {
  const pattern = String(args.pattern || "")
  const root = resolve(context, String(args.path || "."))
  const include = String(args.include || "**/*")
  if (!(await ensureAllowed(context, root))) return { ok: false, output: "Denied by the user." }
  if (!(await approved(context, { kind: "grep", title: "Search files", detail: pattern }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const ignored = await loadIgnore(context.cwd)
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
    if (ignored(path.relative(context.cwd, absolute) || file)) continue
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
  if (!(await ensureAllowed(context, root))) return { ok: false, output: "Denied by the user." }
  if (!(await approved(context, { kind: "list", title: "List directory", detail: root }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const ignored = await loadIgnore(context.cwd)
  const entries = await fs.readdir(root, { withFileTypes: true })
  const output = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .filter((entry) => !ignored(path.relative(context.cwd, path.join(root, entry.name)) || entry.name))
    .slice(0, 500)
    .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
    .join("\n")
  return { ok: true, output: output || "Empty directory." }
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  )
}

async function webfetch(context: ToolContext, args: any): Promise<ToolResult> {
  const raw = String(args.url || "").trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, output: `Invalid URL: ${raw}` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, output: "Only http and https URLs are supported." }
  }
  if (!(await approved(context, { kind: "webfetch", title: "Fetch URL", detail: url.toString() }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const response = await fetch(url, {
    headers: { "user-agent": "ZelAI/0.1 (+https://ai.zelai.qzz.io)", accept: "text/html,application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  }).catch((error) => {
    throw new Error(`Fetch failed: ${error instanceof Error ? error.message : error}`)
  })
  if (!response.ok) return { ok: false, output: `HTTP ${response.status} ${response.statusText}` }
  const type = response.headers.get("content-type") || ""
  const text = await response.text()
  const body = type.includes("html") ? htmlToText(text) : text
  const limit = Math.min(400_000, Math.max(1000, Number(args.max_chars) || 60_000))
  return { ok: true, output: body.length > limit ? `${body.slice(0, limit)}\n... [truncated]` : body }
}

async function websearch(context: ToolContext, args: any): Promise<ToolResult> {
  const query = String(args.query || "").trim()
  if (!query) return { ok: false, output: "query must not be empty" }
  if (!(await approved(context, { kind: "websearch", title: "Search the web", detail: query }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const limit = Math.min(15, Math.max(1, Number(args.num) || 8))
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; ZelAI/0.1)", accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : error}`)
  })
  if (!response.ok) return { ok: false, output: `Search failed with HTTP ${response.status}` }
  const html = await response.text()
  const links: { title: string; url: string }[] = []
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1]
    if (!/result__a/.test(attrs)) continue
    const href = /href="([^"]+)"/.exec(attrs)?.[1]
    if (!href) continue
    let url = href
    try {
      const parsed = new URL(href, "https://duckduckgo.com")
      url = parsed.searchParams.get("uddg") || (href.startsWith("//") ? `https:${href}` : href)
    } catch {}
    const title = htmlToText(match[2]).replace(/\s+/g, " ").trim()
    if (title && url.startsWith("http")) links.push({ title, url })
    if (links.length >= limit) break
  }
  if (!links.length) return { ok: false, output: "No search results found." }
  const snippets = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/gi)].map((match) =>
    htmlToText(match[1]).replace(/\s+/g, " ").trim(),
  )
  return {
    ok: true,
    output: links
      .map((entry, index) => `${index + 1}. ${entry.title}\n${entry.url}${snippets[index] ? `\n${snippets[index]}` : ""}`)
      .join("\n\n"),
  }
}

async function applyPatch(context: ToolContext, args: any): Promise<ToolResult> {
  const patch = String(args.patch ?? args.patchText ?? "")
  if (!patch.trim()) return { ok: false, output: "patch must not be empty" }
  if (!(await approved(context, { kind: "edit", title: "Apply patch", detail: patch.slice(0, 1200) }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const files = new Set<string>()
  for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(match[1].trim())
  for (const match of patch.matchAll(/^--- a\/(.+)$/gm)) files.add(match[1].trim())
  const before = new Map<string, string | null>()
  for (const file of files) {
    const absolute = resolve(context, file)
    before.set(absolute, await fs.readFile(absolute, "utf8").catch(() => null))
  }
  const proc = Bun.spawn(["git", "apply", "--whitespace=nowarn", "-"], {
    cwd: context.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(patch)
  await proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    return { ok: false, output: truncate(`git apply failed (exit ${code})\n${stderr || stdout}`.trim()) }
  }
  for (const [file, content] of before) await recordSnapshot(context.sessionId, file, content)
  const notes: string[] = []
  for (const file of files.keys()) {
    const note = await lspNote(context, file)
    if (note) notes.push(`${file}${note}`)
  }
  return { ok: true, output: `Applied patch to ${files.size} file${files.size === 1 ? "" : "s"}${notes.length ? `\n\nDiagnostics:${notes.join("\n")}` : ""}` }
}

async function skill(context: ToolContext, args: any): Promise<ToolResult> {
  const name = String(args.name || "").trim()
  if (!name) return { ok: false, output: `Available skills: ${(context.skills || []).map((entry) => entry.name).join(", ") || "none"}` }
  if (!(await approved(context, { kind: "skill", title: "Load skill", detail: name }))) {
    return { ok: false, output: "Denied by the user." }
  }
  const found = (context.skills || []).find((entry) => entry.name === name)
  if (!found) {
    return { ok: false, output: `Unknown skill: ${name}. Available: ${(context.skills || []).map((entry) => entry.name).join(", ") || "none"}` }
  }
  return { ok: true, output: truncate(`# Skill: ${found.name}\n\n${found.content}`) }
}

async function gitTool(context: ToolContext, action: "status" | "diff" | "log" | "commit", args: any): Promise<ToolResult> {
  const detail =
    action === "commit"
      ? `git commit -m ${JSON.stringify(String(args.message || ""))}${args.all ? " (stage all)" : ""}`
      : `git ${action}`
  const ok = await approved(context, { kind: "git", title: `Git ${action}`, detail })
  if (!ok) return { ok: false, output: "Denied by the user." }
  if (action === "status") return gitStatus(context.cwd)
  if (action === "diff") return gitDiff(context.cwd, Boolean(args.staged))
  if (action === "log") return gitLog(context.cwd, Number(args.limit) || 10)
  return gitCommit(context.cwd, String(args.message || ""), Boolean(args.all))
}

async function lspTool(context: ToolContext, action: "diagnostics" | "definition" | "references" | "hover", args: any): Promise<ToolResult> {
  if (!context.lsp) return { ok: false, output: "LSP is not enabled. Set lsp to true or configure servers in zelai.json." }
  const file = resolve(context, String(args.path || ""))
  const ok = await approved(context, { kind: "lsp", title: `LSP ${action}`, detail: file })
  if (!ok) return { ok: false, output: "Denied by the user." }
  if (action === "diagnostics") return { ok: true, output: await context.lsp.diagnostics(file) }
  const line = Math.max(1, Number(args.line) || 1)
  const character = Math.max(1, Number(args.character) || 1)
  if (action === "definition") return { ok: true, output: await context.lsp.definition(file, line, character) }
  if (action === "references") return { ok: true, output: await context.lsp.references(file, line, character) }
  return { ok: true, output: await context.lsp.hover(file, line, character) }
}

async function executeBuiltIn(name: string, rawArgs: string, context: ToolContext): Promise<ToolResult> {
  let args: any = {}
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, output: `Invalid JSON arguments for ${name}: ${rawArgs.slice(0, 200)}` }
  }
  try {
    if (name.startsWith("mcp__")) {
      const ok = await approved(context, {
        kind: "mcp",
        title: `MCP tool ${name}`,
        detail: rawArgs.slice(0, 1200),
      })
      if (!ok) return { ok: false, output: "Denied by the user." }
      if (!context.callMcp) return { ok: false, output: "MCP is not available in this mode." }
      return await context.callMcp(name, args)
    }
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
      case "webfetch":
        return await webfetch(context, args)
      case "websearch":
        return await websearch(context, args)
      case "apply_patch":
        return await applyPatch(context, args)
      case "skill":
        return await skill(context, args)
      case "task":
        return await task(context, args)
      case "git_status":
        return await gitTool(context, "status", args)
      case "git_diff":
        return await gitTool(context, "diff", args)
      case "git_log":
        return await gitTool(context, "log", args)
      case "git_commit":
        return await gitTool(context, "commit", args)
      case "lsp_diagnostics":
        return await lspTool(context, "diagnostics", args)
      case "lsp_definition":
        return await lspTool(context, "definition", args)
      case "lsp_references":
        return await lspTool(context, "references", args)
      case "lsp_hover":
        return await lspTool(context, "hover", args)
      default:
        return { ok: false, output: `Unknown tool: ${name}` }
    }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

export async function executeTool(name: string, rawArgs: string, context: ToolContext): Promise<ToolResult> {
  let args: any = {}
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, output: `Invalid JSON arguments for ${name}: ${rawArgs.slice(0, 200)}` }
  }
  try {
    if (context.plugins) args = await context.plugins.before(name, args)
    let outcome: ToolResult
    if (context.plugins?.has(name)) {
      outcome = await context.plugins.execute(name, args, {
        cwd: context.cwd,
        directory: context.cwd,
        worktree: context.cwd,
        sessionId: context.sessionId,
        agent: context.agent || "",
        signal: context.signal,
      })
    } else {
      outcome = await executeBuiltIn(name, JSON.stringify(args ?? {}), context)
    }
    if (context.plugins) outcome = await context.plugins.after(name, args, outcome)
    return outcome
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

export function describeTool(name: string, rawArgs: string) {
  try {
    const args = JSON.parse(rawArgs || "{}")
    if (name === "bash") return String(args.command || "").split("\n")[0]
    if (name === "webfetch") return String(args.url || "")
    if (name === "websearch") return String(args.query || "")
    if (name === "skill") return String(args.name || "")
    if (args.path) return String(args.path)
    if (args.pattern) return String(args.pattern)
  } catch {}
  return ""
}
