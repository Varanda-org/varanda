'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/forward.js')
const sheetSrc = () => readFileSync(join(__dirname, '../src/ui/ForwardSheet.js'), 'utf8')

const PEER_A = 'a'.repeat(64)
const PEER_B = 'b'.repeat(64)
const GROUP_PUB = 'c'.repeat(64)
const GROUP_PRIV = 'd'.repeat(64)
const GROUP_UNHELD = 'e'.repeat(64)
const BLOB_KEY = '7'.repeat(64)
const SHA = '6'.repeat(64)

const dmItem = { id: '1'.repeat(64), key: BLOB_KEY, nonce: 'c'.repeat(48), chunks: 1, bytes: 144, sha256: SHA, mime: 'image/jpeg', w: 32, h: 24, ms: 0 }

test('selection: up to 5, in tap order, a second tap removes', async (t) => {
  const { toggleSelection, FORWARD_MAX } = await load()
  t.is(FORWARD_MAX, 5)
  let s = []
  for (const k of ['1', '2', '3', '4', '5']) s = toggleSelection(s, k)
  t.alike(s, ['1', '2', '3', '4', '5'])
  t.alike(toggleSelection(s, '6'), s, 'a sixth tap changes nothing')
  s = toggleSelection(s, '2')
  t.alike(s, ['1', '3', '4', '5'])
  t.alike(toggleSelection(s, '6'), ['1', '3', '4', '5', '6'])
  t.alike(toggleSelection(s, ''), s)
  t.alike(toggleSelection(null, 'x'), ['x'])
})

test('destinations: inbox DMs and held groups, newest first, with visibility', async (t) => {
  const { forwardDestinations, targetOf } = await load()
  const rows = forwardDestinations({
    dmConversations: [
      { peer: PEER_A, folder: 'inbox', preview: 'oi', at: '2026-11-01T10:00:00.000Z' },
      { peer: PEER_B, folder: 'request', preview: 'pedido', at: '2026-11-05T10:00:00.000Z' }
    ],
    groups: [
      { group: GROUP_PUB, name: 'Praça', visibility: 'public', role: 'member', last: { preview: 'x', at: '2026-11-03T10:00:00.000Z' } },
      { group: GROUP_PRIV, name: 'Cozinha', visibility: 'private', role: 'member', last: null },
      { group: GROUP_UNHELD, name: null, visibility: null, role: null, last: null }
    ]
  })
  t.alike(rows.map((r) => r.key), ['group:' + GROUP_PUB, 'dm:' + PEER_A, 'group:' + GROUP_PRIV])
  t.alike(targetOf(rows[0]), { kind: 'group', group: GROUP_PUB, visibility: 'public' })
  t.alike(targetOf(rows[1]), { kind: 'dm', to: PEER_A })
  t.alike(targetOf(rows[2]), { kind: 'group', group: GROUP_PRIV, visibility: 'private' })
  t.is(targetOf({ kind: 'group', group: GROUP_UNHELD }), null)
})

test('per-destination states from the send phases', async (t) => {
  const { stateOfPhase, canRetry, DEST_STATES } = await load()
  t.alike(DEST_STATES, ['waiting', 'pending', 'sent', 'uncertain', 'failed'])
  t.is(stateOfPhase('done'), 'sent')
  t.is(stateOfPhase('uncertain'), 'uncertain')
  t.is(stateOfPhase('failed'), 'failed')
  t.is(stateOfPhase('cancelled'), 'waiting')
  const op = { method: 'dm.send', params: { to: PEER_A, text: 'a', fwd: 1 } }
  t.is(canRetry({ state: 'uncertain', op }), true)
  t.is(canRetry({ state: 'uncertain' }), false, 'nothing kept, nothing to retry')
  t.is(canRetry({ state: 'failed', op }), false)
  t.is(canRetry({ state: 'sent', op }), false)
})

test('the audience gate: only private media into a public group', async (t) => {
  const { needsAudience } = await load()
  const pub = { key: 'group:' + GROUP_PUB, kind: 'group', group: GROUP_PUB, visibility: 'public' }
  const priv = { key: 'group:' + GROUP_PRIV, kind: 'group', group: GROUP_PRIV, visibility: 'private' }
  const dm = { key: 'dm:' + PEER_A, kind: 'dm', peer: PEER_A }
  const dmPhoto = { kind: 'dm', text: 'oi', media: [dmItem] }
  t.is(needsAudience(dmPhoto, [dm, priv]), false)
  t.is(needsAudience(dmPhoto, [dm, pub]), true)
  t.is(needsAudience({ kind: 'dm', text: 'oi', media: [] }, [pub]), false, 'text only')
  t.is(needsAudience({ kind: 'group', visibility: 'public', text: 'oi', media: [] }, [pub]), false)
})

