// Feira entry for people who are not members yet (docs/protocol.md section 15;
// apps/cli/lib/account/feira-routes.js): GET /account/feira/policy answers
// exactly { enabled }, POST /account/feira/start { author, seq } answers
// { code }, a signup invite code that then goes through the normal signup
// invite flow. Pure ES module: no React, no globals, no Node built-ins; the
// caller does the requests. Every answer is untrusted and rebuilt here.

import { INVITE_CODE_RE } from './account.js'

export const CODE_RE = INVITE_CODE_RE
export const POLICY_PATH = '/account/feira/policy'
export const START_PATH = '/account/feira/start'

const HEX64 = /^[0-9a-f]{64}$/
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/

function isPlain (o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (o, keys) {
  if (!isPlain(o)) return false
  const got = Object.keys(o).sort()
  return got.length === keys.length && got.every((k, i) => k === keys[i])
}

// '' keeps the path relative (same origin); anything else must be an https
// origin with no path (or the loopback one of the local tests).
function withOrigin (origin, path) {
  if (origin === '' || origin === undefined || origin === null) return path
  if (typeof origin !== 'string' || !(HTTPS_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin))) return null
  return origin + path
}

export const policyUrl = (origin = '') => withOrigin(origin, POLICY_PATH)
export const startUrl = (origin = '') => withOrigin(origin, START_PATH)

// -> { enabled } or null: exactly one key, a boolean.
export function parsePolicy (body) {
  if (!hasExactKeys(body, ['enabled']) || typeof body.enabled !== 'boolean') return null
  return { enabled: body.enabled }
}

// -> the exact POST body, or null. The author is lowercased, then checked.
export function startBody ({ author, seq } = {}) {
  if (typeof author !== 'string') return null
  const a = author.toLowerCase()
  if (!HEX64.test(a) || !Number.isSafeInteger(seq) || seq < 1) return null
  return { author: a, seq }
}

// -> the invite code, or null: exactly { code } matching CODE_RE.
export function parseStart (body) {
  if (!hasExactKeys(body, ['code']) || typeof body.code !== 'string' || !CODE_RE.test(body.code)) return null
  return body.code
}
