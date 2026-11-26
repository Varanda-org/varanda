'use strict'

// post.edit of the node session (lib/session.js) through a real dispatcher
// + client pair: one append per edit, one live edit per post, refusals write
// nothing, and the post block itself never changes.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')

const BOOTSTRAP = ['127.0.0.1:49737']
const OTHER = 'ab'.repeat(32)
const AT = '2026-01-02T03:04:05.000Z'
const BAD_REF = { code: 'USAGE', message: 'referência inválida' }
const NOT_A_POST = { code: 'USAGE', message: 'o registro não é uma publicação' }
const NOT_EDITABLE = { code: 'USAGE', message: 'enquetes e eventos não podem ser editados' }
const BAD_TEXT = { code: 'USAGE', message: 'texto inválido' }

async function member (t) {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  return { session, publicKey, dataDir, ...link }
}

async function withDiary (dataDir, fn) {
  const s = await storeLib.openStore(dataDir)
  try {
    return await fn(await storeLib.openDiary(s))
  } finally {
    await s.close()
  }
}

const appendDirect = (dataDir, records) => withDiary(dataDir, async (diary) => {
  let seq = null
  for (const r of records) seq = await storeLib.appendRecord(diary, r)
  return seq
})

const lengthOf = (dataDir) => withDiary(dataDir, (diary) => diary.length)
const blockOf = (dataDir, seq) => withDiary(dataDir, async (diary) => JSON.stringify(await diary.get(seq, { wait: false })))

async function feedText (m, seq) {
  const item = (await m.call('feed.read', {})).items.find((i) => i.kind === 'post' && i.seq === seq)
  return item === undefined ? null : item
}

test('node.info announces postEdit', async (t) => {
  const m = await member(t)
  t.is((await m.call('node.info')).postEdit, true)
})

test('post.edit writes one edit, a second one tombstones the first in the same append', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'primeiro' })
  const before = await blockOf(m.dataDir, post.seq)
  const len = await lengthOf(m.dataDir)

  const e1 = await m.call('post.edit', { to: post.ref, text: 'segundo' })
  t.alike(e1, { seq: len, ref: post.ref, changed: true })
  t.is(await lengthOf(m.dataDir), len + 1)
  const item = await feedText(m, post.seq)
  t.is(item.text, 'segundo')
  t.is(item.edited, true)

  const log = await m.call('log.read', {})
  const shown = log.entries.find((e) => e.seq === post.seq)
  t.is(shown.record.text, 'segundo')
  t.is(shown.edited, true)
  const block = log.entries.find((e) => e.seq === e1.seq)
  t.is(block.record.type, 'post-edit')
  t.absent(block.edited)

  const e2 = await m.call('post.edit', { to: post.ref, text: 'terceiro' })
  t.alike(e2, { seq: len + 1, ref: post.ref, changed: true })
  t.is(await lengthOf(m.dataDir), len + 3, 'new edit plus one tombstone in one append')
  const after = await m.call('log.read', {})
  t.is(after.entries.find((e) => e.seq === post.seq).record.text, 'terceiro')
  t.alike(after.invalid, [{ seq: e1.seq, reason: 'deleted' }])
  t.is(after.entries.filter((e) => e.record.type === 'post-edit').length, 1, 'one live edit')
  t.is((await feedText(m, post.seq)).text, 'terceiro')
  t.is(await blockOf(m.dataDir, post.seq), before, 'the post block is byte-identical')
})

test('the same text writes nothing', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'igual' })
  const len = await lengthOf(m.dataDir)
  t.alike(await m.call('post.edit', { to: post.ref, text: 'igual' }), { seq: null, ref: post.ref, changed: false })
  const e = await m.call('post.edit', { to: post.ref, text: 'outro' })
  const again = await m.call('post.edit', { to: post.ref, text: 'outro' })
  t.alike(again, { seq: e.seq, ref: post.ref, changed: false })
  t.is(await lengthOf(m.dataDir), len + 1)
})

test('every refusal writes nothing', async (t) => {
  const m = await member(t)
  const profile = await m.call('profile.set', { name: 'Ana' })
  const post = await m.call('post.create', { text: 'texto' })
  const gone = await m.call('post.create', { text: 'apagado' })
  await m.call('post.delete', { to: gone.ref })
  await appendDirect(m.dataDir, [{ type: 'post', text: 'Qual?', at: AT, replyTo: null, poll: ['Sim', 'Não'] }])
  const pollSeq = (await lengthOf(m.dataDir)) - 1
  const len = await lengthOf(m.dataDir)

  t.alike(await failure(m.call('post.edit', { to: OTHER + ':1', text: 'x' })), BAD_REF, 'another author')
  t.alike(await failure(m.call('post.edit', { to: m.publicKey + ':' + (len + 5), text: 'x' })), BAD_REF, 'out of range')
  t.alike(await failure(m.call('post.edit', { to: m.publicKey + ':' + len, text: 'x' })), BAD_REF, 'seq equal to the length')
  t.alike(await failure(m.call('post.edit', { to: m.publicKey + ':' + profile.seq, text: 'x' })), NOT_A_POST, 'the profile block')
  t.alike(await failure(m.call('post.edit', { to: gone.ref, text: 'x' })), BAD_REF, 'a deleted post')
  t.alike(await failure(m.call('post.edit', { to: m.publicKey + ':' + pollSeq, text: 'x' })), NOT_EDITABLE, 'a poll')
  t.alike(await failure(m.call('post.edit', { to: post.ref, text: '' })), BAD_TEXT, 'empty text on a text post')
  t.alike(await failure(m.call('post.edit', { to: post.ref, text: 'a\u0000b' })), BAD_TEXT, 'control characters')
  t.is(await lengthOf(m.dataDir), len, 'nothing was appended')
})

test('post.delete after an edit tombstones the edit in the same append', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'antes' })
  const e = await m.call('post.edit', { to: post.ref, text: 'depois' })
  const len = await lengthOf(m.dataDir)
  const d = await m.call('post.delete', { to: post.ref })
  t.alike(d.deleted, [post.seq])
  t.is(await lengthOf(m.dataDir), len + 2, 'the post and its edit are tombstoned together')
  const log = await m.call('log.read', {})
  t.alike(log.invalid.map((i) => [i.seq, i.reason]).sort((a, b) => a[0] - b[0]), [[post.seq, 'deleted'], [e.seq, 'deleted']])
  t.is(await feedText(m, post.seq), null)
})
