import path from "node:path"
import { readMarkdownDir, listValue } from "./markdown"
import { globalAgentDirs, projectAgentDirs } from "./project"

export type AgentTools = "all" | "readonly" | string[]
export type AgentMode = "primary" | "subagent"

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
  return agents.filter((agent) => agent.mode === "primary")
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
    const mode = (file.data.mode === "primary" ? "primary" : "subagent") as AgentMode
    return {
      id: file.name,
      name: file.data.name || file.name,
      description: file.data.description || file.body.split("\n")[0]?.slice(0, 120) || `Custom agent ${file.name}`,
      tools: normalizeTools(file.data.tools),
      mode,
      ...(mode === "primary"
        ? { subagents: listValue(file.data.subagents) || ["general"] }
        : {}),
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

export function agentContext(agent: Agent, cwd: string, instructions = "", summary = "") {
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
