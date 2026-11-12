# codeindex

Stops an agent from writing a helper that already exists in a repo you share.

`codeindex build` scans the repos named in `~/.agents/plugins/codeindex/repos` and writes one JSON
index. Before a write, edit or shell redirect, the plugin looks at the new exported declarations,
scores them against the index, and warns with the existing package, file and a real call site. Set
`CODEINDEX_ENFORCE=1` to block the write instead of warning.

The shell check covers heredocs, `>`, `>>` and `tee`. A new source file written by shell with content
the guard cannot read is blocked in enforce mode, so the write tool cannot be sidestepped with
`cat > file.go`. Formatters on an existing file pass.

The hook only reads the index. Cloning, walking and scoring live in the `codeindex` CLI, so a slow
build never slows a write.

## Config

`~/.agents/plugins/codeindex/repos`, one repo per line:

```
# indexed source
~/workspace/widgets

# call sites only, no symbols indexed
uses ~/workspace/account-registry-service

# GitHub clone, kept in ~/.cache/agents-plugins/codeindex
acme/widgets
https://github.com/acme/widgets.git
```

Plain lines are indexed as reuse sources. `uses <path>` or `consumer <path>` lines are only scanned for
references, so a service repo does not add its own symbols to the index. A declaration in the same
package is never matched against itself. Tests, generated files, `vendor/` and `testdata/` are skipped.

## Commands

```bash
codeindex build                 # clone or pull, scan, write index.json and index.md
codeindex build --no-sync       # scan the local checkouts, do not touch git
codeindex list Publish          # search symbols
codeindex uses Publish          # reference counts and one real call site
codeindex check --file x.go --content new.go
codeindex repos                 # resolved repo paths
```

The index holds `version`, `builtAt`, each repo's commit and commit date, exported symbols with their
package, signature and doc line, plus reference counts. It is written to a temp file and renamed, so
the hook never reads a half-written file.

Supported declarations: Go `func`, methods, `type`, `struct`, `interface`, `const` and `var`; TypeScript
and JavaScript `export`; Python public `def` and `class`.

## Matching

A new declaration matches when one of these holds:

- the same name exists in another package,
- the body is the same as an indexed function, with the declaration name stripped, so a renamed
  copy still matches,
- the body shares at least 8 distinctive tokens and scores 0.55 or more on Jaccard similarity,
- two meaningful name tokens overlap (camelCase and snake_case are split, generic words such as
  `New`, `Get`, `Config` and `Options` are dropped),
- the name hits a house pattern, for example `Producer` maps to `kafka/producer`.

Body matching reads the function body, drops comments and strings, and ignores the declaration name
and language keywords. It catches copy-paste with a new name and small edits. It does not catch a
different implementation that does the same thing.

The check fails open: a missing or broken index allows the write and is logged. The warning says when
the index is more than `CODEINDEX_STALE_DAYS` days old (default 7).

## Env

| variable | default | meaning |
|---|---|---|
| `CODEINDEX=0` | off | disable the hook |
| `CODEINDEX_ENFORCE=1` | off | deny the write instead of warning |
| `CODEINDEX_DIR` | `~/.agents/plugins/codeindex` | config, index |
| `CODEINDEX_REPOS` | `<dir>/repos` | repo list |
| `CODEINDEX_INDEX` | `<dir>/index.json` | index file |
| `CODEINDEX_MARKDOWN` | `<dir>/index.md` | rendered summary |
| `CODEINDEX_CACHE_DIR` | `~/.cache/agents-plugins/codeindex` | clones |
| `CODEINDEX_STATE_DIR` | `~/.agents/state/codeindex` | `decisions.jsonl` |
| `CODEINDEX_STALE_DAYS` | `7` | stale warning threshold |
| `CODEINDEX_TIMEOUT_MS` | `150` | allow the write past this budget |

Override one write with `// codeindex:ok <reason>` anywhere in the new text or the file on disk.
Every decision with a new declaration is appended to `~/.agents/state/codeindex/decisions.jsonl`, so a
warn-only week can be reviewed before enforcing.

## Install

opencode 2.x loads `server.ts` through `package.json`. Add the package directory to `plugins` in
`~/.config/opencode/opencode.json` and restart:

```json
"plugins": ["/absolute/path/to/agents-plugins/packages/codeindex"]
```

opencode 1.x uses `src/opencode/plugin.ts`.

Claude Code:

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install codeindex@agents-plugins
```

`hooks/hooks.json` runs `src/claude/pretooluse.ts` on `Write|Edit|MultiEdit|Bash` with a 10 second timeout.

```bash
cd packages/codeindex && bun test
bun run test:live   # isolated opencode, only this plugin, real model, denies write and shell redirect
```

`test:live` copies the provider block from `~/.config/opencode/opencode.json`, uses a temp HOME and a
temp index, and deletes everything unless `CODEINDEX_LIVE_KEEP=1`.
