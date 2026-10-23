import fs from "node:fs/promises"
import path from "node:path"
import { dataDir } from "./paths"
import { parseJsonc } from "./config"

export type PolicyAction = "provider.use" | "tool.use" | "integration.use"
export type PolicyEffect = "allow" | "deny"

export interface PolicyRule {
  action: PolicyAction | "*"
  resource: string
  effect: PolicyEffect
}

export interface PolicySet {
  rules: PolicyRule[]
  version?: number
}

export interface PolicyContext {
  provider?: string
  model?: string
  tool?: string
  integration?: string
}

export interface PolicyExplanation {
  effect: PolicyEffect | "unspecified"
  rule?: PolicyRule
}

const ACTIONS = new Set<PolicyAction | "*">(["provider.use", "tool.use", "integration.use", "*"])
const ENV_KEYS = ["ZELAI_POLICIES", "OPENCODE_POLICIES"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAction(value: unknown): value is PolicyAction | "*" {
  return typeof value === "string" && ACTIONS.has(value as PolicyAction | "*")
}

function isEffect(value: unknown): value is PolicyEffect {
  return value === "allow" || value === "deny"
}

function normalizeRule(value: unknown): PolicyRule | undefined {
  if (!isRecord(value)) return undefined
  const action = value.action
  const resource = value.resource
  const effect = value.effect
  if (!isAction(action) || typeof resource !== "string" || resource.length === 0 || !isEffect(effect)) return undefined
  return { action, resource, effect }
}

function addRule(rules: PolicyRule[], rule: PolicyRule) {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const existing = rules[index]
    if (existing.action !== rule.action || existing.resource !== rule.resource) continue
    rules.splice(index, 1)
  }
  rules.push(rule)
}

function addRecordValue(rules: PolicyRule[], action: PolicyAction | "*", value: unknown) {
  if (typeof value === "string") {
    if (isEffect(value)) addRule(rules, { action, resource: "*", effect: value })
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        addRule(rules, { action, resource: entry, effect: "allow" })
        continue
      }
      if (!isRecord(entry)) continue
      const resource = entry.resource
      const effect = entry.effect
      if (typeof resource !== "string" || resource.length === 0 || !isEffect(effect)) continue
      addRule(rules, { action, resource, effect })
    }
    return
  }
  if (!isRecord(value)) return
  for (const [resource, effect] of Object.entries(value)) {
    if (resource.length === 0 || !isEffect(effect)) continue
    addRule(rules, { action, resource, effect })
  }
}

export function normalizePolicy(input: unknown): PolicySet {
  const rules: PolicyRule[] = []
  let version: number | undefined
  if (Array.isArray(input)) {
    for (const entry of input) {
      const rule = normalizeRule(entry)
      if (rule) addRule(rules, rule)
    }
    return { rules }
  }
  if (!isRecord(input)) return { rules }
  if (typeof input.version === "number" && Number.isFinite(input.version)) version = input.version
  if (Array.isArray(input.rules)) {
    for (const entry of input.rules) {
      const rule = normalizeRule(entry)
      if (rule) addRule(rules, rule)
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "rules" || key === "version") continue
    if (!isAction(key)) continue
    addRecordValue(rules, key, value)
  }
  return version === undefined ? { rules } : { rules, version }
}

function escapeRegex(value: string) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

export function matchResource(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  const escaped = escapeRegex(pattern).replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

function candidates(action: PolicyAction, resource: string, context?: PolicyContext): string[] {
  if (resource.length > 0) return [resource]
  const values: string[] = []
  const push = (value: string | undefined) => {
    if (!value || values.includes(value)) return
    values.push(value)
  }
  if (action === "provider.use") {
    if (context?.provider) {
      push(context.provider)
      if (context.model) push(`${context.provider}/${context.model}`)
      push(`${context.provider}/`)
    }
    push(context?.model)
  } else if (action === "tool.use") {
    push(context?.tool)
  } else if (action === "integration.use") {
    push(context?.integration)
  }
  if (values.length === 0) values.push("")
  return values
}

function resolve(policies: PolicySet, action: PolicyAction, resource: string, context?: PolicyContext): PolicyExplanation {
  const values = candidates(action, resource, context)
  let effect: PolicyEffect | undefined
  let rule: PolicyRule | undefined
  for (const entry of policies.rules) {
    if (entry.action !== action && entry.action !== "*") continue
    if (!values.some((value) => matchResource(entry.resource, value))) continue
    effect = entry.effect
    rule = entry
  }
  if (!effect) return { effect: "unspecified" }
  return { effect, rule }
}

export function evaluatePolicy(
  policies: PolicySet,
  action: PolicyAction,
  resource: string,
  context?: PolicyContext,
): PolicyEffect | "unspecified" {
  return resolve(policies, action, resource, context).effect
}

export function explainPolicy(
  policies: PolicySet,
  action: PolicyAction,
  resource: string,
  context?: PolicyContext,
): PolicyExplanation {
  return resolve(policies, action, resource, context)
}

export function isToolAllowed(policies: PolicySet, tool: string): boolean {
  return evaluatePolicy(policies, "tool.use", tool) !== "deny"
}

export function isProviderAllowed(policies: PolicySet, provider: string, model?: string): boolean {
  return evaluatePolicy(policies, "provider.use", model ? `${provider}/${model}` : "", { provider, model }) !== "deny"
}

export function isIntegrationAllowed(policies: PolicySet, integration: string): boolean {
  return evaluatePolicy(policies, "integration.use", integration) !== "deny"
}

export function mergePolicies(...sets: PolicySet[]): PolicySet {
  const rules: PolicyRule[] = []
  let version: number | undefined
  for (const set of sets) {
    for (const rule of set.rules) rules.push({ ...rule })
    if (set.version !== undefined) version = set.version
  }
  return version === undefined ? { rules } : { rules, version }
}

function extractConfigPolicies(config: unknown): unknown {
  if (!isRecord(config)) return config
  if ("policies" in config) return config.policies
  if ("policy" in config) return config.policy
  return config
}

function parsePolicyJson(raw: string): unknown {
  try {
    return parseJsonc(raw)
  } catch {
    return undefined
  }
}

async function readPolicyFile(file: string): Promise<unknown> {
  try {
    return parsePolicyJson(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

export async function loadPolicies(
  sources: { config?: unknown; file?: string; env?: Record<string, string | undefined> } = {},
): Promise<PolicySet> {
  const sets: PolicySet[] = []
  if (sources.config !== undefined) sets.push(normalizePolicy(extractConfigPolicies(sources.config)))
  const file = sources.file ?? path.join(dataDir(), "policies.json")
  const fromFile = await readPolicyFile(file)
  if (fromFile !== undefined) sets.push(normalizePolicy(fromFile))
  const env = sources.env ?? process.env
  for (const key of ENV_KEYS) {
    const raw = env[key]
    if (!raw) continue
    const parsed = parsePolicyJson(raw)
    if (parsed !== undefined) sets.push(normalizePolicy(parsed))
  }
  return mergePolicies(...sets)
}
