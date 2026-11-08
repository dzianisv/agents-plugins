// Appends every AGENTS_NOTIFY_CMD call to E2E_NOTIFY_LOG; used as the notify command in the e2e
// container so the checks can prove no notify fired.
import { appendFileSync } from "node:fs"

try {
  appendFileSync(process.env.E2E_NOTIFY_LOG ?? "/out/notify.log", `${process.argv.slice(2).join(" ")}\n`)
} catch {}
