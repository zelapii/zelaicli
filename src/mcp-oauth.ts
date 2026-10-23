import crypto from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { dataDir } from "./paths"

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
  scope?: string
}

export interface AuthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
}

export interface McpAuthOptions {
  serverUrl: string
  clientName?: string
  scope?: string
  fetchImpl?: typeof fetch
  openUrl?: (url: string) => void
  timeoutMs?: number
}

interface StoredTokens extends OAuthTokens {
  clientId?: string
  clientSecret?: string
}

interface JsonResult {
  ok: boolean
  status: number
  statusText: string
  text: string
  data: unknown
}

interface CallbackResult {
  code: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length ? items : undefined
}

function resolveUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, base).toString()
  } catch {
    return undefined
  }
}

function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin
  } catch {
    throw new Error(`Invalid MCP server URL: ${serverUrl}`)
  }
}

function normalizeServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl)
    url.hash = ""
    return url.toString().replace(/\/+$/, "")
  } catch {
    return serverUrl.trim()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(data: unknown, text: string): string {
  if (isRecord(data)) {
    const error = stringValue(data.error)
    const description = stringValue(data.error_description)
    if (error || description) return [error, description].filter(Boolean).join(": ")
  }
  return text.slice(0, 500) || "no response body"
}

async function readJson(fetchImpl: typeof fetch, url: string): Promise<JsonResult> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    data,
  }
}

async function attemptJson(fetchImpl: typeof fetch, url: string): Promise<JsonResult | undefined> {
  try {
    return await readJson(fetchImpl, url)
  } catch {
    return undefined
  }
}

function normalizeMetadata(data: unknown, fallback: string): AuthServerMetadata | undefined {
  if (!isRecord(data)) return undefined
  const issuer = resolveUrl(stringValue(data.issuer) || fallback, fallback)
  if (!issuer) return undefined
  const authorizationEndpoint = resolveUrl(stringValue(data.authorization_endpoint), issuer)
  const tokenEndpoint = resolveUrl(stringValue(data.token_endpoint), issuer)
  if (!authorizationEndpoint || !tokenEndpoint) return undefined
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: resolveUrl(stringValue(data.registration_endpoint), issuer),
    scopes_supported: stringArray(data.scopes_supported),
  }
}

function metadataCandidates(issuerBase: string, origin: string): string[] {
  const urls: string[] = []
  try {
    const issuer = new URL(issuerBase)
    const pathname = issuer.pathname.replace(/\/+$/, "")
    if (pathname) urls.push(`${issuer.origin}/.well-known/oauth-authorization-server${pathname}`)
    urls.push(`${issuer.origin}/.well-known/oauth-authorization-server`)
  } catch {
    urls.push(`${origin}/.well-known/oauth-authorization-server`)
  }
  urls.push(`${origin}/.well-known/oauth-authorization-server`)
  return [...new Set(urls)]
}

