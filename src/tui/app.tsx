import { For, Show, createSignal, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Config } from "../config"
import { saveConfig } from "../config"
import type { ModelInfo } from "../models"
import { findModel } from "../models"
import { AGENTS, findAgent } from "../agents"
import type { Session } from "../session"
import { createSession, listSessions, loadSession, saveSession } from "../session"
import { runTurn, type EngineEvent } from "../engine"
import type { ApprovalRequest } from "../tools"
import { VERSION } from "../paths"

const BG = "#0b0d10"
const PANEL = "#15181d"
const BORDER = "#262b33"
const TEXT = "#e7e9ee"
const MUTED = "#8b93a1"
const ACCENT = "#4ade80"
const BLUE = "#60a5fa"
const YELLOW = "#fbbf24"
const RED = "#f87171"

type ItemKind = "user" | "assistant" | "tool" | "info" | "error"

interface Item {
  id: string
  kind: ItemKind
  text: string
  meta?: string
}

interface Approval {
  request: ApprovalRequest
  resolve: (value: boolean) => void
}

export interface AppProps {
  config: Config
  session: Session
  models: ModelInfo[]
  prompt?: string
  cwd: string
}

let counter = 0
const nextId = () => `item-${++counter}`

function itemFromMessages(session: Session): Item[] {
  const items: Item[] = []
  for (const message of session.messages) {
    if (message.role === "user" && message.content) {
      items.push({ id: nextId(), kind: "user", text: message.content })
    }
    if (message.role === "assistant") {
      if (message.content) items.push({ id: nextId(), kind: "assistant", text: message.content })
      for (const call of message.tool_calls || []) {
        items.push({
          id: nextId(),
          kind: "tool",
          text: call.function.name,
          meta: call.function.arguments.slice(0, 160),
        })
      }
    }
    if (message.role === "tool" && message.content) {
      const first = message.content.split("\n").slice(0, 4).join("\n")
      items.push({ id: nextId(), kind: "tool", text: message.name || "result", meta: first })
    }
  }
  return items
}

