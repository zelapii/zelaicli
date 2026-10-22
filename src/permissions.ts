export type PermissionDecision = "allow" | "ask" | "deny"

export interface PermissionConfig {
  edit?: PermissionDecision
  bash?: PermissionDecision | Record<string, PermissionDecision>
  task?: PermissionDecision
  mcp?: PermissionDecision
  read?: PermissionDecision
  glob?: PermissionDecision
  grep?: PermissionDecision
  list?: PermissionDecision
  webfetch?: PermissionDecision
  websearch?: PermissionDecision
  skill?: PermissionDecision
  external_directory?: PermissionDecision
  question?: PermissionDecision
  lsp?: PermissionDecision
  git?: PermissionDecision
  custom?: PermissionDecision
  [pattern: string]: PermissionDecision | Record<string, PermissionDecision> | undefined
}

export type PermissionKind =
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
  | "question"
  | "lsp"
  | "git"
  | "custom"

const BASE_KEYS = new Set([
  "edit",
  "bash",
  "task",
  "mcp",
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "skill",
  "external_directory",
  "question",
  "lsp",
  "git",
  "custom",
])

function wildcard(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

export function bashDecision(config: PermissionConfig | undefined, command: string): PermissionDecision {
  const setting = config?.bash
  if (!setting) return "ask"
  if (typeof setting === "string") return setting
  const entries = Object.entries(setting).sort(([a], [b]) => b.length - a.length)
  for (const [pattern, decision] of entries) {
    if (wildcard(pattern, command.trim())) return decision
  }
  return setting["*"] ?? "ask"
}

export function decisionFor(
  config: PermissionConfig | undefined,
  kind: PermissionKind,
  detail: string,
  toolName?: string,
): PermissionDecision {
  let decision: PermissionDecision
  if (kind === "bash") decision = bashDecision(config, detail)
  else if (kind === "write" || kind === "edit") decision = config?.edit ?? "ask"
  else if (kind === "task") decision = config?.task ?? "ask"
  else if (kind === "mcp") decision = config?.mcp ?? "ask"
  else if (kind === "external_directory") decision = config?.external_directory ?? "ask"
  else if (kind === "custom") decision = config?.custom ?? "allow"
  else decision = (config?.[kind] as PermissionDecision | undefined) ?? "allow"

  const name = toolName || kind
  const patterns = Object.entries(config || {})
    .filter((entry): entry is [string, PermissionDecision] => typeof entry[1] === "string" && !BASE_KEYS.has(entry[0]))
    .sort(([a], [b]) => a.length - b.length)
  for (const [pattern, value] of patterns) {
    if (wildcard(pattern, name) || wildcard(pattern, kind)) decision = value
  }
  return decision
}

export function mergePermission(base: PermissionConfig | undefined, override: PermissionConfig | undefined): PermissionConfig {
  if (!base) return { ...(override || {}) }
  if (!override) return { ...base }
  const merged: PermissionConfig = { ...base, ...override }
  if (base.bash && override.bash && typeof base.bash === "object" && typeof override.bash === "object") {
    merged.bash = { ...base.bash, ...override.bash }
  }
  return merged
}
