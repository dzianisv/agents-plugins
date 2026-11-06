#!/usr/bin/env bun
// SessionStart hook: create the model and rules files when they are missing.
import { ensureConfig, home } from "../core/review"

try {
  ensureConfig()
  console.log(home())
} catch {
  // init must never break the session
}
