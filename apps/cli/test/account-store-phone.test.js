'use strict'

// apps/cli/lib/account/store.js: links made by a verified phone (sub
// 'telefone:<member>', no e-mail) and nameHolder(). No network: keys and
// certificates are made locally and the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createIssuedCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { openAccountStore, PHONE_SUB_PREFIX, phoneSub, isPhoneSub, JOURNAL_PREFIX, COOLDOWN_MS } = require('../lib/account/store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-11T12:00:00.000Z')
const SIG = 'a'.repeat(128)

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { kp, cert, association: cert.association }
}

function memberKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { t: T0 }
  c.now = () => c.t
  const iss = issuer()
  const open = () => openAccountStore(dir, { now: c.now })
  return { dir, c, iss, store: open(), open }
}

function phoneFinish (s, iss, id) {
  return s.finish(id, { signature: SIG, phone: true }, iss.kp, iss.cert, iss.association)
}

async function googleLink (s, iss, member, username, sub = 'sub-' + member.slice(0, 8)) {
  const row = s.start({ member, username })
  s.reserve(row.id)
  s.putGoogle(row.id, { sub, email: 'm@example.test' })
  return s.finish(row.id, { signature: SIG }, iss.kp, iss.cert, iss.association)
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function journalLines (dir) {
  let n = 0
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(JOURNAL_PREFIX)) continue
    n += fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).length
  }
  return n
}

test('phoneSub and isPhoneSub', (t) => {
  const m = memberKey()
  t.is(PHONE_SUB_PREFIX, 'telefone:')
  t.is(phoneSub(m), 'telefone:' + m)
  t.ok(isPhoneSub(phoneSub(m)), 'a phone label')
  t.absent(isPhoneSub('sub-123'), 'a Google subject')
  t.absent(isPhoneSub('telefone:' + m.toUpperCase()), 'uppercase key')
  t.absent(isPhoneSub(null), 'not a string')
  t.exception.all(() => phoneSub(m.toUpperCase()), TypeError, 'uppercase key refused')
  t.exception.all(() => phoneSub('abc'), TypeError, 'short key refused')
  t.exception.all(() => phoneSub(null), TypeError, 'non-string refused')
})

test('a phone finish links with the phone label and no e-mail, and reopens', async (t) => {
  const { dir, iss, store, open } = setup(t)
  const m = memberKey()
  const row = store.start({ member: m, username: 'ana_tel' })
  const res = await phoneFinish(store, iss, row.id)
  t.ok(res.cert && res.usernameRecord, 'certificate and record issued')
  t.alike(store.contact(m), { email: '', sub: 'telefone:' + m, username: 'ana_tel' }, 'linked member contact')
  t.ok(isPhoneSub(store.contact(m).sub), 'contact sub is a phone label')
  t.is(store.memberForSub(phoneSub(m)), m, 'bySub holds the label')
  t.is(store.status(m).linked, true, 'status linked')
  await store.close()

  const again = open()
  t.alike(again.contact(m), { email: '', sub: 'telefone:' + m, username: 'ana_tel' }, 'reopened past indexes()')
  t.is(again.lookup('ana_tel').member, m, 'name held')
  await again.close()

  const ro = openAccountStore(dir, { readOnly: true })
  t.is(ro.contact(m).sub, phoneSub(m), 'read-only open accepts it')
  await ro.close()
})

test('a second phone finish for the same member answers the link without an e-mail op', async (t) => {
  const { dir, iss, store } = setup(t)
  const m = memberKey()
  const first = store.start({ member: m, username: 'bia_tel' })
  const second = store.start({ member: m, username: 'bia_tel' })
  const a = await phoneFinish(store, iss, first.id)
  const lines = journalLines(dir)
  const b = await phoneFinish(store, iss, second.id)
  t.alike(b, a, 'same link answered')
  t.is(journalLines(dir), lines, 'nothing committed')
  t.is(store.contact(m).email, '', 'e-mail unchanged')
  await rejects(t, phoneFinish(store, iss, second.id), 'expirado', 'the row is gone')
  await store.close()
})

