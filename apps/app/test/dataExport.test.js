'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')
const { exportHead, exportFollowsPage, exportDiaryPage } = require('@varanda/core/lib/export')

const load = () => import('../src/dataExport.js')
const source = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
const KEY = 'ab'.repeat(32)
const ASSOCIATION = 'cd'.repeat(32)
const AT = '2026-11-25T12:00:00.000Z'
const now = () => Date.parse(AT)
const entriesOf = (count) => Array.from({ length: count }, (_, i) => ({
  seq: i + 1,
  record: { type: 'post', text: `Publicação ${i + 1}: café, 漢字, 🌱`, at: AT, replyTo: null }
}))
const followsOf = (count) => Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'))

function node ({ entries = entriesOf(1300), follows = followsOf(1201), change, after, blocked = null, muted = null } = {}) {
  const calls = []
  const answers = []
  async function request (method, params) {
    calls.push({ method, params })
    const result = { key: KEY, head: null, follows: [], entries: [], invalid: [], next: null }
    if (!params.part || params.part === 'head') {
      Object.assign(result, exportHead({ association: ASSOCIATION, length: entries.length ? entries[entries.length - 1].seq + 1 : 0, entries, follows, blocked, muted }))
    } else if (params.part === 'follows') {
      Object.assign(result, exportFollowsPage(follows, params.offset, params.until))
    } else if (params.part === 'diary') {
      Object.assign(result, exportDiaryPage(entries, params.offset, params.until))
    } else throw new Error('unexpected part')
    if (change) change(result, params, calls.length)
    answers.push(result)
    if (after) after(params)
    return result
  }
  return { request, calls, answers }
}

test('collectExport: real paging exports 1300 records and 1201 follows once in order', async (t) => {
  const { collectExport } = await load()
  const entries = entriesOf(1300)
  const follows = followsOf(1201)
  const peer = node({ entries, follows })
  const progress = []
  const result = await collectExport({ request: peer.request, now, onProgress: (p) => progress.push(p) })
  t.is(result.ok, true)
  const doc = JSON.parse(result.text)
  t.is(rpc.checkExport(doc), null)
  t.alike(doc.diary.entries, entries)
  t.alike(doc.follows, follows)
  t.alike(doc.diary.invalid, [])
  t.is(result.records, 1300)
  t.is(result.bytes, Buffer.byteLength(result.text, 'utf8'))
  t.ok(result.text.endsWith('\n'))
  t.is(doc.exportedAt, AT)
  t.is(result.name, 'varanda-dados-abababab-2026-11-25.json')
  t.ok(/^varanda-dados-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/.test(result.name))
  t.alike(progress, [{ done: 500, total: 1301 }, { done: 1000, total: 1301 }, { done: 1300, total: 1301 }])
  t.is(peer.calls.length, 7)
  t.ok(peer.calls.every((call) => call.method === 'export.read'))
  t.alike(peer.calls[0].params, {})
  for (let i = 1; i < peer.calls.length; i++) t.is(peer.calls[i].params, peer.answers[i - 1].next, 'cursor passed verbatim')
})

test('collectExport: follows that change between pages fail instead of skipping or repeating keys', async (t) => {
  const { collectExport } = await load()
  const follows = followsOf(600)
  const shifted = node({ entries: [], follows: [...follows.slice(0, 500), follows[4], ...follows.slice(500), follows[0]] })
  await t.exception(collectExport({ request: shifted.request, now }), /resposta inesperada do nó/)
  const dropped = followsOf(600)
  const peer = node({ entries: [], follows: dropped, after: (params) => { if (params.part === 'follows') dropped.splice(0, 1) } })
  await t.exception(collectExport({ request: peer.request, now }), /resposta inesperada do nó/)
  // Same count: one exported key removed and one appended skips index 500.
  const swapped = followsOf(600)
  const fresh = 'f'.repeat(64)
  const swap = node({ entries: [], follows: swapped, after: (params) => { if (params.part === 'follows' && params.offset === 0) { swapped.splice(0, 1); swapped.push(fresh) } } })
  await t.exception(collectExport({ request: swap.request, now }), /resposta inesperada do nó/)
})

test('collectExport: invalid blocks count toward progress and gaps stay gaps', async (t) => {
  const { collectExport } = await load()
  const entries = [{ seq: 0, record: null, deleted: true }, ...entriesOf(2), { seq: 8, record: null }]
  const peer = node({ entries, follows: [] })
  const progress = []
  const result = await collectExport({ request: peer.request, now, onProgress: (p) => progress.push(p) })
  const doc = JSON.parse(result.text)
  t.is(rpc.checkExport(doc), null)
  t.alike(doc.diary.entries, entriesOf(2))
  t.alike(doc.diary.invalid, [{ seq: 0, reason: 'deleted' }, { seq: 8, reason: 'malformed' }])
  t.alike(progress, [{ done: 4, total: 9 }])
  t.is(result.records, 2)
})