test('busy while any destination is queued or sending', async (t) => {
  const { forwardBusy } = await load()
  t.is(forwardBusy({}), false)
  t.is(forwardBusy(null), false)
  t.is(forwardBusy({ a: { state: 'sent' }, b: { state: 'uncertain' }, c: { state: 'failed' } }), false)
  t.is(forwardBusy({ a: { state: 'sent' }, b: { state: 'pending' } }), true)
  t.is(forwardBusy({ a: { state: 'waiting' } }), true)
})

const PEER_C = 'f'.repeat(64)
const COMM_OK = '1'.repeat(64)
const COMM_BAD = '2'.repeat(64)
const COMM_HALF = '3'.repeat(64)
const at = (d) => '2026-11-0' + d + 'T10:00:00.000Z'

function fakeRequest ({ dmPages, dmFail, listFail, info }) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'dm.list') {
      if (dmFail) throw new Error('falhou dm')
      const i = params.before ? params.before.page : 0
      return dmPages[i]
    }
    if (method === 'community.list') {
      if (listFail) throw new Error('falhou lista')
      return { communities: Object.keys(info).map((community) => ({ community, state: 'ready', role: 'member' })) }
    }
    if (method === 'community.info') return info[params.community]()
    throw new Error('método ' + method)
  }
  return { request, calls }
}

test('destinations load: dm.list pages followed up to the bound, failed lists reject', async (t) => {
  const { loadForwardDestinations, DM_LIST_PAGES } = await load()
  t.is(DM_LIST_PAGES, 4)
  const page = (i, peer, next) => ({ conversations: [{ peer, folder: 'inbox', preview: 'x', at: at(i + 1) }], next })
  const dmPages = [
    page(0, PEER_A, { page: 1 }),
    page(1, PEER_B, { page: 2 }),
    page(2, PEER_C, { page: 3 }),
    page(3, 'a'.repeat(63) + 'b', { page: 4 }),
    page(4, 'a'.repeat(63) + 'c', null)
  ]
  const { request, calls } = fakeRequest({ dmPages, info: {} })
  const r = await loadForwardDestinations(request)
  t.is(calls.filter((c) => c[0] === 'dm.list').length, 4, 'stops at the bound')
  t.is(r.rows.filter((x) => x.kind === 'dm').length, 4)
  t.is(r.partial, false)
  await t.exception(loadForwardDestinations(fakeRequest({ dmFail: true, info: {} }).request), /falhou dm/)
  await t.exception(loadForwardDestinations(fakeRequest({ dmPages: [page(0, PEER_A, null)], listFail: true, info: {} }).request), /falhou lista/)
})

test('destinations load: a failed or incomplete community.info drops only its groups and says so', async (t) => {
  const { loadForwardDestinations } = await load()
  const info = {
    [COMM_OK]: async () => ({ name: 'Bairro', incomplete: false, groups: [{ group: GROUP_PUB, name: 'Geral', general: true, visibility: 'public', role: 'member', last: null }] }),
    [COMM_BAD]: async () => { throw new Error('x') },
    [COMM_HALF]: async () => ({ name: 'Meio', incomplete: true, groups: [{ group: GROUP_PRIV, name: 'Cozinha', visibility: 'private', role: 'member', last: null }] })
  }
  const r = await loadForwardDestinations(fakeRequest({ dmPages: [{ conversations: [], next: null }], info }).request)
  t.alike(r.rows.map((x) => x.key), ['group:' + GROUP_PUB])
  t.is(r.rows[0].title, 'Bairro')
  t.is(r.partial, true)
})

