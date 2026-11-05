'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { removeWalletFiles } = require('../lib/account/wallet-cleanup')

const SECRET = 'SEGREDO-NAO-LOGAR'

function tmp (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-wallet-cleanup-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const sorted = (list) => [...list].sort()

test('wallet cleanup: removes the wallet files and their atomic-write temps only', (t) => {
  const dir = tmp(t)
  const targets = ['wallet.json', 'wallet-ops.json', '.wallet.json.1.0123456789ab.tmp', '.wallet-ops.json.99999.abcdefabcdef.tmp']
  const kept = ['wallet.json.bak', '.wallet.json.tmp', '.wallet.json.2.ABCDEF012345.tmp', '.wallet.json.1.0123456789a.tmp', '.ledger.json.1.abcdefabcdef.tmp', 'unrelated.json']
  for (const name of [...targets, ...kept]) fs.writeFileSync(path.join(dir, name), SECRET)

  const result = removeWalletFiles(dir)
  t.alike(sorted(result.removed), sorted(targets))
  t.alike(result.failed, [])
  for (const name of targets) t.absent(fs.existsSync(path.join(dir, name)), name + ' removed')
  for (const name of kept) t.ok(fs.existsSync(path.join(dir, name)), name + ' kept')
  t.absent(JSON.stringify(result).includes(SECRET))
})

test('wallet cleanup: a directory named wallet.json is skipped', (t) => {
  const dir = tmp(t)
  fs.mkdirSync(path.join(dir, 'wallet.json'))
  const result = removeWalletFiles(dir)
  t.alike(result, { removed: [], failed: [] })
  t.ok(fs.statSync(path.join(dir, 'wallet.json')).isDirectory())
})

test('wallet cleanup: a symlink is unlinked and its target left untouched', (t) => {
  const dir = tmp(t)
  const other = tmp(t)
  const target = path.join(other, 'target.json')
  fs.writeFileSync(target, SECRET)
  fs.symlinkSync(target, path.join(dir, 'wallet.json'))
  const result = removeWalletFiles(dir)
  t.alike(result, { removed: ['wallet.json'], failed: [] })
  let gone = false
  try {
    fs.lstatSync(path.join(dir, 'wallet.json'))
  } catch (err) {
    gone = err.code === 'ENOENT'
  }
  t.ok(gone, 'link removed')
  t.is(fs.readFileSync(target, 'utf8'), SECRET)
})

test('wallet cleanup: a missing or empty directory removes nothing', (t) => {
  const dir = tmp(t)
  t.alike(removeWalletFiles(dir), { removed: [], failed: [] })
  t.alike(removeWalletFiles(path.join(dir, 'nao-existe')), { removed: [], failed: [] })
})

test('wallet cleanup: a failed unlink is reported by name and code, never by content', { skip: Boolean(process.getuid && process.getuid() === 0) }, (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'wallet.json'), SECRET)
  fs.chmodSync(dir, 0o500)
  let result
  try {
    result = removeWalletFiles(dir)
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  t.alike(result.removed, [])
  t.is(result.failed.length, 1)
  t.is(result.failed[0].file, 'wallet.json')
  t.ok(['EACCES', 'EPERM'].includes(result.failed[0].code), result.failed[0].code)
  t.absent(JSON.stringify(result).includes(SECRET))
})
