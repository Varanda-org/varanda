'use strict'

// apps/cli/lib/commands/account.js and signup invites: the
// VARANDA_INVITES_PER_WEEK switch, the lost-lock path and `account status`.
// Keys are generated here; nothing reaches the network.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { openInvitesStore } = require('../lib/account/invites-store')
const { openInviteDrops } = require('../lib/account/invite-drops')
const { readEnv, loseLock } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { tmpDir } = require('./helpers/net')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const ENV = {
  VARANDA_PUBLIC_ORIGIN: 'https://varanda.test',
  VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste'
}

const cleanEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) cleanEnv[k] = v

function varanda (dir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], { env: cleanEnv, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function association () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  return createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc).association
}

test('readEnv: VARANDA_INVITES_PER_WEEK from 1 to 100, unset or blank is open signup', (t) => {
  t.absent('invitesPerWeek' in readEnv(ENV).limits, 'unset: open signup')
  t.absent('invitesPerWeek' in readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: '' }).limits, 'empty: open signup')
  t.absent('invitesPerWeek' in readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: '  ' }).limits, 'blank: open signup')
  t.is(readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: '3' }).limits.invitesPerWeek, 3)
  t.is(readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: '1' }).limits.invitesPerWeek, 1)
  t.is(readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: '100' }).limits.invitesPerWeek, 100)

  for (const value of ['0', '101', '03', 'zz', '-1', '1e2']) {
    try {
      readEnv({ ...ENV, VARANDA_INVITES_PER_WEEK: value })
      t.fail(value + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, value + ': usage error')
      t.is(err.message, 'VARANDA_INVITES_PER_WEEK inválido', value + ': the value is not in the message')
    }
  }
})

test('readEnv: VARANDA_INVITE_DROPS is off unless 1, and needs VARANDA_INVITES_PER_WEEK', (t) => {
  const on = { ...ENV, VARANDA_INVITES_PER_WEEK: '2' }
  t.absent('inviteDrops' in readEnv(on).limits, 'unset: off')
  t.absent('inviteDrops' in readEnv({ ...on, VARANDA_INVITE_DROPS: '' }).limits, 'empty: off')
  t.is(readEnv({ ...on, VARANDA_INVITE_DROPS: '1' }).limits.inviteDrops, 1, '1: on')

  for (const value of ['2', '0', 'sim', '01']) {
    try {
      readEnv({ ...on, VARANDA_INVITE_DROPS: value })
      t.fail(value + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, value + ': usage error')
      t.is(err.message, 'VARANDA_INVITE_DROPS inválido', value + ': the value is not in the message')
    }
  }

  for (const perWeek of [undefined, '']) {
    const env = { ...ENV, VARANDA_INVITE_DROPS: '1' }
    if (perWeek !== undefined) env.VARANDA_INVITES_PER_WEEK = perWeek
    try {
      readEnv(env)
      t.fail('on without VARANDA_INVITES_PER_WEEK accepted')
    } catch (err) {
      t.ok(err instanceof UsageError)
      t.is(err.message, 'VARANDA_INVITE_DROPS exige VARANDA_INVITES_PER_WEEK')
    }
  }
})

test('loseLock: the invite drops fail and their loop stops, trailing arguments stay optional', async (t) => {
  const calls = []
  const drops = { fail: () => calls.push('drops') }
  const loop = { stop: async () => { calls.push('loop') } }
  loseLock({ fail: () => calls.push('store') }, (event) => calls.push(event.event), () => calls.push('stop'), null, { fail: () => calls.push('invites') }, null, null, null, null, null, [], drops, loop)
  t.alike(calls, ['store', 'invites', 'drops', 'loop', 'lock', 'stop'])

  const dir = tmpDir(t)
  const real = openInviteDrops(dir, { perWeek: 2 })
  t.ok(real.available())
  loseLock(null, () => {}, () => {}, null, null, null, null, null, null, null, [], real)
  t.absent(real.available(), 'a real drops sidecar is unavailable afterwards')
})

test('loseLock: the invites sidecar fails synchronously before the log and the stop', (t) => {
  const fake = (name, calls) => ({ fail: () => calls.push(name) })

  const all = []
  loseLock(fake('store', all), (event) => all.push(event.event + ':' + event.reason), () => all.push('stop'), fake('terms', all), fake('invites', all))
  t.alike(all, ['store', 'terms', 'invites', 'lock:perdido', 'stop'])

  const three = []
  loseLock(fake('store', three), (event) => three.push(event.event), () => three.push('stop'))
  t.alike(three, ['store', 'lock', 'stop'], 'the 3-argument form still works')

  const four = []
  loseLock(fake('store', four), (event) => four.push(event.event), () => four.push('stop'), fake('terms', four))
  t.alike(four, ['store', 'terms', 'lock', 'stop'], 'the 4-argument form still works')

  const none = []
  loseLock(null, (event) => none.push(event.event), () => none.push('stop'), null, null)
  t.alike(none, ['lock', 'stop'], 'nothing opened yet: only stops')

  const dir = tmpDir(t)
  const invites = openInvitesStore(dir, { perWeek: 3 })
  loseLock(null, () => {}, () => {}, null, invites)
  t.is(invites.available(), false, 'a real sidecar is unavailable afterwards')
})

test('account status: invite counts, never a code', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const key = varanda(dir, ['account', 'key', '--association', association()])
  t.is(key.code, 0, key.stderr)

  const empty = varanda(dir, ['account', 'status'])
  t.is(empty.code, 0, empty.stderr)
  t.ok(empty.stdout.split('\n').includes('convites: 0 (0 usados)'), 'a missing file is no invite yet')
  t.absent(fs.existsSync(path.join(dir, 'invites.json')), 'status creates no invites.json')
  t.alike(JSON.parse(varanda(dir, ['account', 'status', '--json']).stdout.trim().split('\n').pop()).invites, { total: 0, used: 0 })

  const store = openInvitesStore(dir, { perWeek: 3 })
  const inviter = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const issued = await store.issue(inviter)
  await store.issue(inviter)
  t.ok(fs.existsSync(path.join(dir, 'invites.json')))

  for (const args of [['account', 'status'], ['account', 'status', '--json']]) {
    const r = varanda(dir, args)
    t.is(r.code, 0, r.stderr)
    const out = r.stdout + r.stderr
    t.absent(out.includes(issued.code), args.join(' ') + ': no code')
    t.absent(out.includes(inviter), args.join(' ') + ': no inviter key')
  }
  t.ok(varanda(dir, ['account', 'status']).stdout.split('\n').includes('convites: 2 (0 usados)'))

  fs.writeFileSync(path.join(dir, 'invites.json'), '{"v":1,"invites":[{"slot":"x"}]}')
  const bad = varanda(dir, ['account', 'status'])
  t.is(bad.code, 0, bad.stderr)
  t.ok(bad.stdout.split('\n').includes('convites: indisponível (invites.json inválido)'))
  t.is(JSON.parse(varanda(dir, ['account', 'status', '--json']).stdout.trim().split('\n').pop()).invites, 'indisponivel')
})
