type OperationType = "equal" | "delete" | "insert"

interface Operation {
  type: OperationType
  line: string
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function diffOperations(a: string[], b: string[]): Operation[] {
  const n = a.length
  const m = b.length
  if (!n) return b.map((line): Operation => ({ type: "insert", line }))
  if (!m) return a.map((line): Operation => ({ type: "delete", line }))

  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  v.fill(-1)
  v[offset + 1] = 0
  const trace: Int32Array[] = []
  let depth = 0

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice())
    let found = false
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        depth = d
        found = true
        break
      }
    }
    if (found) break
  }

  const operations: Operation[] = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d -= 1) {
    const previous = trace[d]
    const k = x - y
    let previousK: number
    if (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) {
      previousK = k + 1
    } else {
      previousK = k - 1
    }
    const previousX = previous[offset + previousK]
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      operations.push({ type: "equal", line: a[x - 1] })
      x -= 1
      y -= 1
    }
    if (x === previousX) {
      operations.push({ type: "insert", line: b[y - 1] })
      y -= 1
    } else {
      operations.push({ type: "delete", line: a[x - 1] })
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    operations.push({ type: "equal", line: a[x - 1] })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    x -= 1
    operations.push({ type: "delete", line: a[x] })
  }
  while (y > 0) {
    y -= 1
    operations.push({ type: "insert", line: b[y] })
  }
  return operations.reverse()
}

export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  const a = splitLines(before)
  const b = splitLines(after)
  const operations = diffOperations(a, b)
  const changes: number[] = []
  operations.forEach((operation, index) => {
    if (operation.type !== "equal") changes.push(index)
  })
  if (!changes.length) return ""

  const oldBefore = new Int32Array(operations.length + 1)
  const newBefore = new Int32Array(operations.length + 1)
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    oldBefore[index + 1] = oldBefore[index] + (operation.type === "insert" ? 0 : 1)
    newBefore[index + 1] = newBefore[index] + (operation.type === "delete" ? 0 : 1)
  }

  const ctx = Math.max(0, Math.trunc(context))
  const hunks: { start: number; end: number }[] = []
  for (const index of changes) {
    const start = Math.max(0, index - ctx)
    const end = Math.min(operations.length, index + ctx + 1)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else hunks.push({ start, end })
  }

  const lines = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of hunks) {
    const oldCount = oldBefore[hunk.end] - oldBefore[hunk.start]
    const newCount = newBefore[hunk.end] - newBefore[hunk.start]
    const oldStart = oldBefore[hunk.start] + (oldCount === 0 ? 0 : 1)
    const newStart = newBefore[hunk.start] + (newCount === 0 ? 0 : 1)
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (let index = hunk.start; index < hunk.end; index += 1) {
      const operation = operations[index]
      const prefix = operation.type === "insert" ? "+" : operation.type === "delete" ? "-" : " "
      lines.push(`${prefix}${operation.line}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export function diffStat(before: string, after: string): { added: number; removed: number } {
  const operations = diffOperations(splitLines(before), splitLines(after))
  let added = 0
  let removed = 0
  for (const operation of operations) {
    if (operation.type === "insert") added += 1
    if (operation.type === "delete") removed += 1
  }
  return { added, removed }
}