test('collectExport: empty diary and preferences use only the five allowed keys', async (t) => {
  const { collectExport } = await load()
  const peer = node({ entries: [], follows: [], blocked: [KEY], muted: [ASSOCIATION] })
  const prefs = { previews: false, wifiOnly: true, appearance: 'dark', extra: 'omit', blocked: [], muted: [] }
  const result = await collectExport({ request: peer.request, prefs, now })
  const doc = JSON.parse(result.text)
  t.is(rpc.checkExport(doc), null)
  t.alike(doc.preferences, { previews: false, wifiOnly: true, appearance: 'dark', blocked: [KEY], muted: [ASSOCIATION] })
  t.alike(Object.keys(doc.preferences), ['previews', 'wifiOnly', 'appearance', 'blocked', 'muted'])
  t.is(result.records, 0)
  t.is(peer.calls.length, 1)
})

test('collectExport: cancellation before any request and during follows or diary sends no more calls', async (t) => {
  const { collectExport } = await load()
  const before = node()
  t.alike(await collectExport({ request: before.request, cancelled: () => true }), { ok: false, reason: 'cancelled' })
  t.is(before.calls.length, 0)
  for (const part of ['follows', 'diary']) {
    let cancelled = false
    const peer = node({ after: (params) => { if (params.part === part) cancelled = true } })
    const result = await collectExport({ request: peer.request, cancelled: () => cancelled })
    t.alike(result, { ok: false, reason: 'cancelled' })
    t.is(peer.calls.length, part === 'follows' ? 2 : 5)
  }
})

test('collectExport: cancellation between pages is checked before the next request', async (t) => {
  const { collectExport } = await load()
  const peer = node({ follows: [] })
  let cancelled = false
  const result = await collectExport({
    request: peer.request,
    cancelled: () => cancelled,
    onProgress: () => { cancelled = true }
  })
  t.alike(result, { ok: false, reason: 'cancelled' })
  t.is(peer.calls.length, 2)
})

test('collectExport: a changed key and non-advancing cursors fail without another call', async (t) => {
  const { collectExport } = await load()
  const changes = [
    (r) => { r.key = ASSOCIATION },
    (r, p) => { r.next = { ...p } },
    (r) => { r.next.until++ },
    (r) => { r.next = { part: 'head', offset: 0, until: 1301 } },
    (r) => { r.next = { part: 'diary', offset: 1, until: 1301 } }
  ]
  for (const change of changes) {
    const peer = node({ change: (r, p, n) => { if (n === 2) change(r, p) } })
    await t.exception(collectExport({ request: peer.request }), /resposta inesperada do nó/)
    t.is(peer.calls.length, 2)
  }
  const peer = node({ follows: [], change: (r, p, n) => { if (n === 2) r.next = { part: 'follows', offset: 0, until: 1301 } } })
  await t.exception(collectExport({ request: peer.request }), /resposta inesperada do nó/)
  t.is(peer.calls.length, 2, 'diary cannot go back to follows')
})

test('collectExport: every result key is mandatory and wrong types are rejected', async (t) => {
  const { collectExport } = await load()
  for (const key of ['key', 'head', 'follows', 'entries', 'invalid', 'next']) {
    const peer = node({ change: (r) => { delete r[key] } })
    await t.exception(collectExport({ request: peer.request }), /resposta inesperada do nó/)
    t.is(peer.calls.length, 1)
  }
  const changes = [
    (r) => { r.key = 7 },
    (r) => { r.head = null },
    (r) => { r.head = [] },
    (r) => { r.head.format = 'other' },
    (r) => { r.head.version = 2 },
    (r) => { r.head.length = -1 },
    (r) => { r.head.profile = { name: 1, bio: '' } },
    (r) => { r.follows = {} },
    (r) => { r.follows = ['bad'] },
    (r) => { r.entries = null },
    (r) => { r.entries = [{ seq: 1, record: null }] },
    (r) => { r.invalid = '' },
    (r) => { r.invalid = [{ seq: 1, reason: false }] },
    (r) => { r.next = false },
    (r) => { r.next.offset = 0.5 },
    (r) => { r.next.until = '1301' },
    (r) => { r.next.part = 'unknown' }
  ]
  for (const change of changes) {
    const peer = node({ change })
    await t.exception(collectExport({ request: peer.request }), /resposta inesperada do nó/)
    t.is(peer.calls.length, 1)
  }
})

