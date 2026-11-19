// A diary's public groups for its profile, from the seeder index
// (fetchPublicGroups): at most two pages. The names come in the rows, so no
// group is read one by one. Nothing is asked before the block list is loaded,
// nor for a blocked diary, and blocked groups, communities and creators never
// show. An answer with complete: false is shown as it is and never asked
// again: only a change of `version` reads again. Never throws.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useBlocks } from './blocksProvider'
import { fetchPublicGroups } from './indexClient'
import { visibleRows } from './groupShelves'

const PAGES_MAX = 2
// A burst of group changes costs one read.
const VERSION_DELAY_MS = 800

const EMPTY_ROWS = Object.freeze([])
const NONE = Object.freeze({ rows: EMPTY_ROWS, hidden: false })
const HIDDEN = Object.freeze({ rows: EMPTY_ROWS, hidden: true })

export function sortPublicGroups (rows) {
  return rows.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))
}

// Any failure, on either page, is no list at all.
async function readPages (diary) {
  const rows = []
  let after = null
  for (let page = 0; page < PAGES_MAX; page++) {
    const res = await fetchPublicGroups(diary, after)
    if (!res || res.ok !== true) return NONE
    if (res.value.hidden) return HIDDEN
    rows.push(...res.value.groups)
    after = res.value.next
    if (after === null) break
  }
  return { rows, hidden: false }
}

export function usePublicGroups (owner, { enabled, version } = {}) {
  const diary = typeof owner === 'string' ? owner.toLowerCase() : null
  const blocks = useBlocks()
  const loaded = blocks.loadState === 'ok'
  const blocked = blocks.keys instanceof Set ? blocks.keys : null
  const diaryBlocked = blocked === null || (diary !== null && blocked.has(diary))
  const ready = enabled === true && loaded && !diaryBlocked && diary !== null
  const [state, setState] = useState({ diary: null, value: NONE })
  // Only the latest read may commit; unmount bumps it too.
  const gen = useRef(0)
  const lastVersion = useRef(version)
  const lastDiary = useRef(null)

  useEffect(() => () => { gen.current++ }, [])

  useEffect(() => {
    const mine = ++gen.current
    if (!ready) {
      lastDiary.current = null
      setState({ diary: null, value: NONE })
      return
    }
    const sameDiary = lastDiary.current === diary
    const delay = sameDiary && version !== lastVersion.current ? VERSION_DELAY_MS : 0
    lastVersion.current = version
    lastDiary.current = diary
    if (!sameDiary) setState({ diary: null, value: NONE })
    const timer = setTimeout(() => {
      readPages(diary).then((value) => {
        if (gen.current === mine) setState({ diary, value })
      }, () => {
        if (gen.current === mine) setState({ diary, value: NONE })
      })
    }, delay)
    return () => clearTimeout(timer)
  }, [ready, diary, version])

  return useMemo(() => {
    if (!ready || state.diary !== diary || blocked === null) return NONE
    if (state.value.hidden) return HIDDEN
    const rows = sortPublicGroups(visibleRows(state.value.rows, blocked))
    return rows.length === 0 ? NONE : { rows, hidden: false }
  }, [ready, diary, state, blocked])
}
