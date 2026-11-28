'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/openLine.js')

const OPEN = 'abertura: identidade 20 ms, pronto 1001 ms'
const WIPED = 'cópias locais apagadas ao abrir'
const LISTS = 'listas 1001 ms'
const PINNED = [OPEN, WIPED, LISTS].map((line) => 'aviso: ' + line)

test('opening timing is reported above one second, lists timing always', async (t) => {
  const { openLines, listsLine } = await load()
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1500 }), [])
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1501 }), [OPEN])
  t.alike(openLines({ startedAt: 500, statusAt: 519.6, readyAt: 1500.6 }), [OPEN])
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1500.1 }), [
    'abertura: identidade 20 ms, pronto 1000 ms'
  ])
  t.is(listsLine(500, 1500), 'listas 1000 ms')
  t.is(listsLine(500, 520), 'listas 20 ms')
  t.is(listsLine(500, 500), 'listas 0 ms')
  t.is(listsLine(500, 1500.6), LISTS)
  t.is(listsLine(500, 1501), LISTS)
})

test('a wipe has its own line regardless of timing', async (t) => {
  const { openLines } = await load()
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1500, wiped: true }), [WIPED])
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1501, wiped: true }), [OPEN, WIPED])
  t.alike(openLines({ startedAt: NaN, statusAt: 520, readyAt: 1501, wiped: true }), [WIPED])
  t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: 1500, wiped: 1 }), [])
})

test('invalid timestamps and negative elapsed times are silent', async (t) => {
  const { openLines, listsLine } = await load()
  for (const time of [NaN, Infinity, -Infinity, -1, undefined, null, '0']) {
    t.alike(openLines({ startedAt: time, statusAt: 520, readyAt: 1501 }), [])
    t.alike(openLines({ startedAt: 500, statusAt: time, readyAt: 1501 }), [])
    t.alike(openLines({ startedAt: 500, statusAt: 520, readyAt: time }), [])
    t.is(listsLine(time, 1501), null)
    t.is(listsLine(500, time), null)
  }
  t.alike(openLines({ startedAt: 500, statusAt: 499.6, readyAt: 1501 }), [])
  t.alike(openLines({ startedAt: 500, statusAt: 500, readyAt: 499 }), [])
  t.is(listsLine(500, 499), null)
})

test('opening lines survive 300 sync appends within the 200-line cap', async (t) => {
  const { trimLines, withoutOpenLines } = await load()
  const sync = Array.from({ length: 300 }, (_, i) => '#1 sincronização ' + i)
  const lines = sync.reduce((prev, line) => trimLines(prev.concat([line]), 200), PINNED)
  t.alike(lines, [...PINNED, ...sync.slice(-197)])
  t.alike(withoutOpenLines(lines), sync.slice(-197))
})

test('trimming keeps the newest three pinned lines in their original order', async (t) => {
  const { trimLines, withoutOpenLines } = await load()
  const fourth = 'aviso: listas 1002 ms'
  const lines = ['#1 antigo', PINNED[0], '#1 depois', PINNED[1], PINNED[2], '#1 recente', fourth]
  t.alike(trimLines(lines, 5), ['#1 depois', PINNED[1], PINNED[2], '#1 recente', fourth])
  t.alike(trimLines(lines, 200), ['#1 antigo', '#1 depois', PINNED[1], PINNED[2], '#1 recente', fourth])
  t.alike(trimLines(lines, 2), [PINNED[2], fourth])
  t.alike(trimLines(lines, 0), [])
  t.alike(withoutOpenLines(lines), ['#1 antigo', '#1 depois', '#1 recente'])
})

test('node replaces the opening lines once per connect and trims log appends', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  const connectStart = source.indexOf('const connectNow = useCallback(')
  const connectEnd = source.indexOf('// One connect at a time', connectStart)
  const connect = source.slice(connectStart, connectEnd)
  t.is((source.match(/\bopenLines\(/g) || []).length, 1)
  t.ok(connect.includes('openLines('))
  t.ok(connect.includes('withoutOpenLines(prev.lines)'))
  t.ok(connect.includes("appendLine(state, 'aviso: ' + line)"))
  const append = source.slice(source.indexOf('function appendLine ('), source.indexOf('\nconst NodeContext'))
  t.ok(append.includes('trimLines(prev.lines.concat([line]), MAX_SYNC_LINES)'))
  t.absent(append.includes('slice('), 'no path skips the pinned-line trim')
  t.ok(connect.indexOf('      startedAt = Date.now()') > connect.indexOf('await whenActive()'), 'open time starts after the app is active')
})
