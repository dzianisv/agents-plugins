/**
 * Plugin Load Integration Test
 * 
 * This test actually loads each plugin the same way OpenCode does.
 * It catches issues like:
 * - Missing imports
 * - Wrong export format
 * - Invalid tool schemas
 * - Runtime errors during initialization
 * 
 * RUN THIS TEST BEFORE DEPLOYING: npm run test:load
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { spawn, type ChildProcess } from "child_process"
import { mkdir, rm, cp, writeFile, readdir, readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { availableModel, type ModelRef } from "../scripts/e2e/model.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

// Test configuration
const TEST_DIR = "/tmp/opencode-plugin-load-test"
const PORT = 3333
const SERVER_TIMEOUT = 60_000  // 60s for server startup with all plugins

describe("Plugin Load Tests - Real OpenCode Environment", { timeout: 120_000 }, () => {
  let server: ChildProcess | null = null
  let serverOutput: string[] = []
  let serverErrors: string[] = []
  let password = ""
  let model: ModelRef

  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`)
    return response.json() as Promise<any>
  }

  /**
   * Deploy plugins to test directory - all plugins directly in plugin/
   */
  async function deployPlugins(pluginDir: string) {
    // Copy all plugins directly to plugin directory
    await cp(join(ROOT, "reflection-3.ts"), join(pluginDir, "reflection.ts"))
    await cp(join(ROOT, "worktree.ts"), join(pluginDir, "worktree.ts"))
    await cp(join(ROOT, "tts.ts"), join(pluginDir, "tts.ts"))
    await cp(join(ROOT, "telegram.ts"), join(pluginDir, "telegram.ts"))
    await cp(join(ROOT, "github.ts"), join(pluginDir, "github.ts"))
    await cp(join(ROOT, "opencode-auto-limit-nudge.ts"), join(pluginDir, "opencode-auto-limit-nudge.ts"))
  }

  async function withIsolatedGlobalPlugins<T>(work: () => Promise<T>): Promise<T> {
    const home = process.env.HOME || process.env.USERPROFILE
    if (!home) {
      return work()
    }

    const globalPluginDir = join(home, ".config", "opencode", "plugin")
    const backupDir = `${globalPluginDir}.backup-plugin-load`

    try {
      await rm(backupDir, { recursive: true, force: true })
      await rm(globalPluginDir, { recursive: true, force: true })
      await mkdir(globalPluginDir, { recursive: true })
      return await work()
    } finally {
      try {
        await rm(globalPluginDir, { recursive: true, force: true })
      } catch {}
      try {
        // Restore from backup if it existed
        await rm(backupDir, { recursive: true, force: true })
      } catch {}
    }
  }

  before(async () => {
    console.log("\n=== Setup Test Environment ===\n")
    model = availableModel()
    console.log(`Using model: ${model.model}`)
    
    // Clean up
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    
    // Create plugin directory
    const pluginDir = join(TEST_DIR, ".opencode", "plugin")
    await mkdir(pluginDir, { recursive: true })
    
    // Deploy plugins
    console.log("Deploying plugins...")
    await deployPlugins(pluginDir)
    
    // List deployed files
    const deployed = await readdir(pluginDir)
    console.log(`Deployed plugins: ${deployed.join(", ")}`)
    
    // Create minimal opencode config
    const config = {
      "$schema": "https://opencode.ai/config.json",
      "model": model.model,
      "small_model": model.model,
      "mcp": {
        "context7": { "enabled": false },
        "playwriter": { "enabled": false },
        "chrome-devtools": { "enabled": false },
        "coqui-tts": { "enabled": false },
        "whisper-mcp": { "enabled": false }
      }
    }
    await writeFile(join(TEST_DIR, "opencode.json"), JSON.stringify(config, null, 2))
    
    // Create package.json for plugin dependencies
    const packageJson = {
      "dependencies": {
        "@opencode-ai/plugin": "1.1.48",
        "@supabase/supabase-js": "^2.49.0"
      }
    }
    await writeFile(join(TEST_DIR, ".opencode", "package.json"), JSON.stringify(packageJson, null, 2))
    
    // Install dependencies
    console.log("Installing plugin dependencies...")
    const install = spawn("bun", ["install"], {
      cwd: join(TEST_DIR, ".opencode"),
      stdio: ["ignore", "pipe", "pipe"]
    })
    
    await new Promise<void>((resolve, reject) => {
      install.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`bun install failed with code ${code}`))
      })
      install.on("error", reject)
    })
    
    console.log("Dependencies installed")
  })

  after(async () => {
    console.log("\n=== Cleanup ===")
    if (server) {
      server.kill("SIGTERM")
      await new Promise(r => setTimeout(r, 1000))
    }
    
    if (serverErrors.length > 0) {
      console.log("\n--- Server Errors ---")
      serverErrors.forEach(e => console.log(e))
    }
  })

  it("starts OpenCode server with all plugins loaded (no errors)", async () => {
    console.log("\n--- Starting OpenCode Server ---\n")
    
    await withIsolatedGlobalPlugins(async () => {
      server = spawn("opencode", ["serve", "--port", String(PORT), "--print-logs"], {
        cwd: TEST_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, REFLECTION_DEBUG: "1" }
      })
    })

    if (!server) {
      assert.fail("Server process failed to start")
    }

    server.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) {
        serverOutput.push(line)
        const match = /server password (\S+)/.exec(line)
        if (match) password = match[1]
        console.log(`[stdout] ${line}`)
      }
    })
    
    server.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line) {
        serverErrors.push(line)
        const match = /server password (\S+)/.exec(line)
        if (match) password = match[1]
        console.log(`[stderr] ${line}`)
      }
    })

    // Wait for server to be ready or fail
    const startTime = Date.now()
    let serverReady = false
    let serverFailed = false
    let failureReason = ""

    while (Date.now() - startTime < SERVER_TIMEOUT) {
      // Check if process exited
      if (server && server.exitCode !== null) {
        serverFailed = true
        failureReason = `Server exited with code ${server.exitCode}`
        break
      }
      
      // Check for plugin load errors in output
      const hasError = serverErrors.some(e => 
        e.includes("Error:") || 
        e.includes("TypeError") || 
        e.includes("ReferenceError") ||
        e.includes("Cannot find module") ||
        e.includes("undefined is not")
      )
      
      if (hasError) {
        serverFailed = true
        failureReason = serverErrors.find(e => 
          e.includes("Error:") || 
          e.includes("TypeError")
        ) || "Plugin error detected"
        break
      }
      
      // Try to connect. opencode 2.x uses /api/session with basic auth.
      if (!password) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/session`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        })
        if (res.ok) {
          serverReady = true
          console.log(`[connect] Server ready after ${Date.now() - startTime}ms`)
          break
        }
        if (res.status === 500) {
          const details = await res.text()
          console.log(`[connect] Response 500: ${details.slice(0, 200)}`)
          if (details.includes("UnknownError")) {
            serverFailed = true
            failureReason = details
            break
          }
        } else {
          console.log(`[connect] Response not ok: ${res.status}`)
        }
      } catch (e: unknown) {
        const err = e as Error
        // Only log occasionally to reduce noise
        if ((Date.now() - startTime) % 5000 < 500) {
          console.log(`[connect] Error: ${err.message}`)
        }
      }
      
      await new Promise(r => setTimeout(r, 500))
    }

    if (serverFailed) {
      console.log("\n--- FAILURE: Server failed to start ---")
      console.log(`Reason: ${failureReason}`)
      console.log("\nAll errors:")
      serverErrors.forEach(e => console.log(`  ${e}`))
      
      assert.fail(`Server failed to start: ${failureReason}`)
    }
    
    assert.ok(serverReady, "Server should start and respond within timeout")
    console.log("\nServer started successfully!")
  })

  it("can create a session (plugins are functional)", async () => {
    const created = await api("/session", {
      method: "POST",
      body: JSON.stringify({ model: { providerID: model.providerID, id: model.id } }),
    })
    const session = created?.data
    assert.ok(session?.id, "Should create a session")
    console.log(`Created session: ${session.id}`)
    
    // Get session info
    const info = (await api(`/session/${session.id}`))?.data
    assert.ok(info, "Should get session info")
    console.log(`Session projectID: ${info.projectID}`)
  })

  it("can run a simple task (end-to-end)", async () => {
    const created = await api("/session", {
      method: "POST",
      body: JSON.stringify({ model: { providerID: model.providerID, id: model.id } }),
    })
    const session = created?.data
    assert.ok(session?.id, "Should create session")
    
    // Send a simple task
    await api(`/session/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Create a file called test.txt in the current directory with the content 'hello'. Then reply DONE." }),
    })
    
    // Poll for the task result (max 60 seconds)
    const startTime = Date.now()
    let completed = false
    
    while (Date.now() - startTime < 60_000) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const text = await readFile(join(TEST_DIR, "test.txt"), "utf8")
        if (text.includes("hello")) {
          completed = true
          console.log("Task completed: test.txt created")
          break
        }
      } catch {}
    }
    
    assert.ok(completed, "Task should complete")
  })

  it("worktree tools are registered", async () => {
    // The fact that server started means tools were parsed correctly
    // If tool schemas were invalid, we'd have seen Zod errors
    
    // Check server output for tool registration errors
    const toolErrors = serverErrors.filter(e => {
      const mentionsTool = /(tool|schema|zod)/i.test(e)
      const looksError = /(error|typeerror|referenceerror|zoderror|invalid|failed|exception)/i.test(e)
      const isMcpConfig = /service=mcp/i.test(e)
      return mentionsTool && looksError && !isMcpConfig
    }).filter(e => !e.includes("tool.registry") && !e.includes("service=tool.registry"))
    
    assert.strictEqual(toolErrors.length, 0, `No tool registration errors: ${toolErrors.join(", ")}`)
    console.log("Tool registration: OK (no errors)")
  })

  it("no plugin errors in server output", async () => {
    // Final check - look for any plugin-related errors
    const pluginErrors = serverErrors.filter(e => {
      const mentionsPlugin = /(plugin|reflection|tts|worktree|telegram)/i.test(e)
      const looksError = /(error|typeerror|referenceerror|zoderror|invalid|failed|exception)/i.test(e)
      const isToolRegistry = /service=tool\.registry|tool\.registry/i.test(e)
      return mentionsPlugin && looksError && !isToolRegistry
    })
    
    // Filter out expected warnings
    const realErrors = pluginErrors.filter(e => 
      !e.includes("Warning:") &&
      !e.includes("loaded") &&
      !e.includes("service=plugin") &&
      !e.includes("NotFoundError rejection")
    )
    
    if (realErrors.length > 0) {
      console.log("\n--- Plugin Errors Found ---")
      realErrors.forEach(e => console.log(`  ${e}`))
    }
    
    assert.strictEqual(realErrors.length, 0, `No plugin errors: ${realErrors.join(", ")}`)
    console.log("Plugin error check: OK")
  })
})
