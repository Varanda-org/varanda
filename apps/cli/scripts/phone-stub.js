'use strict'

// Stand-in for the SMS client (lib/account/phone-client.js) where the hosted
// lab and the tests must not reach a provider. Same { send, check } answers,
// and no socket: any Brazilian mobile is accepted, and the only code that
// verifies is STUB_CODE (the same sandbox code the Didit fake uses). A wrong
// but well-formed code answers the shape Failed maps to, so the phone routes
// refuse it as codigo-invalido instead of treating the check as lost.

const { isBrMobile } = require('@varanda/core/lib/phone')

const STUB_CODE = '123456'
const CODE_RE = /^[0-9]{6}$/

function badInput () {
  return { ok: false, reason: 'entrada', fields: [] }
}

function createPhoneStub () {
  async function send ({ phone } = {}) {
    if (!isBrMobile(phone)) return badInput()
    return { ok: true, status: 'enviado' }
  }

  async function check ({ phone, code } = {}) {
    if (!isBrMobile(phone) || typeof code !== 'string' || !CODE_RE.test(code)) return badInput()
    const outcome = code === STUB_CODE ? 'aprovado' : 'codigo-invalido'
    return { ok: true, outcome, unknownType: false }
  }

  return { send, check }
}

module.exports = { createPhoneStub, STUB_CODE }
