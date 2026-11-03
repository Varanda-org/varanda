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
  t.alike(imports, ["import { threadOf } from './dm.js'"])
  t.absent(source.includes(String.fromCharCode(0x2014)))
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
