export interface ModelPrice {
  input: number
  output: number
}

export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet": { input: 3, output: 15 },
  "claude-opus": { input: 15, output: 75 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-7-sonnet-latest": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-sonnet-20240620": { input: 3, output: 15 },
  "claude-3-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-2024-08-06": { input: 2.5, output: 10 },
  "gpt-4o-2024-11-20": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  o3: { input: 2, output: 8 },
  "o3-mini": { input: 1.1, output: 4.4 },
  o4: { input: 2, output: 8 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "deepseek-v3": { input: 0.27, output: 1.1 },
  "deepseek-r1": { input: 0.55, output: 2.19 },
  "kimi-k2": { input: 0.6, output: 2.5 },
  kimi: { input: 0.6, output: 2.5 },
  "kimi-k1.5": { input: 0.6, output: 2.5 },
  "qwen-max": { input: 1.6, output: 6.4 },
  "qwen-plus": { input: 0.4, output: 1.2 },
  "qwen-turbo": { input: 0.05, output: 0.2 },
  qwen: { input: 0.4, output: 1.2 },
  qwen3: { input: 0.4, output: 1.2 },
  nemotron: { input: 0.6, output: 0.6 },
  "llama-3.1-nemotron": { input: 0.6, output: 0.6 },
  "nemotron-4-340b": { input: 1.2, output: 1.2 },
}

function resolve(
  table: Record<string, ModelPrice | { input: number; output: number }>,
  id: string,
): ModelPrice | undefined {
  if (!id) return undefined
  if (Object.prototype.hasOwnProperty.call(table, id)) {
    const price = table[id]
    return { input: price.input, output: price.output }
  }
  const keys = Object.keys(table)
  const lower = id.toLowerCase()
  const exact = keys.find((key) => key.toLowerCase() === lower)
  if (exact) {
    const price = table[exact]
    return { input: price.input, output: price.output }
  }
  const slash = id.lastIndexOf("/")
  if (slash >= 0) {
    const suffix = id.slice(slash + 1)
    if (Object.prototype.hasOwnProperty.call(table, suffix)) {
      const price = table[suffix]
      return { input: price.input, output: price.output }
    }
    const lowerSuffix = suffix.toLowerCase()
    const match = keys.find((key) => key.toLowerCase() === lowerSuffix)
    if (match) {
      const price = table[match]
      return { input: price.input, output: price.output }
    }
  }
  return undefined
}

export function priceFor(
  model: string,
  overrides?: Record<string, ModelPrice | { input: number; output: number }>,
): ModelPrice | undefined {
  if (overrides) {
    const price = resolve(overrides, model)
    if (price) return price
  }
  return resolve(BUILTIN_PRICES, model)
}

export function estimateCost(
  model: string,
  usage: { prompt: number; completion: number },
  overrides?: Record<string, ModelPrice | { input: number; output: number }>,
): { input: number; output: number; total: number } | undefined {
  const price = priceFor(model, overrides)
  if (!price) return undefined
  const prompt = Number.isFinite(usage.prompt) ? Math.max(0, usage.prompt) : 0
  const completion = Number.isFinite(usage.completion) ? Math.max(0, usage.completion) : 0
  const input = (prompt / 1_000_000) * price.input
  const output = (completion / 1_000_000) * price.output
  return { input, output, total: input + output }
}

export function formatCost(cost: { total: number }): string {
  const total = Number.isFinite(cost.total) ? Math.max(0, cost.total) : 0
  if (total === 0) return "$0.00"
  if (total < 0.01) return `$${total.toFixed(6)}`
  if (total < 1) return `$${total.toFixed(4)}`
  return `$${total.toFixed(2)}`
}
