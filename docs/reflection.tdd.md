# Reflection Plugin — Technical Design Document for Testing

**Date:** 2026-06-02  
**Scope:** OpenCode plugin (`reflection-3.ts`) + Claude Code Stop hook (`claude/`)

---

## 1. Component Architecture

```
  OpenCode (OC) side                     Claude Code (CC) side
  ─────────────────────────────────────────────────────────────
  session.idle event
        │
        ▼
  ┌─────────────────┐    spawn judge     ┌──────────────────────┐
  │  reflection-3.ts│ ─────────────────► │  claude -p (judge)   │
  │  (OC plugin)    │ ◄─ JSON verdict ── │  ephemeral session   │
  └────────┬────────┘                    └──────────────────────┘
           │                                      ▲
           │ reads model list                     │ called only on
           ▼                                      │ self-assessment fail
  ┌─────────────────┐
  │ reflection.yaml │   (multi-model fallback list, ~/.config/opencode/)
  └─────────────────┘

  ┌─────────────────┐   Stop hook stdin   ┌──────────────────────┐
  │  Claude Code    │ ──────────────────► │  claude/bin/         │
  │  (CC runtime)   │ ◄─ {decision,reason}│  reflect.mjs         │
  └─────────────────┘                    └──────┬───────────────┘
                                                │
                                       ┌────────▼────────┐
                                       │ claude/lib/      │
                                       │ judge.mjs        │
                                       │ feedback.mjs     │
                                       └────────┬────────┘
                                                │ auth
                                       ┌────────▼────────┐
                                       │ macOS keychain   │
                                       │ "Claude Code-    │
                                       │  credentials"    │
                                       │ OR               │
                                       │ ~/.claude/       │
                                       │ .credentials.json│
                                       └─────────────────┘
```

---

## 2. Test Layer Diagram

```
  USE CASE                            UNIT    INTEG   EVAL    E2E-OC  E2E-CC
  ─────────────────────────────────────────────────────────────────────────────
  inferTaskType / task classification   ✓
  parseSelfAssessmentJson               ✓
  buildSelfAssessmentPrompt (gates)     ✓
  evaluateSelfAssessment (gates)        ✓
  set_reflection tool helpers           ✓
  buildEscalatingFeedback               ✓
  detectPlanningLoop / detectActionLoop ✓
  isPlanMode detection                  ✓
  Abort / ESC race guard                ✓       ✓
  Session abort detection (OC)                  ✓
  Multi-model fallback (YAML routing)   ✓
  Judge LLM verdict accuracy                            ✓
  Antipattern detection (34 cases)                      ✓
  Agent eval (6 task scenarios)                         ✓
  Full OC session: reflect triggers               ✓
  OC session: Telegram filter artifact            ✓
  CC direct-pipe: block emitted (s4)                            ✓
  CC direct-pipe: complete, no block (s5)                       ✓
  CC live: explicit wait → no inject (s1)                               ✓
  CC live: trivial Q → no inject (s2)                                   ✓
  CC live: attempt cap ≤ 3 (s3)                                         ✓

  Layers:
    UNIT   = jest test/reflection-3.unit.test.ts          (no I/O)
    INTEG  = jest test/reflection.test.ts + abort-race    (OC plugin logic)
    EVAL   = node scripts/run-promptfoo.mjs               (LLM judge accuracy)
    E2E-OC = node test/e2e.test.ts                        (real OpenCode session)
    E2E-CC = node claude/test/e2e-cc.mjs                  (real CC + Stop hook)
```

---

## 3. Use Case → Test Matrix

