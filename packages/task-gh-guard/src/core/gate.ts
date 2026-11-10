// The CI gate: records pushed commits and checks their GitHub CI, a port of bin/pr-ci-gate.
import { execFile } from "node:child_process"
import { readFileSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { pushBranches, pushHits } from "./push"
import { expandUser, readState, statePath, writeState, type StateEntry } from "./state"

export type GateStatus = "pass" | "fail" | "pending"

export type Check = {
  name: string
  state: string
  url: string
  pr: number | null
  kind: string
  message?: string
}

export type Entry = {
  repo: string
  owner: string | null
  name: string | null
  branch: string
  sha: string
  pushed_at: number | null
  status: GateStatus
  checks: Check[]
  error: string | null
}

export type Gate = { status: GateStatus; message: string; entries: Entry[] }

export type RecordedEntry = {
  repo: string
  owner: string
  name: string
  branch: string
  sha: string
  pushed_at: number
}

export type RecordResult = {
  recorded: RecordedEntry[]
  skipped: Array<{ repo?: string; branch?: string; reason: string }>
  reason?: string
}

export type RunResult = { code: number; stdout: string; stderr: string }

type CheckRun = {
  name?: string
  status?: string | null
  conclusion?: string | null
  details_url?: string
  html_url?: string
  started_at?: string
}

type StatusItem = { context?: string; state?: string; target_url?: string }

type StackBranch = { branch?: string; pullRequest?: { merged?: boolean } }
type Stack = { number?: number | string; branches?: StackBranch[] }

const PASS_CONCLUSIONS = new Set(["success", "skipped", "neutral", "stale"])
const FAIL_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"])
const FAIL_STATES = new Set(["failure", "error"])
const NO_CHECKS_GRACE = 600

/** Runs a command and never rejects: a missing binary or a timeout becomes exit code 127. */
export function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: options.timeout ?? 60_000, cwd: options.cwd, env: options.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
        const code = typeof err.code === "number" ? err.code : 127
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: typeof err.code === "number" ? String(stderr ?? "") : err.message,
        })
      },
    )
  })
}

async function git(repo: string, ...args: string[]): Promise<string | null> {
  const result = await run("git", ["-C", repo, ...args], { timeout: 20_000 })
  return result.code === 0 ? result.stdout.trim() : null
}

async function toplevel(path: string): Promise<string | null> {
  return git(path, "rev-parse", "--show-toplevel")
}

async function gitDir(repo: string): Promise<string> {
  const raw = await git(repo, "rev-parse", "--path-format=absolute", "--git-dir")
  return raw ?? join(repo, ".git")
}

async function currentBranch(repo: string): Promise<string | null> {
  const branch = await git(repo, "rev-parse", "--abbrev-ref", "HEAD")
  return branch && branch !== "HEAD" ? branch : null
}

async function originSlug(repo: string): Promise<[string, string] | null> {
  const url = (await git(repo, "config", "--get", "remote.origin.url")) ?? (await git(repo, "remote", "get-url", "origin"))
  if (!url) return null
  const match = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? [match[1], match[2]] : null
}

