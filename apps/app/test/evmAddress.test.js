'use strict'

// src/evmAddress.js: the EIP-55 checksum the Enviar screen checks before an
// irreversible send to an outside address.
const test = require('brittle')

const load = () => import('../src/evmAddress.js')

// The EIP-55 specification's own test vectors.
const VALID = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
]

test('hasValidChecksum: the EIP-55 vectors pass', async (t) => {
  const { hasValidChecksum } = await load()
  for (const a of VALID) t.ok(hasValidChecksum(a), a)
})

test('hasValidChecksum: one letter in the wrong case fails', async (t) => {
  const { hasValidChecksum } = await load()
  for (const a of VALID) {
    const i = a.slice(2).search(/[a-fA-F]/) + 2
    const flipped = a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1)
    t.absent(hasValidChecksum(flipped), flipped)
  }
})

test('hasValidChecksum: one wrong character in a checksummed address fails', async (t) => {
  const { hasValidChecksum } = await load()
  t.absent(hasValidChecksum('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee'))
})

test('hasValidChecksum: all lower or all upper case carries no checksum and passes', async (t) => {
  const { hasValidChecksum } = await load()
  t.ok(hasValidChecksum(VALID[0].toLowerCase()))
  t.ok(hasValidChecksum('0x' + VALID[0].slice(2).toUpperCase()))
})

test('hasValidChecksum: anything that is not 0x plus 40 hex is false', async (t) => {
  const { hasValidChecksum } = await load()
  for (const v of [undefined, null, 1, {}, '', '0x', '0x1234', VALID[0].slice(2), VALID[0] + '0', '0X' + VALID[0].slice(2), VALID[0].slice(0, 41) + 'g']) {
    t.absent(hasValidChecksum(v), String(v))
  }
})
