import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function editorCommand() {
  return process.env.VISUAL || process.env.EDITOR || ""
}

export function editorAvailable() {
  return Boolean(editorCommand().trim())
}

async function runEditor(file: string) {
  const editor = editorCommand().trim()
  if (!editor) throw new Error("Set EDITOR or VISUAL to use the external editor.")
  const proc = Bun.spawn(["sh", "-c", `${editor} "$1"`, "zelai-editor", file], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`Editor exited with code ${code}.`)
}

export async function editText(initial = "", extension = "md") {
  const file = path.join(os.tmpdir(), `zelai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`)
  await fs.writeFile(file, initial, { mode: 0o600 })
  try {
    await runEditor(file)
    return await fs.readFile(file, "utf8")
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

export async function writeAndEdit(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, { mode: 0o600 })
  await runEditor(file)
  return file
}