async function sameAsOrigin(repo: string, branch: string): Promise<string | null> {
  const local = await git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)
  const remote = await git(repo, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`)
  return local && remote && local === remote ? local : null
}

/** Open branches of the gh stack holding the current branch (or stack `number`). */
export async function openStackBranches(repo: string, number?: number | null): Promise<string[]> {
  let data: { stacks?: Stack[] }
  try {
    data = JSON.parse(readFileSync(join(await gitDir(repo), "gh-stack"), "utf8")) as { stacks?: Stack[] }
  } catch {
    return []
  }
  const current = await currentBranch(repo)
  for (const stack of data.stacks ?? []) {
    if (number != null && String(stack.number) !== String(number)) continue
    if (number == null && !(stack.branches ?? []).some((branch) => branch.branch === current)) continue
    const branches = (stack.branches ?? [])
      .filter((branch) => branch.branch && !branch.pullRequest?.merged)
      .map((branch) => branch.branch as string)
    if (branches.length) return branches
  }
  return []
}

/** Records the branches a push-like or GitHub-post command landed, state only when local equals origin. */
export async function record(
  runtime: string,
  sessionID: string,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecordResult> {
  const directory = expandUser(cwd)
  const hits = pushHits(command)
  if (!hits.length) return { recorded: [], skipped: [], reason: "not a push" }
  const pairs: Array<{ repo: string; branch: string }> = []
  const skipped: RecordResult["skipped"] = []
  for (const { hit } of hits) {
    if (hit.kind === "sign") {
      if (hit.dry) {
        skipped.push({ reason: "dry run" })
        continue
      }
      const repo = await toplevel(directory)
      const branch = repo ? await currentBranch(repo) : null
      if (repo && branch) pairs.push({ repo, branch })
      continue
    }
    if (hit.kind === "post") {
      const repo = await toplevel(directory)
      const branch = repo ? await currentBranch(repo) : null
      if (repo && branch) pairs.push({ repo, branch })
      continue
    }
    if (hit.kind === "stack") {
      const repo = await toplevel(directory)
      if (!repo) {
        skipped.push({ reason: `not a git repo: ${directory}` })
        continue
      }
      const open = await openStackBranches(repo)
      const branches = open.length ? open : [await currentBranch(repo)]
      for (const branch of branches) if (branch) pairs.push({ repo, branch })
      continue
    }
    const path = hit.repo ? resolve(directory, hit.repo) : directory
    const repo = await toplevel(path)
    if (!repo) {
      skipped.push({ reason: `not a git repo: ${path}` })
      continue
    }
    const named = await pushBranches(repo, hit.args, git, currentBranch)
    const branches = named.length ? named : [await currentBranch(repo)]
    for (const branch of branches) if (branch) pairs.push({ repo, branch })
  }

  const recorded: RecordedEntry[] = []
  const seen = new Set<string>()
  for (const { repo, branch } of pairs) {
    const key = `${repo}\u0000${branch}`
    if (seen.has(key)) continue
    seen.add(key)
    const slug = await originSlug(repo)
    if (!slug) {
      skipped.push({ repo, branch, reason: "no GitHub origin" })
      continue
    }
    const sha = await sameAsOrigin(repo, branch)
    if (!sha) {
      skipped.push({ repo, branch, reason: "local branch is not equal to origin" })
      continue
    }
    recorded.push({ repo, owner: slug[0], name: slug[1], branch, sha, pushed_at: Math.floor(Date.now() / 1000) })
  }

  if (recorded.length) {
    const path = statePath(runtime, sessionID, env)
    const data = readState(path)
    const keys = new Set(recorded.map((item) => `${item.repo}\u0000${item.branch}`))
    data.entries = data.entries.filter((entry) => !keys.has(`${entry.repo}\u0000${entry.branch}`)).concat(recorded)
    data.runtime = runtime
    data.session_id = sessionID
    data.updated_at = Math.floor(Date.now() / 1000)
    writeState(path, data)
  }
  return { recorded, skipped }
}

/** gh env without an inherited GH_TOKEN/GITHUB_TOKEN, so gh falls back to its own keyring auth. */
function ghEnvWithoutToken(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return env
}

async function ghJson(args: string[], timeout = 60_000): Promise<{ doc: unknown; error: string | null }> {
  let result = await run("gh", args, { timeout })
  // A stale exported token must not wedge the gate: retry once with gh's own configured auth.
  if (result.code !== 0 && /Bad credentials/i.test(`${result.stderr}\n${result.stdout}`)) {
    result = await run("gh", args, { timeout, env: ghEnvWithoutToken() })
  }
  if (result.code !== 0) {
    return { doc: null, error: (result.stderr || result.stdout || `gh exited ${result.code}`).trim().slice(0, 300) }
  }
  try {
    return { doc: JSON.parse(result.stdout || "null") as unknown, error: null }
  } catch (err) {
    return { doc: null, error: `bad JSON from gh: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function fetchCheckRuns(
  owner: string,
  name: string,
  sha: string,
): Promise<{ runs: CheckRun[] | null; error: string | null }> {
  const { doc, error } = await ghJson(["api", `repos/${owner}/${name}/commits/${sha}/check-runs`, "--paginate", "--slurp"])
  if (error) return { runs: null, error }
  const pages = Array.isArray(doc) ? doc : [doc]
  const runs: CheckRun[] = []
  for (const page of pages) {
    if (page && typeof page === "object") runs.push(...((page as { check_runs?: CheckRun[] }).check_runs ?? []))
  }
  return { runs, error: null }
}

async function fetchStatuses(
  owner: string,
  name: string,
  sha: string,
): Promise<{ statuses: StatusItem[] | null; error: string | null }> {
  const { doc, error } = await ghJson(["api", `repos/${owner}/${name}/commits/${sha}/status`])
  if (error) return { statuses: null, error }
  const statuses = doc && typeof doc === "object" ? (doc as { statuses?: StatusItem[] }).statuses : null
  return { statuses: statuses ?? [], error: null }
}

async function prNumber(owner: string, name: string, sha: string): Promise<number | null> {
  const { doc, error } = await ghJson(
    ["pr", "list", "--repo", `${owner}/${name}`, "--search", sha, "--state", "all", "--json", "number", "--limit", "1"],
    30_000,
  )
  if (error || !Array.isArray(doc) || !doc.length) return null
  const number = (doc[0] as { number?: unknown }).number
  return typeof number === "number" ? number : null
}

/** True when the branch on GitHub no longer contains the recorded commit (amended, re-signed or force-pushed). */
async function superseded(owner: string, name: string, branch: string, sha: string): Promise<boolean> {
  const head = await ghJson(["api", `repos/${owner}/${name}/branches/${branch}`], 30_000)
  const headSha = (head.doc as { commit?: { sha?: unknown } } | null)?.commit?.sha
  if (head.error || typeof headSha !== "string" || headSha === sha) return false
  const compare = await ghJson(["api", `repos/${owner}/${name}/compare/${sha}...${headSha}`], 30_000)
  const status = (compare.doc as { status?: unknown } | null)?.status
  return !compare.error && (status === "diverged" || status === "behind")
}

/** Drops a cancelled run when a later run of the same check finished on the same commit. */
export function dropSuperseded(runs: CheckRun[]): CheckRun[] {
  const started = (run: CheckRun): string => run.started_at ?? ""
  return runs.filter(
    (run) =>
      !(
        (run.conclusion ?? "").toLowerCase() === "cancelled" &&
        runs.some(
          (other) =>
            other !== run &&
            other.name === run.name &&
            (other.status ?? "").toLowerCase() === "completed" &&
            (other.conclusion ?? "").toLowerCase() !== "cancelled" &&
            started(other) >= started(run),
        )
      ),
  )
}

/** Checks every recorded commit and summarizes the worst status. */
export async function checkEntry(entry: StateEntry, now: number, lookupPr: boolean): Promise<Entry> {
  const owner = entry.owner
  const name = entry.name
  const sha = entry.sha
  const base: Entry = {
    repo: entry.repo ?? "",
    owner: owner ?? null,
    name: name ?? null,
    branch: entry.branch ?? "?",
    sha: sha ?? "",
    pushed_at: entry.pushed_at ?? null,
    status: "pass",
    checks: [],
    error: null,
  }
  if (!owner || !name || !sha) {
    base.status = "pending"
    base.error = "incomplete state entry (owner, repo or sha missing)"
    return base
  }

  if (await superseded(owner, name, base.branch, sha)) return base

  const runsResult = await fetchCheckRuns(owner, name, sha)
  const statusResult = await fetchStatuses(owner, name, sha)
  let error = runsResult.error ?? statusResult.error
  if (error) {
    if (error.includes("No commit found for SHA")) {
      error = `${sha.slice(0, 7)} is not on GitHub (unpushed commit, or it belongs to another repo)`
    }
    base.status = "pending"
    base.error = error
    base.checks = [{ name: "ci", state: "unknown", url: "", pr: null, kind: "error", message: error }]
    return base
  }

  const runs = dropSuperseded(runsResult.runs ?? [])
  const fails: Check[] = []
  const pending: Check[] = []
  for (const item of runs) {
    const conclusion = (item.conclusion ?? "").toLowerCase()
    const state = (item.status ?? "").toLowerCase()
    const check: Check = {
      name: item.name ?? "check",
      state: conclusion || state || "pending",
      url: item.details_url ?? item.html_url ?? "",
      pr: null,
      kind: "check_run",
    }
    if (FAIL_CONCLUSIONS.has(conclusion)) fails.push(check)
    else if (PASS_CONCLUSIONS.has(conclusion)) continue
    else pending.push(check)
  }

  for (const item of statusResult.statuses ?? []) {
    const state = (item.state ?? "").toLowerCase()
    const check: Check = {
      name: item.context ?? "status",
      state: state || "pending",
      url: item.target_url ?? "",
      pr: null,
      kind: "status",
    }
    if (FAIL_STATES.has(state)) fails.push(check)
    else if (state === "success") continue
    else pending.push(check)
  }

  if (fails.length) {
    const pr = lookupPr ? await prNumber(owner, name, sha) : null
    for (const check of fails) check.pr = pr
    base.status = "fail"
    base.checks = fails
  } else if (pending.length) {
    base.status = "pending"
    base.checks = pending
  } else if (!runs.length && !(statusResult.statuses ?? []).length) {
    const pushedAt = entry.pushed_at || now
    const age = Math.max(0, now - Math.floor(pushedAt))
    if (age < NO_CHECKS_GRACE) {
      base.status = "pending"
      base.checks = [
        { name: "no check runs", state: "pending", url: "", pr: null, kind: "wait", message: `none reported yet (${age}s after push)` },
      ]
    }
  }
  return base
}

/** The human-readable summary for a set of checked entries. */
export function buildMessage(status: GateStatus, entries: Entry[]): string {
  if (status === "pass") return ""
  const blocks: string[] = []
  for (const entry of entries) {
    if (entry.status === "pass") continue
    const label = `${entry.branch}@${entry.sha.slice(0, 7)}`
    let lines: string[]
    if (entry.status === "fail") {
      lines = [`CI failed on ${label}:`]
    } else {
      if (entry.error && !entry.checks.length) {
        blocks.push(`CI unavailable on ${label}: ${entry.error}`)
        continue
      }
      const summary = entry.checks.map((check) => `${check.name} (${check.state})`).join(", ")
      lines = [`CI pending on ${label}: ${summary}.`]
    }
    for (const check of entry.checks) {
      let text = `- ${check.name} (${check.state})`
      if (check.url) text += ` ${check.url}`
      if (check.pr) text += ` PR #${check.pr}`
      if (check.message && !check.url) text += `: ${check.message}`
      lines.push(text)
    }
    blocks.push(lines.join("\n"))
  }
  return blocks.join("\n")
}

/** Checks every entry; a failure anywhere beats a pending, which beats a pass. */
export async function evaluate(
  entries: StateEntry[],
  now = Math.floor(Date.now() / 1000),
  lookupPr = true,
): Promise<Gate> {
  const results: Entry[] = []
  for (const entry of entries) results.push(await checkEntry(entry, now, lookupPr))
  const status: GateStatus = results.some((entry) => entry.status === "fail")
    ? "fail"
    : results.some((entry) => entry.status === "pending")
      ? "pending"
      : "pass"
  return { status, message: buildMessage(status, results), entries: results }
}

// Matches Python's Path.is_file(): a missing path or a directory is not state.
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Evaluates a session state file; deletes it once every recorded SHA passes. */
export async function gate(file: string): Promise<Gate> {
  if (!isFile(file)) return { status: "pass", message: "", entries: [] }
  const result = await evaluate(readState(file).entries)
  if (result.status === "pass") rmSync(file, { force: true })
  return result
}

/** Builds gate entries for branches named on the command line (or the current gh stack). */
export async function adhocEntries(
  repoPath: string,
  branches: string[],
  stackRequested: boolean,
  stackNumber: number | null,
): Promise<StateEntry[]> {
  const repo = await toplevel(repoPath)
  if (!repo) throw new Error(`not a git repository: ${repoPath}`)
  const slug = await originSlug(repo)
  if (!slug) throw new Error(`no GitHub origin in ${repo}`)
  let named = branches
  if (stackRequested) {
    const found = await openStackBranches(repo, stackNumber)
    if (!found.length && !named.length) {
      const label = stackNumber != null ? `stack ${stackNumber}` : "a stack"
      throw new Error(`no open ${label} holding ${(await currentBranch(repo)) ?? "HEAD"}`)
    }
    named = named.length ? named : found
  }
  const current = named.length
    ? named
    : [await currentBranch(repo)].filter((branch): branch is string => branch !== null)
  const entries: StateEntry[] = []
  for (const branch of current.filter(Boolean)) {
    const sha =
      (await git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)) ??
      (await git(repo, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`))
    if (!sha) {
      entries.push({ repo, owner: slug[0], name: slug[1], branch, sha: "", pushed_at: null })
      continue
    }
    const stamp = await git(repo, "show", "-s", "--format=%ct", sha)
    entries.push({
      repo,
      owner: slug[0],
      name: slug[1],
      branch,
      sha,
      pushed_at: stamp && /^\d+$/.test(stamp) ? Number(stamp) : Math.floor(Date.now() / 1000),
    })
  }
  return entries
}