test('ForwardSheet: sequential sends with fwd plans, no automatic retry', (t) => {
  const src = sheetSrc()
  t.ok(src.includes('for (const row of chosen)'), 'destinations in tap order')
  t.ok(src.includes('await runForward('), 'one awaited forward at a time')
  t.ok(src.includes('forwardPlan(source, target)'), 'each destination planned by forwardPlan')
  t.ok(src.includes("<Pill label='Tentar de novo' onPress={() => retry(row.key)}"), 'retry only on a tap')
  t.ok(src.includes('if (busy || !canRetry(entry)) return'), 'a retry needs an uncertain kept request and nothing in flight')
  t.absent(/setTimeout|setInterval/.test(src), 'no timer that could resend')
  t.is((src.match(/retryForward\(/g) || []).length, 1, 'one retry call site')
})

test('ForwardSheet: no close while a send is in flight, answers tied to their open', (t) => {
  const src = sheetSrc()
  t.ok(src.includes('const busy = running || forwardBusy(status)'), 'busy while queued or sending')
  const close = src.slice(src.indexOf('const close = () => {'), src.indexOf('const titleOf'))
  t.ok(close.includes('if (busy) {') && close.includes('setWaitHint(true)') && close.indexOf('return') < close.indexOf('onClose()'), 'close ignored while busy, with the hint')
  t.ok(src.includes("const WAIT_HINT = 'Aguarde o envio terminar.'"))
  t.ok(src.includes('disabled={busy}\n      onPress={close}'), 'Cancelar disabled while busy')
  t.ok(src.includes('<Sheet open={!!open} onClose={close}'), 'back and backdrop go through close')
  t.ok(src.includes('dismissable={!busy}'), 'no iOS swipe-down close while busy')
  const sheet = readFileSync(join(__dirname, '..', 'src', 'ui', 'Sheet.js'), 'utf8')
  t.ok(sheet.includes('allowSwipeDismissal={dismissable}') && sheet.includes('dismissable = true'), 'Sheet turns the swipe off only when asked')
  t.ok(src.includes('if (genRef.current !== gen) return'), 'an answer from an older open is dropped')
  t.ok(src.includes('const setOne = setterFor(gen)') && src.includes('const setOne = setterFor(genRef.current)'), 'run and retry both bound to their open')
  t.absent(/setStatus\(\(s\) => \(\{ \.\.\.s/.test(src.replace(/const setterFor[\s\S]*?\n {2}\}\n/, '')), 'no unguarded row update')
  const openEffect = src.slice(src.indexOf('useEffect(() => {\n    genRef.current++'))
  t.ok(openEffect.startsWith('useEffect(() => {\n    genRef.current++\n    if (!open) return\n    setStatus({})'), 'every open and close starts a new generation')
})

test('ForwardSheet: the selection is locked while the audience question shows', (t) => {
  const src = sheetSrc()
  t.ok(src.includes('const locked = started || askAudience'))
  t.ok(src.includes('disabled={off || locked}'), 'rows not tappable while asked')
  t.ok(src.includes('const right = locked'), 'the top Enviar hides while asked')
})

test('ForwardSheet: a failed list shows its error and a reload; partial groups say so', (t) => {
  const src = sheetSrc()
  t.ok(src.includes('loadForwardDestinations(request)'))
  t.ok(src.includes("<Pill label='Carregar de novo' onPress={() => setReload((n) => n + 1)} />"), 'manual reload of a read')
  t.ok(src.includes('[open, request, resolveMany, reload]'), 'the reload reruns the load')
  t.ok(src.includes("const PARTIAL_NOTE = 'Alguns grupos não puderam ser carregados.'"))
  t.absent(src.includes('.catch(() => null)'), 'no failure turned into an empty list')
})

test('ForwardSheet: the audience question comes before any upload', (t) => {
  const src = sheetSrc()
  const gate = src.indexOf('if (!confirmed && needsAudience(source, chosen))')
  const run = src.indexOf('await runForward(')
  t.ok(gate > 0 && run > gate, 'asked before the first runForward')
  t.ok(src.includes('{AUDIENCE_QUESTION}'), 'the question is shown')
  t.ok(src.includes('onPress={() => sendAll(true)}'), 'only an explicit yes continues')
})

test('ForwardSheet: media bytes stay device-local and peer text is escaped', (t) => {
  const src = sheetSrc()
  t.absent(/https?:\/\//.test(src), 'no http(s) literal')
  t.absent(src.includes('urlFromBytes'), 'a forward never makes a display URL (native takes images only)')
  t.ok(src.includes('readLocalBytes(entry.uri)'), 'a cache hit read back from its local URL')
  t.ok(src.includes('cachedOnly: true'), 'a cache miss reads nothing there')
  t.ok(src.includes('fresh.bytesFor(list[i], { ...ctx, readFile: readLocalBytes })'), 'the fresh read hands bytes over')
  t.ok(src.includes('displayText(titleOf(row))'), 'conversation titles through displayText')
  t.absent(src.includes('Platform.OS'), 'capability, never the platform')
  t.absent(/author|from:/.test(src.replace(/original author/g, '')), 'nothing names the original author')
  for (const word of ['lida', 'entregue', 'digitando']) t.absent(src.includes(word), word)
  t.absent(src.includes(String.fromCharCode(0x2014)))
  t.absent(readFileSync(__filename, 'utf8').includes(String.fromCharCode(0x2014)))
})