test('the phone label held by another member is refused conta-vinculada', async (t) => {
  const { iss, store } = setup(t)
  const a = memberKey()
  const b = memberKey()
  const row = store.start({ member: a, username: 'caio_tel' })
  await googleLink(store, iss, b, 'davi_tel', phoneSub(a))
  await rejects(t, phoneFinish(store, iss, row.id), 'conta-vinculada', 'label taken')
  t.is(store.contact(a), null, 'nothing linked')
  await store.close()
})

test('phone mode takes only a reserve row without sub', async (t) => {
  const { iss, store } = setup(t)
  const m = memberKey()

  const reserved = store.start({ member: m, username: 'eva_tel' })
  store.reserve(reserved.id)
  await rejects(t, phoneFinish(store, iss, reserved.id), 'expirado', "phase 'finish' without sub")

  const google = store.start({ member: m, username: 'eva_tel' })
  store.putGoogle(google.id, { sub: 'sub-eva', email: 'eva@example.test' })
  await rejects(t, phoneFinish(store, iss, google.id), 'expirado', 'a row with a Google sub')

  const bare = store.start({ member: m, username: 'eva_tel' })
  await rejects(t, store.finish(bare.id, { signature: SIG }, iss.kp, iss.cert, iss.association), 'expirado', 'Google mode still needs a sub')
  await rejects(t, phoneFinish(store, iss, 'nope'), 'expirado', 'unknown row')

  t.is(store.contact(m), null, 'nothing linked')
  await phoneFinish(store, iss, bare.id)
  t.is(store.contact(m).sub, phoneSub(m), 'the reserve row still links')
  await store.close()
})

test('phone mode keeps the other finish checks', async (t) => {
  const { iss, store } = setup(t)
  const holder = memberKey()
  const m = memberKey()
  const row = store.start({ member: m, username: 'gil_tel' })
  await googleLink(store, iss, holder, 'gil_tel')
  await rejects(t, phoneFinish(store, iss, row.id), 'nome-em-uso', 'name taken meanwhile')
  t.is(store.contact(m), null, 'nothing linked')
  await store.close()
})

test('nameHolder: current member, past name, page, deleted member', async (t) => {
  const { c, iss, store, open } = setup(t)
  const ana = memberKey()
  const bia = memberKey()
  const page = memberKey()

  await googleLink(store, iss, ana, 'ana')
  const row = store.start({ member: bia, username: 'bia' })
  await phoneFinish(store, iss, row.id)
  const date = new Date(c.t).toISOString()
  await store.reservePage({
    key: page,
    username: 'padaria',
    cert: createIssuedCert({ member: page, date }, iss.kp, iss.cert),
    usernameRecord: createUsernameRecord({ member: page, username: 'padaria', date }, iss.kp, iss.cert)
  })

  t.alike(store.nameHolder('ana'), { username: 'ana', key: ana, kind: 'membro', current: true, deletedAt: null }, 'current member')
  t.alike(store.nameHolder('padaria'), { username: 'padaria', key: page, kind: 'pagina', current: true, deletedAt: null }, 'page')

  c.t += COOLDOWN_MS
  await store.rename(ana, 'ana_nova', iss.kp, iss.cert)
  t.alike(store.nameHolder('ana'), { username: 'ana', key: ana, kind: 'membro', current: false, deletedAt: null }, 'past name of a member')
  t.is(store.lookup('ana'), null, 'lookup() answers current holders only')

  const del = await store.deleteMember(bia)
  t.alike(store.nameHolder('bia'), { username: 'bia', key: bia, kind: 'excluido', current: false, deletedAt: del.at }, 'released name with deletedAt')
  t.ok(typeof del.at === 'string', 'deletion date')

  t.is(store.nameHolder('ninguem'), null, 'never issued')
  t.is(store.nameHolder(null), null, 'not a string')
  t.is(store.nameHolder('__proto__'), null, 'prototype key')
  await store.close()

  const again = open()
  t.is(again.nameHolder('bia').kind, 'excluido', 'survives a reopen')
  await again.close()
})
