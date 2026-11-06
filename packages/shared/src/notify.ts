// Failure notifications shared by the agents-plugins packages.
// Source of truth: packages/shared/notify.ts. `scripts/sync-shared.sh` copies it into each package.
//
//   await notify("turn-check", "audit failed: judge timed out", { client })
//
// Raises a desktop notification and, when an opencode v1 client is given, an in-app toast. It never writes
// to stdout or stderr, which would corrupt the opencode TUI. The same
// message shows at most once per AGENTS_NOTIFY_WINDOW seconds (default 600); the dedupe files are shared
// with notify.py. AGENTS_NOTIFY=0 turns it off; AGENTS_NOTIFY_CMD replaces the platform command and
// receives the title and message as its last two arguments; AGENTS_NOTIFY_STATE_DIR moves the state.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, statSync, writeFileSync, utimesSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

const MAX_CHARS = 200

const stateDir = () => process.env.AGENTS_NOTIFY_STATE_DIR || join(homedir(), ".agents", "state", "notify")

const windowSeconds = () => {
  const value = Number.parseInt(process.env.AGENTS_NOTIFY_WINDOW ?? "600", 10)
  return Number.isNaN(value) ? 600 : Math.max(0, value)
}

// True when the message was shown inside the window; otherwise marks it as shown.
function seenRecently(title: string, message: string): boolean {
  const path = join(stateDir(), createHash("sha1").update(`${title}|${message}`).digest("hex"))
  try {
    if (windowSeconds() && Date.now() / 1000 - statSync(path).mtimeMs / 1000 < windowSeconds()) return true
  } catch {}
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(path, "")
    utimesSync(path, new Date(), new Date())
  } catch {}
  return false
}

function command(title: string, message: string, level: string): string[] | undefined {
  const override = process.env.AGENTS_NOTIFY_CMD
  if (override) return [...override.split(/\s+/).filter(Boolean), title, message]
  const esc = (text: string) => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  if (platform() === "darwin") {
    const sound = level === "error" ? ' sound name "Basso"' : ""
    return ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"${sound}`]
  }
  if (platform() === "linux") return ["notify-send", "-u", level === "error" ? "critical" : "normal", title, message]
  return undefined
}

export type NotifyOptions = { level?: "error" | "warning"; client?: any }

/** Tells the user something failed. Resolves true when shown; never rejects. */
export async function notify(title: string, message: string, options: NotifyOptions = {}): Promise<boolean> {
  try {
    if (process.env.AGENTS_NOTIFY === "0") return false
    const level = options.level ?? "error"
    const text = message.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_CHARS)
    if (seenRecently(title, text)) return false
    options.client?.tui
      ?.showToast({ body: { title, message: text, variant: level, duration: 10000 } })
      ?.catch?.(() => {})
    const argv = command(title, text, level)
    if (argv) {
      await new Promise<void>((resolve) => {
        execFile(argv[0], argv.slice(1), { timeout: 5000 }, () => resolve())
      })
    }
    return true
  } catch {
    return false
  }
}
