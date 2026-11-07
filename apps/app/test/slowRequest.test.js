'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/slowRequest.js')

test('slow requests: strictly above two seconds, formatted with one decimal', async (t) => {
  const { SLOW_REQUEST_MS, slowRequestLine } = await load()
  t.is(SLOW_REQUEST_MS, 2000)
  for (const ms of [-1, 0, 1000, 1999, 2000]) {
    t.is(slowRequestLine('feed.read', 10000, 10000 + ms), null)
  }
  t.is(slowRequestLine('feed.read', 10000, 12500), 'pedido lento: feed.read, 2.5 s')
  t.is(slowRequestLine('feed.read', 10000, 12001), 'pedido lento: feed.read, 2.0 s')
  t.is(slowRequestLine('feed.read', 10000, 13400), 'pedido lento: feed.read, 3.4 s')
  t.is(slowRequestLine('feed.read', 10000, 13000), 'pedido lento: feed.read, 3.0 s')
})

test('slow requests: only plain RPC method names enter the log', async (t) => {
  const { slowRequestLine } = await load()
  for (const method of ['dm.list', 'age.sign', 'sync.start', 'a.b', 'feed.readPage2', 'a1.b2.c3']) {
    t.is(slowRequestLine(method, 0, 2500), 'pedido lento: ' + method + ', 2.5 s')
  }
  for (const method of ['', 'feed', 'Feed.read', 'feed.Read', 'feed.read; rm', 'a.b c', '.feed.read', 'feed..read', 'feed.read.', 'feed.read_2', null, undefined, 123, true, {}, [], Object('feed.read')]) {
    t.is(slowRequestLine(method, 0, 2500), null)
  }
})

test('slow requests: both timestamps must be finite numbers', async (t) => {
  const { slowRequestLine } = await load()
  for (const time of [NaN, Infinity, -Infinity, null, undefined, '0', false, {}, []]) {
    t.is(slowRequestLine('feed.read', time, 2500), null)
    t.is(slowRequestLine('feed.read', 0, time), null)
  }
})

test('node request: times both outcomes and returns the original promise on both paths', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  t.ok(/import \{ slowRequestLine \} from '\.\/slowRequest(?:\.js)?'/.test(source))
  const start = source.indexOf('  const request = useCallback(')
  const end = source.indexOf('\n  }, [extendWait])', start)
  t.ok(start >= 0 && end > start)
  const request = source.slice(start, end)
  t.ok(request.includes('const startedAt = Date.now()'))
  t.ok(request.indexOf('const startedAt = Date.now()') < request.indexOf('conn.request('))
  t.ok(/const done = \(\) => \{\s*const line = slowRequestLine\(method, startedAt, Date\.now\(\)\)/.test(request))
  t.ok(request.includes("if (line !== null && connRef.current === conn) setSync((prev) => appendLine(prev, 'aviso: ' + line))"))
  t.ok(request.includes("if (method !== 'sync.start')"))
  t.is((request.match(/const pending = conn\.request\(method, params\)\s+pending\.then\(done, done\)/g) || []).length, 2)
  t.is((request.match(/return pending\b/g) || []).length, 2)
  t.absent(/return pending\.|\basync\b|\bawait\b|\bconsole\.|\bsetTimeout\b|\bsetInterval\b/.test(request))
  t.ok(request.includes('startingRef.current += 1'))
  t.ok(request.includes('startingRef.current -= 1'))
  t.ok(request.includes('pending.then(settled, settled)'))
  // Every request is counted for whenIdle: begun before it is sent, ended in done.
  t.ok(request.indexOf('idle.begin()') >= 0 && request.indexOf('idle.begin()') < request.indexOf('conn.request('))
  t.ok(/const done = \(\) => \{[^}]*idle\.end\(\)/.test(request))
  const helper = source.slice(source.indexOf('function appendLine ('), source.indexOf('\nconst NodeContext'))
  t.ok(helper.includes('const lines = prev.lines.concat([line])'))
  t.ok(helper.includes('lines.length > MAX_SYNC_LINES ? lines.slice(lines.length - MAX_SYNC_LINES) : lines'))
})
