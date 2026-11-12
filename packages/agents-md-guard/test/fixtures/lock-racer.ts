// Lock racer used by the lock test: waits for a wall-clock start, then tries to take the lock and prints the
// result. The winner stays alive so the other racers see a live owner and do not treat the fresh lock as stale.
import { acquireLock } from "../../src/core/state"

const start = Number(process.env.RACE_START)
while (Date.now() < start) {
  // busy-wait so every racer starts at the same moment
}
console.log(String(acquireLock(process.env.RACE_SESSION!, process.env.RACE_HOME!)))
await Bun.sleep(Number(process.env.RACE_HOLD_MS ?? 2000))
