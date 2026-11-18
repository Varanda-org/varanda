// A Página in a private group (src/pageGroupMedia.js): the sealed upload's
// op, the private item from the service's descriptor, the group.seal params
// and one seal-then-send.
'use strict'

const test = require('brittle')
const { validateParams } = require('@varanda/rpc')
const load = () => import('../src/pageGroupMedia.js')

const GROUP = 'ab'.repeat(32)
const PAGE = 'cd'.repeat(32)
const CORE = 'ef'.repeat(32)
const ITEM = { mime: 'application/octet-stream', blocks: 2, bytes: 65536, sha256: '12'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), plainMime: 'image/jpeg', plainSha256: '78'.repeat(32), w: 640, h: 480, ms: 0 }
const DESCRIPTOR = { core: CORE, mime: 'application/octet-stream', start: 7, blocks: 2, bytes: 65536, sha256: '12'.repeat(32) }

test('the sealed upload op names the group and the ciphertext only', async (t) => {
  const { sealedUploadOp } = await load()
  t.alike(sealedUploadOp({ group: GROUP, item: ITEM }), { group: GROUP, sha256: ITEM.sha256, mime: 'application/octet-stream', bytes: 65536 })
})

test('privateItemOf takes core and start from the descriptor and refuses other bytes', async (t) => {
  const { privateItemOf } = await load()
  const full = privateItemOf(DESCRIPTOR, ITEM)
  t.alike(full, { core: CORE, mime: 'application/octet-stream', start: 7, blocks: 2, bytes: 65536, sha256: ITEM.sha256, key: ITEM.key, nonce: ITEM.nonce, plainMime: 'image/jpeg', plainSha256: ITEM.plainSha256, w: 640, h: 480, ms: 0 })
  t.ok(validateParams('group.seal', { group: GROUP, page: PAGE, text: '', media: [full] }).ok, 'group.seal takes the item')
  t.is(privateItemOf({ ...DESCRIPTOR, sha256: '99'.repeat(32) }, ITEM), null, 'another sum')
  t.is(privateItemOf({ ...DESCRIPTOR, bytes: 32768 }, ITEM), null, 'another size')
  t.is(privateItemOf({ ...DESCRIPTOR, blocks: 1 }, ITEM), null, 'other blocks')
  t.is(privateItemOf({ ...DESCRIPTOR, mime: 'image/jpeg' }, ITEM), null, 'a plain descriptor')
  t.is(privateItemOf({ ...DESCRIPTOR, core: 'x' }, ITEM), null, 'a bad core')
  t.is(privateItemOf({ ...DESCRIPTOR, start: 0 }, ITEM), null, 'a bad start')
  t.is(privateItemOf(null, ITEM), null)
  t.is(privateItemOf(DESCRIPTOR, null), null)
})

test('pageSealParams keeps the post and names the page', async (t) => {
  const { pageSealParams } = await load()
  const replyTo = { writer: CORE, seq: 3 }
  t.alike(pageSealParams({ group: GROUP, text: 'oi' }, PAGE), { group: GROUP, page: PAGE, text: 'oi' })
  t.alike(pageSealParams({ group: GROUP, text: 'oi', replyTo, fwd: 0, extra: 1 }, PAGE), { group: GROUP, page: PAGE, text: 'oi', replyTo }, 'fwd 0 and unknown keys dropped')
  const card = { url: 'https://exemplo.org/a', host: 'exemplo.org', title: 'A', desc: '', image: null }
  const params = pageSealParams({ group: GROUP, text: 'oi', card, fwd: 1 }, PAGE)
  t.alike(params, { group: GROUP, page: PAGE, text: 'oi', fwd: 1, card })
  t.ok(validateParams('group.seal', params).ok)
})

test('sendSealed sends the envelope once, and nothing for a reaction already counted', async (t) => {
  const { sendSealed } = await load()
  const sealed = { kid: { writer: CORE, seq: 2 }, nonce: 'n', box: 'b', at: 5, writer: CORE, seq: 9 }
  const sent = []
  const send = async (action, op) => { sent.push([action, op]); return { seq: 9 } }
  t.alike(await sendSealed({ group: GROUP, seal: async () => sealed, send }), { seq: 9 })
  t.alike(sent, [['group-seal', { group: GROUP, kid: { writer: CORE, seq: 2 }, nonce: 'n', box: 'b', at: 5, writer: CORE, seq: 9 }]])
  t.alike(await sendSealed({ group: GROUP, seal: async () => ({ ok: true }), send }), { ok: true })
  t.is(sent.length, 1, 'nothing sent for { ok: true }')
  const refused = Object.assign(new Error('sem chave da página'), { code: 'USAGE' })
  await t.exception(sendSealed({ group: GROUP, seal: async () => { throw refused }, send }), /sem chave da página/)
  t.is(sent.length, 1, 'a refused seal sends nothing')
  const unsure = Object.assign(new Error('x'), { uncertain: true, retry: () => {} })
  const err = await sendSealed({ group: GROUP, seal: async () => sealed, send: async () => { throw unsure } }).catch((e) => e)
  t.is(err, unsure, 'the uncertain error and its retry reach the caller')
})

