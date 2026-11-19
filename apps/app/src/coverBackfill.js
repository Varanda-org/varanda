export const MAX_PER_PASS = 4
export const MAX_PAGE_PER_PASS = 1
// Bound device storage without evicting evidence that prevents another attempt.
export const LEDGER_CAP = 512

const outcomes = new Set(['pending', 'done', 'no-decode', 'failed', 'uncertain'])
// One pass per identity per module lifetime, including planner recreation after lock.
// There is no reset or clock-based expiry; a new process loads a new module.
const begun = new Set()

function validIdentity (identity) {
  return typeof identity === 'string' && identity.length === 64 && /^[a-f0-9]+$/.test(identity)
}

export function isBackfillRef (ref) {
  if (typeof ref !== 'string') return false
  const parts = ref.split(':')
  if (parts.length !== 2 || !validIdentity(parts[0])) return false
  const seq = Number(parts[1])
  return Number.isSafeInteger(seq) && seq >= 0 && String(seq) === parts[1]
}

function parseLedger (text) {
  if (text === null) return new Map()
  if (typeof text !== 'string') return null
  let entries
  try { entries = JSON.parse(text) } catch { return null }
  if (!Array.isArray(entries) || entries.length > LEDGER_CAP) return null
  const ledger = new Map()
  for (const entry of entries) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object' ||
      Object.keys(entry).length !== 2 || !isBackfillRef(entry.ref) ||
      !outcomes.has(entry.outcome) || ledger.has(entry.ref)) return null
    ledger.set(entry.ref, entry.outcome)
  }
  return ledger
}

function serialize (ledger) {
  return JSON.stringify(Array.from(ledger, ([ref, outcome]) => ({ ref, outcome })))
}

export function createBackfillPlanner ({ store, identity }) {
  if (!validIdentity(identity)) throw new Error('Identidade inválida.')

  function beginPass () {
    if (begun.has(identity)) return null
    begun.add(identity)
    let stopped = false
    let busy = false
    let count = 0
    let pages = 0
    let selected = null
    let claimed = false
    const observed = new Set()

    async function readLedger () {
      const ledger = parseLedger(await store.read(identity))
      if (!ledger || [...observed].some((ref) => !ledger.has(ref))) {
        throw new Error('Registro de capas indisponível.')
      }
      for (const ref of ledger.keys()) observed.add(ref)
      return ledger
    }

    async function nextStep (candidates) {
      if (stopped || busy || selected || count >= MAX_PER_PASS) return null
      busy = true
      try {
        const ledger = await readLedger()
        if (ledger.size >= LEDGER_CAP) {
          stopped = true
          return null
        }
        if (!Array.isArray(candidates)) return null
        for (const kind of ['own', 'page']) {
          if (kind === 'page' && pages >= MAX_PAGE_PER_PASS) continue
          const candidate = candidates.find((item) => item && item.kind === kind &&
            isBackfillRef(item.ref) && !ledger.has(item.ref) &&
            (kind === 'own' ? item.ref.startsWith(identity + ':') : !item.ref.startsWith(identity + ':')))
          if (!candidate) continue
          selected = { ref: candidate.ref, kind }
          count++
          if (kind === 'page') pages++
          return candidate
        }
        return null
      } catch {
        stopped = true
        return null
      } finally {
        busy = false
      }
    }

    // Await this before downloading, encoding or making any state-changing request.
    async function claim (ref) {
      if (stopped || busy || !selected || selected.ref !== ref || claimed) {
        throw new Error('Tentativa de capa indisponível.')
      }
      busy = true
      try {
        const ledger = await readLedger()
        if (ledger.size >= LEDGER_CAP || ledger.has(ref)) throw new Error('Capa já reservada ou registro cheio.')
        ledger.set(ref, 'pending')
        await store.write(identity, serialize(ledger))
        observed.add(ref)
        claimed = true
      } catch (err) {
        stopped = true
        throw err
      } finally {
        busy = false
      }
    }

    async function settle (ref, outcome) {
      if (stopped || busy || !selected || selected.ref !== ref || !claimed ||
        outcome === 'pending' || !outcomes.has(outcome)) throw new Error('Resultado de capa inválido.')
      busy = true
      try {
        const ledger = await readLedger()
        if (ledger.get(ref) !== 'pending') throw new Error('Reserva de capa indisponível.')
        ledger.set(ref, outcome)
        await store.write(identity, serialize(ledger))
        selected = null
        claimed = false
      } catch (err) {
        stopped = true
        throw err
      } finally {
        busy = false
      }
    }

    return { nextStep, claim, settle }
  }

  return { beginPass }
}

// Serialize the shared native file so writes for different identities cannot erase each other.
export function createBackfillFileStore ({ read, write }) {
  let queue = Promise.resolve()
  function run (fn) {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  }

  async function readDocument () {
    const text = await read()
    if (text === null) return Object.create(null)
    if (typeof text !== 'string') throw new Error('Registro de capas indisponível.')
    const document = JSON.parse(text)
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !Object.keys(document).every(validIdentity)) throw new Error('Registro de capas inválido.')
    return document
  }

  return {
    read: (identity) => run(async () => {
      if (!validIdentity(identity)) throw new Error('Identidade inválida.')
      const document = await readDocument()
      return Object.hasOwn(document, identity) ? JSON.stringify(document[identity]) : null
    }),
    write: (identity, text) => run(async () => {
      if (!validIdentity(identity) || text === null || !parseLedger(text)) throw new Error('Registro de capas inválido.')
      const document = await readDocument()
      document[identity] = JSON.parse(text)
      await write(JSON.stringify(document))
    })
  }
}
