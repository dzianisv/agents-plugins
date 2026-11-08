// opencode v2 entry: the same reflection/judge loop as the v1 plugin (reflection-3.ts), triggered by
// the `session.execution.*` events 2.0.29 emits in place of `session.idle`, with the self-assessment
// and judge run through `ctx.generate.text` and feedback pushed with `ctx.session.prompt`.
import {
  createState,
  debug,
  initDebugLogger,
  isSessionDisabled,
  runReflection,
  setSessionDisabled,
} from "./src/core"

const TRIGGERS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

const SET_REFLECTION_DESCRIPTION =
  "Use this for difficult or complex tasks to set reflection guidance with a plan/checklist. Provide concrete steps and verification checks so reflection can validate completion quality and catch missed work."
const REFLECTION_TOGGLE_DESCRIPTION =
  "Enable or disable the reflection judge for the current session. 'off' adds this session's ID to .reflection/disabled so the judge skips it; 'on' removes it. Other sessions and other running instances are unaffected."

/** opencode v2 entry: judge each finished turn and push the agent to continue until the work is done. */
export default {
  id: "reflection",
  async setup(ctx: any) {
    const directory = ctx.location?.directory ?? process.cwd()
    initDebugLogger(directory)
    const state = createState()

    // Same two tools as the v1 plugin, registered through the v2 tool transform.
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "set_reflection",
          description: SET_REFLECTION_DESCRIPTION,
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              guidance: { type: "string", description: "Reflection guidance. Include a concise plan/checklist for complex work and evidence expectations." },
              clear: { type: "boolean", description: "Set true to clear the current tool-provided reflection guidance." },
            },
          },
          async execute(args: any) {
            if (args?.clear) {
              state.toolReflectionPrompt = null
              return { content: "Cleared tool-provided reflection guidance. Reflection now uses file override (.reflection.md/reflection.md) or default prompt." }
            }
            const guidance = String(args?.guidance ?? "").trim()
            if (!guidance) {
              return { content: state.toolReflectionPrompt ? `Current tool-provided reflection guidance:\n${state.toolReflectionPrompt}` : "No tool-provided reflection guidance is set." }
            }
            state.toolReflectionPrompt = guidance
            const message = "Set tool-provided reflection guidance for this runtime. It will be used when no .reflection.md/reflection.md file override exists."
            return { content: guidance.length > 4000 ? `${message}\n\nNote: guidance exceeds 4000 chars and will be truncated when applied to reflection prompts.` : message }
          },
        })

        editor.add({
          name: "reflection",
          description: REFLECTION_TOGGLE_DESCRIPTION,
          input: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: { action: { type: "string", enum: ["on", "off"], description: "'on' to enable reflection, 'off' to disable it for this session." } },
          },
          async execute(args: any, toolCtx: any) {
            const sessionID = toolCtx?.sessionID ?? state.currentSessionId
            if (!sessionID) return { content: "No active session tracked yet — wait for the first finished turn, then try again." }
            await setSessionDisabled(directory, sessionID, args?.action === "off")
            return { content: args?.action === "off" ? `Reflection disabled for session ${sessionID.slice(0, 8)}…` : `Reflection enabled for session ${sessionID.slice(0, 8)}…` }
          },
        })
      })
    } catch (error) {
      debug("tool registration failed:", error)
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!TRIGGERS.has((event as any)?.type)) continue
          const sessionID = (event as any)?.data?.sessionID
          if (typeof sessionID !== "string") continue
          if (await isSessionDisabled(directory, sessionID)) {
            debug("Reflection disabled for session:", sessionID.slice(0, 8))
            continue
          }
          try {
            await runReflection(ctx, sessionID, state, directory)
          } catch (error) {
            debug("runReflection error:", error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) debug("event subscription failed:", error)
      }
    })()

    return () => controller.abort()
  },
}
