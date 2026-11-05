'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/dm-open.js')

test('dm-open notifies every subscriber and stops after unsubscribe', async (t) => {
  const { onDmOpen, requestDmOpen } = await load()
  let a = 0
  let b = 0
  const offA = onDmOpen(() => { a++ })
  const offB = onDmOpen(() => { b++ })
  requestDmOpen()
  t.is(a, 1)
  t.is(b, 1)
  offA()
  requestDmOpen()
  t.is(a, 1)
  t.is(b, 2)
  offB()
  requestDmOpen()
  t.is(b, 2)
})

test('dm-open lets a listener unsubscribe while being notified', async (t) => {
  const { onDmOpen, requestDmOpen } = await load()
  let calls = 0
  const off = onDmOpen(() => { calls++; off() })
  requestDmOpen()
  requestDmOpen()
  t.is(calls, 1)
})

test('Conversas opens on the Mensagens segment', async (t) => {
  const { initialSegment, DEFAULT_SEGMENT } = await load()
  const { selectorItems } = await import('../src/dm.js')
  t.is(DEFAULT_SEGMENT, 'mensagens')
  t.is(initialSegment(selectorItems()), 'mensagens')
  t.is(initialSegment([{ id: 'comunidades' }]), 'comunidades')
  t.is(initialSegment([]), 'mensagens')
  t.is(initialSegment(null), 'mensagens')
})

test('dm-open has no imports', async (t) => {
  const source = readFileSync(join(__dirname, '../src/dm-open.js'), 'utf8')
  t.absent(source.split('\n').some((line) => line.startsWith('import ')))
  t.absent(source.includes(String.fromCharCode(0x2014)))
})

const screen = () => import('../src/dm-screen.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ID = '1'.repeat(32)

test('thread rows keep two senders that share an id apart', async (t) => {
  const { threadRows } = await screen()
  const at = '2026-11-01T10:00:00.000Z'
  const rows = threadRows([
    { id: ID, from: B, text: 'deles', at, mine: false, replyTo: null },
    { id: ID, from: A, text: 'minha', at, mine: true, replyTo: null }
  ])
  t.is(rows.length, 2)
  t.alike(rows.map((r) => r.key), [A + ':' + ID, B + ':' + ID])
  t.alike(rows.map((r) => r.mine), [true, false])
  t.alike(rows.map((r) => r.rawText), ['minha', 'deles'])
  t.alike(rows.map((r) => r.text), ['minha', 'deles'])
  t.alike(rows.map((r) => r.from), [A, B])
})

test('thread rows pair each message with its own source in time order', async (t) => {
  const { threadRows } = await screen()
  const rows = threadRows([
    { id: '2'.repeat(32), from: B, text: 'depois', at: '2026-11-01T10:01:00.000Z', mine: false, replyTo: ID },
    { id: ID, from: A, text: 'antes', at: '2026-11-01T10:00:00.000Z', mine: true, replyTo: null },
    null,
    { from: A, text: 'sem id' }
  ])
  t.alike(rows.map((r) => r.rawText), ['antes', 'depois'])
  t.alike(rows.map((r) => r.mine), [true, false])
  t.is(rows[1].replyTo, 'antes')
})

test('an older thread page is prepended and the held copy wins', async (t) => {
  const { mergeMessages } = await screen()
  const old = { id: '3'.repeat(32), from: A, text: 'velha', at: '2026-10-01T10:00:00.000Z' }
  const mine = { id: ID, from: A, text: 'x', at: '2026-11-01T10:00:00.000Z' }
  const theirs = { id: ID, from: B, text: 'y', at: '2026-11-01T10:00:00.000Z' }
  const merged = mergeMessages([old, mine], [{ ...mine, deleted: true }, theirs])
  t.is(merged.length, 3)
  t.ok(merged.find((m) => m.from === A && m.id === ID).deleted)
  t.ok(merged.includes(old))
})

test('a newest thread page replaces its window and keeps only older rows', async (t) => {
  const { refreshThread } = await screen()
  const msg = (id, from, at) => ({ id: id.repeat(32), from, text: id, at })
  const older = msg('1', A, '2026-10-01T10:00:00.000Z')
  const gone = msg('2', B, '2026-11-01T10:05:00.000Z')
  const kept = msg('3', A, '2026-11-01T10:00:00.000Z')
  const fresh = msg('4', B, '2026-11-01T10:10:00.000Z')
  const out = refreshThread([older, kept, gone], [kept, fresh])
  t.alike(out.messages.map((m) => m.text), ['1', '3', '4'])
  t.ok(out.keepOlder)
  const none = refreshThread([kept, gone], [kept, fresh])
  t.alike(none.messages.map((m) => m.text), ['3', '4'])
  t.absent(none.keepOlder)
  const empty = refreshThread([older, kept], [])
  t.alike(empty.messages, [])
  t.absent(empty.keepOlder)
})

test('a refresh keeps a held row tied with the page oldest time', async (t) => {
  const { refreshThread } = await screen()
  const at = '2026-11-01T10:00:00.000Z'
  // Same time and id: the node may order the two senders either way, so the
  // page can cut the tie and leave one of them for the older page.
  const tiedA = { id: ID, from: A, text: 'a', at }
  const tiedB = { id: ID, from: B, text: 'b', at }
  const fresh = { id: '4'.repeat(32), from: B, text: 'c', at: '2026-11-01T10:10:00.000Z' }
  const out = refreshThread([tiedA, tiedB, fresh], [tiedB, fresh])
  t.alike(out.messages.map((m) => m.text).sort(), ['a', 'b', 'c'])
  const changed = refreshThread([tiedA, tiedB], [{ ...tiedA, deleted: true }, tiedB])
  t.is(changed.messages.length, 2)
  t.ok(changed.messages.find((m) => m.from === A).deleted)
})

test('the newest key is the last message of the newest page', async (t) => {
  const { newestOf } = await screen()
  const page = [{ id: ID, from: A, at: '2026-11-01T10:00:00.000Z' }, { id: '2'.repeat(32), from: B, at: '2026-11-01T09:00:00.000Z' }]
  t.is(newestOf(page), B + ':' + '2'.repeat(32))
  t.is(newestOf([]), '')
  t.is(newestOf(null), '')
})

test('a conversation preview is one line', async (t) => {
  const { previewLine } = await screen()
  t.is(previewLine('oi\ntudo\r\nbem'), 'oi tudo bem')
  t.is(previewLine(null), '')
})

test('Conversas reports its segment and App.js counts groups only on Comunidades', async (t) => {
  const conversas = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(conversas.includes('onSegment(segment)'))
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes("tab === 'comunidades' && convSegment === 'comunidades'"))
  t.ok(app.includes('onSegment={setConvSegment}'))
})

