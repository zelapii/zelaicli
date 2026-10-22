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
): PermissionDecision {
  if (kind === "bash") return bashDecision(config, detail)
  if (kind === "write" || kind === "edit") return config?.edit ?? "ask"
  if (kind === "task") return config?.task ?? "ask"
  if (kind === "mcp") return config?.mcp ?? "ask"
  if (kind === "external_directory") return config?.external_directory ?? "ask"
  return (config as any)?.[kind] ?? "allow"
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
