import type { ToolDefinition } from "./api"

export interface GitResult {
  ok: boolean
  output: string
}

const MAX_OUTPUT = 80_000

function clip(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n... [truncated]` : value
}

export async function git(cwd: string, args: string[], timeout = 30_000): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "--no-pager", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_PAGER: "cat" },
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
    }, timeout)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    const output = clip([stdout.trimEnd(), stderr.trim() ? `[stderr]\n${stderr.trimEnd()}` : ""].filter(Boolean).join("\n"))
    return { ok: code === 0, output: output || (code === 0 ? "(no output)" : `git exited with ${code}`) }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

export async function isGitRepo(cwd: string) {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
  return result.ok && result.output.trim() === "true"
}

export async function gitRoot(cwd: string) {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"])
  return result.ok ? result.output.trim() : undefined
}

export async function gitBranch(cwd: string) {
  const result = await git(cwd, ["branch", "--show-current"])
  return result.ok ? result.output.trim() : ""
}

export async function gitStatus(cwd: string) {
  return git(cwd, ["status", "--short", "--branch"])
}

export async function gitDiff(cwd: string, staged = false) {
  return git(cwd, ["diff", ...(staged ? ["--cached"] : [])])
}

export async function gitLog(cwd: string, limit = 10) {
  return git(cwd, ["log", `-${Math.min(100, Math.max(1, limit))}`, "--oneline", "--decorate"])
}

export async function gitShow(cwd: string, ref = "HEAD") {
  return git(cwd, ["show", "--stat", "--oneline", ref])
}

export async function gitCommit(cwd: string, message: string, all = false) {
  if (!message.trim()) return { ok: false, output: "Commit message must not be empty." }
  if (all) {
    const staged = await git(cwd, ["add", "-A"])
    if (!staged.ok) return staged
  }
  const status = await git(cwd, ["status", "--porcelain"])
  if (status.ok && !status.output.trim()) return { ok: false, output: "Nothing to commit." }
  return git(cwd, ["commit", "-m", message])
}

const gitStatusTool: ToolDefinition = {
  type: "function",
  function: {
    name: "git_status",
    description: "Show git working tree status, including the current branch.",
    parameters: { type: "object", properties: {} },
  },
}

const gitDiffTool: ToolDefinition = {
  type: "function",
  function: {
    name: "git_diff",
    description: "Show unstaged or staged git changes.",
    parameters: {
      type: "object",
      properties: { staged: { type: "boolean", description: "Show staged changes instead of unstaged" } },
    },
  },
}

const gitLogTool: ToolDefinition = {
  type: "function",
  function: {
    name: "git_log",
    description: "Show recent git commits.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Number of commits, default 10" } },
    },
  },
}

const gitCommitTool: ToolDefinition = {
  type: "function",
  function: {
    name: "git_commit",
    description: "Create a git commit from staged changes, or stage all changes first when all=true.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        all: { type: "boolean", description: "Stage all changes before committing" },
      },
      required: ["message"],
    },
  },
}

export const GIT_TOOLS = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool]
