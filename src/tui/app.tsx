import { For, Show, createSignal, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Config } from "../config"
import { saveConfig } from "../config"
import type { ModelInfo } from "../models"
import { findModel } from "../models"
import { type Agent, findAgent, primaryAgents } from "../agents"
import type { Session, Todo } from "../session"
import { createSession, listSessions, loadSession, saveSession } from "../session"
import type { CustomCommand } from "../commands"
import type { McpManager } from "../mcp"
import { expandCommand } from "../commands"
import { compactSession, shouldCompact } from "../compact"
import { redoLast, undoLast } from "../undo"
import { runTurn, type EngineEvent, type QuestionRequest } from "../engine"
import type { ApprovalRequest } from "../tools"
import { VERSION } from "../paths"
import type { Skill } from "../skills"
import { activeReference, expandReferences, listProjectFiles, matchFiles, replaceReference } from "../files"
import { keybindSummary, matchesAction } from "../keybinds"
import { resolveTheme, themeName, themeNames, type Palette } from "../theme"
import type { PluginManager } from "../plugins"
import type { LspManager } from "../lsp"
import { gitCommit, gitDiff, gitLog, gitStatus } from "../git"

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

interface Question {
  request: QuestionRequest
  resolve: (value: string) => void
}

interface PickerItem {
  label: string
  value: string
  description?: string
}

interface PickerState {
  title: string
  items: PickerItem[]
  onSelect: (value: string) => void
}

export interface AppProps {
  config: Config
  session: Session
  models: ModelInfo[]
  agents: Agent[]
  commands: CustomCommand[]
  instructions: string
  mcp?: McpManager
  skills: Skill[]
  plugins?: PluginManager
  lsp?: LspManager
  themes: Record<string, Palette>
  prompt?: string
  cwd: string
}

const SLASH_COMMANDS = [
  "help",
  "model",
  "agent",
  "plan",
  "build",
  "review",
  "new",
  "sessions",
  "resume",
  "undo",
  "redo",
  "details",
  "theme",
  "keybinds",
  "git",
  "status",
  "diff",
  "commit",
  "plugins",
  "lsp",
  "skills",
  "init",
  "compact",
  "commands",
  "mcp",
  "quit",
]

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

