'use strict'

// apps/cli/lib/account/ai/forget.js: Excluir conta drops the AI triage's
// copies about a deleted member while no worker runs. No network, no model.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { openLedger, FILE: LEDGER_FILE, LOG_FILE } = require('../lib/account/ai/ledger')
const { openExemplarStore, FILE: EXEMPLARS_FILE } = require('../lib/account/ai/exemplar-store')
const { createTriageForget } = require('../lib/account/ai/forget')
const { quantize } = require('../lib/account/ai/triage')
const { fakeEmbed } = require('./helpers/fake-embed')
const { tmpDir } = require('./helpers/net')

const TEXT = 'compre agora bitcoin gratis clique aqui no link promocao imperdivel'

function hex () {
  return crypto.randomBytes(32).toString('hex')
}

function rid () {
  return crypto.randomBytes(16).toString('base64url')
}

// A moderation desk holding one report per target: { target -> id }.
function desk (targets) {
  const rows = targets.map((target) => ({ id: rid(), target }))
  return {
    ids: Object.fromEntries(rows.map((r) => [r.target, r.id])),
    moderation: { reportIdsAbout: (member) => rows.filter((r) => r.target === member).map((r) => r.id) }
  }
}

function putRead (ledger, id, target) {
  ledger.putRead(id, { target, seq: 1, contentHash: 'cd'.repeat(32), text: TEXT, hasMedia: false, hasQuote: false, hasPoll: false, textCp: Array.from(TEXT).length, truncated: false, embedding: quantize(fakeEmbed(TEXT)) })
  ledger.mark(id, { code: 'frio' })
}

function addExemplar (exemplars, target) {
  exemplars.add({ reportId: rid(), target, seq: 2, reason: 'spam', decision: 'descartar', contentHash: 'ef'.repeat(32), text: TEXT, hasMedia: false, embedding: quantize(fakeEmbed(TEXT)) })
}

test('triage forget: an empty data dir holds nothing and gets no file', (t) => {
  const dir = tmpDir(t)
  const { moderation } = desk([])
  const f = createTriageForget({ dataDir: dir, moderation })
  const m = hex()
  t.absent(f.holdsMember(m))
  f.forgetMember(m)
  t.alike(fs.readdirSync(dir), [], 'nothing created')
  t.alike(f.brokenFiles(), [])
})

test('triage forget: drops the reads, marks and precedents of a deleted member, of any model, and keeps the others', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const keep = hex()
  const { ids, moderation } = desk([gone, keep])
  const ledger = openLedger(dir)
  for (const target of [gone, keep]) putRead(ledger, ids[target], target)
  const exemplars = openExemplarStore(dir, { model: 'outro-modelo' })
  for (const target of [gone, keep]) addExemplar(exemplars, target)

  const f = createTriageForget({ dataDir: dir, moderation })
  t.ok(f.holdsMember(gone))
  f.forgetMember(gone)
  t.absent(f.holdsMember(gone), 'nothing left about them')
  t.ok(f.holdsMember(keep))

  const led = openLedger(dir)
  t.is(led.read(ids[gone]), null, 'the cached read is gone')
  t.is(led.get(ids[gone]), null, 'the mark is gone')
  t.ok(led.read(ids[keep]), 'another member keeps theirs')
  t.ok(led.get(ids[keep]))
  const file = JSON.parse(fs.readFileSync(path.join(dir, EXEMPLARS_FILE), 'utf8'))
  t.is(file.model, 'outro-modelo', 'the file keeps its model')
  t.alike(file.items.map((e) => e.target), [keep], 'only the other member\'s precedent stays')
  t.absent(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').includes(ids[gone]), 'not replayed from the marks log')
})

test('triage forget: precedents alone never create the ledger', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const { moderation } = desk([gone])
  addExemplar(openExemplarStore(dir, { model: 'm' }), gone)
  const f = createTriageForget({ dataDir: dir, moderation })
  t.ok(f.holdsMember(gone))
  f.forgetMember(gone)
  t.absent(f.holdsMember(gone))
  t.alike(fs.readdirSync(dir).sort(), [EXEMPLARS_FILE], 'no ledger file appears')
  t.absent(fs.existsSync(path.join(dir, LEDGER_FILE)))
})

