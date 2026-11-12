#!/usr/bin/env bun
// gh-guard CLI: the pr-ci-gate gate, its internal `record`, and the git-rules-review subcommands.
import { existsSync } from "node:fs"
import { adhocEntries, evaluate, gate, record, type Gate } from "./core/gate"
import { check, ensureConfig, home, type Review } from "./core/review"
import { expandUser } from "./core/state"

const PASS = 0
const FAIL = 1
const PENDING = 2
const USAGE = 64
const REVIEW_USAGE = 2

const GATE_USAGE = `usage: pr-ci-gate [--state FILE] [--repo DIR] [--stack [N]] [--wait SECONDS] [--json] [branches ...]
       pr-ci-gate record --runtime {claude,opencode} --session ID --cwd DIR --command COMMAND`

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function usageError(prog: string, text: string, code = USAGE): never {
  process.stderr.write(`${prog}: error: ${text}\n`)
  process.exit(code)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Splits `--name=value` into its parts; argparse accepts both forms.
function splitOption(arg: string): [string, string | undefined] {
  const separator = arg.indexOf("=")
  return separator === -1 ? [arg, undefined] : [arg.slice(0, separator), arg.slice(separator + 1)]
}

type GateArgs = { state?: string; repo: string; stack?: string; wait: number; json: boolean; branches: string[] }

function parseGateArgs(argv: string[]): GateArgs {
  const args: GateArgs = { repo: ".", wait: 0, json: false, branches: [] }
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitOption(argv[i])
    if (name === "-h" || name === "--help") {
      process.stdout.write(`${GATE_USAGE}\n\nCheck GitHub CI for the commits this session pushed.\n`)
      process.exit(0)
    }
    if (name === "--state" || name === "--repo" || name === "--wait") {
      const value = inline ?? argv[++i]
      if (value === undefined) usageError("pr-ci-gate", `argument ${name}: expected one argument`)
      if (name === "--state") args.state = value
      else if (name === "--repo") args.repo = value
      else {
        const wait = Number(value)
        if (!Number.isInteger(wait)) usageError("pr-ci-gate", `argument --wait: invalid int value: '${value}'`)
        args.wait = wait
      }
      continue
    }
    if (name === "--stack") {
      if (inline !== undefined) args.stack = inline
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) args.stack = argv[++i]
      else args.stack = ""
      continue
    }
    if (name === "--json" && inline === undefined) {
      args.json = true
      continue
    }
    if (name.startsWith("-") && name !== "-") usageError("pr-ci-gate", `unrecognized arguments: ${argv[i]}`)
    args.branches.push(argv[i])
  }
  return args
}

// `pr-ci-gate record ...` is the internal recorder; every other argument belongs to the gate.
async function gateMain(argv: string[]): Promise<number> {
  if (argv[0] === "record") return recordMain(argv.slice(1))
  const args = parseGateArgs(argv)
  if (args.state && (args.branches.length || args.stack !== undefined)) {
    usageError("pr-ci-gate", "--state cannot be combined with branches or --stack")
  }
  if (args.stack !== undefined && args.branches.length) usageError("pr-ci-gate", "use --stack or branch names, not both")
  if (args.stack && !/^\d+$/.test(args.stack)) usageError("pr-ci-gate", "--stack takes a stack number, not a branch name")

  const stackRequested = args.stack !== undefined
  const stackNumber = args.stack ? Number(args.stack) : null
  const stateFile = args.state ? expandUser(args.state) : undefined

  let result: Gate
  if (stateFile) {
    result = existsSync(stateFile) ? await gate(stateFile) : { status: "pass", message: "", entries: [] }
  } else {
    result = await evaluate(await adhocEntries(args.repo, args.branches, stackRequested, stackNumber))
  }

  const deadline = Date.now() / 1000 + Math.max(0, args.wait)
  while (result.status === "pending" && Date.now() / 1000 < deadline) {
    await sleep(Math.min(10, Math.max(0, deadline - Date.now() / 1000)) * 1000)
    if (stateFile) {
      if (!existsSync(stateFile)) {
        result = { status: "pass", message: "", entries: [] }
        break
      }
      result = await gate(stateFile)
    } else {
      result = await evaluate(await adhocEntries(args.repo, args.branches, stackRequested, stackNumber))
    }
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.message) {
    console.log(result.message)
  } else if (result.status === "pass" && !stateFile) {
    const labels = result.entries.filter((entry) => entry.sha).map((entry) => `${entry.branch}@${entry.sha.slice(0, 7)}`)
    console.log(`CI passing: ${labels.join(", ")}`)
  }
  return result.status === "pass" ? PASS : result.status === "fail" ? FAIL : PENDING
}

async function recordMain(argv: string[]): Promise<number> {
  let runtime: string | undefined
  let session: string | undefined
  let cwd = process.cwd()
  let command: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitOption(argv[i])
    if (name === "--runtime" || name === "--session" || name === "--cwd" || name === "--command") {
      const value = inline ?? argv[++i]
      if (value === undefined) usageError("pr-ci-gate record", `argument ${name}: expected one argument`)
      if (name === "--runtime") runtime = value
      else if (name === "--session") session = value
      else if (name === "--cwd") cwd = value
      else command = value
      continue
    }
    usageError("pr-ci-gate record", `unrecognized arguments: ${argv[i]}`)
  }
  if (runtime !== "claude" && runtime !== "opencode") {
    usageError("pr-ci-gate record", "argument --runtime is required (choices: claude, opencode)")
  }
  if (session === undefined) usageError("pr-ci-gate record", "argument --session is required")
  if (command === undefined) usageError("pr-ci-gate record", "argument --command is required")
  console.log(JSON.stringify(await record(runtime, session, cwd, command), null, 2))
  return PASS
}

async function reviewMain(argv: string[]): Promise<number> {
  if (argv[0] === "init") {
    ensureConfig()
    console.log(home())
    return 0
  }
  if (argv[0] === "check") {
    let command: string | undefined
    for (let i = 1; i < argv.length; i++) {
      const [name, inline] = splitOption(argv[i])
      if (name === "--command") {
        command = inline ?? argv[++i]
        if (command === undefined) usageError("git-rules-review", "argument --command: expected one argument", REVIEW_USAGE)
        continue
      }
      usageError("git-rules-review", `unrecognized arguments: ${argv[i]}`, REVIEW_USAGE)
    }
    if (command === undefined) usageError("git-rules-review", "the following arguments are required: --command", REVIEW_USAGE)
    let verdict: Review
    try {
      verdict = await check(command)
    } catch (err) {
      verdict = { decision: "skip", reason: `rule review skipped: ${message(err)}` }
    }
    console.log(JSON.stringify(verdict))
    return 0
  }
  usageError("git-rules-review", "the following arguments are required: {init,check}", REVIEW_USAGE)
}

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0)
})

try {
  const command = process.argv[2]
  if (command === "gate") process.exitCode = await gateMain(process.argv.slice(3))
  else if (command === "review") process.exitCode = await reviewMain(process.argv.slice(3))
  else {
    process.stderr.write(`${GATE_USAGE}\n`)
    process.exitCode = USAGE
  }
} catch (err) {
  process.stderr.write(`${process.argv[2] === "review" ? "git-rules-review" : "pr-ci-gate"}: ${message(err)}\n`)
  process.exitCode = 1
}