function formatTokens(value: number) {
  if (!value) return "0"
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function shortModel(model: string) {
  const id = model.includes("/") ? model.split("/").pop()! : model
  return id.length > 28 ? `${id.slice(0, 27)}…` : id
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let activeSession = props.session
  let currentAssistant: string | undefined
  let controller: AbortController | undefined
  let hintGuard = false

  const [items, setItems] = createSignal<Item[]>(itemFromMessages(props.session))
  const [theme, setTheme] = createSignal(themeName(props.config.theme))
  const [palette, setPalette] = createSignal(resolveTheme(props.config.theme, props.themes))
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [step, setStep] = createSignal(0)
  const [approval, setApproval] = createSignal<Approval | undefined>()
  const [agent, setAgent] = createSignal(findAgent(activeSession.agent || props.config.agent || "build", props.agents))
  const [todos, setTodos] = createSignal<Todo[]>(activeSession.todos || [])
  const [details, setDetails] = createSignal(true)
  const [question, setQuestion] = createSignal<Question | undefined>()
  const [files, setFiles] = createSignal<string[]>([])
  const [hints, setHints] = createSignal<string[]>([])
  const [hintIndex, setHintIndex] = createSignal(0)
  const [picker, setPicker] = createSignal<PickerState | undefined>()
  const [usage, setUsage] = createSignal<{ prompt: number; completion: number }>()
  const [pickerIndex, setPickerIndex] = createSignal(0)
  const history: string[] = []
  let historyIndex = -1
  const always = new Set<string>()
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

  const requestQuestion = (request: QuestionRequest) =>
    new Promise<string>((resolve) => {
      add("info", [request.header, request.question, ...(request.options || []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`)].filter(Boolean).join("\n"))
      setQuestion({
        request,
        resolve: (value) => {
          setQuestion(undefined)
          add("info", `Answer: ${value}`)
          resolve(value)
          setTimeout(() => input?.focus(), 0)
        },
      })
      setTimeout(() => input?.focus(), 0)
    })

  const currentModel = () => agent().model || model()

  const updateHints = (value: string) => {
    const ref = activeReference(value)
    if (ref) {
      setHints(matchFiles(files(), ref.query))
      setHintIndex(0)
      return
    }
    if (value.startsWith("/") && !value.includes(" ")) {
      const query = value.slice(1).toLowerCase()
      const names = [...SLASH_COMMANDS, ...props.commands.map((item) => item.name)]
      setHints(names.filter((name) => name.startsWith(query)).sort())
      setHintIndex(0)
      return
    }
    setHints([])
    setHintIndex(0)
  }

  const applyHint = () => {
    const current = draft()
    const file = hints()[hintIndex()]
    if (!file) return
    const ref = activeReference(current)
    const value = ref ? replaceReference(current, ref.start, file) : `/${file} `
    setDraft(value)
    if (input) input.value = value
    setHints([])
    hintGuard = true
    setTimeout(() => {
      hintGuard = false
    }, 50)
  }

  const persist = async () => {
    activeSession.agent = agent().id
    activeSession.model = model()
    await saveSession(activeSession)
  }

  const event = (value: EngineEvent) => {
    if (renderer.isDestroyed) return
    if (value.type === "usage") {
      setUsage({ prompt: value.prompt, completion: value.completion })
      return
    }
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
    if (value.type === "todos") {
      setTodos(value.todos)
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
    const display = text
    const prepared = await expandReferences(text, props.cwd, props.agents)
    if (prepared.agent) setCurrentAgent(prepared.agent)
    text = prepared.text || "Review the attached file."
    const currentAgent = agent()
    add("user", display)
    activeSession.messages.push({ role: "user", content: text })
    activeSession.agent = currentAgent.id
    activeSession.model = model()
    await saveSession(activeSession)
    setBusy(true)
    setStep(0)
    currentAssistant = undefined
    const activeModel = currentModel()
    const catalog = props.models.find((entry) => entry.id === activeModel)
    if (shouldCompact(activeSession, catalog?.context)) {
      add("info", "Compacting earlier context...")
      const compacted = await compactSession(activeSession, {
        baseUrl: props.config.baseUrl,
        apiKey: props.config.apiKey!,
        model: activeModel,
      }).catch(() => false)
      if (compacted) {
        add("info", "Context compacted.")
        await saveSession(activeSession)
      }
    }
    controller = new AbortController()
    try {
      await runTurn({
        session: activeSession,
        agent: currentAgent,
        baseUrl: props.config.baseUrl,
        apiKey: props.config.apiKey,
        model: activeModel,
        cwd: props.cwd,
        approve: requestApproval,
        permission: props.config.permission,
        always,
        agents: props.agents,
        instructions: props.instructions,
        mcp: props.mcp,
        skills: props.skills,
        formatter: props.config.formatter,
        askQuestion: requestQuestion,
        plugins: props.plugins,
        lsp: props.lsp,
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

  const runShell = async (command: string) => {
    add("user", `!${command}`)
    setBusy(true)
    try {
      const proc = Bun.spawn(["bash", "-lc", command], { cwd: props.cwd, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const output = [stdout.trimEnd(), stderr.trim() ? `[stderr]\n${stderr.trimEnd()}` : "", `[exit ${code}]`]
        .filter(Boolean)
        .join("\n")
      add("tool", code === 0 ? "shell" : "shell FAILED", output.length > 4000 ? `${output.slice(0, 4000)}\n...` : output)
      activeSession.messages.push({ role: "user", content: `Shell command: ${command}\n\n${output}` })
      await persist()
    } catch (error) {
      add("error", error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const setCurrentAgent = (id: string) => {
    const next = findAgent(id, props.agents)
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

  const openPicker = (title: string, items: PickerItem[], onSelect: (value: string) => void) => {
    if (!items.length) {
      add("info", `${title}: nothing to choose.`)
      return
    }
    setPickerIndex(0)
    setPicker({ title, items, onSelect })
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
            "/undo           revert the last file change",
            "/redo           redo the last undone change",
            "/details        toggle tool output details",
            "/theme [name]   list or switch theme",
            "/keybinds       show effective keybinds",
            "/git <action>   status, diff, log, commit",
            "/diff           show unstaged changes",
            "/status         show git status",
            "/commit <msg>   commit staged changes",
            "/plugins        list custom tools and hooks",
            "/lsp            list LSP servers",
            "/skills         list available skills",
            "/init           create or update AGENTS.md",
            "/compact        summarize older context",
            "/commands       list custom commands",
            "/mcp            list MCP servers and tools",
            "/login          login instructions",
            "/quit           exit",
            ...(props.commands.length ? ["", "Custom commands:", ...props.commands.map((item) => `/${item.name.padEnd(14)} ${item.description}`)] : []),
          ].join("\n"),
        )
        return
      case "model":
        if (argument) setCurrentModel(argument)
        else if (props.models.length) {
          openPicker(
            "Select model",
            props.models.map((entry) => ({
              label: `${entry.id === model() ? "*" : " "} ${entry.id}`,
              value: entry.id,
              description: entry.tools ? "" : "no tools",
            })),
            setCurrentModel,
          )
        } else add("info", "No models cached. Run zelai models.")
        return
      case "agent":
        if (argument) setCurrentAgent(argument)
        else {
          const list = primaryAgents(props.agents)
          openPicker(
            "Select agent",
            list.map((entry) => ({
              label: `${entry.id === agent().id ? "*" : " "} ${entry.id}`,
              value: entry.id,
              description: entry.description,
            })),
            setCurrentAgent,
          )
        }
        return
      case "plan":
      case "build":
      case "review":
        setCurrentAgent(name)
        return
      case "new":
        activeSession = createSession(agent().id, model())
        setItems([])
        setTodos([])
        await saveSession(activeSession)
        add("info", "Started a new session.")
        return
      case "sessions": {
        const sessions = await listSessions()
        if (!sessions.length) {
          add("info", "No sessions yet.")
          return
        }
        openPicker(
          "Resume session",
          sessions.slice(0, 20).map((session) => ({
            label: `${session.id}  ${session.title}`,
            value: session.id,
            description: new Date(session.updatedAt).toLocaleString(),
          })),
          (id) => command(`/resume ${id}`),
        )
        return
      }
      case "resume": {
        if (!argument) {
          await command("/sessions")
          return
        }
        const loaded = await loadSession(argument)
        if (!loaded) {
          add("error", `Session not found: ${argument}`)
          return
        }
        activeSession = loaded
        setItems(itemFromMessages(loaded))
        setAgent(findAgent(loaded.agent, props.agents))
        setModel(loaded.model || model())
        add("info", `Resumed ${loaded.id}`)
        return
      }
      case "undo": {
        const reverted = await undoLast(activeSession.id)
        add("info", reverted ? `Reverted ${reverted}` : "Nothing to undo in this session.")
        return
      }
      case "redo": {
        const redone = await redoLast(activeSession.id)
        add("info", redone ? `Redid ${redone}` : "Nothing to redo in this session.")
        return
      }
      case "details":
        setDetails(!details())
        add("info", `Tool details ${details() ? "on" : "off"}.`)
        return
      case "theme":
        if (argument) await applyTheme(argument)
        else add("info", `Themes: ${themeNames(props.themes).map((name) => (name === theme() ? `*${name}` : name)).join(", ")}`)
        return
      case "keybinds":
        add("info", `Keybinds:\n${keybindSummary(props.config.keybinds).join("\n")}`)
        return
      case "plugins": {
        const info = props.plugins?.info || []
        add(
          "info",
          info.length
            ? info.map((item) => `${item.name}  tools: ${item.tools.join(", ") || "-"}  hooks: ${item.hooks.join(", ") || "-"}`).join("\n")
            : "No plugins or custom tools loaded.",
        )
        return
      }
      case "lsp": {
        const status = props.lsp?.status() || []
        add(
          "info",
          status.length
            ? status.map((server) => `${server.name} [${server.running ? "running" : "idle"}] ${server.extensions.join(" ")}`).join("\n")
            : "LSP is disabled. Set lsp to true in zelai.json.",
        )
        return
      }
      case "git": {
        const [action = "status", ...rest] = argument.split(/\s+/)
        if (action === "status") {
          const result = await gitStatus(props.cwd)
          add(result.ok ? "tool" : "error", result.output)
        } else if (action === "diff") {
          const result = await gitDiff(props.cwd, rest.includes("--staged"))
          add(result.ok ? "tool" : "error", result.output)
        } else if (action === "log") {
          const result = await gitLog(props.cwd, Number(rest[0]) || 10)
          add(result.ok ? "tool" : "error", result.output)
        } else if (action === "commit") {
          const message = rest.join(" ")
          if (!message) {
            add("error", "Usage: /git commit <message>")
            return
          }
          const result = await gitCommit(props.cwd, message)
          add(result.ok ? "tool" : "error", result.output)
        } else add("error", `Unknown git action: ${action}`)
        return
      }
      case "status": {
        const result = await gitStatus(props.cwd)
        add(result.ok ? "tool" : "error", result.output)
        return
      }
      case "diff": {
        const result = await gitDiff(props.cwd, argument.includes("--staged"))
        add(result.ok ? "tool" : "error", result.output)
        return
      }
      case "commit": {
        if (!argument) {
          add("error", "Usage: /commit <message>")
          return
        }
        const result = await gitCommit(props.cwd, argument)
        add(result.ok ? "tool" : "error", result.output)
        return
      }
      case "skills":
        add(
          "info",
          props.skills.length
            ? props.skills.map((entry) => `${entry.name} - ${entry.description}`).join("\n")
            : "No skills. Add .zelai/skills/<name>/SKILL.md.",
        )
        return
      case "init":
        setCurrentAgent("build")
        await run("Analyze this repository and create or update AGENTS.md with build/test commands, architecture, and coding conventions. Keep it concise and factual. Use the write tool to save it.")
        return
      case "compact": {
        if (busy()) return
        setBusy(true)
        add("info", "Compacting context...")
        const compacted = await compactSession(activeSession, {
          baseUrl: props.config.baseUrl,
          apiKey: props.config.apiKey!,
          model: model(),
        }).catch(() => false)
        setBusy(false)
        if (compacted) await persist()
        add("info", compacted ? "Context compacted." : "Not enough history to compact.")
        return
      }
      case "commands":
        add("info", props.commands.length ? props.commands.map((item) => `/${item.name}  ${item.description}`).join("\n") : "No custom commands. Add markdown files under .zelai/commands/.")
        return
      case "mcp": {
        const summaries = props.mcp?.summaries() || []
        add(
          "info",
          summaries.length
            ? summaries.map((server) => `${server.name}: ${server.tools.map((tool) => `mcp__${server.name}__${tool}`).join(", ") || "no tools"}`).join("\n")
            : "No MCP servers connected.",
        )
        return
      }
      case "login":
        add("info", "Run `zelai auth login` in another terminal, then restart ZelAI.")
        return
      case "logout":
        add("info", "Run `zelai auth logout` in another terminal.")
        return
      default: {
        const custom = props.commands.find((item) => item.name === name)
        if (!custom) {
          add("error", `Unknown command: /${name}. Try /help.`)
          return
        }
        if (custom.agent) setCurrentAgent(custom.agent)
        if (custom.model) setCurrentModel(custom.model)
        await run(expandCommand(custom, argument))
      }
    }
  }

  const submit = async () => {
    if (hintGuard) {
      hintGuard = false
      return
    }
    if (hints().length && activeReference(draft())) {
      applyHint()
      return
    }
    const text = draft().trim()
    if (!text) return
    if (question()) {
      const options = question()!.request.options || []
      const index = /^\d+$/.test(text) ? Number(text) - 1 : -1
      const answer = index >= 0 && options[index] ? options[index].label : text
      setDraft("")
      if (input) input.value = ""
      question()!.resolve(answer)
      return
    }
    if (busy()) return
    setDraft("")
    if (input) input.value = ""
    if (text.trim()) {
      history.push(text)
      historyIndex = -1
    }
    setHints([])
    if (text.startsWith("!")) {
      await runShell(text.slice(1).trim())
      return
    }
    if (text.startsWith("/")) {
      await command(text)
      return
    }
    await run(text)
  }

  const applyTheme = async (name: string) => {
    if (!props.themes[name]) {
      add("error", `Unknown theme: ${name}. Try: ${themeNames(props.themes).join(", ")}`)
      return
    }
    setTheme(name)
    setPalette(props.themes[name])
    props.config.theme = name
    await saveConfig(props.config).catch(() => {})
    add("info", `Theme: ${name}`)
  }

  useKeyboard((key) => {
    const pending = approval()
    if (pending) {
      if (key.name === "y" || key.name === "return") {
        key.preventDefault?.()
        pending.resolve(true)
      }
      if (key.name === "a") {
        key.preventDefault?.()
        always.add(pending.request.kind)
        pending.resolve(true)
      }
      if (key.name === "n" || key.name === "escape") {
        key.preventDefault?.()
        pending.resolve(false)
      }
      return
    }
    const active = picker()
    if (active) {
      if (key.name === "up") {
        key.preventDefault?.()
        setPickerIndex((index) => (index - 1 + active.items.length) % active.items.length)
        return
      }
      if (key.name === "down") {
        key.preventDefault?.()
        setPickerIndex((index) => (index + 1) % active.items.length)
        return
      }
      if (key.name === "return") {
        key.preventDefault?.()
        const item = active.items[pickerIndex()]
        setPicker(undefined)
        if (item) active.onSelect(item.value)
        return
      }
      if (key.name === "escape") {
        key.preventDefault?.()
        setPicker(undefined)
        return
      }
      return
    }
    if (!question() && hints().length) {
      if (key.name === "tab" || (key.name === "return" && !!activeReference(draft()))) {
        key.preventDefault?.()
        applyHint()
        return
      }
      if (key.name === "escape") {
        key.preventDefault?.()
        setHints([])
        return
      }
      if (key.name === "down") {
        key.preventDefault?.()
        setHintIndex((hintIndex() + 1) % hints().length)
        return
      }
      if (key.name === "up") {
        key.preventDefault?.()
        setHintIndex((hintIndex() + hints().length - 1) % hints().length)
        return
      }
    }
    if (!question() && !hints().length && !draft() && (key.name === "up" || key.name === "down")) {
      if (!history.length) return
      key.preventDefault?.()
      if (key.name === "up") {
        historyIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      } else {
        historyIndex = historyIndex < 0 ? -1 : Math.min(history.length - 1, historyIndex + 1)
      }
      const value = historyIndex < 0 ? "" : history[historyIndex]
      setDraft(value)
      if (input) input.value = value
      return
    }
    if (!question() && matchesAction(props.config.keybinds, "details_toggle", key)) {
      key.preventDefault?.()
      setDetails(!details())
      add("info", `Tool details ${details() ? "on" : "off"}.`)
      return
    }
    if (!question() && matchesAction(props.config.keybinds, "theme_cycle", key)) {
      key.preventDefault?.()
      const names = themeNames(props.themes)
      const next = names[(names.indexOf(theme()) + 1) % names.length]
      if (next) applyTheme(next)
      return
    }
    if (!question() && matchesAction(props.config.keybinds, "help_show", key)) {
      key.preventDefault?.()
      add("info", `Keybinds:\n${keybindSummary(props.config.keybinds).join("\n")}`)
      return
    }
    if (!question() && matchesAction(props.config.keybinds, "session_new", key)) {
      key.preventDefault?.()
      command("/new")
      return
    }
    if (matchesAction(props.config.keybinds, "session_interrupt", key) && busy() && controller) {
      key.preventDefault?.()
      controller.abort()
      add("info", "Cancelled.")
      return
    }
    if (!busy() && matchesAction(props.config.keybinds, "app_exit", key)) {
      key.preventDefault?.()
      renderer.destroy()
      return
    }
    if (!question() && !busy()) {
      const list = primaryAgents(props.agents)
      if (matchesAction(props.config.keybinds, "agent_cycle", key)) {
        key.preventDefault?.()
        const index = list.findIndex((entry) => entry.id === agent().id)
        const next = list[(index + 1) % list.length]
        if (next) setCurrentAgent(next.id)
        return
      }
      if (matchesAction(props.config.keybinds, "agent_cycle_reverse", key)) {
        key.preventDefault?.()
        const index = list.findIndex((entry) => entry.id === agent().id)
        const next = list[(index + list.length - 1) % list.length]
        if (next) setCurrentAgent(next.id)
        return
      }
    }
  })

  onMount(() => {
    listProjectFiles(props.cwd).then(setFiles).catch(() => {})
    input?.focus()
    if (props.prompt) {
      setTimeout(() => run(props.prompt!), 100)
    }
  })

  const colorFor = (item: Item) => {
    if (item.kind === "user") return palette().blue
    if (item.kind === "assistant") return palette().text
    if (item.kind === "error") return palette().red
    if (item.kind === "tool") return item.text.startsWith("FAILED") ? palette().red : palette().muted
    return palette().muted
  }

  const prefixFor = (item: Item) => {
    if (item.kind === "user") return "> "
    if (item.kind === "assistant") return ""
    if (item.kind === "error") return "! "
    if (item.kind === "tool") return "  "
    return "  "
  }

  return (
    <box width="100%" height="100%" backgroundColor={palette().bg} flexDirection="column">
      <box
        height={2}
        flexShrink={0}
        border={["bottom"]}
        borderColor={palette().border}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text>
          <span style={{ fg: palette().accent, attributes: TextAttributes.BOLD }}>ZELAI</span>
          <span style={{ fg: palette().muted }}> {VERSION}</span>
        </text>
        <text fg={palette().muted}>{props.cwd}</text>
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
                <span style={{ fg: item.kind === "user" ? palette().text : colorFor(item) }}>{item.text}</span>
              </text>
              <Show when={item.meta && (details() || item.kind !== "tool")}>
                <text wrapMode="word" fg={palette().muted}>
                  {item.kind === "tool" ? `    ${item.meta}` : item.meta}
                </text>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>

      <Show when={todos().length}>
        <box
          flexShrink={0}
          border={["top"]}
          borderColor={palette().border}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          <For each={todos().slice(0, 6)}>
            {(todo) => (
              <text wrapMode="word">
                <span style={{ fg: todo.status === "completed" ? palette().accent : todo.status === "in_progress" ? palette().yellow : palette().muted }}>
                  {todo.status === "completed" ? "[x] " : todo.status === "in_progress" ? "[~] " : todo.status === "cancelled" ? "[-] " : "[ ] "}
                </span>
                <span style={{ fg: todo.status === "completed" ? palette().muted : palette().text }}>{todo.content}</span>
              </text>
            )}
          </For>
        </box>
      </Show>

      <Show when={busy()}>
        <box height={1} paddingLeft={1} flexShrink={0}>
          <text fg={palette().yellow}>
            working · step {step()} · {agent().name} · {shortModel(currentModel())}
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
          borderColor={palette().yellow}
          backgroundColor={palette().panel}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={palette().yellow} attributes={TextAttributes.BOLD}>
            Allow {approval()!.request.kind}?
          </text>
          <text fg={palette().text} wrapMode="word">
            {approval()!.request.title}
          </text>
          <text fg={palette().muted} wrapMode="word">
            {approval()!.request.detail.length > 600
              ? `${approval()!.request.detail.slice(0, 600)}...`
              : approval()!.request.detail}
          </text>
          <text fg={palette().muted}>[y] once   [a] always   [n] deny</text>
        </box>
      </Show>

      <Show when={question()}>
        <box
          position="absolute"
          bottom={5}
          left={2}
          right={2}
          zIndex={110}
          border
          borderColor={palette().blue}
          backgroundColor={palette().panel}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={palette().blue} attributes={TextAttributes.BOLD}>
            {question()!.request.header || "Question"}
          </text>
          <text fg={palette().text} wrapMode="word">
            {question()!.request.question}
          </text>
          <For each={question()!.request.options || []}>
            {(option, index) => (
              <text fg={palette().muted} wrapMode="word">
                {index() + 1}. {option.label}
                {option.description ? ` - ${option.description}` : ""}
              </text>
            )}
          </For>
          <text fg={palette().muted}>type an answer or a number, then enter</text>
        </box>
      </Show>

      <Show when={picker()}>
        <box
          position="absolute"
          top={4}
          left={2}
          right={2}
          zIndex={120}
          border
          borderColor={palette().accent}
          backgroundColor={palette().panel}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={palette().accent} attributes={TextAttributes.BOLD}>
            {picker()!.title}
          </text>
          <For each={picker()!.items.slice(0, 12)}>
            {(item, index) => (
              <text fg={index() === pickerIndex() ? palette().text : palette().muted} wrapMode="none">
                {index() === pickerIndex() ? "> " : "  "}
                {item.label}
                {item.description ? ` - ${item.description}` : ""}
              </text>
            )}
          </For>
          <text fg={palette().muted}>up/down to move · enter to select · esc to cancel</text>
        </box>
      </Show>

      <Show when={!question() && hints().length}>
        <box
          flexShrink={0}
          border={["top"]}
          borderColor={palette().border}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          <For each={hints().slice(0, 8)}>
            {(file, index) => (
              <text fg={index() === hintIndex() ? palette().accent : palette().muted} wrapMode="none">
                {index() === hintIndex() ? "> " : "  "}
                {file}
              </text>
            )}
          </For>
          <text fg={palette().muted}>tab/enter to insert · esc to close</text>
        </box>
      </Show>

      <box
        flexShrink={0}
        border={["top"]}
        borderColor={palette().border}
        paddingLeft={1}
        paddingRight={1}
        height={3}
        flexDirection="column"
      >
        <input
          ref={(value: InputRenderable) => (input = value)}
          width="100%"
          placeholder={busy() ? "Waiting for ZelAI..." : "Ask ZelAI, or type /help"}
          placeholderColor={palette().muted}
          focusedBackgroundColor={palette().border}
          backgroundColor={palette().panel}
          textColor={palette().text}
          cursorColor={palette().accent}
          onInput={(value: string) => {
            setDraft(value)
            updateHints(value)
          }}
          onSubmit={submit}
        />
      </box>

      <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} justifyContent="space-between" flexDirection="row">
        <text fg={palette().muted}>
          {agent().name} · {shortModel(currentModel())}
          {usage() ? ` · ctx ${formatTokens(usage()!.prompt)}` : ""}
        </text>
        <text fg={palette().muted}>{busy() ? "ctrl+c cancel" : `enter · ^C quit · /help${todos().length ? ` · ${todos().filter((todo) => todo.status === "completed").length}/${todos().length}` : ""}`}</text>
      </box>
    </box>
  )
}
