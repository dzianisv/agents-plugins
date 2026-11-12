// Find exported declarations in one file. Regex only: gofmt puts every top-level Go
// declaration at column 0, and the same holds for the other languages here.

export type Lang = "go" | "ts" | "py"

export type Decl = {
  name: string
  kind: string
  recv?: string
  sig: string
  doc?: string
  body?: string
  line: number
}

const EXT: Record<string, Lang> = {
  ".go": "go",
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
}

export function languageOf(file: string): Lang | undefined {
  const dot = file.lastIndexOf(".")
  return dot < 0 ? undefined : EXT[file.slice(dot)]
}

export function isGenerated(text: string): boolean {
  const head = text.slice(0, 4000)
  return /Code generated .* DO NOT EDIT\./.test(head) || /@generated\b/.test(head)
}

const firstSentence = (text: string): string => {
  const flat = text.split("\n").map((line) => line.replace(/^\s*(?:\/\/|\*)\s?/, "").trim()).filter(Boolean).join(" ")
  const end = /[.!?](?:\s|$)/.exec(flat)
  const sentence = end ? flat.slice(0, end.index + 1) : flat
  return sentence.slice(0, 200)
}

const commentsAbove = (lines: string[], index: number): string | undefined => {
  let i = index - 1
  if (i >= 0 && lines[i].trim().endsWith("*/")) {
    const block: string[] = []
    while (i >= 0) {
      block.unshift(lines[i].trim())
      if (lines[i].includes("/*")) break
      i--
    }
    const text = firstSentence(block.join("\n"))
    return text || undefined
  }
  const block: string[] = []
  while (i >= 0 && lines[i].trim().startsWith("//")) {
    block.unshift(lines[i].trim())
    i--
  }
  const text = firstSentence(block.join("\n"))
  return text || undefined
}

const signature = (lines: string[], index: number): string => {
  const parts: string[] = []
  let depth = 0
  for (let i = index; i < Math.min(lines.length, index + 6); i++) {
    const part = lines[i].trim()
    parts.push(part)
    for (const char of part) {
      if (char === "(" || char === "[") depth++
      if (char === ")" || char === "]") depth--
    }
    if (depth <= 0 && (part.endsWith("{") || !part.endsWith(","))) break
  }
  return parts.join(" ").replace(/\s*\{\s*$/, "").slice(0, 240)
}

/** Text from the first `{` to its matching `}`, skipping comments and strings. */
const balancedBody = (text: string): string | undefined => {
  const start = text.indexOf("{")
  if (start < 0) return undefined
  let depth = 0
  let state: "code" | "line" | "block" | "double" | "single" | "raw" = "code"
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line"
        i++
      } else if (char === "/" && next === "*") {
        state = "block"
        i++
      } else if (char === '"') state = "double"
      else if (char === "'") state = "single"
      else if (char === "`") state = "raw"
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) return text.slice(start, i + 1)
    } else if (state === "line") {
      if (char === "\n") state = "code"
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code"
        i++
      }
    } else if (state === "double" || state === "single") {
      if (char === "\\") i++
      else if ((state === "double" && char === '"') || (state === "single" && char === "'")) state = "code"
    } else if (char === "`") state = "code"
  }
  return undefined
}

const pythonBody = (lines: string[], index: number): string | undefined => {
  const base = lines[index].match(/^\s*/)?.[0].length ?? 0
  const body: string[] = []
  for (let i = index + 1; i < lines.length; i++) {
    if (!lines[i].trim()) {
      body.push(lines[i])
      continue
    }
    const indent = lines[i].match(/^\s*/)?.[0].length ?? 0
    if (indent <= base) break
    body.push(lines[i])
  }
  return body.length ? body.join("\n") : undefined
}

