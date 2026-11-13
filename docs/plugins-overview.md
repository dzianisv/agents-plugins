# Plugins in this repo

What runs, when it runs, what it touches on disk, and why it exists. The nodes are the plugins and
their stores; the triggers are on the edges.

## When they run

```mermaid
flowchart LR
  RT("opencode runtime") -->|"prompt"| OV("overhelm")
  RT -->|"shell or turn end"| AG("agents-md-guard")
  RT -->|"3 actions, once"| SS("session-self-improve")
  RT -->|"git/gh or turn end"| GG("gh-guard")
  RT -->|"file write"| CI("codeindex")
  RT -->|"turn end: judge"| RF("reflection")
  RT -->|"turn end: review"| AR("auto-review")
  RT -->|"30 min busy"| SA("session-autoreflect")
  RT -->|"10 min idle"| SI("session-index")
```

## What they read and write

```mermaid
flowchart LR
  AG(["agents-md-guard"]) -.->|"writes"| SUPA[("~/.cache/supervisor<br/>audits.jsonl, pending, locks")]
  AG -.->|"reads"| RULES[("~/.agents/AGENTS.md<br/>~/.agents/MEMORY.md<br/>project AGENTS.md and MEMORY.md")]
  AG -.->|"creates once"| CMD[("~/.agents/plugins/<br/>agents-md-guard/commands")]
  GG(["gh-guard"]) -.->|"creates once"| GGCFG[("~/.agents/plugins/gh-guard<br/>model, rules")]
  GG -.->|"writes"| GGST[("~/.agents/state/gh-guard<br/>review.jsonl<br/>runtime-session.json")]
  CI(["codeindex"]) -.->|"reads"| CIIDX[("~/.agents/plugins/codeindex<br/>index.json")]
  CI -.->|"writes"| CILOG[("~/.agents/state/codeindex<br/>decisions.jsonl")]
  RF(["reflection"]) -.->|"writes"| REFL[(".reflection/<br/>verdict_session.json<br/>disabled, debug.log")]
  SA(["session-autoreflect"]) -.->|"writes"| SAEV[("~/.cache/session-autoreflect<br/>events.jsonl")]
  SA -.->|"reads"| SACFG[("~/.config/opencode<br/>session-autoreflect.json")]
  SS(["session-self-improve"]) -.->|"writes"| SSQ[("~/.cache/session-self-improve<br/>queue, markers")]
  SI(["session-index"]) -.->|"writes"| SIDX[("~/.agents/sessions.csv<br/>session-index.log")]
  OV(["overhelm"]) -.->|"reads"| OVF[("~/.agents/overhelm.md")]
  AR(["auto-review"]) -.->|"reads"| ARCFG[("~/.config/opencode/plugin<br/>auto-review.json")]
```

## The plugins

| Plugin | Runs on | Writes or changes on disk | Why you need it |
|---|---|---|---|
| agents-md-guard | turn end, and before every shell command on its list | `~/.cache/supervisor/` (audit log, pending notes, locks); creates `~/.agents/plugins/agents-md-guard/commands` | Judges the turn against `AGENTS.md` and `MEMORY.md` and blocks a configured command that breaks a rule |
| gh-guard | before a git or gh write, and at turn end | `~/.agents/plugins/gh-guard/` (model, rules, created once); `~/.agents/state/gh-guard/` (review log, per-session state) | Blocks the turn while CI for a commit this session pushed is red or pending, and checks writes against the review rules |
| codeindex | before a write or edit | creates `~/.agents/plugins/codeindex/` index files when built; appends `~/.agents/state/codeindex/decisions.jsonl` | Warns before a new exported declaration duplicates one an indexed repo already provides |
| reflection | turn end | `.reflection/verdict_<session>.json`, `.reflection/disabled`, `.reflection/debug.log` when debug is on | Re-prompts the agent until tests, PR and CI evidence are really there |
| auto-review | turn end | reads `~/.config/opencode/plugin/auto-review.json`; no state of its own | A second model looks for completion, test and CI gaps |
| session-autoreflect | after 30 minutes of busy time, per interval | `~/.cache/session-autoreflect/events.jsonl`; reads `~/.config/opencode/session-autoreflect.json` | Re-anchors the agent on the goal during long work |
| session-self-improve | once per session, after 3 actions | `~/.cache/session-self-improve/queue/` and `markers/` | Turns what the session learned into skill, AGENTS.md or memory updates |
| session-index | about 10 minutes after an execution ends | appends `~/.agents/sessions.csv` and `~/.agents/session-index.log` | Searchable one-line recaps across sessions |
| overhelm | every prompt | reads `~/.agents/overhelm.md`; no writes | Keeps replies short and plain |

Single-file plugins at the repo root:

| Plugin | Runs on | Writes on disk | Why you need it |
|---|---|---|---|
| `tts.ts` | agent finishes | `~/.config/opencode/opencode-helpers/tts.log` | Reads the final reply aloud |
| `telegram.ts` | agent finishes | nothing local; posts through Supabase | Two-way Telegram notifications and replies |
| `worktree.ts` | when the agent calls its tool | nothing | Git worktree status for the session |
| `opencode-auto-limit-nudge.ts` | a run dies on a usage limit | `~/.cache/opencode-auto-limit-resume/state.json` | Resumes the task on a fallback model or after backoff |
| `github.ts` | agent messages and GitHub comments | nothing local | Mirrors the session to a GitHub issue or PR |
| `sentry.ts` | an error | nothing local | Sends plugin errors to Sentry |

## Notes

- Install paths and model files: opencode reads `~/.config/opencode/opencode.json`; each judge plugin
  reads its model from `~/.agents/plugins/<name>/model`.
- The prompt evals are disabled for now (`npm run eval:*` prints a skip), so nothing here depends on
  them.