function shortModel(model: string) {
  return model.includes("/") ? model.split("/").pop()! : model
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let activeSession = props.session
  let currentAssistant: string | undefined
  let controller: AbortController | undefined

  const [items, setItems] = createSignal<Item[]>(itemFromMessages(props.session))
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [step, setStep] = createSignal(0)
  const [approval, setApproval] = createSignal<Approval | undefined>()
  const [agent, setAgent] = createSignal(findAgent(activeSession.agent || props.config.agent || "build"))
  const [model, setModel] = createSignal(
    activeSession.model || props.config.model || props.models[0]?.id || "deepseek-chat",
  )

  const scrollDown = () => {
    setTimeout(() => {
      if (scroll) scroll.scrollTop = 1_000_000
    }, 0)
  }

  const add = (kind: ItemKind, text: string, meta?: string) => {
    const item = { id: nextId(), kind, text, meta }
    setItems((current) => [...current, item])
    scrollDown()
    return item.id
  }

  const update = (id: string, text: string, meta?: string) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, text, meta } : item)))
    scrollDown()
  }

  const requestApproval = (request: ApprovalRequest) =>
    new Promise<boolean>((resolve) => {
      input?.blur()
      setApproval({
        request,
        resolve: (value) => {
          setApproval(undefined)
          resolve(value)
          setTimeout(() => input?.focus(), 0)
        },
      })
    })

  const persist = async () => {
    activeSession.agent = agent().id
    activeSession.model = model()
    await saveSession(activeSession)
  }

  const event = (value: EngineEvent) => {
    if (renderer.isDestroyed) return
    if (value.type === "assistant_start") {
      currentAssistant = add("assistant", "")
      return
    }
    if (value.type === "text") {
      if (!currentAssistant) currentAssistant = add("assistant", "")
      setItems((current) =>
        current.map((item) =>
          item.id === currentAssistant ? { ...item, text: item.text + value.text } : item,
        ),
      )
      scrollDown()
      return
    }
    if (value.type === "step") {
      setStep(value.step)
      return
    }
    if (value.type === "tool_start") {
      add("tool", value.name, value.args.slice(0, 200))
      return
    }
    if (value.type === "tool_end") {
      const output = value.output.length > 1200 ? `${value.output.slice(0, 1200)}\n...` : value.output
      add("tool", `${value.ok ? "OK" : "FAILED"} ${value.name}`, output)
      return
    }
    if (value.type === "error") add("error", value.message)
  }

  const run = async (text: string) => {
    if (!props.config.apiKey) {
      add("error", "Not logged in. Run `zelai auth login`, then restart ZelAI.")
      return
    }
    const currentAgent = agent()
    add("user", text)
    activeSession.messages.push({ role: "user", content: text })
    activeSession.agent = currentAgent.id
    activeSession.model = model()
    await saveSession(activeSession)
    controller = new AbortController()
    setBusy(true)
    setStep(0)
    currentAssistant = undefined
    try {
      await runTurn({
        session: activeSession,
        agent: currentAgent,
        baseUrl: props.config.baseUrl,
        apiKey: props.config.apiKey,
        model: model(),
        cwd: props.cwd,
        approve: requestApproval,
        signal: controller.signal,
        onEvent: event,
        onPersist: persist,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/cancelled/i.test(message)) add("error", message)
    } finally {
      controller = undefined
      setBusy(false)
      setStep(0)
      await persist()
      scrollDown()
    }
  }

  const setCurrentAgent = (id: string) => {
    const next = findAgent(id)
    setAgent(next)
    activeSession.agent = next.id
    props.config.agent = next.id
    saveConfig(props.config).catch(() => {})
    add("info", `Agent: ${next.name}`)
  }

  const setCurrentModel = (id: string) => {
    const found = findModel(props.models, id)
    if (!found) {
      const sample = props.models.slice(0, 12).map((entry) => entry.id).join(", ")
      add("error", `Unknown model: ${id}\nTry: ${sample}`)
      return
    }
    setModel(found.id)
    activeSession.model = found.id
    props.config.model = found.id
    saveConfig(props.config).catch(() => {})
    add("info", `Model: ${found.name} (${found.id})`)
  }

  const command = async (text: string) => {
    const [name, ...rest] = text.slice(1).split(/\s+/)
    const argument = rest.join(" ").trim()
    switch (name) {
      case "quit":
      case "exit":
        renderer.destroy()
        return
      case "help":
        add(
          "info",
          [
            "Commands:",
            "/model [id]     show or switch model",
            "/agent [name]   show or switch agent (build, plan, review)",
            "/plan           switch to plan mode",
            "/build          switch to build mode",
            "/review         switch to review mode",
            "/new            start a new session",
            "/sessions       list recent sessions",
            "/resume <id>    load a session",
            "/login          login instructions",
            "/quit           exit",
          ].join("\n"),
        )
        return
      case "model":
        if (argument) setCurrentModel(argument)
        else {
          const list = props.models
            .map((entry) => `${entry.id === model() ? "*" : " "} ${entry.id}${entry.tools ? "" : " (no tools)"}`)
            .join("\n")
          add("info", `Models:\n${list || "No models cached. Run zelai models."}`)
        }
        return
      case "agent":
        if (argument) setCurrentAgent(argument)
        else add("info", `Agents:\n${AGENTS.map((entry) => `${entry.id === agent().id ? "*" : " "} ${entry.id} - ${entry.description}`).join("\n")}`)
        return
      case "plan":
      case "build":
      case "review":
        setCurrentAgent(name)
        return
      case "new":
        activeSession = createSession(agent().id, model())
        setItems([])
        await saveSession(activeSession)
        add("info", "Started a new session.")
        return
      case "sessions": {
        const sessions = await listSessions()
        add(
          "info",
          sessions.length
            ? sessions.slice(0, 12).map((session) => `${session.id}  ${session.title}`).join("\n")
            : "No sessions yet.",
        )
        return
      }
      case "resume": {
        if (!argument) {
          add("error", "Usage: /resume <session-id>")
          return
        }
        const loaded = await loadSession(argument)
        if (!loaded) {
          add("error", `Session not found: ${argument}`)
          return
        }
        activeSession = loaded
        setItems(itemFromMessages(loaded))
        setAgent(findAgent(loaded.agent))
        setModel(loaded.model || model())
        add("info", `Resumed ${loaded.id}`)
        return
      }
      case "login":
        add("info", "Run `zelai auth login` in another terminal, then restart ZelAI.")
        return
      case "logout":
        add("info", "Run `zelai auth logout` in another terminal.")
        return
      default:
        add("error", `Unknown command: /${name}. Try /help.`)
    }
  }

  const submit = async () => {
    const text = draft().trim()
    if (!text || busy()) return
    setDraft("")
    if (input) input.value = ""
    if (text.startsWith("/")) {
      await command(text)
      return
    }
    await run(text)
  }

  useKeyboard((key) => {
    const pending = approval()
    if (pending) {
      if (key.name === "y" || key.name === "return") {
        key.preventDefault?.()
        pending.resolve(true)
      }
      if (key.name === "n" || key.name === "escape") {
        key.preventDefault?.()
        pending.resolve(false)
      }
      return
    }
    if (key.ctrl && key.name === "c") {
      if (busy() && controller) {
        controller.abort()
        add("info", "Cancelled.")
      } else {
        renderer.destroy()
      }
    }
  })

  onMount(() => {
    input?.focus()
    if (props.prompt) {
      setTimeout(() => run(props.prompt!), 100)
    }
  })

  const colorFor = (item: Item) => {
    if (item.kind === "user") return BLUE
    if (item.kind === "assistant") return TEXT
    if (item.kind === "error") return RED
    if (item.kind === "tool") return item.text.startsWith("FAILED") ? RED : MUTED
    return MUTED
  }

  const prefixFor = (item: Item) => {
    if (item.kind === "user") return "> "
    if (item.kind === "assistant") return ""
    if (item.kind === "error") return "! "
    if (item.kind === "tool") return "  "
    return "  "
  }

  return (
    <box width="100%" height="100%" backgroundColor={BG} flexDirection="column">
      <box
        height={2}
        flexShrink={0}
        border={["bottom"]}
        borderColor={BORDER}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text>
          <span style={{ fg: ACCENT, attributes: TextAttributes.BOLD }}>ZELAI</span>
          <span style={{ fg: MUTED }}> {VERSION}</span>
        </text>
        <text fg={MUTED}>{props.cwd}</text>
      </box>

      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        flexGrow={1}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        stickyScroll
        stickyStart="bottom"
        scrollY
        scrollX={false}
      >
        <For each={items()}>
          {(item) => (
            <box flexDirection="column" marginBottom={item.kind === "tool" ? 0 : 1}>
              <text wrapMode="word">
                <span style={{ fg: colorFor(item) }}>{prefixFor(item)}</span>
                <span style={{ fg: item.kind === "user" ? TEXT : colorFor(item) }}>{item.text}</span>
              </text>
              <Show when={item.meta}>
                <text wrapMode="word" fg={MUTED}>
                  {item.kind === "tool" ? `    ${item.meta}` : item.meta}
                </text>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>

      <Show when={busy()}>
        <box height={1} paddingLeft={1} flexShrink={0}>
          <text fg={YELLOW}>
            working · step {step()} · {agent().name} · {shortModel(model())}
          </text>
        </box>
      </Show>

      <Show when={approval()}>
        <box
          position="absolute"
          bottom={5}
          left={2}
          right={2}
          zIndex={100}
          border
          borderColor={YELLOW}
          backgroundColor={PANEL}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={YELLOW} attributes={TextAttributes.BOLD}>
            Allow {approval()!.request.kind}?
          </text>
          <text fg={TEXT} wrapMode="word">
            {approval()!.request.title}
          </text>
          <text fg={MUTED} wrapMode="word">
            {approval()!.request.detail.length > 600
              ? `${approval()!.request.detail.slice(0, 600)}...`
              : approval()!.request.detail}
          </text>
          <text fg={MUTED}>[y] allow   [n] deny</text>
        </box>
      </Show>

      <box
        flexShrink={0}
        border={["top"]}
        borderColor={BORDER}
        paddingLeft={1}
        paddingRight={1}
        height={3}
        flexDirection="column"
      >
        <input
          ref={(value: InputRenderable) => (input = value)}
          width="100%"
          placeholder={busy() ? "Waiting for ZelAI..." : "Ask ZelAI, or type /help"}
          placeholderColor={MUTED}
          focusedBackgroundColor={BORDER}
          backgroundColor={PANEL}
          textColor={TEXT}
          cursorColor={ACCENT}
          onInput={(value: string) => setDraft(value)}
          onSubmit={submit}
        />
      </box>

      <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} justifyContent="space-between" flexDirection="row">
        <text fg={MUTED}>
          {agent().name} · {shortModel(model())}
        </text>
        <text fg={MUTED}>{busy() ? "ctrl+c cancel" : "enter send · ctrl+c quit · /help"}</text>
      </box>
    </box>
  )
}
