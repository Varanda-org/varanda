'use strict'

// apps/cli/lib/account/guarded-write.js: the account service's sidecar
// writes ask the lock again right before the rename. No network.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const nodeCrypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { writeGuarded, isRefused } = require('../lib/account/guarded-write')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { openInviteDrops } = require('../lib/account/invite-drops')
const { openPushStore } = require('../lib/account/push-store')
const { openAgeStore } = require('../lib/account/age-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { settleAgeCheck } = require('../lib/account/age-check-state')
const { tmpDir } = require('./helpers/net')

// Monday 2026-10-26 00:00 Brasília.
const WEEK0 = Date.parse('2026-10-26T03:00:00.000Z')

const PHONE_CBS = { linked: () => true, burnable: () => false, deleted: () => false }

function pushSub () {
  const p256dh = Buffer.alloc(65, 1)
  p256dh[0] = 0x04
  return { member: hex32(), endpoint: 'https://fcm.googleapis.com/fcm/send/device-' + hex32(), p256dh: p256dh.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') }
}

function hex32 () {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function seed (t) {
  const dir = tmpDir(t)
  const file = path.join(dir, 'x.json')
  writeJsonAtomic(file, { v: 1 }, 0o600)
  return { dir, file, before: fs.readFileSync(file) }
}

test('writeGuarded: a guard that answers true renames', async (t) => {
  const { dir, file } = seed(t)
  let calls = 0
  writeGuarded(file, { v: 2 }, 0o600, () => {
    calls++
    t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 }, 'asked before the target is replaced')
    t.is(fs.readdirSync(dir).length, 2, 'with the temp file already written')
    return true
  })
  t.is(calls, 1, 'asked once')
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 })
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.alike(fs.readdirSync(dir), ['x.json'])
})

test('writeGuarded: a guard that answers false or throws keeps the target and throws the refusal', async (t) => {
  const guards = {
    false: () => false,
    null: () => null,
    throws: () => { throw new Error('lock read failed') }
  }
  for (const [name, guard] of Object.entries(guards)) {
    const { dir, file, before } = seed(t)
    let err = null
    try {
      writeGuarded(file, { v: 2 }, 0o600, guard)
    } catch (e) {
      err = e
    }
    t.ok(isRefused(err), name + ': a refusal')
    t.is(err && err.code, 'indisponivel', name + ': with the usual code')
    t.ok(b4a.equals(fs.readFileSync(file), before), name + ': the target is byte-identical')
    t.alike(fs.readdirSync(dir), ['x.json'], name + ': no temp file is left')
  }
})

test('writeGuarded: an ordinary failure is not a refusal', async (t) => {
  const { file } = seed(t)
  const boom = Object.assign(new Error('EIO'), { code: 'EIO' })
  let err = null
  try {
    writeGuarded(file, { v: 2 }, 0o600, () => true, () => { throw boom })
  } catch (e) {
    err = e
  }
  t.is(err, boom, 'the writer\'s own error goes through')
  t.absent(isRefused(err))
  t.absent(isRefused(null))
  t.absent(isRefused(Object.assign(new Error('indisponivel'), { code: 'indisponivel', refused: true })), 'a look-alike error is not a refusal')

  // A refusal stays a refusal even when the writer's cleanup fails after it.
  err = null
  try {
    writeGuarded(file, { v: 2 }, 0o600, () => false, (f, obj, mode, { beforeRename }) => {
      try {
        beforeRename()
      } finally {
        throw boom // eslint-disable-line no-unsafe-finally
      }
    })
  } catch (e) {
    err = e
  }
  t.ok(isRefused(err), 'a cleanup failure does not hide the refusal')
})

test('writeGuarded: an injected writer gets the hook', async (t) => {
  const { file } = seed(t)
  const seen = []
  writeGuarded(file, { v: 3 }, 0o600, () => true, (f, obj, mode, opts) => {
    seen.push([f, obj, mode, typeof opts.beforeRename])
    writeJsonAtomic(f, obj, mode, opts)
  })
  t.alike(seen, [[file, { v: 3 }, 0o600, 'function']])
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 3 })
})

// Each store whose guarded writes go through writeGuarded. `seed` writes
// once with the guard answering true; `write` is a further write. The guard
// then refuses only while a temp file sits next to the target, that is right
// before the rename: every check before the write passes.
async function rejectsWith (p, code) {
  try {
    await p
  } catch (err) {
    return err.code === code
  }
  return false
}

