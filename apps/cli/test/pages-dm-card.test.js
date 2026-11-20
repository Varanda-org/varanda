'use strict'

// apps/cli/lib/account/pages-dm.js serves a page's legacy rows read only:
// a member's link card (a Feira listing or offer) stored before the page's
// keys moved to devices is checked again on load. No network.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { tmpDir } = require('./helpers/net')
const { createPagesDm } = require('../lib/account/pages-dm')

const PAGE_KEYS = 'cd'.repeat(32)
const CARD_HOST = 'feira.varanda.test'

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function jpegItem () {
  return { id: hex(crypto.randomBytes(32)), key: hex(crypto.randomBytes(32)), nonce: hex(crypto.randomBytes(24)), chunks: 1, bytes: 20000, sha256: hex(crypto.randomBytes(32)), mime: 'image/jpeg', w: 640, h: 480, ms: 0 }
}

function offerCard () {
  return { url: 'https://' + CARD_HOST + '/l/abc#oferta=' + 'x'.repeat(20), host: CARD_HOST, title: 'Bicicleta aro 26', desc: 'Oferta: R$ 300', image: jpegItem() }
}

// ---- offline: a fake writer and key table, rows written by the test -------

const ROWS_LABEL = 'varanda-page-dm-rows-v1'
const ROWS_AAD = b4a.from('varanda-page-dm-v1')

function rowKey (page) {
  const master = nodeCrypto.createHmac('sha256', Buffer.from(PAGE_KEYS, 'hex')).update(ROWS_LABEL).digest()
  return nodeCrypto.createHmac('sha256', master).update(page).digest()
}

function writeRows (dir, page, s) {
  fs.mkdirSync(path.join(dir, 'pages-dm'), { recursive: true })
  const iv = nodeCrypto.randomBytes(12)
  const c = nodeCrypto.createCipheriv('aes-256-gcm', rowKey(page), iv, { authTagLength: 16 })
  c.setAAD(ROWS_AAD)
  const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(s))), c.final()])
  fs.writeFileSync(path.join(dir, 'pages-dm', page + '.json'), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 })
}

test('pages-dm card: stored rows load with a missing, bad or half bad card and keep their text', async (t) => {
  const dir = tmpDir(t, 'varanda-pdm-')
  const page = hex(crypto.randomBytes(32))
  const peer = hex(crypto.randomBytes(32))
  const good = offerCard()
  const badImage = { ...offerCard(), image: { ...jpegItem(), mime: 'image/gif' } }
  const at = (i) => '2026-11-01T10:0' + i + ':00.000Z'
  const row = (i, extra) => ({ id: hex(crypto.randomBytes(16)), peer, from: peer, text: 'm' + i, replyTo: null, at: at(i), mine: false, filedAt: i + 1, ...extra })
  writeRows(dir, page, {
    v: 1,
    filed: 5,
    stopped: false,
    messages: [
      row(0, {}),
      row(1, { card: 'https://' + CARD_HOST }),
      row(2, { card: { ...good, host: 'outro.test' } }),
      row(3, { card: badImage }),
      row(4, { card: good })
    ],
    ops: [],
    seen: [],
    wallet: { items: [], kids: [] },
    sends: {}
  })
  const writer = {
    ready: async () => {},
    pageKeys: () => [page],
    ensureDmKey: async () => ({ seq: null, length: 0 }),
    readEntries: async () => [],
    follows: () => [],
    certOf: () => { throw new Error('unused') }
  }
  const pagesDm = createPagesDm({ writer, keys: { get: () => null, put: noop }, association: 'ab'.repeat(32), dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS }, limits: { refreshEveryMs: 0 } })
  t.teardown(() => pagesDm.close(), { force: true })
  await pagesDm.ready()

  const th = await pagesDm.thread(page, { peer })
  t.alike(th.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4'], 'every message is kept')
  t.is(th.messages[0].card, null, 'an old row without a card reads null')
  t.is(th.messages[1].card, null, 'a card that is not an object is dropped')
  t.is(th.messages[2].card, null, 'a card with a wrong host is dropped')
  t.alike(th.messages[3].card, { ...badImage, image: null }, 'a bad image drops only the image')
  t.alike(th.messages[4].card, good, 'a valid card is kept with its image')

  const l = await pagesDm.list(page, { folder: 'request' })
  t.is(l.conversations[0].preview, 'm4', 'the preview is the text, never the card')
})
