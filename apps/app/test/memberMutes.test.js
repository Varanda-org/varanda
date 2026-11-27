'use strict'

// The pure rules of the member's mute list on screen (src/memberMutes.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/memberMutes.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const hasOf = (...keys) => (key) => keys.includes(key)

test('mutedSetOf: the keys of a mute.list answer, nothing else', async (t) => {
  const { mutedSetOf } = await load()
  t.alike([...mutedSetOf({ keys: [A, 'x', 7, B.toUpperCase(), B] })], [A, B])
  t.is(mutedSetOf(null).size, 0)
  t.is(mutedSetOf({ keys: 'no' }).size, 0)
})

test('withoutMutedRows: a muted author goes, with reposts of their posts', async (t) => {
  const { withoutMutedRows } = await load()
  const own = { kind: 'post', author: B, seq: 1 }
  const muted = { kind: 'post', author: A, seq: 2 }
  const repostOfMuted = { kind: 'repost', author: B, seq: 3, to: { author: A, seq: 2 } }
  const repostByMuted = { kind: 'repost', author: A, seq: 4, to: { author: B, seq: 1 } }
  const items = [own, muted, repostOfMuted, repostByMuted]
  t.alike(withoutMutedRows(items, hasOf(A)), [own])
  t.is(withoutMutedRows(items, hasOf()), items, 'nothing muted: the same array')
  t.alike(withoutMutedRows([{ kind: 'post', author: A.toUpperCase(), seq: 1 }], hasOf(A)), [], 'case folded')
  t.is(withoutMutedRows(null, hasOf(A)), null)
})

test('hiddenInFold: blocked and muted together, the blocked Set itself when nobody is muted', async (t) => {
  const { hiddenInFold } = await load()
  const blocked = new Set([A])
  t.is(hiddenInFold(blocked, new Set()), blocked)
  t.is(hiddenInFold(blocked, null), blocked)
  t.alike([...hiddenInFold(blocked, new Set([B]))].sort(), [A, B])
  t.alike([...hiddenInFold(null, new Set([B]))], [B])
})

test('fold: a comment on a muted author\'s post never makes a card of it', async (t) => {
  const { hiddenInFold } = await load()
  const { foldFeed } = await import('../src/feedFold.js')
  const at = '2026-11-15T10:00:00.000Z'
  const root = { kind: 'post', author: A, seq: 1, text: 'raiz', at, replyTo: null }
  const comment = { kind: 'post', author: B, seq: 2, text: 'comentário', at, replyTo: { author: A, seq: 1 } }
  const originalOf = (r) => (r === A + ':1' ? root : undefined)
  const open = foldFeed([comment], { originalOf, blocked: hiddenInFold(new Set(), new Set()) })
  t.is(open.rows[0].kind, 'comentarios', 'unmuted, the comment folds into a card of the root')
  const muted = foldFeed([comment], { originalOf, blocked: hiddenInFold(new Set(), new Set([A])) })
  t.alike(muted.rows, [comment], 'muted root: the comment stays a plain row')
})

test('texts: pt-BR, no em dash, help behind the (i)', async (t) => {
  const { MUTE_TEXTS, MUTE_HELP } = await load()
  const all = Object.values(MUTE_TEXTS).concat(MUTE_HELP.title, MUTE_HELP.paragraphs)
  t.ok(all.every((s) => typeof s === 'string' && s.length > 0 && !s.includes('\u2014')))
  t.is(MUTE_TEXTS.mute, 'Silenciar')
  t.is(MUTE_TEXTS.unmute, 'Deixar de silenciar')
  t.is(MUTE_TEXTS.listTitle, 'Pessoas silenciadas')
  const screen = fs.readFileSync(path.join(__dirname, '../src/screens/Silenciados.js'), 'utf8')
  t.ok(screen.includes('<HelpNote doc={MUTE_HELP}>'), 'the list explains behind the (i)')
})

test('wiring: A Rua and Avisos clear muted rows, the shell refreshes on a seen pass', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const rua = read('src/screens/ARua.js')
  t.ok(rua.includes('withoutMutedRows('), 'A Rua')
  t.is(rua.split('hiddenInFold(blockedKeys, mutes.keys)').length - 1, 2, 'the live fold and the preview hide muted roots')
  t.is(rua.split('blocked: foldHidden').length - 1, 2)
  t.ok(read('src/screens/Avisos.js').includes('mutes.has'), 'Avisos')
  const app = read('App.js')
  t.ok(app.includes('<MutesProvider bindingOf={liveBinding}>'), 'provider')
  t.ok(app.includes('if (result.mutesChanged) refreshMutes()'), 'another device muted someone')
  const provider = read('src/mutesProvider.js')
  t.ok(provider.includes('if (err && err.uncertain === true) refresh()'), 'an uncertain mute.set reloads A Rua too')
  t.ok(provider.includes('reportMutes([...next])'), 'every list goes to the web worker, which keeps their pushes quiet')
})