const STORES = [
  {
    name: 'terms.json',
    file: 'terms.json',
    open: (dir, guard) => openTermsStore(dir, { guard }),
    seed: (s) => s.accept({ member: hex32(), version: 1, nonce: 'n'.repeat(43), signature: 'ab'.repeat(64) }),
    write: (s) => s.accept({ member: hex32(), version: 1, nonce: 'n'.repeat(43), signature: 'ab'.repeat(64) }),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    name: 'passkeys.json',
    file: 'passkeys.json',
    open: (dir, guard) => openPasskeyStore(dir, { guard }),
    seed: (s) => s.add({ member: hex32(), credentialId: b4a.toString(crypto.randomBytes(16), 'base64url'), alg: -7, spki: 'ab'.repeat(91), signCount: 0 }),
    write: (s) => s.add({ member: hex32(), credentialId: b4a.toString(crypto.randomBytes(16), 'base64url'), alg: -7, spki: 'ab'.repeat(91), signCount: 0 }),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    name: 'invites.json',
    file: 'invites.json',
    open: (dir, guard) => openInvitesStore(dir, { perWeek: 3, guard }),
    seed: (s) => s.issue(hex32()),
    write: (s) => s.issue(hex32()),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    // The Feira's codes: the same module with the options the service uses.
    name: 'feira-invites.json',
    file: 'feira-invites.json',
    open: (dir, guard) => openInvitesStore(dir, { file: 'feira-invites.json', ttlMs: 3600 * 1000, capOn: 'use', maxRows: 20000, pruneUnused: true, perWeek: 3, guard }),
    seed: (s) => s.issue(hex32()),
    write: (s) => s.issue(hex32()),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    // invite-drops-key.json is written at open; its refusal is in
    // invite-drops.test.js.
    name: 'invite-drops.json',
    file: 'invite-drops.json',
    open: (dir, guard) => openInviteDrops(dir, { perWeek: 1, now: () => WEEK0, guard }),
    seed: (s) => s.markNotified(hex32(), new Date(WEEK0).toISOString(), [0]),
    write: (s) => s.markNotified(hex32(), new Date(WEEK0).toISOString(), [0]),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    name: 'push.json',
    file: 'push.json',
    open: (dir, guard) => openPushStore(dir, { guard }),
    seed: (s) => s.put(pushSub()),
    write: (s) => s.put(pushSub()),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    name: 'age.json',
    file: 'age.json',
    open: (dir, guard) => openAgeStore(dir, { guard }),
    seed: (s) => s.record({ member: hex32(), band: '18+', method: 'didit' }),
    write: (s) => s.record({ member: hex32(), band: '18+', method: 'didit' }),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    name: 'phone.json',
    file: 'phone.json',
    open: (dir, guard) => openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), guard }),
    seed: (s) => s.record({ member: hex32(), phone: '+5511987654321' }, PHONE_CBS),
    write: (s) => s.record({ member: hex32(), phone: '+5521998765432' }, PHONE_CBS),
    refused: (p) => rejectsWith(p, 'indisponivel')
  },
  {
    // put() is synchronous; async turns its throw into a rejection.
    name: 'page-keys.json',
    file: 'page-keys.json',
    open: (dir, guard) => openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: 'ab'.repeat(32) }, guard }),
    seed: async (s) => { const p = s.pending('s'.repeat(43)); s.put(p.key, p.row) },
    write: async (s) => { const p = s.pending('w'.repeat(43)); s.put(p.key, p.row) },
    refused: (p) => rejectsWith(p, 'indisponivel'),
    after: (t, s, name) => t.is(s.get(s.pending('w'.repeat(43)).key), null, name + ': the refused row is not in the table')
  },
  {
    name: 'pages.json',
    file: 'pages.json',
    open: (dir, guard) => openPagesStore(dir, { guard }),
    seed: (s) => s.create({ page: hex32(), owner: hex32() }),
    write: (s) => s.create({ page: hex32(), owner: hex32() }),
    refused: (p) => rejectsWith(p, 'indisponivel')
  }
]

test('every guarded store: a refusal right before the rename leaves the file untouched', async (t) => {
  for (const def of STORES) {
    const root = tmpDir(t)
    const dir = path.join(root, 'account')
    fs.mkdirSync(dir, { mode: 0o700 })
    const file = path.join(dir, def.file)
    let armed = false
    const tempNext = () => fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp'))
    const store = def.open(dir, () => !armed || !tempNext())
    await def.seed(store)
    const before = fs.readFileSync(file)
    armed = true
    t.ok(await def.refused(def.write(store)), def.name + ': the request gets the usual refusal')
    t.ok(b4a.equals(fs.readFileSync(file), before), def.name + ': the file is byte-identical')
    t.absent(tempNext(), def.name + ': no temp file is left')
    if (def.after) await def.after(t, store, def.name)
    else t.ok(store.available(), def.name + ': the store is not failed')
  }
})

test('age-check.json: a refusal right before the rename leaves the file untouched and answers ok: false', async (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'age-check.json')
  t.alike(settleAgeCheck(dir, { on: false }), { ok: true, on: false, enabledAt: null })
  const before = fs.readFileSync(file)
  const guard = () => !fs.readdirSync(dir).some((n) => n.endsWith('.tmp'))
  t.alike(settleAgeCheck(dir, { on: true, now: () => WEEK0, guard }), { ok: false }, 'the usual refusal')
  t.ok(b4a.equals(fs.readFileSync(file), before), 'the file is byte-identical')
  t.alike(fs.readdirSync(dir), ['age-check.json'], 'no temp file is left')
})
