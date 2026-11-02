# opencode-plugins branch cleanup — recovery manifest (2026-06-08)

Deleted during supervisor extraction cleanup. To restore any branch:
`git push origin <sha>:refs/heads/<branch>`

## Deleted — merged into main (zero loss, also in main history)
- eval/expand-coverage                                104335a
- issue-120-reflection-toast                          8fefc01
- issue-123-reflection-next-steps                     b0f062e
- issue-74-plan-mode-reflection                       7422543
- issue-80-reflection-loop-prevention                 85d7a44

## Deleted — harvested into dzianisv/agents-supervisor (value preserved there)
- feat/supervisor-mode                                2c7b165   # goal loop → agents-supervisor core/goal.mjs + both runtimes
- fix/115-reflection-stuck-research-misclassification ee13878   # folded into core/patterns.json (analysis_no_implementation, stuck guidance)

## Deleted — local redundant copies (identical to remote, kept on remote)
- (local) issue-135-auto-review                       4fe631d
- (local) issue-136-package-auto-review               9aa93b9

## Consolidation check — 2026-11-02

All remaining branch work is now on `main`; none of the five branches carries unique code.

- feat/148-slack-bridge                       0574a09   # `slack-bridge/` identical to main (#149)
- feat/cross-model-review                     b4a5718   # cross-model review present in `reflection-3.ts` (#119)
- fix/opencode-worktree-sanitize-branch-name  1afc6b3   # `scripts/opencode-worktree.ts` identical to main (#118)
- issue-135-auto-review                       4fe631d   # `auto-review.ts` superseded by `packages/auto-review`
- issue-136-package-auto-review               9aa93b9   # `packages/auto-review/` copied to main

The five remote branches can now be deleted; restore any with
`git push origin <sha>:refs/heads/<branch>`.