| # | Use Case | File/Test | Status |
|---|----------|-----------|--------|
| 1 | Task type inference (coding/docs/research/ops/other) | unit: `inferTaskType` (10 cases) | COVERED |
| 2 | research+coding keyword collision → prefer coding | unit: issue #115 tests | COVERED |
| 3 | GitHub issue URL → coding not research | unit: issue #115 URL tests | COVERED |
| 4 | ops task skips PR/CI gates | unit: `ops tasks do not require PR or CI` | COVERED |
| 5 | Self-assessment JSON parse | unit: `parseSelfAssessmentJson` | COVERED |
| 6 | Self-assessment prompt includes premature-stop antipatterns | unit: antipattern test | COVERED |
| 7 | Self-assessment prompt: permission_seeking pattern | unit: `PERMISSION-SEEKING` | COVERED |
| 8 | Self-assessment prompt: stopped_with_todos pattern | unit: `STOPPED-WITH-TODOS` | COVERED |
| 9 | Self-assessment prompt: false_complete pattern | unit: `FALSE-COMPLETE` | COVERED |
| 10 | Self-assessment prompt: verification_deferral pattern | MISSING — antipattern not asserted in unit test |
| 11 | Self-assessment prompt: analysis_no_implementation pattern | MISSING — not asserted in unit test |
| 12 | Gate: tests ran + passed + ran after changes | unit: `evaluates missing tests` | COVERED |
| 13 | Gate: tests skipped → incomplete | unit: `flags skipped tests` | COVERED |
| 14 | Gate: build ran | unit: `evaluates missing... build requirements` | COVERED |
| 15 | Gate: PR required, URL present, CI checked | unit: `requires PR evidence and CI checks` | COVERED |
| 16 | Gate: direct push to default branch → incomplete | unit: `flags direct push to default branch` | COVERED |
| 17 | Gate: local test commands must exist in session | unit: `requires local test commands from this session` | COVERED |
| 18 | needs_user_action: human-only action → requiresHumanAction=true | unit: multiple tests | COVERED |
| 19 | needs_user_action: agent-actionable items → shouldContinue=true | unit: multiple tests | COVERED |
| 20 | needs_user_action: mixed (agent + human) → shouldContinue=true | unit: `shouldContinue is true when agent has actionable work` | COVERED |
| 21 | set_reflection tool: buildToolReflectionGuidanceSection | unit: section header, truncation, null/empty | COVERED |
| 22 | set_reflection tool: precedence (file > tool > default) | unit: `precedence` tests | COVERED |
| 23 | Judge fallback on self-assessment parse failure | MISSING — no unit test; runtime path only |
| 24 | Judge fallback: JSON verdict parsed correctly | integration: `parses JSON verdict correctly` | COVERED (shallow) |
| 25 | Multi-model fallback (reflection.yaml tried in order) | unit: `parseRoutingFromYaml`, `getRoutingModel` | PARTIALLY — config parsing covered; actual fallback loop not tested |
| 26 | Task-based model routing (backend/architecture/frontend) | unit: routing describe block | COVERED |
| 27 | Cross-review model selection (opus ↔ gpt-5.2-codex) | unit: `getCrossReviewModelSpec` | COVERED |
| 28 | GitHub Copilot model normalization | unit: `getGitHubCopilotModelForRouting` | COVERED |
| 29 | buildEscalatingFeedback: null/undefined verdict | unit: null + undefined verdict tests | COVERED |
| 30 | buildEscalatingFeedback: escalation at attempt 3 (final) | unit: `escalates to final attempt message` | COVERED |
| 31 | buildEscalatingFeedback: planning loop override | unit: planning loop tests | COVERED |
| 32 | buildEscalatingFeedback: action loop override | unit: action loop tests | COVERED |
| 33 | detectPlanningLoop: all-read session → detected | unit: issue #115 test | COVERED |
| 34 | detectPlanningLoop: research task → skip loop message | unit: `does not apply planning loop for research` | COVERED |
| 35 | detectActionLoop: repeated commands → detected | unit: multiple detect tests | COVERED |
| 36 | detectActionLoop: timestamp normalization | unit: `normalizes timestamps` | COVERED |
| 37 | isPlanMode: system/developer message detection | unit: plan mode describe block | COVERED |
| 38 | isPlanMode: build-switch reminder → NOT plan mode | unit: `handles build-switch reminder` | COVERED |
| 39 | ESC abort → skip reflection (abort race guard) | abort-race.test.ts + integration | COVERED |
| 40 | Same user message → skip reflection (dedup) | MISSING — no direct unit test |
| 41 | Session guard: skip judge/plan/aborted sessions | MISSING — guard logic tested only indirectly |
| 42 | Verdict written to `.reflection/verdict_<session>.json` | MISSING — not asserted in any test |
| 43 | macOS keychain auth for CC judge | MISSING — only runtime path; not mocked/tested |
| 44 | CC hook: decision=block emitted on incomplete | E2E-CC s4 (direct-pipe, fake judge) | COVERED |
| 45 | CC hook: no block on complete verdict | E2E-CC s5 (direct-pipe, fake judge) | COVERED |
| 46 | CC hook: attempt cap ≤ 3 | E2E-CC s3 (live, judge-evaluated) | INCONCLUSIVE (live model) |
| 47 | CC hook: explicit wait → no inject (false positive guard) | E2E-CC s1 (live) | INCONCLUSIVE (live model) |
| 48 | CC hook: trivial Q → no inject | E2E-CC s2 (live) | INCONCLUSIVE (live model) |
| 49 | OC: full session reflection triggered + artifact written | reflection-static.eval.test.ts | COVERED (eval) |
| 50 | OC: Telegram filter strips reflection artifacts | integration: extractFinalResponse | COVERED |
| 51 | Judge accuracy: 34 static fixtures (promptfoo) | eval: promptfooconfig.yaml | COVERED |
| 52 | Agent eval: 6 scenario tasks (promptfoo) | eval: agent-evaluation.yaml | COVERED |
| 53 | opencode-reflection npm package published correctly | MISSING — no publish smoke test |

