'use strict'

// The "Meu QR" code (src/profileQr.js): only a profile link becomes a code,
// and the link it carries opens the same profile in the app
// (src/linkReturn.js), never anything else.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/profileQr.js')
const KEY = 'ab'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'

async function withOrigin (t, origin) {
  const { setInstallation } = await import('../src/installation.js')
  t.ok(setInstallation(origin))
  t.teardown(() => setInstallation(null))
}

// The 15 format bits next to the top-left finder, unmasked: the error
// correction level and the mask a reader decodes first.
function formatInfo (qr) {
  const cells = []
  for (const x of [0, 1, 2, 3, 4, 5, 7, 8]) cells.push([x, 8])
  for (const y of [7, 5, 4, 3, 2, 1, 0]) cells.push([8, y])
  let bits = 0
  for (const [x, y] of cells) bits = (bits << 1) | (qr.dark(x, y) ? 1 : 0)
  return bits ^ 0x5412
}

function bch (data) {
  let v = data << 10
  for (let i = 14; i >= 10; i--) if (v & (1 << i)) v ^= 0x537 << (i - 10)
  return (data << 10) | v
}

function finderAt (qr, ox, oy) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      if (qr.dark(ox + x, oy + y) !== (ring !== 2)) return false
    }
  }
  return true
}

test('profileQr: a profile link becomes a well-formed code at level M', async (t) => {
  const { profileQr, qrPath, QUIET_ZONE } = await load()
  for (const url of [ORIGIN + '/@ana_lima', ORIGIN + '/m/' + KEY, 'https://localhost:8443/@ana']) {
    const qr = profileQr(url)
    t.ok(qr !== null, url)
    t.ok(qr.size >= 21 && (qr.size - 17) % 4 === 0, 'a QR side: ' + qr.size)
    t.ok(finderAt(qr, 0, 0) && finderAt(qr, qr.size - 7, 0) && finderAt(qr, 0, qr.size - 7), 'three finder patterns')
    const info = formatInfo(qr)
    t.is(bch(info >> 10), info, 'format bits pass their BCH check')
    t.is(info >> 13, 0, 'error correction M')
    t.absent(qr.dark(-1, 0) || qr.dark(qr.size, 0), 'nothing outside the matrix')
    const d = qrPath(qr)
    t.ok(d.startsWith('M' + QUIET_ZONE + ' ' + QUIET_ZONE + 'h1v1h-1z'), 'the path starts at the top-left module, past the quiet zone')
    t.is(profileQr(url).size, qr.size, 'same link, same code')
  }
})

test('profileQr: anything but a profile link draws no code', async (t) => {
  const { profileQr, isProfileUrl } = await load()
  for (const url of [
    undefined, null, 42, '', 'ana', '@ana', 'varanda:///@ana',
    'http://bora.varanda.app/@ana', 'https://bora.varanda.app', 'https://bora.varanda.app/',
    'https://bora.varanda.app/@an', 'https://bora.varanda.app/@ana/x', 'https://bora.varanda.app/@ana?x=1',
    'https://bora.varanda.app/@ana#x', 'https://bora.varanda.app/@%61na', 'https://bora.varanda.app/m/' + KEY.slice(1),
    'https://bora.varanda.app/m/' + KEY + 'a', 'https://bora.varanda.app/g/' + KEY, 'https://bora.varanda.app/convite/abc',
    'https://user@bora.varanda.app/@ana', 'https://BORA.varanda.app/@ana', 'https://bora.varanda.app:99999x/@ana',
    'https://evil.example/@ana\n', 'https://bora.varanda.app//@ana', 'https://bora.varanda.app/@ana ',
    'https://bora.varanda.app/@' + 'a'.repeat(200), 'javascript:alert(1)//https://bora.varanda.app/@ana'
  ]) {
    t.is(profileQr(url), null, String(url))
    t.absent(isProfileUrl(url), String(url))
  }
})

test('profileQr: the link in the code opens the same profile in the app', async (t) => {
  await withOrigin(t, ORIGIN)
  const { profileQr } = await load()
  const { buildProfileUrl } = await import('../src/profileLink.js')
  const { parseAppLink } = await import('../src/linkReturn.js')
  const { captureInvite, dropInvite } = await import('../src/profileLinkStore.native.js')
  t.teardown(() => dropInvite())

  const byName = buildProfileUrl({ origin: ORIGIN, username: 'ana_lima', publicKey: KEY })
  const byKey = buildProfileUrl({ origin: ORIGIN, username: null, publicKey: KEY })
  t.ok(profileQr(byName) && profileQr(byKey), 'both forms draw')
  t.alike(parseAppLink(byName), { kind: 'perfil', username: 'ana_lima' })
  t.alike(parseAppLink(byKey), { kind: 'perfil', key: KEY })

  // Opening the link records a fresh invite: no consent, so the profile
  // shows with a Seguir button and nobody is followed until it is tapped.
  const rec = captureInvite(byName)
  t.is(rec.username, 'ana_lima')
  t.is(rec.state, 'new')
  t.is(rec.recipient, null)
})

test('profileQr: a code of another installation follows nobody in this app', async (t) => {
  await withOrigin(t, ORIGIN)
  const { profileQr } = await load()
  const { parseAppLink } = await import('../src/linkReturn.js')
  const { captureInvite, dropInvite } = await import('../src/profileLinkStore.native.js')
  t.teardown(() => dropInvite())
  const other = 'https://outra.example/@ana_lima'
  t.ok(profileQr(other) !== null, 'another association draws its own code')
  t.is(parseAppLink(other), null, 'but this app does not open it')
  t.is(captureInvite(other), null, 'and records no invite')
})

test('profileQr: pure module, toqr pinned as a direct dependency', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/profileQr.js'), 'utf8')
  t.absent(/from '(react|node:|expo-camera)/.test(src), 'no React, react-native, Node or camera import')
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  t.is(pkg.dependencies.toqr, '0.1.1', 'exact version')
})

test('Meu QR: the Diário sheet draws the own profile link, help behind the (i)', (t) => {
  const diario = fs.readFileSync(path.join(__dirname, '../src/screens/Diario.js'), 'utf8')
  t.ok(diario.includes('<ProfileQr url={profileUrl}'), 'the code is the share link')
  t.ok(diario.includes('<HelpNote doc={HELP.meuQr}>'), 'the explanation sits behind the (i)')
  t.absent(/Platform\.OS/.test(fs.readFileSync(path.join(__dirname, '../src/ui/ProfileQr.js'), 'utf8')), 'no platform branch')
})