export async function discoverMetadata(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthServerMetadata | undefined> {
  const origin = serverOrigin(serverUrl)
  let issuerBase = origin
  const resource = await attemptJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource`)
  if (resource?.ok && isRecord(resource.data)) {
    const servers = resource.data.authorization_servers
    const first = Array.isArray(servers) ? stringValue(servers[0]) : undefined
    const resolved = resolveUrl(first, origin)
    if (resolved) issuerBase = resolved
  }
  for (const candidate of metadataCandidates(issuerBase, origin)) {
    const result = await attemptJson(fetchImpl, candidate)
    if (!result?.ok) continue
    const metadata = normalizeMetadata(result.data, issuerBase)
    if (metadata) return metadata
  }
  return undefined
}

export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  clientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!metadata.registration_endpoint) return { clientId: "zelai" }
  const payload = {
    client_name: clientName,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [redirectUri],
  }
  let response: Response
  try {
    response = await fetchImpl(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`Client registration request failed for ${metadata.registration_endpoint}: ${errorMessage(error)}`)
  }
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    throw new Error(`Client registration failed (${response.status} ${response.statusText}): ${errorDetails(data, text)}`)
  }
  if (!isRecord(data)) {
    throw new Error(`Client registration returned invalid JSON (${response.status}): ${text.slice(0, 500) || response.statusText}`)
  }
  const clientId = stringValue(data.client_id)
  if (!clientId) {
    throw new Error(`Client registration response is missing client_id (${response.status}): ${text.slice(0, 500) || response.statusText}`)
  }
  return {
    clientId,
    clientSecret: stringValue(data.client_secret),
  }
}

function createVerifier(): string {
  return crypto.randomBytes(32).toString("base64url")
}

function createChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}

function defaultOpenUrl(url: string) {
  process.stderr.write(`Open this URL in your browser to authorize access:\n${url}\n`)
}

function expiresAtFrom(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Date.now() + seconds * 1000
}

async function requestToken(endpoint: string, body: URLSearchParams, fetchImpl: typeof fetch): Promise<OAuthTokens> {
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`Token request failed for ${endpoint}: ${errorMessage(error)}`)
  }
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status} ${response.statusText}): ${errorDetails(data, text)}`)
  }
  if (!isRecord(data)) {
    throw new Error(`Token response is not valid JSON (${response.status}): ${text.slice(0, 500) || response.statusText}`)
  }
  const accessToken = stringValue(data.access_token)
  if (!accessToken) {
    throw new Error(`Token response is missing access_token (${response.status}): ${text.slice(0, 500) || response.statusText}`)
  }
  return {
    accessToken,
    refreshToken: stringValue(data.refresh_token),
    expiresAt: expiresAtFrom(data.expires_in),
    tokenType: stringValue(data.token_type),
    scope: stringValue(data.scope),
  }
}

async function exchangeCode(
  tokenEndpoint: string,
  client: { clientId: string; clientSecret?: string },
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
  })
  if (client.clientSecret) body.set("client_secret", client.clientSecret)
  return requestToken(tokenEndpoint, body, fetchImpl)
}

function closeServer(server: ReturnType<typeof http.createServer>) {
  try {
    server.close()
  } catch {}
  const closeAllConnections = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections
  if (closeAllConnections) closeAllConnections.call(server)
}

export async function beginAuth(options: McpAuthOptions): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs ?? 180_000
  const metadata = await discoverMetadata(options.serverUrl, fetchImpl)
  if (!metadata) throw new Error(`No OAuth authorization server metadata found for ${options.serverUrl}`)
  const verifier = createVerifier()
  const challenge = createChallenge(verifier)
  const state = crypto.randomBytes(16).toString("base64url")
  const server = http.createServer()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const callback = new Promise<CallbackResult>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the OAuth callback`))
      }, timeoutMs)
      server.on("request", (request, response) => {
        const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`)
        if (url.pathname !== "/callback") {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          response.end("Not found")
          return
        }
        const error = stringValue(url.searchParams.get("error"))
        const description = stringValue(url.searchParams.get("error_description"))
        if (error) {
          const message = description ? `${error}: ${description}` : error
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end(`Authorization failed: ${message}`)
          reject(new Error(`Authorization failed: ${message}`))
          return
        }
        if (url.searchParams.get("state") !== state) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end("Invalid OAuth state")
          reject(new Error("OAuth state mismatch; the callback may not belong to this login attempt"))
          return
        }
        const code = stringValue(url.searchParams.get("code"))
        if (!code) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end("Missing authorization code")
          reject(new Error("OAuth callback did not include an authorization code"))
          return
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end("<!doctype html><html><body>Authentication complete. You can close this window.</body></html>")
        resolve({ code })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Could not determine the OAuth callback port")
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const client = await registerClient(metadata, redirectUri, options.clientName || "zelai", fetchImpl)
    const authUrl = new URL(metadata.authorization_endpoint)
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", client.clientId)
    authUrl.searchParams.set("redirect_uri", redirectUri)
    authUrl.searchParams.set("code_challenge", challenge)
    authUrl.searchParams.set("code_challenge_method", "S256")
    authUrl.searchParams.set("state", state)
    if (options.scope) authUrl.searchParams.set("scope", options.scope)
    const openUrl = options.openUrl || defaultOpenUrl
    openUrl(authUrl.toString())
    const result = await callback
    const tokens = await exchangeCode(metadata.token_endpoint, client, result.code, redirectUri, verifier, fetchImpl)
    await saveRecord(options.serverUrl, {
      ...tokens,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    })
    return tokens
  } finally {
    if (timer) clearTimeout(timer)
    closeServer(server)
  }
}

