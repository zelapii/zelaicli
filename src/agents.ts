export interface Agent {
  id: string
  name: string
  description: string
  tools: "all" | "readonly"
  system: string
  color: string
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
End by asking whether to switch to build mode, unless the user asked only for a plan.`

const BUILD = `${BASE}

You are in BUILD mode. You may read, write, edit files, and run shell commands.
Work in small, verifiable steps. After changing code, run the project's typecheck, lint, or tests when available.
If a command fails, diagnose the real cause before retrying. Do not claim success without evidence.`

const REVIEW = `${BASE}

You are in REVIEW mode. This is read-only.
Review the provided change or code for correctness, regressions, security issues, and missing tests.
Report findings ordered by severity. For each finding give file:line, why it matters, and a concrete fix.
Do not rewrite the code unless the user asks. If there are no findings, say so plainly.`

export const AGENTS: Agent[] = [
  {
    id: "build",
    name: "Build",
    description: "Default agent that can read, edit, and run commands",
    tools: "all",
    system: BUILD,
    color: "#4ade80",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read-only agent that investigates and writes a plan",
    tools: "readonly",
    system: PLAN,
    color: "#60a5fa",
  },
  {
    id: "review",
    name: "Review",
    description: "Read-only code review agent",
    tools: "readonly",
    system: REVIEW,
    color: "#fbbf24",
  },
]

export function findAgent(id: string) {
  return AGENTS.find((agent) => agent.id === id) || AGENTS.find((agent) => agent.id === "build")!
}

export function agentContext(agent: Agent, cwd: string) {
  const now = new Date().toISOString()
  return `${agent.system}

Environment:
- working directory: ${cwd}
- platform: ${process.platform}
- date: ${now}
- tool approvals: the user is asked before writes and shell commands in interactive mode`
}
