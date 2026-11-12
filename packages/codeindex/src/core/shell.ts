// Find files a shell command would write. A model can dodge the write tool with a redirect,
// so the guard reads the obvious forms: heredoc, >, >>, tee. Unknown writes are flagged only
// when they create a new source file, so formatters on existing files still pass.
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { WriteTarget } from "./write"

const SKIP = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "-", "&1", "&2"])

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

const add = (targets: Map<string, string | undefined>, file: string, cwd: string, content?: string) => {
  if (!file || SKIP.has(file) || file.startsWith("&")) return
  const path = isAbsolute(file) ? file : resolve(cwd, file)
  if (content !== undefined) targets.set(path, content)
  else if (!targets.has(path)) targets.set(path, undefined)
}

/** Write targets in a shell command, in command order. `after` is empty when the content cannot be read. */
export function shellTargets(command: string, cwd = process.cwd()): WriteTarget[] {
  const targets = new Map<string, string | undefined>()

  for (const match of command.matchAll(/\bcat\s*>\s*(['"]?)([^\s'";|&]+)\1\s*<<-?\s*(['"]?)(\w+)\3\r?\n([\s\S]*?)\r?\n\4\b/g)) {
    add(targets, match[2], cwd, match[5])
  }
  for (const match of command.matchAll(/\btee(?:\s+-a)?\s+(['"]?)([^\s'";|&]+)\1\s*<<-?\s*(['"]?)(\w+)\3\r?\n([\s\S]*?)\r?\n\4\b/g)) {
    add(targets, match[2], cwd, match[5])
  }
  for (const match of command.matchAll(/(?:^|[^0-9&>])>{1,2}\s*(['"]?)([^\s'";|&]+)\1/g)) {
    add(targets, match[2], cwd)
  }
  for (const match of command.matchAll(/\btee(?:\s+-a)?\s+(['"]?)([^\s'";|&]+)\1/g)) {
    add(targets, match[2], cwd)
  }

  return [...targets].map(([file, content]) => ({
    file,
    before: read(file),
    after: content ?? "",
    op: content === undefined ? "shell-unknown" : "shell",
  }))
}
