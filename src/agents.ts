import path from "node:path"
import { readMarkdownDir, listValue } from "./markdown"
import type { PermissionConfig } from "./permissions"
import { globalAgentDirs, projectAgentDirs } from "./project"

export type AgentTools = "all" | "readonly" | string[]
export type AgentMode = "primary" | "subagent" | "all"

export interface Agent {
  id: string
  name: string
  description: string
  tools: AgentTools
  mode: AgentMode
  subagents?: string[]
  system: string
  color: string
  source: "builtin" | "global" | "project"
  model?: string
  temperature?: number
  topP?: number
  steps?: number
  permission?: PermissionConfig
  hidden?: boolean
}

const BASE = `You are ZelAI, a coding agent running in the user's terminal.
You help with software engineering: reading code, explaining it, planning changes, editing files, and running commands.
Be concise and concrete. Prefer doing the work over describing it.
When you need information, use tools instead of guessing.
Never invent file contents, command output, or API behavior.
When you finish, state what changed and how it was verified.`

const PLAN = `${BASE}

You are in PLAN mode. This is read-only.
Do not write or edit files, and do not run commands that mutate the workspace.
Investigate the repository with read-only tools, then produce a clear plan:
- goal and constraints
- relevant files with paths
- step-by-step changes
- risks and verification steps
Use the todowrite tool to track plan steps when the work has more than two steps.`

const BUILD = `${BASE}

You are in BUILD mode. You may read, write, edit files, and run shell commands.
Work in small, verifiable steps. After changing code, run the project's typecheck, lint, or tests when available.
If a command fails, diagnose the real cause before retrying. Do not claim success without evidence.
Use todowrite for multi-step work, and task to delegate focused research to a subagent.`

const REVIEW = `${BASE}

You are in REVIEW mode. This is read-only.
Review the provided change or code for correctness, regressions, security issues, and missing tests.
Report findings ordered by severity. For each finding give file:line, why it matters, and a concrete fix.
Do not rewrite the code unless the user asks. If there are no findings, say so plainly.`

const EXPLORE = `${BASE}

You are an exploration subagent. You are read-only.
Find relevant files, symbols, and flows quickly using glob, grep, read, and list.
Return a compact map of the codebase with file paths and line numbers. Do not propose large rewrites.`

const SCOUT = `${BASE}

You are an external research subagent. You are read-only in the workspace.
Use webfetch and websearch to check documentation, upstream source, and dependency behavior.
Return concise findings with links and exact version or path evidence.`

const GENERAL = `${BASE}

You are a subagent. Work only on the task you were given.
Investigate with tools, return a compact result with file paths and evidence.
Do not ask the user questions; make reasonable assumptions and state them.`

export const AGENTS: Agent[] = [
  {
    id: "build",
    name: "Build",
    description: "Default agent that can read, edit, and run commands",
    tools: "all",
    mode: "primary",
    subagents: ["general", "plan", "review"],
    system: BUILD,
    color: "#4ade80",
    source: "builtin",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read-only agent that investigates and writes a plan",
    tools: "readonly",
    mode: "primary",
    subagents: ["general"],
    system: PLAN,
    color: "#60a5fa",
    source: "builtin",
  },
  {
    id: "review",
    name: "Review",
    description: "Read-only code review agent",
    tools: "readonly",
    mode: "primary",
    subagents: ["general"],
    system: REVIEW,
    color: "#fbbf24",
    source: "builtin",
  },
  {
    id: "explore",
    name: "Explore",
    description: "Fast read-only codebase exploration",
    tools: "readonly",
    mode: "subagent",
    system: EXPLORE,
    color: "#38bdf8",
    source: "builtin",
  },
  {
    id: "scout",
    name: "Scout",
    description: "Read-only external docs and dependency research",
    tools: "readonly",
    mode: "subagent",
    system: SCOUT,
    color: "#f472b6",
    source: "builtin",
  },
  {
    id: "general",
    name: "General",
    description: "Subagent for focused research and implementation",
    tools: "all",
    mode: "subagent",
    system: GENERAL,
    color: "#c084fc",
    source: "builtin",
  },
]

export function findAgent(id: string, agents: Agent[] = AGENTS) {
  return agents.find((agent) => agent.id === id) || agents.find((agent) => agent.id === "build") || AGENTS[0]
}

export function primaryAgents(agents: Agent[]) {
  return agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
}

function normalizeMode(value: string | undefined): AgentMode {
  if (value === "primary" || value === "subagent") return value
  return "all"
}

function numberValue(value: string | undefined) {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parsePermission(value: string | undefined): PermissionConfig | undefined {
  if (!value) return undefined
  if (value.trim().startsWith("{")) {
    try {
      return JSON.parse(value) as PermissionConfig
    } catch {
      return undefined
    }
  }
  const config: Record<string, string> = {}
  for (const part of value.split(",")) {
    const [key, action] = part.split("=").map((item) => item.trim())
    if (key && (action === "allow" || action === "ask" || action === "deny")) config[key] = action
  }
  return Object.keys(config).length ? (config as PermissionConfig) : undefined
}

function normalizeTools(value: string | undefined): AgentTools {
  if (!value) return "all"
  if (value === "readonly") return "readonly"
  if (value === "all") return "all"
  return listValue(value) || "all"
}

async function loadDir(directory: string, source: "global" | "project"): Promise<Agent[]> {
  const files = await readMarkdownDir(directory)
  return files.map((file) => {
    const mode = normalizeMode(file.data.mode)
    const permission = parsePermission(file.data.permission)
    return {
      id: file.name,
      name: file.data.name || file.name,
      description: file.data.description || file.body.split("\n")[0]?.slice(0, 120) || `Custom agent ${file.name}`,
      tools: normalizeTools(file.data.tools),
      mode,
      ...(mode !== "subagent" ? { subagents: listValue(file.data.subagents) || ["general"] } : {}),
      ...(file.data.model ? { model: file.data.model } : {}),
      ...(numberValue(file.data.temperature) !== undefined ? { temperature: numberValue(file.data.temperature) } : {}),
      ...(numberValue(file.data.top_p) !== undefined ? { topP: numberValue(file.data.top_p) } : {}),
      ...(numberValue(file.data.steps) !== undefined ? { steps: numberValue(file.data.steps) } : {}),
      ...(permission ? { permission } : {}),
      ...(file.data.hidden === "true" || file.data.hidden === "1" ? { hidden: true } : {}),
      system: file.body || BASE,
      color: file.data.color || "#c084fc",
      source,
    } satisfies Agent
  })
}

export async function loadAgents(cwd: string) {
  const agents = new Map(AGENTS.map((agent) => [agent.id, agent]))
  for (const directory of await globalAgentDirs()) {
    for (const agent of await loadDir(directory, "global")) agents.set(agent.id, agent)
  }
  for (const directory of await projectAgentDirs(cwd)) {
    for (const agent of await loadDir(directory, "project")) agents.set(agent.id, agent)
  }
  return [...agents.values()]
}

export function agentContext(agent: Agent, cwd: string, instructions = "", summary = "", skills = "") {
  const now = new Date().toISOString()
  const parts = [
    agent.system,
    `Environment:
- working directory: ${cwd}
- platform: ${process.platform}
- date: ${now}
- tool approvals: writes and shell commands may require user approval`,
  ]
  if (instructions) parts.push(`Project instructions:\n\n${instructions}`)
  if (summary) parts.push(`Summary of earlier conversation:\n\n${summary}`)
  return parts.join("\n\n")
}