test('mutesProvider: mute.list on the control lane, re-read after a set it overlapped', (t) => {
  const provider = fs.readFileSync(path.join(__dirname, '../src/mutesProvider.js'), 'utf8')
  const reload = provider.slice(provider.indexOf('const reload = useCallback'), provider.indexOf('}, [commit])', provider.indexOf('const reload = useCallback')))
  const writesAt = reload.indexOf('const writes = writesRef.current')
  const requestAt = reload.indexOf("requestRef.current('mute.list', {}, { priority: 'control' })")
  const latestAt = reload.indexOf('if (!alive() || !isLatestReload(seq, reloadSeqRef.current, epoch, epochRef.current)) return')
  const rereadAt = reload.indexOf('if (rereadsAfterWrites(writes, writesRef.current)) return reload(alive)')
  const commitAt = reload.indexOf('commit(mutedSetOf(answer))')
  t.ok(requestAt !== -1, 'control priority')
  t.ok(writesAt !== -1 && writesAt < requestAt, 'the write count is read before the request')
  t.ok(latestAt > requestAt && rereadAt > latestAt, 'only the latest reload reads again')
  t.ok(rereadAt < commitAt, 'a moved count commits nothing and reads the list again')
  t.ok(/import \{ isLatestReload, rereadsAfterWrites, [^}]*\} from '\.\/blocksProvider'/.test(provider), 'the same rule as the block list')
  t.is(provider.split("requestRef.current('mute.list'").length - 1, 1, 'one list request')
  const setMute = provider.slice(provider.indexOf('const setMute = useCallback'), provider.indexOf('const value = useMemo'))
  const setAt = setMute.indexOf("await requestRef.current('mute.set', { key, on })")
  const countAt = setMute.indexOf('writesRef.current++')
  t.ok(setAt !== -1 && countAt > setAt && countAt < setMute.indexOf('commit(next)'), 'counted once the set settled, before its commit')
  t.is(setMute.split("'mute.set'").length - 1, 1, 'the set is never repeated')
  t.is(provider.split('writesRef.current++').length - 1, 1, 'only a set moves the count')
})

test('mutesProvider: a stored list sets the keys, with no report, purge or save', (t) => {
  const provider = fs.readFileSync(path.join(__dirname, '../src/mutesProvider.js'), 'utf8')
  t.ok(provider.includes('const { binding, bindingKey, seed, forget, mayStore } = useQuietSeed(bindingOf, node.passkey ? node.passkey.status : null, node.config)'), 'the same seed as the block list')
  const start = provider.indexOf('if (seed !== null && adoptedRef.current !== seed')
  t.ok(start !== -1, 'adopted during render')
  const adopt = provider.slice(start, provider.indexOf('\n  }\n', start))
  t.ok(adopt.includes('liveWipeRef.current !== wipeEpoch()'), 'only before a live answer of this wipe epoch')
  t.ok(/adoptedRef\.current = seed\s*keysRef\.current = seed\.mutes\s*setKeys\(seed\.mutes\)\s*$/.test(adopt), 'keys and nothing else')
  for (const name of ['reportMutes', 'commit(', 'saveQuietList', 'localCaches', 'Authors(']) t.absent(adopt.includes(name), 'no ' + name)
  const commit = provider.slice(provider.indexOf('const commit = useCallback'), provider.indexOf('const reload = useCallback'))
  t.ok(/keysRef\.current = next\s*liveWipeRef\.current = wipeEpoch\(\)/.test(commit), 'any live commit ends the adoption')
  t.ok(/registerLocalCache\(\{\s*wipe: \(\) => \{\s*adoptedRef\.current = null\s*forget\(\)\s*\}\s*\}\)/.test(provider), 'a wipe forgets the seed')
  t.ok(/if \(mayStore && listedRef\.current && trustedRef\.current\) saveQuietList\('silenciados', bindingRef\.current, keysRef\.current\)\s*\}, \[mayStore, bindingKey\]\)/.test(provider), 'saved again once storing is allowed')
})

// The provider's commit, reload, effects and setMute, and its adoption of a
// stored list, compiled from their own text over stub refs.
const MUTES = fs.readFileSync(path.join(__dirname, '../src/mutesProvider.js'), 'utf8')
const BLOCKS = fs.readFileSync(path.join(__dirname, '../src/blocksProvider.js'), 'utf8')
const C = 'c'.repeat(64)

