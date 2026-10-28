'use strict'

// linkNew (lib/link-new.js): the exclusive publish of a finished temp file.
// Android answers link() with EACCES (SELinux), which the tests reproduce by
// replacing fs.linkSync; the callers (member config, key files) must still
// publish without clobbering.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const cert = require('../lib/cert')
const member = require('../lib/member')
const { linkNew } = require('../lib/link-new')
const { tmpDir } = require('./helpers/tmp')

function denyLink (t, code) {
  const real = fs.linkSync
  fs.linkSync = () => {
    const err = new Error(code + ': operation not permitted, link')
    err.code = code
    throw err
  }
  t.teardown(() => { fs.linkSync = real }, { force: true })
}

function codeOf (fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return null
}

function write (file, text) {
  fs.writeFileSync(file, text)
  return file
}

test('linkNew links the temp file, and refuses to replace an existing one', (t) => {
  const dir = tmpDir(t)
  const tmp = write(path.join(dir, 'a.tmp'), 'new')
  const file = path.join(dir, 'a')
  linkNew(tmp, file)
  t.is(fs.readFileSync(file, 'utf8'), 'new')
  t.is(codeOf(() => linkNew(write(path.join(dir, 'b.tmp'), 'other'), file)), 'EEXIST')
  t.is(fs.readFileSync(file, 'utf8'), 'new', 'the existing file is untouched')
})

for (const code of ['EACCES', 'EPERM']) {
  test('linkNew without link(): ' + code + ' falls back to a rename, never over an existing entry', (t) => {
    denyLink(t, code)
    const dir = tmpDir(t)
    const file = path.join(dir, 'a')
    linkNew(write(path.join(dir, 'a.tmp'), 'new'), file)
    t.is(fs.readFileSync(file, 'utf8'), 'new')
    t.absent(fs.existsSync(path.join(dir, 'a.tmp')), 'the temp name is gone')

    const other = write(path.join(dir, 'b.tmp'), 'other')
    t.is(codeOf(() => linkNew(other, file)), 'EEXIST')
    t.is(fs.readFileSync(file, 'utf8'), 'new', 'the existing file is untouched')
    t.ok(fs.existsSync(other), 'the temp file is left for the caller to remove')

    const dangling = path.join(dir, 'dangling')
    fs.symlinkSync(path.join(dir, 'nowhere'), dangling)
    t.is(codeOf(() => linkNew(other, dangling)), 'EEXIST', 'a dangling symlink counts as existing')
    t.absent(fs.existsSync(path.join(dir, 'nowhere')), 'and is not followed')
  })
}

test('linkNew passes other link errors through', (t) => {
  denyLink(t, 'ENOSPC')
  const dir = tmpDir(t)
  t.is(codeOf(() => linkNew(write(path.join(dir, 'a.tmp'), 'x'), path.join(dir, 'a'))), 'ENOSPC')
  t.absent(fs.existsSync(path.join(dir, 'a')))
})

test('without link(): idCreate publishes config.json and a second one reads it', async (t) => {
  denyLink(t, 'EACCES')
  const dataDir = tmpDir(t)
  const kp = crypto.keyPair()
  const association = b4a.toString(kp.publicKey, 'hex')
  const created = await member.idCreate({ dataDir, association })
  t.alike(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), { v: 1, role: 'member', association })
  t.alike(await member.idCreate({ dataDir, association: null }), created)
  t.alike(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left')
})

test('without link(): saveKeyPairFile publishes the key and refuses a second save', (t) => {
  denyLink(t, 'EACCES')
  const dir = tmpDir(t)
  const file = path.join(dir, 'key.json')
  const kp = cert.generateAssociationKeyPair()
  cert.saveKeyPairFile(file, kp)
  t.alike(cert.loadKeyPairFile(file).publicKey, kp.publicKey)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const before = fs.readFileSync(file, 'utf8')
  t.exception(() => cert.saveKeyPairFile(file, cert.generateAssociationKeyPair()), /arquivo de chave já existe/)
  t.is(fs.readFileSync(file, 'utf8'), before, 'the first key survives')
  t.alike(fs.readdirSync(dir), ['key.json'], 'no temp file is left')
})
