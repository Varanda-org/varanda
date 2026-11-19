'use strict'

// apps/cli/lib/account/push-wake-key.js: the account service's DM notice key.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { sealDmNotice, openDmNotice } = require('@varanda/core/lib/dm-notice')
const { loadOrCreateWakeKey, WAKE_KEY_FILE } = require('../lib/account/push-wake-key')
const { tmpDir } = require('./helpers/net')

const MEMBER = 'ab'.repeat(32)

function dataDir (t) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  return dir
}

// Every way the file is refused must throw without the secret in the message.
function refused (t, dir, secretHex, label) {
  let caught = null
  try {
    loadOrCreateWakeKey(dir)
  } catch (err) {
    caught = err
  }
  t.ok(caught instanceof Error, label + ': throws')
  if (caught === null) return
  t.absent(String(caught.message).includes(secretHex), label + ': no secret in the message')
  t.absent(/[0-9a-f]{64}/.test(String(caught.message)), label + ': no key in the message')
}

test('wake key: created once with mode 0600, the same pair on the next load, and it opens what is sealed to it', async (t) => {
  const dir = dataDir(t)
  const first = loadOrCreateWakeKey(dir)
  t.is(first.publicKey.length, 32)
  t.is(first.secretKey.length, 32)
  const file = path.join(dir, WAKE_KEY_FILE)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike(Object.keys(obj).sort(), ['publicKey', 'secretKey', 'v'])
  t.is(obj.v, 1)
  t.is(obj.publicKey, first.publicKey.toString('hex'))
  const second = loadOrCreateWakeKey(dir)
  t.alike(second.publicKey, first.publicKey)
  t.alike(second.secretKey, first.secretKey)
  t.is(openDmNotice(sealDmNotice(MEMBER, first.publicKey), second), MEMBER)
  t.alike(fs.readdirSync(dir), [WAKE_KEY_FILE], 'no temp file left behind')
})

test('wake key: a corrupt file, wrong shape, wrong lengths or a mismatched pair throws and is never replaced', async (t) => {
  const dir = dataDir(t)
  const good = loadOrCreateWakeKey(dir)
  const file = path.join(dir, WAKE_KEY_FILE)
  const secretHex = good.secretKey.toString('hex')
  const pubHex = good.publicKey.toString('hex')
  const other = loadOrCreateWakeKey(dataDir(t))
  const cases = [
    ['not JSON', secretHex + '{'],
    ['array', JSON.stringify([1, pubHex, secretHex])],
    ['missing v', JSON.stringify({ publicKey: pubHex, secretKey: secretHex })],
    ['v 2', JSON.stringify({ v: 2, publicKey: pubHex, secretKey: secretHex })],
    ['extra key', JSON.stringify({ v: 1, publicKey: pubHex, secretKey: secretHex, note: 'x' })],
    ['short public', JSON.stringify({ v: 1, publicKey: pubHex.slice(2), secretKey: secretHex })],
    ['long secret', JSON.stringify({ v: 1, publicKey: pubHex, secretKey: secretHex + '00' })],
    ['uppercase hex', JSON.stringify({ v: 1, publicKey: pubHex.toUpperCase(), secretKey: secretHex })],
    ['mismatched pair', JSON.stringify({ v: 1, publicKey: other.publicKey.toString('hex'), secretKey: secretHex })]
  ]
  for (const [label, body] of cases) {
    fs.writeFileSync(file, body)
    refused(t, dir, secretHex, label)
    t.is(fs.readFileSync(file, 'utf8'), body, label + ': the file is kept as it was')
  }
})

test('wake key: a symlinked file or data dir is refused', async (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real, { mode: 0o700 })
  const good = loadOrCreateWakeKey(real)
  const secretHex = good.secretKey.toString('hex')

  const linkedFile = path.join(root, 'linked-file')
  fs.mkdirSync(linkedFile, { mode: 0o700 })
  fs.symlinkSync(path.join(real, WAKE_KEY_FILE), path.join(linkedFile, WAKE_KEY_FILE))
  refused(t, linkedFile, secretHex, 'symlinked file')
  t.ok(fs.lstatSync(path.join(linkedFile, WAKE_KEY_FILE)).isSymbolicLink(), 'the link is not replaced')

  const dangling = path.join(root, 'dangling')
  fs.mkdirSync(dangling, { mode: 0o700 })
  fs.symlinkSync(path.join(root, 'nowhere.json'), path.join(dangling, WAKE_KEY_FILE))
  refused(t, dangling, secretHex, 'dangling symlink')
  t.absent(fs.existsSync(path.join(root, 'nowhere.json')), 'nothing written through the link')

  const linkedDir = path.join(root, 'linked-dir')
  fs.symlinkSync(real, linkedDir)
  refused(t, linkedDir, secretHex, 'symlinked dir')
})
