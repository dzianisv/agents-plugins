// Read the new file text out of the tool input. opencode and Claude Code use
// different key spellings, so both are accepted here and nowhere else.
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

export type WriteTarget = {
  file: string
  before: string
  after: string
  op: string
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

const replace = (source: string, oldText: string, newText: string): string =>
  source.includes(oldText) ? source.replace(oldText, newText) : `${source}\n${newText}`

/** The file and its new content for a write, edit or multiedit call. */
export function writeTarget(input: Record<string, unknown>, cwd = process.cwd()): WriteTarget | undefined {
  const raw = text(input.filePath) ?? text(input.file_path) ?? text(input.path)
  if (!raw) return undefined
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw)
  const before = read(file)

  const content = text(input.content)
  if (content !== undefined) return { file, before, after: content, op: "write" }

  const oldText = text(input.oldString) ?? text(input.old_string)
  const newText = text(input.newString) ?? text(input.new_string)
  if (oldText !== undefined && newText !== undefined) {
    return { file, before, after: replace(before, oldText, newText), op: "edit" }
  }

  const edits = input.edits
  if (Array.isArray(edits)) {
    let after = before
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      const row = edit as Record<string, unknown>
      const from = text(row.oldString) ?? text(row.old_string)
      const to = text(row.newString) ?? text(row.new_string)
      if (from !== undefined && to !== undefined) after = replace(after, from, to)
    }
    if (after !== before) return { file, before, after, op: "multiedit" }
  }

  return undefined
}
