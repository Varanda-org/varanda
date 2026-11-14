'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/installationSwap.js')

test('swappedInstallation: only a change from a known installation counts', async (t) => {
  const { swappedInstallation } = await load()
  t.is(swappedInstallation('https://a.example', 'https://b.example'), true)
  t.is(swappedInstallation('https://a.example', 'https://a.example'), false)
  t.is(swappedInstallation('', 'https://a.example'), false, 'the saved installation loading after a link is not a swap')
  t.is(swappedInstallation('https://a.example', ''), true, 'forgetting the installation leaves it')
  for (const bad of [undefined, null, 5, {}]) t.is(swappedInstallation(bad, 'https://a.example'), false, String(bad))
  t.is(swappedInstallation('https://a.example', undefined), false)
})

test('installation swap: App drops the held invite and shows Conexão where the installation can change', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('if (!swappedInstallation(previous, ageOrigin)) return\n    dropSignupInvite()\n    dropSignupInviteCard()'))
  t.ok(app.includes("const connectionLink = mode === 'hosted' && !node.canConfigure"))
  const src = fs.readFileSync(path.join(__dirname, '../src/installationSwap.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:']) t.absent(src.includes(bad), bad)
})
