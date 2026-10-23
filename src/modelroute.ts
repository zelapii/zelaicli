import type { Config } from "./config"
import { loadProviders, parseModelRef, resolveProvider, variantOptions } from "./providers"

export interface ChatRoute {
  provider?: string
  model: string
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  extra: Record<string, unknown>
  variant?: string
}

function stripV1(value: string) {
  return value.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export async function chatRoute(config: Config, ref: string): Promise<ChatRoute> {
  const parsed = parseModelRef(ref)
  const providers = await loadProviders({ config: config.providers, env: process.env })
  const resolved = resolveProvider(providers, ref)
  const baseUrl = stripV1(resolved?.baseUrl || config.baseUrl)
  const apiKey = resolved?.apiKey || config.apiKey || ""
  return {
    provider: resolved?.provider ?? parsed.provider,
    model: resolved?.model ?? parsed.model,
    baseUrl,
    apiKey,
    headers: resolved?.headers,
    extra: { ...(resolved?.options || {}), ...variantOptions(parsed.variant) },
    variant: parsed.variant,
  }
}
