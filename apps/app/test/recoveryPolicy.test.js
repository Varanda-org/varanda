'use strict'

const test = require('brittle')

const load = () => import('../src/recoveryPolicy.js')

test('blockingRecovery: a device with its member certificate never blocks', async (t) => {
  const { blockingRecovery } = await load()
  for (const onLine of [true, false, undefined]) t.is(blockingRecovery({ onLine, memberCert: true }), false)
})

test('blockingRecovery: without the certificate it blocks unless offline', async (t) => {
  const { blockingRecovery } = await load()
  t.is(blockingRecovery({ onLine: false, memberCert: false }), false)
  for (const memberCert of [false, undefined]) {
    for (const onLine of [true, undefined]) t.is(blockingRecovery({ onLine, memberCert }), true)
  }
})
