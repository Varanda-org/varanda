'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { compileFunction } = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/Curtidas.js'), 'utf8')
const OWN = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const FOCAL = OWN + ':3'
const binding = { origin: 'https://example.test', association: 'c'.repeat(64), owner: OWN, acting: { kind: 'me' } }

function section (start, end) {
  const a = source.indexOf(start)
  if (a < 0) throw new Error('Missing: ' + start)
  const b = source.indexOf(end, a + start.length)
  if (b < 0) throw new Error('Missing end: ' + end)
  return source.slice(a + start.length, b)
}

const evaluate = (expression, env) => compileFunction('return (' + expression + ')', Object.keys(env))(...Object.values(env))

function initializer (env) {
  return evaluate('function () {' + section('const [tabs, setTabs] = useState(() => {', '\n  })\n  const tabsRef') + '\n}', env)
}

const row = (n) => ({ author: n.toString(16).padStart(64, '0'), seq: n, name: 'P', username: null, avatar: null })
const emptyTab = () => ({ rows: [], total: null, seeded: false })

test('only the likes tab seeds, and only when the scope is this post', async (t) => {
  const mk = (entry, over = {}) => initializer({
    binding: 'binding' in over ? over.binding : binding,
    hosted: true,
    focal: FOCAL,
    emptyTab,
    loadScreenSnapshot: (kind, b) => {
      t.is(kind, 'listas')
      return { body: { lists: { curtidas: entry } } }
    }
  })()
  const rows = [row(1), row(2)]
  const seeded = mk({ savedAt: 1, scope: FOCAL, rows, total: 7 })
  t.is(seeded.likes.seeded, true)
  t.is(seeded.likes.total, 7)
  t.alike(seeded.likes.rows, rows)
  t.is(seeded.reposts.seeded, false)
  t.is(seeded.reposts.rows.length, 0)
  t.is(mk({ savedAt: 1, scope: OWN + ':4', rows, total: 7 }).likes.seeded, false)
  t.is(mk({ savedAt: 1, scope: FOCAL, rows, total: 7 }, { binding: null }).likes.seeded, false)
})

test('the render gate hides stored rows until block.list answered', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  t.ok(source.includes('authorsOf: engagerAuthors') && source.includes('loadState: blocks.loadState'))
  t.ok(/useMemo\(\(\) => \(seeded\n\s+\? cachedRowsShown\(/.test(source))
  const rows = [row(1), row(2)]
  const opts = (loadState, blocked) => ({ loadState, blocked, owner: OWN, authorsOf: (r) => [r.author] })
  t.is(cachedRowsShown(rows, opts('pending', new Set())).length, 0)
  t.is(cachedRowsShown(rows, opts('ok', new Set())).length, 2)
  t.is(cachedRowsShown(rows, opts('ok', new Set([rows[0].author]))).length, 1)
})

test('no footer, notes or load-more over stored rows; the live page replaces them', (t) => {
  t.ok(source.includes("const ready = phase === 'ready' && !seeded"))
  t.ok(/ListFooterComponent=\{ready/.test(source))
  t.ok(/const canMore = hosted && online !== false && ready/.test(source))
  t.ok(source.includes("stored && stored.seeded === true ? { ...stored, phase: 'ready' } : stored"))
  const live = section('const { value } = page\n    patch(k, {', '})\n    if (stamp')
  t.ok(live.includes('rows: page.rows') && live.includes('seeded: false'))
  // A failed first read keeps the stored rows: the patch leaves seeded alone.
  const fail = section('const fail = ', 'return\n    }\n    const { value }')
  t.absent(fail.includes('seeded'))
})

test('generation and binding are read before the request, saves skip incomplete pages', (t) => {
  const body = section('const load = useCallback(async (k, refreshing) => {', '}, [hosted, readPage, patch, learnMany, armSave])')
  const stampAt = body.indexOf("const stamp = k === 'likes' ? { gen: cacheGeneration(), binding: bindingRef.current } : null")
  t.ok(stampAt > 0)
  t.ok(stampAt < body.indexOf('await readPage(k, null, alive)'))
  t.ok(body.includes('if (stamp !== null && value.complete !== false) armSave(stamp, page.rows, value.total)'))
  const more = section('const loadMore = useCallback(', '}, [hosted, online, readPage')
  t.absent(more.includes('armSave'))
  t.ok(source.includes('clearTimeout(saveTimer.current)'))
})

async function saveHarness (over = {}) {
  const { cachedRowsShown, withoutBlockedRows } = await import('../src/cachedRows.js')
  const saved = []
  const timers = []
  let gen = 1
  const env = {
    cacheGeneration: () => gen,
    saveTimer: { current: null },
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    SAVE_DELAY_MS: 2000,
    SAVE_ROWS_MAX: 30,
    engagerAuthors: (r) => [r.author],
    withoutBlockedRows,
    cachedRowsShown,
    nodeRef: { current: {} },
    actingRef: { current: { kind: 'me' } },
    blocksRef: { current: { keys: new Set([row(2).author]) } },
    focal: FOCAL,
    memberSnapshotBinding: () => over.now === undefined ? binding : over.now,
    sameSnapshotBinding: (a, b) => a !== null && b !== null && a.owner === b.owner,
    loadScreenSnapshot: () => ({ body: { lists: { seguindo: { keep: true } } } }),
    buildScreenSnapshot: (kind, input) => ({ kind, input }),
    saveScreenSnapshot: (kind, snap, g) => { saved.push({ kind, snap, g }); return true }
  }
  return { env, saved, timers, bump: () => { gen++ } }
}

test('the save is debounced and keeps the other lists, minus blocked people', async (t) => {
  const { env, saved, timers } = await saveHarness()
  const armSave = evaluate('(' + section('const armSave = useCallback(', '\n  }, [focal])') + '\n})', env)
  armSave({ gen: 1, binding }, [row(1), row(2), row(3)], 5)
  t.is(saved.length, 0)
  t.is(timers.length, 1)
  timers[0]()
  t.is(saved.length, 1)
  t.is(saved[0].kind, 'listas')
  t.is(saved[0].g, 1)
  t.is(saved[0].snap.input.name, 'curtidas')
  t.is(saved[0].snap.input.scope, FOCAL)
  t.is(saved[0].snap.input.total, 5)
  t.alike(saved[0].snap.input.rows.map((r) => r.seq), [1, 3])
  t.alike(saved[0].snap.input.previous, { lists: { seguindo: { keep: true } } })
})

test('a changed generation or identity drops the save', async (t) => {
  const a = await saveHarness()
  const armA = evaluate('(' + section('const armSave = useCallback(', '\n  }, [focal])') + '\n})', a.env)
  a.bump()
  armA({ gen: 1, binding }, [row(1)], 1)
  t.is(a.timers.length, 0)
  const b = await saveHarness()
  const armB = evaluate('(' + section('const armSave = useCallback(', '\n  }, [focal])') + '\n})', b.env)
  armB({ gen: 1, binding }, [row(1)], 1)
  b.bump()
  b.timers[0]()
  t.is(b.saved.length, 0)
  const c = await saveHarness({ now: { ...binding, owner: PEER } })
  const armC = evaluate('(' + section('const armSave = useCallback(', '\n  }, [focal])') + '\n})', c.env)
  armC({ gen: 1, binding }, [row(1)], 1)
  c.timers[0]()
  t.is(c.saved.length, 0)
})
