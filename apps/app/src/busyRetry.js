// A read the browser node answers with 'ocupado' while its peek slots are
// taken. Reads (never state-changing requests) may be asked again a few times.

export const BUSY_RETRY_MS = 600
export const BUSY_RETRIES = 3

export const isBusy = (err) => !!err && err.code === 'USAGE' && err.message === 'ocupado'

// What a slot run answers when the screen went away while it waited.
const SKIPPED = Symbol('skipped')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs `read` through `slots` (an app-wide limiter with run(fn, opts)) and
// asks again, with growing waits, while the node says 'ocupado'. Resolves
// { busy: false, value }, or { busy: true } when still busy or `alive()` went
// false: a busy answer is no failure, the caller keeps its state and reads
// again on its next trigger. Any other error is thrown.
export async function readRetryingBusy (read, { slots = null, alive = () => true, sleep = wait, tries = BUSY_RETRIES, ms = BUSY_RETRY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (!alive()) return { busy: true }
    try {
      const run = () => (alive() ? read() : SKIPPED)
      const value = slots ? await slots.run(run, { front: true }) : await run()
      if (value === SKIPPED) return { busy: true }
      return { busy: false, value }
    } catch (err) {
      if (!isBusy(err)) throw err
      if (attempt >= tries) return { busy: true }
      await sleep(ms * (attempt + 1))
    }
  }
}