test('an uncertain send stays held until a different text is confirmed', async (t) => {
  const { sendPlan } = await screen()
  t.is(sendPlan(null, 'oi', null), 'send')
  t.is(sendPlan({ text: 'oi', quoteId: null }, 'oi', null), 'retry')
  t.is(sendPlan({ text: 'oi', quoteId: ID }, 'oi', ID), 'retry')
  t.is(sendPlan({ text: 'oi', quoteId: ID }, 'oi', null), 'confirm')
  t.is(sendPlan({ text: 'oi', quoteId: null }, 'oi!', null), 'confirm')
})

test('dm-screen stays pure', async (t) => {
  const source = readFileSync(join(__dirname, '../src/dm-screen.js'), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import '))
  t.alike(imports, ["import { threadOf } from './dm.js'", "import { dayHeading } from './format.js'"])
  t.absent(source.includes(String.fromCharCode(0x2014)))
})

test('day marks sit on the first row of each local day', async (t) => {
  const { withDayMarks } = await screen()
  const now = new Date(2026, 9, 23, 12).getTime()
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString()
  const rows = [{ at: at(22, 9) }, { at: at(22, 10) }, { at: at(23, 8) }, { at: 'x' }, { at: at(23, 9) }]
  const marked = withDayMarks(rows, now)
  t.alike(marked.map((r) => r.dayMark), ['ontem', null, 'hoje', null, null])
  t.is(marked[0].at, rows[0].at)
  const old = withDayMarks([{ at: new Date(2025, 2, 4, 9).toISOString() }, { at: new Date(2026, 2, 4, 9).toISOString() }], now)
  t.alike(old.map((r) => r.dayMark), ['4 mar 2025', '4 mar'])
})

test('bubbleShape groups same-side rows within five minutes', async (t) => {
  const { withDayMarks, bubbleShape } = await screen()
  const now = new Date(2026, 9, 23, 12).getTime()
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString()
  const row = (mine, when, from = 'a') => ({ mine, from: mine ? 'me' : from, at: when })
  const shapes = (rows) => { const r = withDayMarks(rows, now); return r.map((_, i) => bubbleShape(r, i)) }
  t.alike(shapes([row(true, at(23, 9, 0)), row(true, at(23, 9, 2)), row(true, at(23, 9, 4))]), ['first', 'middle', 'last'])
  t.alike(shapes([row(true, at(23, 9, 0)), row(false, at(23, 9, 1)), row(true, at(23, 9, 2))]), ['single', 'single', 'single'])
  t.alike(shapes([row(true, at(23, 9, 0)), row(true, at(23, 9, 6))]), ['single', 'single'], 'a 6 minute gap splits')
  t.alike(shapes([row(true, at(22, 23, 59)), row(true, new Date(2026, 9, 23, 0, 1).toISOString())]), ['single', 'single'], 'a day break splits')
  t.alike(shapes([row(true, 'x'), row(true, 'x')]), ['single', 'single'])
  t.alike(shapes([row(false, at(23, 9, 0), 'a'), row(false, at(23, 9, 1), 'b')]), ['single', 'single'], 'different senders split')
})

test('bubble groups span at most five minutes from their first message', async (t) => {
  const { bubbleShape, withDayMarks, DM_GROUP_MS } = await screen()
  const start = new Date(2026, 9, 23, 10).getTime()
  const rowsAt = (minutes) => withDayMarks(minutes.map((minute) => ({
    mine: true, from: A, at: new Date(start + minute * 60000).toISOString()
  })), start)
  const shapes = (rows) => rows.map((_, i) => bubbleShape(rows, i))
  t.is(DM_GROUP_MS, 300000)
  t.alike(shapes(rowsAt([0, 4, 9])), ['first', 'last', 'single'])
  const steady = rowsAt([0, 3, 6, 9, 12, 15, 18, 21, 24])
  t.alike(shapes(steady), ['first', 'last', 'first', 'last', 'first', 'last', 'first', 'last', 'single'])
  t.alike(steady.map((_, i) => bubbleShape(steady, steady.length - 1 - i)).reverse(), shapes(steady), 'independent of render order')
  t.alike(shapes(rowsAt([0, 5, 6])), ['first', 'last', 'single'], 'five minutes is inclusive')
})

test('an invite pill ends its bubble group', async (t) => {
  const { bubbleShape, withDayMarks } = await screen()
  const { inviteLinkOf } = await import('../src/inviteMessage.js')
  const origin = 'https://example.test'
  const inviteLink = inviteLinkOf(origin + '/g/' + B, origin)
  t.ok(inviteLink)
  const start = new Date(2026, 9, 23, 10).getTime()
  const rows = withDayMarks([0, 1, 2, 3].map((minute) => ({
    mine: false,
    from: B,
    at: new Date(start + minute * 60000).toISOString(),
    inviteLink: minute === 1 ? inviteLink : null
  })), start)
  const shapes = () => rows.map((_, i) => bubbleShape(rows, i))
  t.alike(shapes(), ['first', 'last', 'first', 'last'], 'the invite can follow a bubble but ends that run')
  rows[0].inviteLink = inviteLink
  t.alike(shapes(), ['single', 'single', 'first', 'last'], 'consecutive invite pills stay apart')
  rows[0].inviteLink = rows[1].inviteLink = null
  t.alike(shapes(), ['first', 'middle', 'middle', 'last'], 'without a rendered pill there is no break')
})

test('an open menu keeps its neighbours from joining it', async (t) => {
  const { bubbleShape, withDayMarks } = await screen()
  const start = new Date(2026, 9, 23, 10).getTime()
  const rows = withDayMarks([0, 1, 2].map((minute) => ({
    key: B + ':m' + minute,
    mine: false,
    from: B,
    at: new Date(start + minute * 60000).toISOString()
  })), start)
  const shapes = (opts) => rows.map((_, i) => bubbleShape(rows, i, opts))
  t.alike(shapes(), ['first', 'middle', 'last'])
  t.alike(shapes({ breakKey: null }), ['first', 'middle', 'last'], 'no open menu changes nothing')
  t.alike(shapes({ breakKey: rows[1].key }), ['single', 'single', 'single'], 'the row above ends its run, the row below starts a new one')
  t.alike(shapes({ breakKey: rows[0].key }), ['single', 'first', 'last'])
  t.alike(shapes({ breakKey: 'other' }), ['first', 'middle', 'last'], 'an unknown key changes nothing')
})

test('a private message links from its raw text, but not beside Abrir convite', (t) => {
  const row = readFileSync(join(__dirname, '../src/ui/DmMessageRow.js'), 'utf8')
  t.ok(row.includes('<MentionText text={item.rawText} style={styles.text} selectable />'), 'MentionText escapes the raw text itself')
  t.ok(row.includes("const linked = link === null && item.deleted !== true && typeof item.rawText === 'string'"))
  t.absent(row.includes('onOpenMention'), 'mentions stay plain')
})

test('invite links in a conversation only open a screen, never join', (t) => {
  const read = (p) => readFileSync(join(__dirname, p), 'utf8')
  const row = read('../src/ui/DmMessageRow.js')
  t.ok(row.includes('inviteLinkOf(') && row.includes('OPEN_INVITE'))
  t.ok(row.includes("link.kind === 'grupo' ? ', abre o grupo' : ', abre a comunidade'"), 'label follows the link kind')
  t.absent(/join/i.test(row))
  const screen = read('../src/screens/Mensagem.js')
  t.ok(screen.includes('onOpenInvite={onOpenInvite}') && screen.includes('origin={origin}'))
  t.absent(/join/i.test(screen))
  const app = read('../App.js')
  const at = app.indexOf('onOpenInvite={(link)')
  t.ok(at > 0)
  const line = app.slice(at, app.indexOf('\n', at))
  t.ok(line.includes('openGroup(link.key)') && line.includes('openCommunity(link.key)'))
  t.absent(line.includes('community.join'))
})
