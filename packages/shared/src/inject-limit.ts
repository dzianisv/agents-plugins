// Injection ceilings: no plugin may inject the same finding forever.
//
// Every plugin that pushes text into a session (a nudge, a stop block, a rule-feedback note) must
// bound it with a budget like this one, keyed by the scope it owns and counted inside a window. A key
// that changes on every turn (a new commit sha, a new message id) must not re-arm the injection: the
// caller counts every key that shares the scope prefix, not the exact key.

export type Budget = Record<string, { at: number }>

/** Number of recorded injections for keys with this prefix inside the window. */
export function countInWindow(budget: Budget, prefix: string, now: number, windowSeconds: number): number {
  if (windowSeconds <= 0) return 0
  let count = 0
  for (const [key, value] of Object.entries(budget)) {
    if (!key.startsWith(prefix)) continue
    if (typeof value?.at === "number" && now - value.at < windowSeconds) count++
  }
  return count
}

/** True when the plugin may inject again for this scope: fewer than `limit` injections inside the window. */
export function mayInject(budget: Budget, prefix: string, now: number, windowSeconds: number, limit: number): boolean {
  return countInWindow(budget, prefix, now, windowSeconds) < limit
}

/** Records one injection for the key and returns the new budget. */
export function recordInjection(budget: Budget, key: string, now: number): Budget {
  return { ...budget, [key]: { at: now } }
}
