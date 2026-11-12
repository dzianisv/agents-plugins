// Pick the model the OS already has configured, instead of hardcoding a provider in tests.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ModelRef = { model: string; providerID: string; id: string }

const parse = (model: string): ModelRef => {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) throw new Error(`invalid model "${model}", expected provider/model`)
  return { model, providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

/** `override`, then `OPENCODE_MODEL`, then the user's configured model, then the first model opencode lists. */
export function availableModel(override = process.env.OPENCODE_MODEL): ModelRef {
  if (override) return parse(override)

  let models: string[] = []
  try {
    models = execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 30_000 })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+\/[\w./-]+$/.test(line))
  } catch {}

  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "opencode.json"), "utf8")) as { model?: unknown }
    if (typeof config.model === "string" && models.includes(config.model)) return parse(config.model)
  } catch {}

  if (!models.length) throw new Error("no opencode model available; set OPENCODE_MODEL")
  return parse(models[0])
}