async function mutesHarness () {
  const { mutedSetOf } = await load()
  const names = ['isLatestReload', 'rereadsAfterWrites']
  const texts = names.map((n) => new RegExp('\\nexport (function ' + n + ' \\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n)').exec(BLOCKS)[1])
  // eslint-disable-next-line no-new-func
  const helpers = new Function(texts.join('\n') + '\nreturn { ' + names.join(', ') + ' }')()
  const answers = []
  const effects = []
  const h = {
    answers,
    saves: [],
    reports: [],
    wipe: 0,
    keysRef: { current: new Set() },
    liveWipeRef: { current: -1 },
    adoptedRef: { current: null },
    listedRef: { current: false },
    trustedRef: { current: false }
  }
  // As the wipe callbacks the provider registers.
  h.wipeAll = () => {
    h.wipe++
    h.listedRef.current = false
    h.trustedRef.current = false
    h.adoptedRef.current = null
  }
  const deps = {
    ...helpers,
    useCallback: (fn) => fn,
    useEffect: (fn, list) => effects.push({ fn, list }),
    keysRef: h.keysRef,
    liveWipeRef: h.liveWipeRef,
    wipeEpoch: () => h.wipe,
    setKeys: () => {},
    reportMutes: (keys) => { h.reports.push(keys) },
    epochRef: { current: 0 },
    reloadSeqRef: { current: 0 },
    writesRef: { current: 0 },
    requestRef: {
      current: (method) => method === 'mute.set'
        ? Promise.resolve({})
        : new Promise((resolve) => answers.push(resolve))
    },
    mutedSetOf,
    listedRef: h.listedRef,
    trustedRef: h.trustedRef,
    saveQuietList: (kind, binding, keys) => { h.saves.push([kind, [...keys]]) },
    bindingRef: { current: {} },
    ready: false,
    node: { epoch: 0 },
    generation: 0,
    noop: () => {},
    sessionKey: null,
    openPushLists: () => {},
    mayStore: true,
    bindingKey: 'b',
    setChanged: () => {}
  }
  const from = MUTES.indexOf('const commit = useCallback')
  const body = MUTES.slice(from, MUTES.indexOf('const value = useMemo', from))
  // eslint-disable-next-line no-new-func
  const out = new Function(...Object.keys(deps), body + '\nreturn { reload, setMute }')(...Object.values(deps))
  h.reload = out.reload
  h.setMute = out.setMute
  h.storeEffect = () => effects.find((e) => e.list.includes('b') && e.list.includes(true)).fn()
  const start = MUTES.indexOf('if (seed !== null && adoptedRef.current !== seed')
  const adopt = MUTES.slice(start, MUTES.indexOf('\n  }\n', start) + 4)
  // eslint-disable-next-line no-new-func
  const adoptSeed = new Function('seed', 'adoptedRef', 'liveWipeRef', 'wipeEpoch', 'keysRef', 'setKeys', adopt)
  h.adopt = (seed) => adoptSeed(seed, h.adoptedRef, h.liveWipeRef, () => h.wipe, h.keysRef, () => {})
  return h
}

test('mutesProvider: a mute.list answer that is not a key array is never stored', async (t) => {
  for (const malformed of [{}, { keys: 'no' }, null]) {
    const h = await mutesHarness()
    const read = h.reload()
    h.answers[0](malformed)
    await read
    t.is(h.keysRef.current.size, 0, 'the screens read no mutes')
    t.is(h.listedRef.current, true, 'still a list for the web worker')
    t.alike(h.saves, [], 'not stored by the reload')
    h.storeEffect()
    t.alike(h.saves, [], 'nor once storing is allowed')
    await h.setMute(A, true)
    t.ok(h.keysRef.current.has(A))
    t.alike(h.saves, [], 'nor by a later set')
  }
  const h = await mutesHarness()
  const read = h.reload()
  h.answers[0]({ keys: [B] })
  await read
  t.alike(h.saves, [['silenciados', [B]]], 'a key array is stored')
  h.storeEffect()
  await h.setMute(A, true)
  t.alike(h.saves.slice(1), [['silenciados', [B]], ['silenciados', [B, A]]], 'and stored again by the effect and a set')
  const again = h.reload()
  h.answers[1]({ keys: 'no' })
  await again
  h.storeEffect()
  await h.setMute(C, true)
  t.is(h.saves.length, 3, 'a malformed answer after a good one stores nothing more')
  t.ok(/registerLocalCache\(\{ wipe: \(\) => \{ trustedRef\.current = false \} \}\)/.test(MUTES), 'a wipe forgets it')
})

test('mutesProvider: a mute.list answer asked before a wipe is read again, never committed', async (t) => {
  const h = await mutesHarness()
  const read = h.reload()
  h.wipeAll()
  h.answers[0]({ keys: [A] })
  await new Promise((resolve) => setImmediate(resolve))
  t.is(h.keysRef.current.size, 0, 'the previous account\'s mutes are not shown')
  t.alike(h.reports, [], 'nor reported')
  t.alike(h.saves, [], 'nor stored')
  t.is(h.answers.length, 2, 'mute.list is read again')
  const seed = { mutes: new Set([B]) }
  h.adopt(seed)
  t.alike([...h.keysRef.current], [B], 'the new identity\'s stored list is adopted')
  if (h.answers.length < 2) return
  h.answers[1]({ keys: [B, C] })
  await read
  t.alike([...h.keysRef.current], [B, C], 'the second read commits')
  t.alike(h.saves, [['silenciados', [B, C]]], 'and is stored')
})
