import fs from "node:fs/promises"
import path from "node:path"
import { configDir } from "./paths"
import { projectRoot } from "./project"

export interface Palette {
  bg: string
  panel: string
  border: string
  text: string
  muted: string
  accent: string
  blue: string
  yellow: string
  red: string
}

export interface ThemeConfig {
  name?: string
  colors?: Partial<Palette>
}

const DARK: Palette = {
  bg: "#0b0d10",
  panel: "#15181d",
  border: "#262b33",
  text: "#e7e9ee",
  muted: "#8b93a1",
  accent: "#4ade80",
  blue: "#60a5fa",
  yellow: "#fbbf24",
  red: "#f87171",
}

export const BUILTIN_THEMES: Record<string, Palette> = {
  dark: DARK,
  light: {
    bg: "#f7f7f5",
    panel: "#ececea",
    border: "#c9c9c4",
    text: "#1f2328",
    muted: "#5f6672",
    accent: "#137a3f",
    blue: "#1f5fbf",
    yellow: "#8a5a00",
    red: "#b42318",
  },
  tokyonight: {
    bg: "#1a1b26",
    panel: "#24283b",
    border: "#414868",
    text: "#c0caf5",
    muted: "#7aa2f7",
    accent: "#9ece6a",
    blue: "#7aa2f7",
    yellow: "#e0af68",
    red: "#f7768e",
  },
  gruvbox: {
    bg: "#282828",
    panel: "#3c3836",
    border: "#504945",
    text: "#ebdbb2",
    muted: "#a89984",
    accent: "#b8bb26",
    blue: "#83a598",
    yellow: "#fabd2f",
    red: "#fb4934",
  },
  nord: {
    bg: "#2e3440",
    panel: "#3b4252",
    border: "#4c566a",
    text: "#eceff4",
    muted: "#a3be8c",
    accent: "#8fbcbb",
    blue: "#81a1c1",
    yellow: "#ebcb8b",
    red: "#bf616a",
  },
  catppuccin: {
    bg: "#1e1e2e",
    panel: "#313244",
    border: "#585b70",
    text: "#cdd6f4",
    muted: "#a6adc8",
    accent: "#a6e3a1",
    blue: "#89b4fa",
    yellow: "#f9e2af",
    red: "#f38ba8",
  },
  matrix: {
    bg: "#050805",
    panel: "#0b140b",
    border: "#1d3a1d",
    text: "#b6ffb6",
    muted: "#4f8f4f",
    accent: "#00ff66",
    blue: "#5cffb0",
    yellow: "#b8ff5c",
    red: "#ff5c5c",
  },
}

function isPalette(value: any): value is Palette {
  return !!value && typeof value === "object" && typeof value.bg === "string" && typeof value.text === "string"
}

async function readThemeDir(directory: string, themes: Record<string, Palette>) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const raw = await fs.readFile(path.join(directory, entry.name), "utf8").catch(() => undefined)
    if (!raw) continue
    try {
      const value = JSON.parse(raw)
      const name = entry.name.slice(0, -5)
      const palette = value?.theme && isPalette(value.theme) ? value.theme : value
      if (isPalette(palette)) themes[name] = { ...DARK, ...palette }
    } catch {}
  }
}

export async function loadThemes(cwd: string) {
  const themes: Record<string, Palette> = { ...BUILTIN_THEMES }
  await readThemeDir(path.join(configDir(), "themes"), themes)
  const root = await projectRoot(cwd)
  await readThemeDir(path.join(root, ".zelai", "themes"), themes)
  return themes
}

export function themeName(theme: string | ThemeConfig | undefined) {
  if (typeof theme === "string") return theme
  return theme?.name || "dark"
}

export function resolveTheme(
  theme: string | ThemeConfig | undefined,
  themes: Record<string, Palette> = BUILTIN_THEMES,
): Palette {
  const name = themeName(theme)
  const base = themes[name] || themes.dark || DARK
  const overrides = typeof theme === "object" && theme?.colors ? theme.colors : {}
  return { ...base, ...overrides }
}

export function themeNames(themes: Record<string, Palette> = BUILTIN_THEMES) {
  return Object.keys(themes).sort()
}
