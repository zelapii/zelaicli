export interface KeyLike {
  name?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  option?: boolean
  super?: boolean
}

export type KeybindValue = string | string[] | false | undefined
export type KeybindConfig = Record<string, KeybindValue>

export const DEFAULT_KEYBINDS: Record<string, string> = {
  app_exit: "ctrl+c",
  session_interrupt: "ctrl+c",
  agent_cycle: "tab",
  agent_cycle_reverse: "shift+tab",
  details_toggle: "ctrl+d",
  theme_cycle: "ctrl+t",
  help_show: "f1",
  session_new: "ctrl+n",
}

function normalizeName(value: string) {
  const name = value.trim().toLowerCase()
  if (name === "esc") return "escape"
  if (name === "enter") return "return"
  if (name === "spacebar" || name === "space") return "space"
  if (name === "del") return "delete"
  if (name === "cmd" || name === "command" || name === "super") return "meta"
  return name
}

export function normalizeBinding(value: string) {
  const parts = value
    .split("+")
    .map((part) => normalizeName(part))
    .filter(Boolean)
  const name = parts.pop() || ""
  const mods = new Set(parts)
  return {
    name,
    ctrl: mods.has("ctrl") || mods.has("control"),
    shift: mods.has("shift"),
    meta: mods.has("meta") || mods.has("alt") || mods.has("option"),
  }
}

export function bindingList(value: KeybindValue): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : value.split(",").map((item) => item.trim()).filter(Boolean)
}

export function matchesBinding(value: KeybindValue, key: KeyLike) {
  const name = normalizeName(String(key.name || ""))
  if (!name) return false
  const ctrl = Boolean(key.ctrl)
  const shift = Boolean(key.shift)
  const meta = Boolean(key.meta || key.option || key.super)
  for (const entry of bindingList(value)) {
    const binding = normalizeBinding(entry)
    if (binding.name !== name) continue
    if (binding.ctrl !== ctrl) continue
    if (binding.shift !== shift) continue
    if (binding.meta !== meta) continue
    return true
  }
  return false
}

export function keybindFor(config: KeybindConfig | undefined, action: string): KeybindValue {
  if (config && Object.prototype.hasOwnProperty.call(config, action)) return config[action]
  return DEFAULT_KEYBINDS[action]
}

export function matchesAction(config: KeybindConfig | undefined, action: string, key: KeyLike) {
  return matchesBinding(keybindFor(config, action), key)
}

export function keybindSummary(config: KeybindConfig | undefined) {
  const actions = new Set([...Object.keys(DEFAULT_KEYBINDS), ...Object.keys(config || {})])
  return [...actions].sort().map((action) => {
    const value = keybindFor(config, action)
    const keys = bindingList(value).join(", ")
    return `${action.padEnd(22)} ${keys || "none"}`
  })
}
