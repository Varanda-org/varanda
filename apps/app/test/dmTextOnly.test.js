'use strict'

// src/dmTextOnly.js: a core node's Conversas send text only (#352).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/dmTextOnly.js')

test('dmTextOnly: a node that is not hosted and offers no media.putDm', async (t) => {
  const { dmTextOnly } = await load()
  const putDm = async () => ({})
  t.is(dmTextOnly({ hosted: false, media: null }), true, 'a core node')
  t.is(dmTextOnly({ hosted: false, media: { read: async () => ({}) } }), true, 'reading received media is not sending')
  t.is(dmTextOnly({ hosted: false, media: { putDm } }), false, 'a node that sends media')
  t.is(dmTextOnly({ hosted: true, media: null }), false, 'a hosted node, even locked')
  t.is(dmTextOnly(null), false)
})

test('isTextOnlyRefusal reads the core engine refusal', async (t) => {
  const { isTextOnlyRefusal, DM_TEXT_ONLY } = await load()
  const engine = fs.readFileSync(path.join(__dirname, '../../../packages/web-member/lib/core-dm.js'), 'utf8')
  t.ok(engine.includes("const TEXT_ONLY = '" + DM_TEXT_ONLY + "'"), 'the same text as core-dm.js')
  t.is(isTextOnlyRefusal(new Error(DM_TEXT_ONLY)), true)
  t.is(isTextOnlyRefusal(new Error('outra')), false)
  t.is(isTextOnlyRefusal(null), false)
})

test('Mensagem attaches no card on a text-only node, and no photo or voice without media.putDm', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('const textOnly = dmTextOnly(node)'))
  t.ok(src.includes('enabled: !initialTarget && !textOnly'), 'no card preview')
  t.ok(src.includes('if (textOnly) snapshot = null'), 'no card in the send')
  t.ok(src.includes("const mediaApi = node.media && typeof node.media.putDm === 'function' ? node.media : null"), 'attach and voice need putDm')
})
