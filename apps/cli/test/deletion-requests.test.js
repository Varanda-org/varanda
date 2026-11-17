'use strict'

// apps/cli/lib/account/deletion-requests.js: the requests filed by Excluir
// conta sem a passkey, one row per member key, in a 0o600 file.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { openDeletionRequests, MAX_AGE_MS, FILE } = require('../lib/account/deletion-requests')
const { tmpDir } = require('./helpers/net')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

function clock () {
  const c = { t: Date.parse('2026-11-17T12:00:00.000Z') }
  c.now = () => c.t
  return c
}

test('deletion requests: record, refresh, read back from a new store, file shape and mode', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const r = openDeletionRequests(dir, { now: c.now })
  t.is(r.requestedAt(A), null)
  t.is(await r.record(A), c.t)
  c.t += 1000
  await r.record(A)
  t.is(r.requestedAt(A), c.t, 'a repeat refreshes the time')
  const file = path.join(dir, FILE)
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, requests: { [A]: c.t } })
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.is(openDeletionRequests(dir, { now: c.now }).requestedAt(A), c.t, 'a new store reads the file')
  await t.exception.all(r.record('nao-e-chave'), /member must be a key/)
})

test('deletion requests: 30 days, then prune; forget drops one row', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const r = openDeletionRequests(dir, { now: c.now })
  await r.record(A)
  c.t += 1000
  await r.record(B)
  c.t += MAX_AGE_MS - 500
  t.is(r.requestedAt(A), null, 'past 30 days')
  t.ok(r.requestedAt(B) !== null, 'not yet')
  t.is(r.holds(A), true, 'still in the file')
  await r.prune()
  t.is(r.holds(A), false, 'prune removed it')
  t.is(r.holds(B), true)
  await r.forget(B)
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')), { v: 1, requests: {} })
})

test('deletion requests: a full table drops the oldest with a fixed log line', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  const logs = []
  const r = openDeletionRequests(dir, { now: c.now, max: 2, log: (e) => logs.push(e) })
  await r.record(A)
  c.t += 1
  await r.record(B)
  c.t += 1
  await r.record(C)
  t.is(r.requestedAt(A), null, 'the oldest went')
  t.ok(r.requestedAt(B) !== null && r.requestedAt(C) !== null)
  t.alike(logs, [{ event: 'exclusao', reason: 'pedidos-cheio' }])
  c.t += 1
  await r.record(B)
  t.is(logs.length, 1, 'a refresh of a row on file drops nothing')
})

test('deletion requests: a refused guard or a file it would not write answers indisponivel and is never rewritten', async (t) => {
  const dir = tmpDir(t)
  const c = clock()
  let ok = false
  const r = openDeletionRequests(dir, { now: c.now, guard: () => ok })
  await t.exception(r.record(A), /indisponivel/)
  t.absent(fs.existsSync(path.join(dir, FILE)), 'nothing written')
  ok = true
  await r.record(A)

  const file = path.join(dir, FILE)
  for (const bad of ['{', JSON.stringify({ v: 2, requests: {} }), JSON.stringify({ v: 1, requests: { [A]: -1 } }), JSON.stringify({ v: 1, requests: { XYZ: 1 } }), JSON.stringify({ v: 1, requests: {}, extra: 1 })]) {
    fs.writeFileSync(file, bad)
    t.exception(() => r.requestedAt(A), /indisponivel/)
    t.is(r.available(), false)
    await t.exception(r.record(B), /indisponivel/)
    t.is(fs.readFileSync(file, 'utf8'), bad, 'left as found')
  }
  fs.unlinkSync(file)
  fs.symlinkSync(path.join(dir, 'outro.json'), file)
  t.exception(() => r.holds(A), /indisponivel/, 'a symlink is refused')
})
