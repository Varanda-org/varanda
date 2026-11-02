'use strict'

// src/sha256.js: the SHA-256 the payments screen and kycHash use on the web
// and on the phone, where React Native has no crypto.subtle.
const test = require('brittle')
const crypto = require('node:crypto')

const load = () => import('../src/sha256.js')

test('sha256Hex: the FIPS 180-2 vector, UTF-8 input, null for a non-string', async (t) => {
  const { sha256Hex } = await load()
  t.is(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  t.is(await sha256Hex(''), crypto.createHash('sha256').update('', 'utf8').digest('hex'))
  t.is(await sha256Hex('ação 😀'), crypto.createHash('sha256').update('ação 😀', 'utf8').digest('hex'))
  t.is(await sha256Hex(1), null)
  t.is(await sha256Hex(null), null)
  t.is(await sha256Hex(undefined), null)
})
