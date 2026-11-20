import { expiredOwn, outcomeOf } from './momentCleanup.js'

export async function runCleanupPass ({ store, ...options }) {
  return store.exclusive(() => runPass(options))
}

async function release (pass, ref) {
  try {
    await pass.release(ref)
    return true
  } catch {
    return false
  }
}

async function runPass ({ planner, identity, listPast, remove, alive, now }) {
  let removed = 0
  if (!alive()) return removed
  const pass = planner.beginPass()
  if (pass === null) return removed
  let past
  try {
    past = await listPast()
  } catch {
    return removed
  }
  if (!alive()) return removed
  const candidates = expiredOwn(past, identity, now())
  try {
    await pass.settleStale(past)
  } catch {
    return removed
  }
  while (alive()) {
    const candidate = await pass.nextStep(candidates)
    if (!candidate) return removed
    try {
      await pass.claim(candidate.ref)
    } catch {
      return removed
    }
    // Until moment.delete is dispatched nothing was sent, so any stop gives the try back.
    let current
    try {
      current = expiredOwn(await listPast(), identity, now())
    } catch {
      await release(pass, candidate.ref)
      return removed
    }
    if (!current.some((item) => item.ref === candidate.ref)) {
      if (!await release(pass, candidate.ref)) return removed
      continue
    }
    if (!alive()) {
      await release(pass, candidate.ref)
      return removed
    }
    let outcome = 'done'
    try {
      await remove(candidate.ref)
    } catch (err) {
      outcome = outcomeOf(err)
    }
    if (outcome === 'refused') {
      await release(pass, candidate.ref)
      return removed
    }
    try {
      await pass.settle(candidate.ref, outcome)
    } catch {
      return removed
    }
    if (outcome === 'done') removed++
    if (outcome === 'uncertain') return removed
  }
  return removed
}
