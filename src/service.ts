import fs from "node:fs/promises"
import path from "node:path"
import { writePrivateJson } from "./config"
import { dataDir } from "./paths"

export interface ServiceState {
  pid: number
  host: string
  port: number
  startedAt: number
  logFile: string
  env: Record<string, string>
}

export interface ServiceStartOptions {
  command: string[]
  host?: string
  port?: number
  password?: string
  cwd?: string
  logFile?: string
  env?: Record<string, string>
}

export interface ServiceStopOptions {
  timeoutMs?: number
}

export function serviceFile() {
  return path.join(dataDir(), "service.json")
}

export function envFile() {
  return path.join(dataDir(), "service-env.json")
}

function cleanEnv(env: Record<string, string | undefined>) {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") output[key] = value
  }
  return output
}

function validState(value: unknown): value is ServiceState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<ServiceState>
  const env = state.env
  if (
    typeof state.pid !== "number" ||
    typeof state.host !== "string" ||
    typeof state.port !== "number" ||
    typeof state.startedAt !== "number" ||
    typeof state.logFile !== "string" ||
    !env ||
    typeof env !== "object"
  ) {
    return false
  }
  return Object.values(env).every((entry) => typeof entry === "string")
}

export async function readService(): Promise<ServiceState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(serviceFile(), "utf8"))
    return validState(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function statusService(): Promise<{ running: boolean; state?: ServiceState }> {
  const state = await readService()
  if (!state || !isAlive(state.pid)) return { running: false }
  return { running: true, state }
}

export async function getServiceEnv(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(envFile(), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return cleanEnv(parsed as Record<string, string | undefined>)
  } catch {
    return {}
  }
}

export async function setServiceEnv(entries: Record<string, string>) {
  const env = { ...(await getServiceEnv()), ...cleanEnv(entries) }
  await writePrivateJson(envFile(), env)
  return env
}

export async function unsetServiceEnv(keys: string[]) {
  const env = await getServiceEnv()
  for (const key of keys) delete env[key]
  await writePrivateJson(envFile(), env)
  return env
}

function spawnCommand(command: string[]) {
  if (!command.length) throw new Error("command is required")
  const first = command[0]
  const base = path.basename(first).toLowerCase()
  if (
    first === process.execPath ||
    path.isAbsolute(first) ||
    first.startsWith(".") ||
    first.includes("/") ||
    first.includes("\\") ||
    base === "bun" ||
    base === "bun.exe" ||
    base === "node" ||
    base === "node.exe" ||
    !!Bun.which(first)
  ) {
    return command
  }
  const runtime = path.basename(process.execPath).toLowerCase()
  const script = process.argv[1]
  if (script && (runtime === "bun" || runtime === "bun.exe") && /\.(?:[cm]?[jt]sx?)$/i.test(script)) {
    return [process.execPath, script, ...command]
  }
  return [process.execPath, ...command]
}

function probeHost(host: string) {
  if (host === "0.0.0.0") return "127.0.0.1"
  if (host === "::" || host === "[::]") return "[::1]"
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`
  return host
}

export async function startService(options: ServiceStartOptions): Promise<ServiceState> {
  if (!options.command || !options.command.length) throw new Error("command is required")
  const current = await statusService()
  if (current.running) throw new Error(`Service already running (pid ${current.state?.pid})`)
  const host = options.host || "127.0.0.1"
  const port = options.port ?? 4096
  const cwd = path.resolve(options.cwd || process.cwd())
  const logFile = path.resolve(options.logFile || path.join(dataDir(), "service.log"))
  const stored = await getServiceEnv()
  const extra = cleanEnv({ ...stored, ...(options.env || {}) })
  const env = cleanEnv({ ...process.env, ...extra })
  if (options.password && !env.ZELAI_SERVER_PASSWORD) env.ZELAI_SERVER_PASSWORD = options.password
  const child = Bun.spawn({
    cmd: spawnCommand(options.command),
    cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  child.unref()
  const headers: Record<string, string> = {}
  if (options.password) headers.authorization = `Bearer ${options.password}`
  const health = `http://${probeHost(host)}:${port}/health`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Service exited before becoming healthy (code ${child.exitCode})`)
    }
    try {
      const response = await fetch(health, { headers, signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const state: ServiceState = {
          pid: child.pid,
          host,
          port,
          startedAt: Date.now(),
          logFile,
          env: extra,
        }
        await writePrivateJson(serviceFile(), state)
        return state
      }
    } catch {}
    await Bun.sleep(200)
  }
  try {
    process.kill(child.pid, "SIGTERM")
  } catch {}
  throw new Error(`Timed out waiting for http://${host}:${port}/health`)
}

export async function stopService(options: ServiceStopOptions = {}): Promise<boolean> {
  const state = await readService()
  if (!state) return false
  if (!isAlive(state.pid)) {
    await fs.rm(serviceFile(), { force: true })
    return false
  }
  const timeout = options.timeoutMs ?? 5000
  try {
    process.kill(state.pid, "SIGTERM")
  } catch {}
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) {
      await fs.rm(serviceFile(), { force: true })
      return true
    }
    await Bun.sleep(100)
  }
  try {
    process.kill(state.pid, "SIGKILL")
  } catch {}
  const finalDeadline = Date.now() + 2000
  while (Date.now() < finalDeadline && isAlive(state.pid)) await Bun.sleep(50)
  await fs.rm(serviceFile(), { force: true })
  return true
}

export async function restartService(options: ServiceStartOptions): Promise<ServiceState> {
  await stopService()
  return startService(options)
}
