import fs from "node:fs/promises"
import path from "node:path"
import { modelsCachePath } from "./paths"

export interface ModelInfo {
  id: string
  name: string
  context?: number
  tools: boolean
  input: string[]
  output: string[]
  availability?: string
  description?: string
}

const PREFERRED = [
  "nemotron-3.5-lightning-free",
  "deepseek-chat",
  "deepseek-v4-flash",
  "mimo-v2.6-flash-free",
]

const MODALITIES = new Set(["text", "audio", "image", "video", "pdf"])

function parseContext(value: string | undefined) {
  if (!value) return undefined
  const match = /^([\d.]+)\s*([km])?/i.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = (match[2] || "").toLowerCase()
  return Math.round(amount * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1))
}

function modalities(values: string[] | undefined) {
  const list = (values || []).filter((value) => MODALITIES.has(value))
  return list.length ? list : ["text"]
}

function mapModel(input: any): ModelInfo {
  return {
    id: String(input.id),
    name: String(input.name || input.id),
    context: parseContext(input.context),
    tools: Array.isArray(input.features) && input.features.includes("Tools"),
    input: modalities(input.input),
    output: modalities(input.output),
    availability: input.availability,
    description: input.description,
  }
}

export async function fetchModels(baseUrl: string): Promise<ModelInfo[]> {
  const response = await fetch(`${baseUrl}/api/models`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Model catalog returned ${response.status}`)
  const body: any = await response.json()
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const models = data.map(mapModel).filter((model: ModelInfo) => model.id)
  await saveModels(models)
  return models
}

async function saveModels(models: ModelInfo[]) {
  try {
    await fs.mkdir(path.dirname(modelsCachePath()), { recursive: true })
    await fs.writeFile(modelsCachePath(), JSON.stringify(models, null, 2) + "\n")
  } catch {}
}

export async function cachedModels(): Promise<ModelInfo[]> {
  try {
    return JSON.parse(await fs.readFile(modelsCachePath(), "utf8"))
  } catch {
    return []
  }
}

export async function models(baseUrl: string): Promise<ModelInfo[]> {
  try {
    return await fetchModels(baseUrl)
  } catch {
    return await cachedModels()
  }
}

export function defaultModel(list: ModelInfo[]) {
  const available = list.filter((model) => !model.availability || model.availability === "available")
  const preferred = PREFERRED.map((id) => available.find((model) => model.id === id)).find(Boolean)
  const chosen = preferred || available.find((model) => model.tools) || available[0] || list[0]
  return chosen?.id
}

export function findModel(list: ModelInfo[], id: string) {
  const normalized = id.split("/").pop() || id
  return list.find((model) => model.id === normalized)
}
