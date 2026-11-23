import { FANOUT_GAP_MS, FANOUT_MAX_FAILURES } from './groupShelves.js'
import { fetchStandaloneGroupsOf } from './indexClient.js'

export { FANOUT_GAP_MS, FANOUT_MAX_FAILURES }

export const DIARY_PAGES = 2

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// One diary at a time, at least FANOUT_GAP_MS between two request starts.
// 'not-found' skips a diary the seeder does not serve or blocks.
// 'rate-limited' stops and keeps what was gathered, as do
// FANOUT_MAX_FAILURES failures in a row. An answer with complete: false
// still supplies usable rows, with no retry.
// -> { perDiary, answeredAll }, or null when superseded.
export async function fanOut (sample, alive, {
  fetchPage = fetchStandaloneGroupsOf,
  sleep = delay,
  now = Date.now
} = {}) {
  const perDiary = []
  let answeredAll = true
  let failures = 0
  let lastStart = null
  for (const diary of sample) {
    const groups = []
    let after = null
    let stop = false
    let skip = false
    for (let page = 0; page < DIARY_PAGES; page++) {
      if (lastStart !== null) {
        const wait = lastStart + FANOUT_GAP_MS - now()
        if (wait > 0) await sleep(wait)
      }
      if (!alive()) return null
      lastStart = now()
      const res = await fetchPage(diary, after)
      if (!alive()) return null
      if (!res || res.ok !== true) {
        const reason = res ? res.reason : null
        if (reason === 'not-found') {
          failures = 0
          skip = true
        } else if (reason === 'rate-limited') {
          answeredAll = false
          stop = true
        } else {
          answeredAll = false
          failures++
          if (failures >= FANOUT_MAX_FAILURES) stop = true
        }
        break
      }
      failures = 0
      if (res.value.hidden === true) {
        skip = true
        break
      }
      groups.push(...res.value.groups)
      after = res.value.next
      if (after === null) break
    }
    if (!skip && groups.length > 0) perDiary.push({ diary, groups })
    if (stop) {
      answeredAll = false
      break
    }
  }
  return { perDiary, answeredAll }
}