const goDecls = (text: string): Decl[] => {
  const lines = text.split("\n")
  const out: Decl[] = []
  let group: "const" | "var" | "type" | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    if (/^(?:const|var|type)\s*\(\s*$/.test(line)) {
      group = line.startsWith("const") ? "const" : line.startsWith("var") ? "var" : "type"
      continue
    }
    if (group && /^\)\s*$/.test(line)) {
      group = undefined
      continue
    }
    if (group === "type") {
      const member = /^\s+([A-Z]\w*)\s*(.*)$/.exec(line)
      if (member) {
        const shape = member[2].replace(/^\[[^\]]*\]\s*/, "").trim()
        const kind = shape.startsWith("struct") ? "struct" : shape.startsWith("interface") ? "interface" : "type"
        out.push({ name: member[1], kind, sig: line.trim(), doc: commentsAbove(lines, i), line: lineNo })
      }
      continue
    }
    if (group) {
      const member = /^\s+([A-Z]\w*)\b/.exec(line)
      if (member) {
        out.push({ name: member[1], kind: group, sig: line.trim(), doc: commentsAbove(lines, i), line: lineNo })
      }
      continue
    }

    const single = /^(const|var)\s+([A-Z]\w*)\b/.exec(line)
    if (single) {
      out.push({ name: single[2], kind: single[1], sig: line.trim(), doc: commentsAbove(lines, i), line: lineNo })
      continue
    }

    const fn = /^func\s+(?:\(([^)]*)\)\s+)?([A-Z]\w*)\s*[([]/.exec(line)
    if (fn) {
      const recv = fn[1]
        ?.replace(/\s+/g, " ")
        .replace(/^(\w+)\s+/, "")
        .replace(/^\*/, "")
        .replace(/\[.*\]$/, "")
      out.push({
        name: fn[2],
        kind: recv ? "method" : "func",
        recv,
        sig: signature(lines, i),
        doc: commentsAbove(lines, i),
        body: balancedBody(lines.slice(i).join("\n")),
        line: lineNo,
      })
      continue
    }

    const typ = /^type\s+([A-Z]\w*)\s*(.*)$/.exec(line)
    if (typ) {
      const shape = typ[2].replace(/^\[[^\]]*\]\s*/, "").trim()
      const kind = shape.startsWith("struct") ? "struct" : shape.startsWith("interface") ? "interface" : "type"
      out.push({
        name: typ[1],
        kind,
        sig: signature(lines, i),
        doc: commentsAbove(lines, i),
        body: balancedBody(lines.slice(i).join("\n")),
        line: lineNo,
      })
    }
  }
  return out
}

const tsDecls = (text: string): Decl[] => {
  const lines = text.split("\n")
  const out: Decl[] = []
  const re = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/
  for (let i = 0; i < lines.length; i++) {
    const match = re.exec(lines[i])
    if (!match) continue
    out.push({ name: match[2], kind: match[1], sig: lines[i].trim(), doc: commentsAbove(lines, i), body: balancedBody(lines.slice(i).join("\n")), line: i + 1 })
  }
  return out
}

const pyDecls = (text: string): Decl[] => {
  const lines = text.split("\n")
  const out: Decl[] = []
  const fn = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/
  const cls = /^class\s+([A-Za-z_]\w*)/
  for (let i = 0; i < lines.length; i++) {
    const f = fn.exec(lines[i])
    const c = cls.exec(lines[i])
    if (f && !f[1].startsWith("_")) {
      out.push({ name: f[1], kind: "func", sig: lines[i].trim(), doc: commentsAbove(lines, i), body: pythonBody(lines, i), line: i + 1 })
    } else if (c && !c[1].startsWith("_")) {
      out.push({ name: c[1], kind: "class", sig: lines[i].trim(), doc: commentsAbove(lines, i), body: pythonBody(lines, i), line: i + 1 })
    }
  }
  return out
}

/** Exported declarations of a file, in source order. */
export function declsOf(text: string, lang: Lang): Decl[] {
  if (lang === "go") return goDecls(text)
  if (lang === "ts") return tsDecls(text)
  return pyDecls(text)
}

/** Declarations present in `after` but not in `before`, keyed by kind and name. */
export function newDecls(before: string, after: string, lang: Lang): Decl[] {
  const seen = new Set(declsOf(before, lang).map((decl) => `${decl.kind}:${decl.name}`))
  return declsOf(after, lang).filter((decl) => !seen.has(`${decl.kind}:${decl.name}`))
}