export async function refreshTokens(
  metadata: AuthServerMetadata,
  clientId: string,
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new Error("Cannot refresh OAuth tokens without a refresh token")
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  })
  if (tokens.scope) body.set("scope", tokens.scope)
  const refreshed = await requestToken(metadata.token_endpoint, body, fetchImpl)
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken || tokens.refreshToken,
    scope: refreshed.scope || tokens.scope,
  }
}

export function tokenPath(serverUrl: string): string {
  const hash = crypto.createHash("sha256").update(normalizeServerUrl(serverUrl)).digest("hex")
  return path.join(dataDir(), "mcp-auth", `${hash}.json`)
}

async function saveRecord(serverUrl: string, tokens: StoredTokens) {
  const file = tokenPath(serverUrl)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => {})
}

async function loadRecord(serverUrl: string): Promise<StoredTokens | undefined> {
  try {
    const raw = await fs.readFile(tokenPath(serverUrl), "utf8")
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data)) return undefined
    const accessToken = stringValue(data.accessToken)
    if (!accessToken) return undefined
    return {
      accessToken,
      refreshToken: stringValue(data.refreshToken),
      expiresAt: typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined,
      tokenType: stringValue(data.tokenType),
      scope: stringValue(data.scope),
      clientId: stringValue(data.clientId),
      clientSecret: stringValue(data.clientSecret),
    }
  } catch {
    return undefined
  }
}

export async function loadTokens(serverUrl: string): Promise<OAuthTokens | undefined> {
  return loadRecord(serverUrl)
}

export async function saveTokens(serverUrl: string, tokens: OAuthTokens) {
  const existing = await loadRecord(serverUrl)
  await saveRecord(serverUrl, { ...(existing || {}), ...tokens })
}

export async function clearTokens(serverUrl: string) {
  await fs.rm(tokenPath(serverUrl), { force: true })
}

export function authorizationHeader(tokens: OAuthTokens): string {
  return `Bearer ${tokens.accessToken}`
}

export async function ensureTokens(options: McpAuthOptions): Promise<string | undefined> {
  const existing = await loadRecord(options.serverUrl)
  if (!existing) return undefined
  const expiresSoon = existing.expiresAt !== undefined && existing.expiresAt - Date.now() <= 60_000
  if (!expiresSoon) return authorizationHeader(existing)
  if (!existing.refreshToken) {
    if (existing.expiresAt !== undefined && existing.expiresAt <= Date.now()) {
      throw new Error(`Stored MCP OAuth token for ${options.serverUrl} has expired and no refresh token is available`)
    }
    return authorizationHeader(existing)
  }
  const fetchImpl = options.fetchImpl || fetch
  const metadata = await discoverMetadata(options.serverUrl, fetchImpl)
  if (!metadata) {
    throw new Error(`Cannot refresh MCP OAuth token for ${options.serverUrl}: no authorization server metadata found`)
  }
  const refreshed = await refreshTokens(metadata, existing.clientId || "zelai", existing, fetchImpl)
  const updated: StoredTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken || existing.refreshToken,
    clientId: existing.clientId || "zelai",
    clientSecret: existing.clientSecret,
  }
  await saveRecord(options.serverUrl, updated)
  return authorizationHeader(updated)
}