test('triage forget: an unusable exemplars.json throws, is named and never replaced', (t) => {
  const dir = tmpDir(t)
  const m = hex()
  const { moderation } = desk([m])
  const file = path.join(dir, EXEMPLARS_FILE)
  for (const body of ['{ not json', JSON.stringify({ v: 1, model: 'm', items: [{ id: 'x' }] })]) {
    fs.writeFileSync(file, body, { mode: 0o600 })
    const f = createTriageForget({ dataDir: dir, moderation })
    t.exception(() => f.holdsMember(m), 'holds throws')
    t.exception(() => f.forgetMember(m), 'forget throws')
    t.alike(f.brokenFiles(), [EXEMPLARS_FILE], 'the file is named for the sweep\'s warning')
    t.is(fs.readFileSync(file, 'utf8'), body, 'left for the operator')
  }
})

// Every file in `dir` with its bytes, to show nothing was created, renamed
// or rewritten.
function snapshotDir (dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
}

test('triage forget: a corrupt triage.json throws, is named, and is neither set aside nor replaced', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const { ids, moderation } = desk([gone])
  putRead(openLedger(dir), ids[gone], gone)
  const file = path.join(dir, LEDGER_FILE)
  // One bad row: the member's read is still in the file as text.
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  obj.reads[ids[gone]].seq = -1
  fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 })
  const before = snapshotDir(dir)
  const f = createTriageForget({ dataDir: dir, moderation })
  t.exception(() => f.holdsMember(gone), 'holds throws')
  t.exception(() => f.forgetMember(gone), 'forget throws')
  t.alike(f.brokenFiles(), [LEDGER_FILE], 'the file is named for the sweep\'s warning')
  t.alike(snapshotDir(dir), before, 'no file created, renamed or rewritten')
  t.ok(fs.readFileSync(file, 'utf8').includes(gone), 'the read is still there, so the purge stays pending')
})

test('triage forget: a corrupt marks log throws and names the log', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const { ids, moderation } = desk([gone])
  putRead(openLedger(dir), ids[gone], gone)
  fs.appendFileSync(path.join(dir, LOG_FILE), 'not json\n{"also": "bad"}\n')
  const before = snapshotDir(dir)
  const f = createTriageForget({ dataDir: dir, moderation })
  t.exception(() => f.holdsMember(gone))
  t.alike(f.brokenFiles(), [LOG_FILE])
  t.alike(snapshotDir(dir), before, 'nothing set aside')
})

test('triage forget: a marks log without triage.json holds nothing and creates no file', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const { ids, moderation } = desk([gone])
  const ledger = openLedger(dir)
  ledger.mark(ids[gone], { code: 'frio' })
  fs.unlinkSync(path.join(dir, LEDGER_FILE))
  const before = snapshotDir(dir)
  t.alike(Object.keys(before), [LOG_FILE], 'fixture: only the marks log')
  const f = createTriageForget({ dataDir: dir, moderation })
  t.absent(f.holdsMember(gone))
  f.forgetMember(gone)
  t.alike(snapshotDir(dir), before, 'no triage.json created')
})

test('triage forget: without a marks log, a forget writes the snapshot only', (t) => {
  const dir = tmpDir(t)
  const gone = hex()
  const keep = hex()
  const { ids, moderation } = desk([gone, keep])
  const ledger = openLedger(dir)
  for (const target of [gone, keep]) putRead(ledger, ids[target], target)
  fs.unlinkSync(path.join(dir, LOG_FILE))
  const f = createTriageForget({ dataDir: dir, moderation })
  f.forgetMember(gone)
  t.alike(fs.readdirSync(dir).sort(), [LEDGER_FILE])
  const led = openLedger(dir)
  t.is(led.read(ids[gone]), null)
  t.ok(led.read(ids[keep]))
})