test('collectExport: request rejection propagates unchanged without a retry', async (t) => {
  const { collectExport } = await load()
  for (const failAt of [1, 2, 5]) {
    const peer = node()
    const failure = new Error('offline')
    let calls = 0
    const request = async (...args) => {
      if (++calls === failAt) throw failure
      return peer.request(...args)
    }
    let caught
    try { await collectExport({ request }) } catch (err) { caught = err }
    t.is(caught, failure)
    t.is(calls, failAt)
  }
})

test('export texts and help are frozen, non-empty and contain no em dash', async (t) => {
  const { EXPORT_TEXTS, EXPORT_HELP } = await load()
  t.ok(Object.isFrozen(EXPORT_TEXTS))
  t.ok(Object.isFrozen(EXPORT_HELP))
  t.ok(Object.isFrozen(EXPORT_HELP.paragraphs))
  const texts = Object.values(EXPORT_TEXTS).map((value) => typeof value === 'function' ? value(12, 2048) : value)
  texts.push(EXPORT_HELP.title, ...EXPORT_HELP.paragraphs)
  t.ok(texts.every((text) => typeof text === 'string' && text.length > 0 && !text.includes('\u2014')))
  t.is(EXPORT_TEXTS.title, 'Exportar meus dados')
  t.is(EXPORT_TEXTS.reading(3, 10), 'Lendo… 3 de 10')
  t.is(EXPORT_TEXTS.ready(3, 2048), 'Pronto: 3 registros, 2 KB.')
})

test('export modules keep platform dependencies isolated', (t) => {
  const imports = (text) => [...text.matchAll(/^import\s+.+?\s+from\s+'([^']+)'/gm)].map((match) => match[1])
  t.alike(imports(source('dataExport.js')), ['@varanda/rpc'])
  t.alike(imports(source('dataExportFile.native.js')), ['react-native', 'expo-file-system'])
  for (const name of ['dataExport.js', 'dataExportFile.web.js', 'dataExportFile.native.js']) {
    t.absent(source(name).includes('\u2014'))
  }
  const exported = (text) => [...text.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]).sort()
  t.alike(exported(source('dataExportFile.native.js')), exported(source('dataExportFile.web.js')), 'both platform files export the same names')
  t.alike(exported(source('dataExportFile.web.js')), ['clearExportCache', 'exportDelivery', 'saveExport', 'shareExport'])
})

test('app start removes an export copy a killed run left, before the first render', (t) => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  t.ok(index.includes("import { clearExportCache } from './src/dataExportFile'"), 'imported from the platform module')
  const call = index.indexOf('clearExportCache()')
  t.ok(call !== -1 && call < index.indexOf('registerRootComponent('), 'called before the root registers')
})

test('web delivery creates one JSON download and revokes its URL after one second', async (t) => {
  const { exportDelivery, saveExport, shareExport } = await import('../src/dataExportFile.web.js')
  t.ok(Object.isFrozen(exportDelivery))
  t.alike(exportDelivery, { save: true, share: false })
  t.alike(await shareExport(), { ok: false, reason: 'unavailable' })
  t.is(typeof (await import('../src/dataExportFile.web.js')).clearExportCache, 'function')
  const saved = Object.fromEntries(['Blob', 'URL', 'document', 'setTimeout'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const blobs = []
  const downloads = []
  const revoked = []
  const timers = []
  let removed = 0
  const stubs = {
    Blob: class {
      constructor (parts, options) { blobs.push({ parts, options }) }
    },
    URL: { createObjectURL: () => 'blob:export', revokeObjectURL: (url) => revoked.push(url) },
    document: {
      createElement (tag) {
        t.is(tag, 'a')
        return { click () { downloads.push({ name: this.download, url: this.href }) }, remove () { removed++ } }
      },
      body: { appendChild () {} }
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  }
  try {
    for (const [key, value] of Object.entries(stubs)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    t.alike(saveExport('dados.json', '{"nome":"café"}\n'), { ok: true })
    t.alike(blobs, [{ parts: ['{"nome":"café"}\n'], options: { type: 'application/json' } }])
    t.alike(downloads, [{ name: 'dados.json', url: 'blob:export' }])
    t.is(removed, 1)
    t.is(timers.length, 1)
    t.is(timers[0].ms, 1000)
    t.alike(revoked, [])
    timers[0].fn()
    t.alike(revoked, ['blob:export'])
    globalThis.document.createElement = () => { throw new Error('download unavailable') }
    t.alike(saveExport('dados.json', '{}'), { ok: false })
    t.is(timers.length, 2, 'even a failed download releases the URL')
    timers[1].fn()
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
