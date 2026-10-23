import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export interface PairOptions {
  password: string
  port?: number
  onPrompt: (text: string) => Promise<string>
  sessionTtlMs?: number
}

const MAX_BODY = 1024 * 1024
const DEFAULT_SESSION_TTL = 30 * 24 * 60 * 60 * 1000

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  })
}

function html(markup: string) {
  return new Response(markup, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

type BodyResult = { ok: true; text: string } | { ok: false; tooLarge: boolean }

async function readBody(request: Request): Promise<BodyResult> {
  const length = Number(request.headers.get("content-length") || "")
  if (Number.isFinite(length) && length > MAX_BODY) return { ok: false, tooLarge: true }
  if (!request.body) return { ok: true, text: "" }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {})
      return { ok: false, tooLarge: true }
    }
    chunks.push(value)
  }
  return { ok: true, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") }
}

type JsonResult = { ok: true; value: Record<string, unknown> } | { ok: false; status: number }

async function readJson(request: Request): Promise<JsonResult> {
  const body = await readBody(request)
  if (!body.ok) return { ok: false, status: 413 }
  try {
    const value = JSON.parse(body.text)
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400 }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400 }
  }
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") || ""
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return undefined
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZelAI Pair</title>
<style>
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101216; color: #e7e9ee; }
main { width: min(640px, calc(100vw - 32px)); padding: 24px; border: 1px solid #2a2f3a; border-radius: 14px; background: #171a21; }
h1 { margin: 0 0 6px; font-size: 22px; }
p { margin: 0 0 20px; color: #9aa3b2; font-size: 14px; }
section { margin-top: 20px; }
label { display: block; margin-bottom: 6px; font-size: 13px; color: #9aa3b2; }
input, textarea, button { width: 100%; font: inherit; }
input, textarea { padding: 11px 12px; border: 1px solid #303746; border-radius: 9px; background: #0f1116; color: #e7e9ee; }
textarea { min-height: 110px; resize: vertical; }
button { margin-top: 10px; padding: 11px 14px; border: 0; border-radius: 9px; background: #5b8cff; color: #fff; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
pre { min-height: 44px; margin: 0; padding: 12px; border: 1px solid #2a2f3a; border-radius: 9px; background: #0f1116; white-space: pre-wrap; overflow-wrap: anywhere; }
#status { min-height: 18px; margin-top: 10px; font-size: 13px; color: #9aa3b2; }
</style>
</head>
<body>
<main>
<h1>ZelAI Pair</h1>
<p>Sign in with the pairing password, then send a message to the local agent.</p>
<section id="login">
<form id="login-form" action="/login" method="post">
<label for="password">Password</label>
<input id="password" type="password" autocomplete="current-password">
<button id="login-button" type="submit">Sign in</button>
</form>
<div id="status"></div>
</section>
<section id="chat" hidden>
<form id="message-form" action="/message" method="post">
<label for="text">Message</label>
<textarea id="text" placeholder="Ask ZelAI..."></textarea>
<button id="send" type="submit">Send</button>
</form>
<pre id="output"></pre>
</section>
</main>
<script>
const password = document.getElementById("password")
const loginForm = document.getElementById("login-form")
const loginButton = document.getElementById("login-button")
const messageForm = document.getElementById("message-form")
const status = document.getElementById("status")
const chat = document.getElementById("chat")
const text = document.getElementById("text")
const send = document.getElementById("send")
const output = document.getElementById("output")
function setStatus(value) { status.textContent = value }
async function login(event) {
  if (event) event.preventDefault()
  loginButton.disabled = true
  setStatus("Signing in...")
  try {
    const response = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: password.value }) })
    if (!response.ok) {
      setStatus("Wrong password.")
      return
    }
    chat.hidden = false
    setStatus("Signed in.")
    text.focus()
  } catch (error) {
    setStatus("Sign in failed.")
  } finally {
    loginButton.disabled = false
  }
}
async function message(event) {
  if (event) event.preventDefault()
  const value = text.value.trim()
  if (!value) return
  send.disabled = true
  output.textContent = "Working..."
  try {
    const response = await fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: value }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      output.textContent = data.error || "Request failed."
      if (response.status === 401) chat.hidden = true
      return
    }
    output.textContent = data.text || data.result || "No response."
  } catch (error) {
    output.textContent = "Request failed."
  } finally {
    send.disabled = false
  }
}
loginForm.addEventListener("submit", login)
messageForm.addEventListener("submit", message)
text.addEventListener("keydown", function (event) { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") message(event) })
</script>
</body>
</html>`
}

async function makeQr(url: string) {
  try {
    const child = Bun.spawn(["qrencode", "-t", "ANSIUTF8", url], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(child.stdout).text()
    const code = await child.exited
    const qr = output.trimEnd()
    if (code === 0 && qr) return qr
  } catch {}
  return url
}

export async function createPairServer(options: PairOptions) {
  const secret = randomBytes(32)
  const sessions = new Map<string, number>()
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL
  const issue = () => {
    const sessionId = randomBytes(32).toString("hex")
    const token = createHmac("sha256", secret).update(sessionId).digest("hex")
    sessions.set(token, Date.now() + sessionTtlMs)
    return token
  }
  const valid = (token: string) => {
    const expires = sessions.get(token)
    if (!expires) return false
    if (expires <= Date.now()) {
      sessions.delete(token)
      return false
    }
    return true
  }
  const authorized = (request: Request) => {
    const token = cookieValue(request, "zelai_pair")
    return !!token && valid(token)
  }
  const token = issue()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      const method = request.method
      if (url.pathname === "/health" && method === "GET") return json({ ok: true })
      if ((url.pathname === "/" || url.pathname === "/ui") && method === "GET") return html(page())
      if (url.pathname === "/login" && method === "POST") {
        const body = await readJson(request)
        if (!body.ok) return json({ error: body.status === 413 ? "Request body too large" : "Invalid JSON" }, body.status)
        const password = typeof body.value.password === "string" ? body.value.password : ""
        if (!safeEqual(password, options.password)) return json({ error: "Unauthorized" }, 401)
        const next = issue()
        const maxAge = Math.max(0, Math.floor(sessionTtlMs / 1000))
        const cookie = `zelai_pair=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
        return json({ ok: true }, 200, { "set-cookie": cookie })
      }
      if (url.pathname === "/message" && method === "POST") {
        if (!authorized(request)) return json({ error: "Unauthorized" }, 401)
        const body = await readJson(request)
        if (!body.ok) return json({ error: body.status === 413 ? "Request body too large" : "Invalid JSON" }, body.status)
        const text = typeof body.value.text === "string" ? body.value.text.trim() : ""
        if (!text) return json({ error: "text is required" }, 400)
        try {
          const result = await options.onPrompt(text)
          return json({ ok: true, text: result, result })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }
      return json({ error: "Not found" }, 404)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const qr = await makeQr(url)
  return {
    url,
    port: server.port,
    token,
    qr,
    async close() {
      sessions.clear()
      await server.stop(true)
    },
  }
}
