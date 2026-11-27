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
  t.ok(app.includes('<MutesProvider>'), 'provider')
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
  t.ok(provider.includes("import { isLatestReload, rereadsAfterWrites } from './blocksProvider'"), 'the same rule as the block list')
  t.is(provider.split("requestRef.current('mute.list'").length - 1, 1, 'one list request')
  const setMute = provider.slice(provider.indexOf('const setMute = useCallback'), provider.indexOf('const value = useMemo'))
  const setAt = setMute.indexOf("await requestRef.current('mute.set', { key, on })")
  const countAt = setMute.indexOf('writesRef.current++')
  t.ok(setAt !== -1 && countAt > setAt && countAt < setMute.indexOf('commit(next)'), 'counted once the set settled, before its commit')
  t.is(setMute.split("'mute.set'").length - 1, 1, 'the set is never repeated')
  t.is(provider.split('writesRef.current++').length - 1, 1, 'only a set moves the count')
})

// The provider's own commit, reload and session-open effect, run from its
// source text against a stubbed node and worker.
async function mutesHarness (answers) {
  const { mutedSetOf } = await load()
  const provider = fs.readFileSync(path.join(__dirname, '../src/mutesProvider.js'), 'utf8')
  const slice = (from, to) => {
    const start = provider.indexOf(from)
    const end = provider.indexOf(to, start)
    return start === -1 || end === -1 ? null : provider.slice(start + from.length, end + 1)
  }
  const commitText = slice('const commit = useCallback(', '}, [])')
  const reloadText = slice('const reload = useCallback(', '}, [commit])')
  const openText = slice('// worker only once one is; a list read before that is sent now.\n  useEffect(', '}, [sessionKey, node.epoch])')
  const reported = []
  const deps = {
    requestRef: { current: async () => answers.shift() },
    epochRef: { current: 0 },
    reloadSeqRef: { current: 0 },
    writesRef: { current: 0 },
    keysRef: { current: new Set() },
    listedRef: { current: false },
    wipeEpoch: () => 0,
    isLatestReload: (seq, seqNow, epoch, epochNow) => seq === seqNow && epoch === epochNow,
    rereadsAfterWrites: (at, now) => at !== now,
    mutedSetOf,
    setKeys: () => {},
    reportMutes: (keys) => reported.push(keys),
    openPushLists: () => {},
    sessionKey: A
  }
  // eslint-disable-next-line no-new-func
  const make = new Function('deps', 'const {' + Object.keys(deps).join(', ') + '} = deps\n' +
    'const commit = ' + commitText + '\nconst reload = ' + reloadText + '\nreturn { reload, open: ' + openText + ' }')
  return { ...make(deps), reported, deps }
}

test('mutesProvider: a malformed mute.list never reaches the worker, as a read or when the account opens', async (t) => {
  const h = await mutesHarness([{ keys: [A] }, { keys: 'x' }, null])
  await h.reload()
  t.alike(h.reported, [[A]], 'a whole list goes to the worker')
  h.open()
  t.alike(h.reported, [[A], [A]], 'and again when the account opens')
  h.reported.length = 0
  await h.reload()
  t.is(h.deps.keysRef.current.size, 0, 'the screens read no mutes, as before')
  t.alike(h.reported, [], 'the worker keeps the last whole list')
  h.open()
  t.alike(h.reported, [], 'nothing sent when the account opens')
  await h.reload()
  h.open()
  t.alike(h.reported, [], 'an empty answer is not a list either')

  const first = await mutesHarness([{ nope: 1 }])
  await first.reload()
  first.open()
  t.alike(first.reported, [], 'a malformed first answer sends nothing')
  const src = fs.readFileSync(path.join(__dirname, '../src/mutesProvider.js'), 'utf8')
  const set = src.slice(src.indexOf('const setMute = useCallback'))
  t.ok(/commit\(next\)\s*reportMutes\(\[\.\.\.next\]\)/.test(set.slice(0, set.indexOf('}, ['))), 'a settled setMute still goes to the worker')
})
