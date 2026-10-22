import { loadConfig, saveAccount, saveConfig, clearAccount, type Account, type Config } from "./config"
import { verifyKey } from "./api"

interface DeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await response.json().catch(() => ({}))) as T
  return { ok: response.ok, status: response.status, data }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function deviceLogin(
  config: Config,
  onCode: (info: { userCode: string; url: string; expiresIn: number }) => void,
): Promise<{ account?: Account }> {
  const started = await post<DeviceStart & { error?: string; error_description?: string }>(
    config.baseUrl,
    "/auth/cli/device",
    {},
  )
  if (!started.ok || !started.data.device_code) {
    throw new Error(started.data.error_description || started.data.error || "Could not start device login")
  }
  const info = started.data
  const url = info.verification_uri_complete || info.verification_uri
  onCode({ userCode: info.user_code, url, expiresIn: info.expires_in })

  const deadline = Date.now() + Number(info.expires_in || 600) * 1000
  let interval = Math.max(1, Number(info.interval || 5)) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const polled = await post<{
      access_token?: string
      account?: Account
      error?: string
      error_description?: string
    }>(config.baseUrl, "/auth/cli/token", { device_code: info.device_code })
    if (polled.ok && polled.data.access_token) {
      config.apiKey = polled.data.access_token
      await saveConfig(config)
      if (polled.data.account) await saveAccount(polled.data.account)
      return { account: polled.data.account }
    }
    if (polled.data.error === "authorization_pending") continue
    if (polled.data.error === "slow_down") {
      interval += 5_000
      continue
    }
    throw new Error(polled.data.error_description || polled.data.error || "Login failed")
  }
  throw new Error("The code expired before it was approved")
}

export async function logout() {
  const config = await loadConfig()
  delete config.apiKey
  delete config.model
  await saveConfig(config)
  await clearAccount()
}

export async function whoami() {
  const config = await loadConfig()
  const key = config.apiKey
  if (!key) return { loggedIn: false as const, config }
  const check = await verifyKey(config.baseUrl, key)
  return { loggedIn: true as const, config, valid: check.ok, reason: check.ok ? undefined : check.reason }
}

export function readStoredKey(config: Config) {
  return config.apiKey
}
