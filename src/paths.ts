import os from "node:os"
import path from "node:path"

function home() {
  return process.env.HOME || os.homedir()
}

export const VERSION = process.env.ZELAI_VERSION || "0.1.0"

export function configDir() {
  return process.env.ZELAI_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "zelai")
}

export function dataDir() {
  return process.env.ZELAI_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(home(), ".local", "share"), "zelai")
}

export function configPath() {
  return path.join(configDir(), "zelai.json")
}

export function accountPath() {
  return path.join(configDir(), "account.json")
}

export function sessionsDir() {
  return path.join(dataDir(), "sessions")
}

export function modelsCachePath() {
  return path.join(dataDir(), "models.json")
}

export function statePath() {
  return path.join(dataDir(), "state.json")
}
