'use strict'

// Busca reopens Assuntos do momento from the shared 'listas' snapshot.
// BuscaGlobal.js loads react-native, so the wiring is checked on its text
// and the save callback runs here against the real listas codec.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { compileFunction, runInNewContext } = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/BuscaGlobal.js'), 'utf8')
const OWN = 'a'.repeat(64)
const FOLLOW = 'b'.repeat(64)
const BLOCKED = 'd'.repeat(64)
const ASSOC = 'e'.repeat(64)
const ORIGIN = 'https://bora.varanda.app'
const binding = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: { kind: 'me' } }

function section (start, end) {
  const a = source.indexOf(start)
  if (a < 0) throw new Error('missing ' + start)
  const b = end === undefined ? source.length : source.indexOf(end, a + start.length)
  if (b < 0) throw new Error('missing end ' + end)
  return source.slice(a + start.length, b)
}

function callbackOf (name) {
  return section('const ' + name + ' = useCallback(', '\n  }, [') + '\n}'
}

function evaluate (expression, env) {
  return compileFunction('return (' + expression + ')', Object.keys(env))(...Object.values(env))
}

function trendFromSnapshotWith (loadScreenSnapshot) {
  const fn = section('function trendFromSnapshot (binding) {', '\n}\n')
  return compileFunction('function trendFromSnapshot (binding) {' + fn + '\n}\nreturn trendFromSnapshot', ['loadScreenSnapshot'])(loadScreenSnapshot)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// The trend effect, as the screen runs it, with the snapshot bindings defined.
function runTrend (answer, helpers) {
  const start = source.indexOf('  const [trend, setTrend]')
  const end = source.indexOf('  // While typing', start)
  const events = []
  const arms = []
  const refs = []
  let refIndex = 0
  let previous = []
  let trend = null
  const render = runInNewContext('(active, refresh) => {\n' + source.slice(start, end) + '}', {
    ...helpers,
    postsGate: null,
    drafts: { publicacoes: '' },
    openTag () {},
    visible: true,
    category: 'publicacoes',
    binding,
    Date: { now: () => 0 },
    useState: () => [trend, (next) => { trend = next }],
    useRef (current) {
      const i = refIndex++
      return refs[i] || (refs[i] = { current })
    },
    useEffect (effect, deps) {
      if (!deps.length || deps.every((value, i) => value === previous[i])) return
      previous = deps
      effect()
    },
    cacheGeneration () {
      events.push('generation')
      return 3
    },
    fetchTopicTrend () {
      events.push('request')
      return Promise.resolve(answer)
    },
    armAssuntosSave (gen, b, rows) {
      arms.push({ gen, b, rows })
    }
  })
  render(true, 0)
  return { events, arms, trend: () => trend, ready: settle() }
}

test('a member binding paints the stored assuntos ranking at once', (t) => {
  const reads = []
  const trendFromSnapshot = trendFromSnapshotWith((kind, bound) => {
    reads.push([kind, bound])
    return { body: { lists: { assuntos: { savedAt: 1, scope: '', rows: [{ tag: 'samba', label: '#samba', meta: '2 pessoas' }] } } } }
  })
  t.alike(trendFromSnapshot(binding), {
    rows: [{ tag: 'samba', label: '#samba', meta: '2 pessoas' }],
    indexing: false,
    complete: true
  })
  t.alike(reads, [['listas', binding]])
  t.is(trendFromSnapshot(null), null)
  t.alike(reads, [['listas', binding]], 'no binding never reads')
  const wrongScope = trendFromSnapshotWith(() => ({ body: { lists: { assuntos: { scope: 'outra', rows: [] } } } }))
  t.is(wrongScope(binding), null, 'a scope this screen does not own is not painted')
  const missing = trendFromSnapshotWith(() => ({ body: { lists: {} } }))
  t.is(missing(binding), null)
  const empty = trendFromSnapshotWith(() => ({ body: { lists: { assuntos: { scope: '', rows: [] } } } }))
  t.alike(empty(binding), { rows: [], indexing: false, complete: true })
  t.ok(source.includes('useState(() => trendFromSnapshot(binding))'), 'the first paint is the stored ranking, not a later effect')
  t.ok(source.includes('const binding = memberSnapshotBinding({ node, acting, pageKey })'))
  t.absent(source.includes('cachedRowsShown'), 'topics name no one, so no block gate')
  t.absent(source.includes('ver novidades'), 'a ranking replaces in place, with no pill')
  t.absent(source.includes('\u2014'))
})

test('the generation and the binding are read before the trend request', async (t) => {
  const helpers = await import('../src/topicTrend.js')
  const topics = [{ tag: 'samba', authors: 2 }]
  const failed = runTrend({ ok: false }, helpers)
  t.alike(failed.events, ['generation', 'request'], 'generation is captured before fetchTopicTrend')
  await failed.ready
  t.alike(failed.arms, [], 'a failed read arms nothing and keeps the list')
  t.is(failed.trend(), null)
  const ok = runTrend({ ok: true, value: { topics, indexing: false } }, helpers)
  t.alike(ok.events, ['generation', 'request'])
  await ok.ready
  t.is(ok.arms.length, 1)
  t.is(ok.arms[0].gen, 3, 'the armed generation is the one read before the request')
  t.is(ok.arms[0].b, binding)
  t.alike(ok.arms[0].rows, helpers.trendRows(topics))
  t.alike(JSON.parse(JSON.stringify(ok.trend())), JSON.parse(JSON.stringify({ rows: helpers.trendRows(topics), indexing: false, complete: true })), 'the live ranking replaces the cached one')
  const effect = section('useEffect(() => {\n    if (!showTrend', '\n  }, [showTrend, refresh])')
  t.ok(effect.indexOf('cacheGeneration()') < effect.indexOf('fetchTopicTrend()'))
  t.ok(effect.indexOf('if (!result.ok) return') < effect.indexOf('armAssuntosSave(gen, b, rows)'))
  t.ok(effect.includes("if (!indexing && complete !== false && typeof armAssuntosSave === 'function') armAssuntosSave(gen, b, rows)"), 'only a complete ranking is saved')
})

test('only the trend list is saved, and a stale generation or binding is refused', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const { trendRows } = await import('../src/topicTrend.js')
  const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const sameBody = communities.match(/export function sameSnapshotBinding \(binding, now\) \{([\s\S]*?)\n\}/)[1]
  const sameSnapshotBinding = evaluate('function (binding, now) {' + sameBody + '\n}', {})
  const rows = trendRows([{ tag: 'samba', authors: 2 }])
  const follow = buildScreenSnapshot('listas', {
    ...binding,
    name: 'seguindo',
    scope: '',
    rows: [FOLLOW, BLOCKED],
    total: 2,
    blocked: []
  })
  t.ok(follow, 'fixture')
  let gen = 4
  let now = { ...binding }
  let pending = null
  let timers = 0
  const saves = []
  const loads = []
  // The callback closes over this, so a later refusal can swap the codec.
  let buildImpl = buildScreenSnapshot
  const env = {
    ASSUNTOS_SAVE_MS: 2000,
    cacheGeneration: () => gen,
    cancelAssuntosSave: () => { pending = null },
    assuntosSaveTimer: { current: null },
    assuntosSaveCtx: { current: { node: {}, acting: { kind: 'me' }, pageKey: null, blocks: { keys: new Set([BLOCKED]) } } },
    setTimeout: (fn, ms) => {
      t.is(ms, 2000)
      timers++
      pending = fn
      return timers
    },
    memberSnapshotBinding: () => now,
    sameSnapshotBinding,
    loadScreenSnapshot: (kind, bound) => {
      t.is(kind, 'listas')
      loads.push(bound)
      return { body: follow.body }
    },
    buildScreenSnapshot: (...args) => buildImpl(...args),
    saveScreenSnapshot: (kind, snapshot, g) => {
      saves.push({ kind, snapshot, g })
      return false
    }
  }
  const arm = evaluate(callbackOf('armAssuntosSave'), env)
  arm(4, binding, rows)
  t.is(timers, 1)
  pending()
  t.is(saves.length, 1, 'a refused save is attempted once')
  t.is(saves[0].kind, 'listas')
  t.is(saves[0].g, 4, 'the generation written is the one captured before the request')
  t.is(loads[0], now, 'the body read at write time is the recomputed binding')
  t.alike(saves[0].snapshot.body.lists.assuntos.rows, rows)
  t.is(saves[0].snapshot.body.lists.assuntos.scope, '')
  t.alike(saves[0].snapshot.body.lists.seguindo.rows, [FOLLOW], 'the other list stays, without the blocked key')
  t.is(timers, 1, 'a refused save is not retried')
  const save = section('const armAssuntosSave = useCallback(', 'useEffect(() => cancelAssuntosSave')
  for (const word of ['drafts', 'query', 'recents', 'counts', 'setQuery']) {
    t.absent(save.includes(word), word + ' is not stored')
  }
  t.is((save.match(/name: '/g) || []).length, 1)
  t.ok(save.includes("name: 'assuntos'"))
  pending = null
  arm(4, null, rows)
  t.is(pending, null, 'no binding arms nothing')
  arm(3, binding, rows)
  t.is(pending, null, 'a purge before the commit arms nothing')
  arm(4, binding, rows)
  gen = 9
  pending()
  t.is(saves.length, 1, 'a purge during the debounce writes nothing')
  gen = 4
  arm(4, binding, rows)
  now = { ...binding, owner: FOLLOW }
  pending()
  t.is(saves.length, 1, 'another owner cannot inherit the save')
  now = null
  arm(4, binding, rows)
  pending()
  t.is(saves.length, 1, 'a lock or a page actor writes nothing')
  buildImpl = () => null
  now = { ...binding }
  const before = timers
  arm(4, binding, rows)
  pending()
  t.is(saves.length, 1, 'a snapshot the codec refuses is not saved or retried')
  t.is(timers, before + 1)
  t.ok(source.includes('useEffect(() => cancelAssuntosSave, [cancelAssuntosSave])'), 'unmount cancels the debounce')
})
