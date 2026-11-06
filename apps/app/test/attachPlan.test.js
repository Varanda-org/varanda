'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/attach-plan.js')
const KEY = 'a'.repeat(64)
const ID = 'b'.repeat(32)
const dm = { kind: 'dm', to: KEY }
const group = { kind: 'group', group: KEY, visibility: 'public' }
const privateGroup = { ...group, visibility: 'private' }

function attachment (n = 1, mime = 'image/jpeg') {
  return { name: n.toString(16).padStart(32, '0') + '.bin', mime, width: 32, height: 24 }
}

function blob (n = 1, mime = 'image/jpeg') {
  return { id: n.toString(16).padStart(64, '0'), key: KEY, nonce: 'c'.repeat(48), chunks: 1, bytes: 144, sha256: KEY, mime, w: 32, h: 24, ms: 0 }
}

// As wide as a DM media item gets: the plan measures with this before upload.
function widest (n = 1) {
  return { ...blob(n), chunks: 257, bytes: 257 * 32768, w: 16384, h: 16384 }
}

function publicMedia (start = 1) {
  return { core: KEY, mime: 'image/jpeg', start, blocks: 1, bytes: 128, sha256: KEY, width: 32, height: 24 }
}

function privateMedia (start = 1) {
  return { core: KEY, mime: 'application/octet-stream', start, blocks: 1, bytes: 32768, sha256: KEY, key: KEY, nonce: 'c'.repeat(48), plainMime: 'image/jpeg', plainSha256: KEY, w: 32, h: 24, ms: 0 }
}

test('text-only plans preserve exact text and omit media and sealed fields', async (t) => {
  const { composePlan } = await load()
  for (const target of [dm, group, privateGroup]) {
    const plan = composePlan({ text: ' olá\n', target })
    t.alike(plan.uploads, [])
    t.alike(plan.send(), {
      method: target.kind === 'dm' ? 'dm.send' : 'group.post',
      params: { [target.kind === 'dm' ? 'to' : 'group']: KEY, text: ' olá\n' }
    })
    t.is(plan.preview, ' olá ')
  }
})

test('DM photos and GIFs upload in order before the exact send request', async (t) => {
  const { composePlan } = await load()
  const attachments = [attachment(), attachment(2, 'image/gif')]
  const media = [blob(), blob(2, 'image/gif')]
  const plan = composePlan({ text: '', attachments, target: { ...dm, replyTo: ID } })
  t.alike(plan.uploads, attachments.map(params => ({ method: 'dm.putMedia', params })))
  t.exception(() => plan.send(), /anexos pendentes/)
  t.exception(() => plan.send([media[0]]), /anexos pendentes/)
  t.alike(plan.send(media), { method: 'dm.send', params: { to: KEY, text: '', replyTo: ID, media } })
  t.is(plan.preview, 'Foto')
})

test('public and private group plans use the matching upload and post descriptors', async (t) => {
  const { composePlan } = await load()
  const replyTo = { writer: KEY, seq: 1 }
  for (const target of [group, privateGroup]) {
    const sealed = target.visibility === 'private'
    const plan = composePlan({ text: '', attachments: [attachment()], target: { ...target, replyTo } })
    const flags = sealed ? { sealed: true } : {}
    const media = [sealed ? privateMedia() : publicMedia()]
    t.alike(plan.uploads, [{ method: 'media.uploadFile', params: { ...attachment(), ...flags } }])
    t.alike(plan.send(media), { method: 'group.post', params: { group: KEY, text: '', replyTo, media, ...flags } })
    t.exception(() => plan.send([sealed ? publicMedia() : privateMedia()]), /parâmetro inválido: media/)
  }
})

test('each target allows four images and refuses a fifth before uploads', async (t) => {
  const { composePlan } = await load()
  for (const target of [dm, group, privateGroup]) {
    const attachments = [1, 2, 3, 4].map(n => attachment(n))
    const plan = composePlan({ text: '', attachments, target })
    t.is(plan.uploads.length, 4)
    const media = attachments.map((_, i) => target.kind === 'dm' ? blob(i + 1) : target.visibility === 'private' ? privateMedia(i + 1) : publicMedia(i + 1))
    t.is(plan.send(media).params.media.length, 4)
    t.exception(() => composePlan({ text: '', attachments: [...attachments, attachment(5)], target }), /no máximo quatro imagens/)
  }
})

