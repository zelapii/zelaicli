import path from "node:path"

function wildcard(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function formatterFor(file: string, formatter: Record<string, string> | undefined) {
  if (!formatter) return undefined
  const base = path.basename(file)
  const normalized = file.replace(/\\/g, "/")
  for (const [pattern, command] of Object.entries(formatter)) {
    if (!command) continue
    if (wildcard(pattern, base) || wildcard(pattern, normalized)) return command
  }
  return undefined
}

export async function runFormatter(
  file: string,
  formatter: Record<string, string> | undefined,
  cwd: string,
) {
  const template = formatterFor(file, formatter)
  if (!template) return undefined
  const command = template.includes("$FILE") ? template.split("$FILE").join(shellQuote(file)) : `${template} ${shellQuote(file)}`
  const proc = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code === 0) return undefined
  const error = (await new Response(proc.stderr).text()).trim().split("\n").slice(-3).join("\n")
  return `Formatter failed for ${file}${error ? `: ${error}` : ""}`
}