test('sealAgainAfter: a raced seq or a key change, never an unknown outcome', async (t) => {
  const { sealAgainAfter } = await load()
  t.ok(sealAgainAfter({ code: 'sequencia' }))
  t.ok(sealAgainAfter({ code: 'aguardando-chave' }))
  t.ok(sealAgainAfter({ message: 'aguardando nova chave' }))
  t.absent(sealAgainAfter({ code: 'sequencia', uncertain: true }))
  t.absent(sealAgainAfter({ code: 'limite' }))
  t.absent(sealAgainAfter(null))
})

test('carriesPrivateItems: a sealed mark, or an item or card image with its key', async (t) => {
  const { carriesPrivateItems } = await load()
  const PLAIN = { core: CORE, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: ITEM.sha256, width: 4, height: 4 }
  t.ok(carriesPrivateItems({ group: GROUP, text: '', media: [ITEM] }), 'a private photo')
  t.ok(carriesPrivateItems({ group: GROUP, text: '', media: [PLAIN, { ...PLAIN, nonce: ITEM.nonce }] }), 'a nonce on any item')
  t.ok(carriesPrivateItems({ group: GROUP, text: '', media: [{ ...PLAIN, plainSha256: ITEM.plainSha256 }] }), 'a plain sum')
  t.ok(carriesPrivateItems({ group: GROUP, text: 'oi', card: { url: 'https://a.b', image: ITEM } }), 'a private card image')
  t.ok(carriesPrivateItems({ group: GROUP, text: 'oi', sealed: true }), 'marked sealed')
  t.absent(carriesPrivateItems({ group: GROUP, text: 'oi', media: [PLAIN], card: { url: 'https://a.b', image: PLAIN } }), 'public items')
  t.absent(carriesPrivateItems({ group: GROUP, text: 'oi', card: { url: 'https://a.b', image: null } }), 'an imageless card')
  t.absent(carriesPrivateItems(null))
})

test('a held sealed post is never sent as a plain group-post', async (t) => {
  const { heldPageSender } = await load()
  const sealedOp = { method: 'group.post', params: { group: GROUP, text: 'oi', media: [ITEM] } }
  const publicOp = { method: 'group.post', params: { group: GROUP, text: 'oi', media: [{ core: CORE, mime: 'image/jpeg', start: 1 }] } }
  for (const vis of [null, 'public', undefined]) {
    t.is(heldPageSender({ op: sealedOp, retry: null }, vis), null, 'sealed hold, visibility ' + vis)
    t.is(heldPageSender({ op: { method: 'group.post', params: { group: GROUP, text: 'oi' } }, sealed: true, retry: null }, vis), null, 'marked sealed hold, visibility ' + vis)
  }
  t.is(heldPageSender({ op: sealedOp, retry: null }, 'private'), 'sealed', 'sealed again while the node reads it private')
  t.is(heldPageSender({ op: sealedOp, retry: async () => {} }, null), 'retry', 'the kept signed statement is resent as is')
  t.is(heldPageSender({ op: publicOp, retry: null }, 'public'), 'plain')
  t.is(heldPageSender({ op: publicOp, retry: null }, null), null, 'unknown group: nothing sent')
  t.is(heldPageSender({ op: publicOp, retry: null }, 'private'), null, 'public items never go into a private group')
  t.is(heldPageSender(null, 'private'), null)
})

test('the plain page group-post builder refuses private items before anything is signed', async (t) => {
  const { pageGroupPostOp, PAGE_PRIVATE_AS_PLAIN_TEXT } = await import('../src/groups.js')
  // A TypeError: brittle's t.exception rethrows native errors.
  const refused = (params) => {
    try { pageGroupPostOp(params) } catch (err) { return err.message }
    return null
  }
  t.is(refused({ group: GROUP, text: 'oi', media: [ITEM] }), PAGE_PRIVATE_AS_PLAIN_TEXT, 'a private photo')
  t.is(refused({ group: GROUP, text: 'oi', card: { url: 'https://a.b', image: ITEM } }), PAGE_PRIVATE_AS_PLAIN_TEXT, 'a private card image')
  t.is(refused({ group: GROUP, text: 'oi', sealed: true }), PAGE_PRIVATE_AS_PLAIN_TEXT, 'marked sealed')
  t.alike(pageGroupPostOp({ group: GROUP, text: 'oi' }), { group: GROUP, text: 'oi' }, 'a public post still builds')
})