test('DM budget includes media, certificate, quote, UTF-8 and JSON escaping', async (t) => {
  const { composePlan } = await load()
  const attachments = [1, 2, 3, 4].map(n => attachment(n))
  const media = [1, 2, 3, 4].map(n => widest(n))
  const cert = { fixture: 'a'.repeat(700) }
  const target = { ...dm, replyTo: ID, cert }
  const budget = rpc.dmTextBudget({ to: KEY, replyTo: ID, cert, media })
  const prefix = 'á\n"\\'
  const remaining = budget - rpc.dmTextBytes(prefix)
  const text = prefix + '😀'.repeat(Math.floor(remaining / 4)) + 'x'.repeat(remaining % 4)
  t.ok([...text].length < rpc.MAX_TEXT, 'byte limit is tighter than character limit')
  t.is(rpc.dmTextBytes(text), budget)
  t.is(composePlan({ text, attachments, target }).send(media).params.text, text)
  t.exception(() => composePlan({ text: text + 'x', attachments, target }).send(media), /texto longo demais com anexo/)
  t.exception(() => composePlan({ text: '', attachments, target: { ...dm, cert: { fixture: 'a'.repeat(6000) } } }), /texto longo demais com anexo/, 'no room even for an empty caption: refused before any upload')
})

test('a DM caption is measured before upload, with the widest items and the largest certificate', async (t) => {
  const { composePlan } = await load()
  const attachments = [attachment(1)]
  // Fits with a small real item, not with the widest one: refused up front,
  // so no photo goes to the blob channel for a message the node would refuse.
  const small = rpc.dmTextBudget({ to: KEY, cert: rpc.MEMBER_CERT_STANDIN, media: [blob(1)] })
  const wide = rpc.dmTextBudget({ to: KEY, cert: rpc.MEMBER_CERT_STANDIN, media: [widest(1)] })
  t.ok(small > wide)
  t.exception(() => composePlan({ text: 'x'.repeat(small), attachments, target: dm }), /texto longo demais com anexo/)
  t.ok(composePlan({ text: 'x'.repeat(wide), attachments, target: dm }).uploads.length === 1)
  // No certificate known: measured with the largest one, not with null.
  const nullCert = rpc.dmTextBudget({ to: KEY, cert: null, media: [widest(1)] })
  t.ok(nullCert > wide)
  t.exception(() => composePlan({ text: 'x'.repeat(nullCert), attachments, target: dm }), /texto longo demais com anexo/)
})

test('previews use fixed media labels and sanitize peer text', async (t) => {
  const { attachmentPreview } = await load()
  t.is(attachmentPreview('', []), '')
  t.is(attachmentPreview('', [attachment()]), 'Foto')
  t.is(attachmentPreview('', [attachment(1, 'image/gif'), attachment(2, 'image/gif')]), 'GIF')
  t.is(attachmentPreview('', [attachment(1, 'image/gif'), attachment()]), 'Foto')
  t.is(attachmentPreview('', [{ ...privateMedia(), plainMime: 'image/gif' }]), 'GIF')
  t.is(attachmentPreview('', [{ unavailable: true, name: 'untrusted label' }]), 'Foto')
  t.is(attachmentPreview('olá\n\u001b[31m', [attachment()]), rpc.displayText('olá \u001b[31m'))
})

test('plans snapshot inputs and never mutate caller descriptors', async (t) => {
  const { composePlan } = await load()
  const target = { ...group, replyTo: { writer: KEY, seq: 1 } }
  const file = attachment()
  const plan = composePlan({ text: 'oi', attachments: [file], target })
  file.width = 99
  target.replyTo.seq = 2
  target.visibility = 'private'
  const media = Object.freeze([Object.freeze(publicMedia())])
  const request = plan.send(media)
  t.is(plan.uploads[0].params.width, 32)
  t.is(request.params.replyTo.seq, 1)
  t.absent(request.params.sealed)
  request.params.media[0].width = 99
  request.params.replyTo.seq = 3
  t.is(plan.send(media).params.media[0].width, 32)
  t.is(plan.send(media).params.replyTo.seq, 1)
})