---

## 4. Gaps (Untested Behaviors)

1. **verification_deferral + analysis_no_implementation antipatterns** — The self-assessment prompt test only asserts `PERMISSION-SEEKING`, `STOPPED-WITH-TODOS`, `FALSE-COMPLETE`, and `LEGITIMATE STOP`. The other two mined antipatterns are never checked in the test suite.

2. **Judge LLM fallback path (parse failure → spawn)** — No test exercises the path where `parseSelfAssessmentJson` returns null and the judge session is actually spawned. The integration test (`reflection.test.ts`) mocks verdict structure superficially but does not inject a parse-failure case to verify fallback kicks in.

3. **Multi-model fallback loop** — `parseRoutingFromYaml` and `getRoutingModel` are unit-tested, but the actual retry-next-model logic (when model N times out or errors) has no test coverage.

4. **Verdict file written to `.reflection/`** — No test asserts that `verdict_<session>.json` is created after a reflection cycle. TTS/Telegram gating depends on this file.

5. **Same-message deduplication guard** — The logic that prevents re-reflecting on the same user message within a session is not directly exercised by any test.

6. **macOS keychain auth (`security find-generic-password`)** — Covered only at the code-reading level in `judge.mjs`; no test mocks the `spawnSync("security", ...)` call to verify the fallback path (file missing → keychain → OAuth Bearer).

7. **CC E2E scenarios 1/2/3 are INCONCLUSIVE** — Scenarios 1 (`explicit_wait_negative`), 2 (`complete_negative`), and 3 (`attempt_cap_respected`) use live `claude -p` calls; subject model budget or auth errors yield `INCONCLUSIVE` on every run in the current CI environment. Only scenarios 4 and 5 (direct-pipe with `REFLECTION_CC_FAKE_JUDGE`) produce deterministic PASS/FAIL.

8. **`opencode-reflection` npm package smoke test** — Publishing the package under `packages/reflection/` is CI-gated but no post-publish install test verifies the published artifact is importable.

9. **Session skip guards tested only as integration simulation** — The guard checks (is judge session?, is plan mode?, was ESC-aborted?) are tested indirectly through `reflection.test.ts` mocks, not against the real `reflection-3.ts` guard code path.

---

## 5. How to Run

```sh
# Unit tests (pure logic, no I/O)
npm test -- --testPathPattern="reflection-3.unit|abort-race" --verbose

# Integration tests (OC plugin stubs)
npm test -- --testPathPattern="reflection.test" --verbose

# Static eval (OC full session, no live API)
npm run test:reflection

# All unit + integration
npm test

# Judge accuracy eval (34-case suite — needs FIREWORKS_API_KEY)
npm run eval:judge

# Agent eval (6 task scenarios)
npm run eval:agent

# CC E2E direct-pipe (scenarios 4+5, deterministic, no live API, FAKE_JUDGE)
REFLECTION_CC_FAKE_JUDGE=1 node claude/test/e2e-cc.mjs

# CC E2E full suite (needs claude CLI + macOS keychain OAuth)
node claude/test/e2e-cc.mjs
```
