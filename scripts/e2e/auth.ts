// Exports host credentials into a throwaway 0700 directory for the e2e containers. It never prints a
// secret and never passes one on a command line: the keychain is read by `security`, the result goes
// straight to a 0600 file that the container entrypoint copies into its fresh HOME.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** The environment auth export reads; injectable so tests use fake homes and PATHs. */
export type AuthEnv = Record<string, string | undefined>

/** Options for one export; the platform is injectable so the macOS path is testable anywhere. */
export type AuthOptions = { env?: AuthEnv; platform?: string }

const home = (env: AuthEnv): string => env.HOME || homedir()
const configDir = (env: AuthEnv): string =>
  env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home(env), ".config", "opencode")
const dataDir = (env: AuthEnv): string =>
  env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode") : join(home(env), ".local", "share", "opencode")

function writePrivate(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Writes the container auth layout into `dir` (0700, files 0600). Throws, without the content, when credentials are missing. */
export function exportAuth(dir: string, options: AuthOptions = {}): void {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  // opencode: only the fireworks-ai provider block, so the user's plugins, MCP servers and other
  // providers never enter the container.
  const source = join(configDir(env), "opencode.json")
  let config: { provider?: Record<string, unknown> }
  try {
    config = JSON.parse(readFileSync(source, "utf8")) as { provider?: Record<string, unknown> }
  } catch (err) {
    throw new Error(`cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const provider = config.provider?.["fireworks-ai"]
  if (!provider) throw new Error(`no provider["fireworks-ai"] block in ${source}`)
  writePrivate(join(dir, "opencode.json"), `${JSON.stringify({ provider: { "fireworks-ai": provider } }, null, 2)}\n`)
  const authSource = join(dataDir(env), "auth.json")
  if (existsSync(authSource)) writePrivate(join(dir, "auth.json"), readFileSync(authSource))

  // Claude Code: the env token wins; macOS reads the keychain, then any credentials file.
  const token = env.CLAUDE_CODE_OAUTH_TOKEN
  if (token) {
    writePrivate(join(dir, "claude", "oauth-token"), token)
    return
  }
  if (platform === "darwin") {
    const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      env: env as NodeJS.ProcessEnv,
    })
    if (result.status === 0 && result.stdout.length > 0) {
      writePrivate(join(dir, "claude", ".credentials.json"), result.stdout)
      return
    }
  }
  const credentials = join(home(env), ".claude", ".credentials.json")
  if (existsSync(credentials)) {
    writePrivate(join(dir, "claude", ".credentials.json"), readFileSync(credentials))
    return
  }
  throw new Error("no Claude Code credentials: CLAUDE_CODE_OAUTH_TOKEN, the macOS keychain and ~/.claude/.credentials.json are all empty")
}

/** Deletes an exported auth directory; safe to call twice. */
export function removeAuth(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: bun scripts/e2e/auth.ts <dir>")
    process.exit(2)
  }
  try {
    exportAuth(dir)
    console.log(`auth exported to ${dir}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
