'use strict'

// Shared sign-up driver for tests that link a member by a verified Brazilian
// mobile. The Google callback is not part of this path. It only speaks to an
// account service that is already listening: loading this module binds no
// port, and `origin` has to be that service's own loopback origin (the fetch
// base and the Origin header are the same value). `sign` stays with the
// caller, so this file never sees a diary secret.
//
// No age flag. The service already refuses a send until ageVerified says the
// member has a band. Callers that turn the age check on record the band
// themselves.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { isBrMobile } = require('@varanda/core/lib/phone')
const { createPhoneStub, STUB_CODE } = require('../../scripts/phone-stub')
const { openPhoneStore } = require('../../lib/account/phone-store')
const { phoneSub } = require('../../lib/account/store')
const { CLIENT_HEADER, CLIENT_APP, LINK_HEADER, proofOf } = require('../../lib/account/app-return')
const { COOKIE, LOOPBACK_ORIGIN_RE } = require('../../lib/account/server')

const COOKIE_RE = new RegExp('^' + COOKIE + '=([A-Za-z0-9_-]+);')

const scratchDirs = new Set()
let exitArmed = false

// One Brazilian mobile per call, so two links in one store do not collide
// on telefone-em-uso. The number is never put in an error.
let phoneSeq = nodeCrypto.randomInt(0, 100000000)
function freshPhone () {
  phoneSeq = (phoneSeq + 1) % 100000000
  const phone = '+55119' + String(phoneSeq).padStart(8, '0')
  if (!isBrMobile(phone)) throw new Error('telefone de teste inválido')
  return phone
}

function scratchDir () {
  const base = process.env.VARANDA_TEST_TMPDIR || os.tmpdir()
  const dir = fs.mkdtempSync(path.join(base, 'varanda-phone-'))
  fs.chmodSync(dir, 0o700)
  scratchDirs.add(dir)
  if (!exitArmed) {
    exitArmed = true
    process.once('exit', () => {
      for (const d of scratchDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
      }
    })
  }
  return dir
}

function memberOf (member) {
  if (typeof member === 'string') return member
  if (member !== null && typeof member === 'object' && typeof member.hex === 'string') return member.hex
  throw new TypeError('member must be a hex diary key')
}

function loopbackOrigin (origin) {
  if (typeof origin !== 'string' || !LOOPBACK_ORIGIN_RE.test(origin)) {
    throw new TypeError('origin must be a loopback http origin')
  }
  return new URL(origin).origin
}

function cookieOf (res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || '']
  for (const raw of list) {
    const m = COOKIE_RE.exec(raw)
    if (m) return m[1]
  }
  return null
}

function stepError (step, res) {
  const token = res.body !== null && typeof res.body === 'object' && typeof res.body.error === 'string'
    ? res.body.error
    : 'falhou'
  const err = new Error(step + ': ' + res.status + ' ' + token)
  err.status = res.status
  err.token = token
  return err
}

async function signatureOf (sign, fields) {
  const out = await sign(fields)
  if (typeof out === 'string') return out
  if (out !== null && typeof out === 'object' && typeof out.signature === 'string') return out.signature
  throw new TypeError('sign must return a signature')
}

// { phoneClient, phones, dir, key }. `phoneClient` and `phones` are the
// createAccountServer options. The directory is removed on process exit.
function phoneServerOptions () {
  const dir = scratchDir()
  const key = nodeCrypto.randomBytes(32)
  const phones = openPhoneStore(dir, { key })
  return { phoneClient: createPhoneStub(), phones, dir, key }
}

// Drives /account/start, /account/phone/start, send, check (STUB_CODE) and
// /account/finish. `sign` is called with { action, nonce, member } for a
// phone step and { phase: 'finish', nonce, username, member, sub: phoneSub(member) }
// for the link. The finish subject is phoneSub(member) ('telefone:' plus the
// member hex): the service verifies that proof with phoneSub(row.member), and
// account.sign at phase 'finish' refuses an empty sub. The caller's `sign`
// binds the association itself. Phone steps are varanda-phone-v1 statements
// verified with the association (packages/core/lib/phone.js signPhone); the
// finish is the account-link proof. `sign` tells the two kinds apart by the
// presence of `action` (phone step) or `phase` (finish). With app true, start
// carries appProof (sha256 of a fresh V) and finish carries V in
// x-varanda-link. R is never sent. With app false the link cookie is used.
// `invite` defaults to null. A string is placed on the /account/start body so
// a service with invites on can reserve one (reserveInvite reads body.invite).
// `onResponse`, when given, is called with { path, request, status, headers,
// text, body } for every response, so a caller can run its leak checks on all of
// them. Returns the finish JSON (the link answer).
async function linkByPhone ({ origin, member, username, sign, app = false, invite = null, onResponse = null } = {}) {
  if (typeof sign !== 'function') throw new TypeError('sign must be a function')
  if (typeof username !== 'string') throw new TypeError('username must be a string')
  if (typeof app !== 'boolean') throw new TypeError('app must be a boolean')
  const base = loopbackOrigin(origin)
  const who = memberOf(member)
  const phone = freshPhone()
  let cookie = null
  let linkSecret = null

  async function post (pathname, body, extraHeaders) {
    const headers = {
      origin: base,
      'content-type': 'application/json',
      ...extraHeaders
    }
    if (app) headers[CLIENT_HEADER] = CLIENT_APP
    if (!app && cookie !== null) headers.cookie = COOKIE + '=' + cookie
    const res = await fetch(base + pathname, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    // Every response the helper sees, for callers that check leaks.
    if (onResponse !== null) onResponse({ path: pathname, request: body, status: res.status, headers: res.headers, text, body: parsed })
    return { status: res.status, headers: res.headers, body: parsed }
  }

  async function phoneStep (action, extra) {
    const started = await post('/account/phone/start', { member: who })
    if (started.status !== 200 || started.body === null || typeof started.body.nonce !== 'string') {
      throw stepError('phone/start', started)
    }
    const nonce = started.body.nonce
    const signature = await signatureOf(sign, { action, nonce, member: who })
    return post('/account/phone/' + action, { member: who, nonce, signature, ...extra })
  }

  const startBody = { member: who, username }
  if (typeof invite === 'string') startBody.invite = invite
  if (app) {
    linkSecret = nodeCrypto.randomBytes(32).toString('base64url')
    const appProof = proofOf(linkSecret)
    if (appProof === null) throw new Error('appProof ausente')
    startBody.appProof = appProof
  }
  const started = await post('/account/start', startBody)
  if (started.status !== 200 || started.body === null || typeof started.body.nonce !== 'string') {
    throw stepError('start', started)
  }
  if (!app) {
    cookie = cookieOf(started)
    if (cookie === null) throw stepError('start', started)
  }

  const sent = await phoneStep('send', { phone })
  if (sent.status !== 200 || sent.body === null || sent.body.state !== 'enviado') throw stepError('phone/send', sent)
  const checked = await phoneStep('check', { code: STUB_CODE })
  if (checked.status !== 200 || checked.body === null || checked.body.state !== 'verificado') {
    throw stepError('phone/check', checked)
  }

  const signature = await signatureOf(sign, {
    phase: 'finish',
    nonce: started.body.nonce,
    username,
    member: who,
    sub: phoneSub(who)
  })
  const finishHeaders = app ? { [LINK_HEADER]: linkSecret } : {}
  const done = await post('/account/finish', { signature }, finishHeaders)
  if (done.status !== 200 || done.body === null || typeof done.body.error === 'string') throw stepError('finish', done)
  return done.body
}

module.exports = { linkByPhone, phoneServerOptions }
