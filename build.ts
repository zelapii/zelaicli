#!/usr/bin/env bun
import path from "node:path"
import { rm } from "node:fs/promises"
import solidPlugin from "@opentui/solid/bun-plugin"
import pkg from "./package.json"

const args = process.argv.slice(2)
const outdir = args.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) || "dist"
const requested = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)

function hostTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  return `bun-${platform}-${process.arch}`
}

const target = requested || hostTarget()
const outfile = path.join(outdir, target.includes("windows") ? "zelai.exe" : "zelai")

await rm(outdir, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  target: "bun",
  plugins: [solidPlugin],
  define: {
    "process.env.ZELAI_VERSION": JSON.stringify(pkg.version),
  },
  compile: {
    target: target as any,
    outfile,
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`built ${outfile}`)