test('invalid plans fail without network or platform dependencies', async (t) => {
  const { composePlan } = await load()
  t.exception(() => composePlan({ text: '', target: dm }))
  t.exception(() => composePlan({ text: 'oi', target: { kind: 'other' } }), /destino inválido/)
  t.exception(() => composePlan({ text: 'oi', target: { ...group, visibility: undefined } }), /visibilidade inválida/)
  t.exception(() => composePlan({ attachments: null, target: dm }), /anexos inválidos/)
  t.exception(() => composePlan({ attachments: [null], target: dm }), /anexo inválido/)
  t.exception(() => composePlan({ attachments: new Array(1), target: dm }), /anexo inválido/)
  t.exception(() => composePlan({ attachments: [attachment(1, 'video/mp4')], target: dm }), /parâmetro inválido: mime/)
  const source = readFileSync(join(__dirname, '../src/attach-plan.js'), 'utf8')
  t.absent(/@varanda\/(core|web-member)|react-native|node:|Platform\.OS|fetch\(/.test(source))
  t.absent(source.includes(String.fromCharCode(0x2014)))
})

// Voice notes: one audio/mp4 item, no picture size, its duration.
function voiceBlob () {
  return { id: '1'.padStart(64, '0'), key: KEY, nonce: 'c'.repeat(48), chunks: 1, bytes: 4096, sha256: KEY, mime: 'audio/mp4', w: 0, h: 0, ms: 4200 }
}
function voicePublic () {
  return { core: KEY, mime: 'audio/mp4', start: 1, blocks: 1, bytes: 4096, sha256: KEY, width: 0, height: 0, ms: 4200 }
}
function voicePrivate () {
  return { ...privateMedia(), plainMime: 'audio/mp4', w: 0, h: 0, ms: 4200 }
}

test('one voice note plans an upload for a DM, a public and a private group', async (t) => {
  const { composePlan, stagedVoice } = await load()
  const staged = stagedVoice({ ms: 4200 })
  t.alike(staged, { name: '0'.repeat(32) + '.bin', mime: 'audio/mp4', width: 0, height: 0, ms: 4200 })
  for (const target of [dm, group, privateGroup]) {
    const plan = composePlan({ text: '', attachments: [staged], target })
    const flags = target.visibility === 'private' ? { sealed: true } : {}
    t.alike(plan.uploads, [{ method: target.kind === 'dm' ? 'dm.putMedia' : 'media.uploadFile', params: { ...staged, ...flags } }])
    t.is(plan.preview, 'Áudio')
  }
})

test('voice send requests carry the single voice item', async (t) => {
  const { composePlan, stagedVoice } = await load()
  const staged = stagedVoice({ ms: 4200 })
  const cases = [[dm, voiceBlob()], [group, voicePublic()], [privateGroup, voicePrivate()]]
  for (const [target, item] of cases) {
    const plan = composePlan({ text: '', attachments: [staged], target })
    t.alike(plan.send([item]).params.media, [item])
  }
})

test('voice is refused next to photos, twice, out of range or with a caption over the budget', async (t) => {
  const { composePlan, stagedVoice } = await load()
  const staged = stagedVoice({ ms: 4200 })
  for (const target of [dm, group, privateGroup]) {
    t.exception(() => composePlan({ text: '', attachments: [staged, attachment()], target }), /áudio vai sozinho/)
    t.exception(() => composePlan({ text: '', attachments: [staged, stagedVoice({ ms: 900 }, 1)], target }), /áudio vai sozinho/)
    t.exception(() => composePlan({ text: '', attachments: [stagedVoice({ ms: 0 })], target }), /áudio inválido/)
    t.exception(() => composePlan({ text: '', attachments: [stagedVoice({ ms: 120001 })], target }), /áudio inválido/)
    t.exception(() => composePlan({ text: '', attachments: [{ ...staged, width: 32 }], target }), /áudio inválido/)
  }
  const room = rpc.dmTextBudget({ to: KEY, cert: rpc.MEMBER_CERT_STANDIN, media: [{ ...voiceBlob(), chunks: 49, bytes: 1572880, ms: 120000 }] })
  t.ok(composePlan({ text: 'x'.repeat(room), attachments: [staged], target: dm }).uploads.length === 1)
  t.exception(() => composePlan({ text: 'x'.repeat(room + 1), attachments: [staged], target: dm }), /texto longo demais com anexo/)
})

test('voice preview label wins over text-less photo labels', async (t) => {
  const { attachmentPreview } = await load()
  t.is(attachmentPreview('', [voicePublic()]), 'Áudio')
  t.is(attachmentPreview('', [voicePrivate()]), 'Áudio')
  t.is(attachmentPreview('oi', [voicePublic()]), 'oi')
})
