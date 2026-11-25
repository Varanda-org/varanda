// Sends a new iOS version to App Review through the App Store Connect API,
// for .github/workflows/ios-release.yml. Only Node built-ins: it runs in the
// job that holds the App Store Connect key, before and after the EAS build.
//
//   node scripts/ios-app-review.js plan
//     Checks that the version is the same in app.json, store.config.json,
//     Info.plist and project.pbxproj, then asks App Store Connect whether that
//     version string still has to go to review. Writes version=<x> and
//     release=true|false to $GITHUB_OUTPUT. Without the key it warns and
//     writes release=false: the build still goes to TestFlight.
//   node scripts/ios-app-review.js submit <eas-build.json>
//     Reads the build number from the output of `eas build --json`, waits
//     until App Store Connect has processed that build, creates or reuses the
//     App Store version, attaches the build, sets "release automatically after
//     approval", writes the release notes and submits it for review.
//
// "Still has to go to review" means App Store Connect has no version with
// that string, or has one nobody submitted yet (EDITABLE). A merge that does
// not raise the version finds its version already submitted or released and
// stays on TestFlight. A version Apple rejected stays with a person.
//
// Request shapes follow the App Store Connect API documentation (checked
// 2026-11-25): POST /v1/appStoreVersions, PATCH /v1/appStoreVersions/{id},
// PATCH /v1/appStoreVersionLocalizations/{id}, POST /v1/reviewSubmissions,
// POST /v1/reviewSubmissionItems, PATCH /v1/reviewSubmissions/{id}
// (submitted: true), and the JWT of "Generating tokens for API requests".
// apps/cli/test/ios-app-review.test.js runs it against a fake API.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const API = 'https://api.appstoreconnect.apple.com'
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'READY_FOR_REVIEW'])
const BUILD_POLL_MS = 30 * 1000
const BUILD_WAIT_MS = 60 * 60 * 1000

const FILES = {
  appJson: 'apps/app/app.json',
  storeConfig: 'apps/app/store.config.json',
  infoPlist: 'apps/app/ios/Varanda/Info.plist',
  pbxproj: 'apps/app/ios/Varanda.xcodeproj/project.pbxproj',
  easJson: 'apps/app/eas.json'
}

// -> { version, appId, notes } or { error }
function readProject (root) {
  const read = (f) => fs.readFileSync(path.join(root, FILES[f]), 'utf8')
  const app = JSON.parse(read('appJson'))
  const store = JSON.parse(read('storeConfig'))
  const plist = read('infoPlist').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/)
  const marketing = [...read('pbxproj').matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim())
  const found = {
    [FILES.appJson + ' expo.version']: app.expo && app.expo.version,
    [FILES.storeConfig + ' apple.version']: store.apple && store.apple.version,
    [FILES.infoPlist + ' CFBundleShortVersionString']: plist && plist[1]
  }
  for (const m of new Set(marketing)) found[FILES.pbxproj + ' MARKETING_VERSION ' + m] = m
  if (marketing.length === 0) found[FILES.pbxproj + ' MARKETING_VERSION'] = undefined
  const values = new Set(Object.values(found))
  if (values.size !== 1) {
    return { error: 'a versão do app difere entre os arquivos: ' + Object.entries(found).map(([k, v]) => k + ' = ' + v).join(', ') }
  }
  const version = [...values][0]
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,2}$/.test(version)) {
    return { error: 'versão inválida: ' + version }
  }
  const eas = JSON.parse(read('easJson'))
  const appId = eas.submit && eas.submit.production && eas.submit.production.ios && eas.submit.production.ios.ascAppId
  if (!/^\d+$/.test(appId || '')) return { error: FILES.easJson + ' sem submit.production.ios.ascAppId' }
  const notes = {}
  for (const [locale, info] of Object.entries((store.apple && store.apple.info) || {})) {
    notes[locale] = typeof info.releaseNotes === 'string' ? info.releaseNotes.trim() : ''
  }
  return { version, appId, notes }
}

function missingNotes (notes) {
  const locales = Object.keys(notes)
  if (locales.length === 0) return ['(nenhum idioma em apple.info)']
  return locales.filter((l) => notes[l] === '')
}

function b64url (buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

// ES256 JWT for the App Store Connect API; Apple refuses an exp more than 20
// minutes after iat, so each request gets a fresh 10-minute token.
function token ({ keyId, issuerId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000)
  const input = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 600, aud: 'appstoreconnect-v1' }))
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return input + '.' + b64url(sig)
}

function credentials (env) {
  const keyId = (env.ASC_API_KEY_ID || '').trim()
  const issuerId = (env.ASC_API_ISSUER_ID || '').trim()
  const pem = (env.ASC_API_KEY_P8 || '').replace(/\\n/g, '\n').trim()
  if (!keyId || !issuerId || !pem) return null
  return { keyId, issuerId, privateKey: crypto.createPrivateKey(pem) }
}

class ApiError extends Error {
  constructor (method, url, status, body) {
    const details = ((body && body.errors) || []).map((e) => [e.code, e.title, e.detail].filter(Boolean).join(': ')).join('; ')
    super(method + ' ' + url + ' -> ' + status + (details ? ' (' + details + ')' : ''))
    this.status = status
  }
}

// One call per request, never repeated here: a POST or PATCH that failed is
// reported, and the person decides (App Store Connect or Run workflow).
function client ({ creds, fetch = globalThis.fetch, now = Date.now }) {
  return async function api (method, url, body) {
    const res = await fetch(API + url, {
      method,
      headers: {
        authorization: 'Bearer ' + token({ ...creds, now: now() }),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) throw new ApiError(method, url, res.status, json)
    return json
  }
}

function query (params) {
  return '?' + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
}

function stateOf (v) {
  return v.attributes.appVersionState || v.attributes.appStoreState
}

async function versions (api, appId, filter) {
  const res = await api('GET', '/v1/apps/' + appId + '/appStoreVersions' + query({
    'filter[platform]': 'IOS',
    ...filter,
    'fields[appStoreVersions]': 'versionString,appVersionState,appStoreState,releaseType',
    limit: 10
  }))
  return res.data
}

// -> { release: true, version: null | { id, versionString, state } }
//  | { release: false, reason }
function decide (versionString, own, editable) {
  if (own) {
    const state = stateOf(own)
    if (EDITABLE.has(state)) return { release: true, version: { id: own.id, versionString, state } }
    return { release: false, reason: 'a versão ' + versionString + ' já está no App Store Connect em ' + state }
  }
  if (editable) return { release: true, version: { id: editable.id, versionString: editable.attributes.versionString, state: stateOf(editable) } }
  return { release: true, version: null }
}

async function plan (api, appId, versionString) {
  const [own] = await versions(api, appId, { 'filter[versionString]': versionString })
  const [editable] = own ? [] : await versions(api, appId, { 'filter[appVersionState]': [...EDITABLE].join(',') })
  return decide(versionString, own, editable)
}

// -> the build id once App Store Connect processed it.
async function waitForBuild (api, { appId, versionString, buildNumber, sleep, now = Date.now, waitMs = BUILD_WAIT_MS, pollMs = BUILD_POLL_MS, log = () => {} }) {
  const deadline = now() + waitMs
  const url = '/v1/builds' + query({
    'filter[app]': appId,
    'filter[version]': buildNumber,
    'filter[preReleaseVersion.version]': versionString,
    'filter[preReleaseVersion.platform]': 'IOS',
    'fields[builds]': 'version,processingState',
    limit: 2
  })
  for (;;) {
    let build = null
    try {
      build = (await api('GET', url)).data[0] || null
    } catch (err) {
      // A GET while polling: a busy or unreachable API only costs a poll.
      if (err.status && err.status !== 429 && err.status < 500) throw err
      log('consulta do build falhou, tentando de novo: ' + err.message)
    }
    const state = build && build.attributes.processingState
    if (state === 'VALID') return build.id
    if (state === 'FAILED' || state === 'INVALID') throw new Error('o App Store Connect recusou o build ' + buildNumber + ' (' + state + ')')
    if (now() >= deadline) throw new Error('o build ' + buildNumber + ' da versão ' + versionString + ' não ficou pronto no App Store Connect a tempo')
    log('build ' + buildNumber + ': ' + (state || 'ainda não apareceu') + ', esperando')
    await sleep(pollMs)
  }
}

async function attach (api, { appId, versionString, buildId, decision }) {
  const build = { data: { type: 'builds', id: buildId } }
  if (!decision.version) {
    const res = await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: appId } }, build }
      }
    })
    return res.data.id
  }
  const attributes = { releaseType: 'AFTER_APPROVAL' }
  if (decision.version.versionString !== versionString) attributes.versionString = versionString
  await api('PATCH', '/v1/appStoreVersions/' + decision.version.id, {
    data: { type: 'appStoreVersions', id: decision.version.id, attributes, relationships: { build } }
  })
  return decision.version.id
}

async function writeNotes (api, versionId, notes) {
  const res = await api('GET', '/v1/appStoreVersions/' + versionId + '/appStoreVersionLocalizations' + query({
    'fields[appStoreVersionLocalizations]': 'locale,whatsNew',
    limit: 50
  }))
  const byLocale = new Map(res.data.map((l) => [l.attributes.locale, l]))
  const missing = Object.keys(notes).filter((l) => !byLocale.has(l))
  if (missing.length) throw new Error('a versão no App Store Connect não tem o idioma ' + missing.join(', ') + ' (rode eas metadata:push)')
  for (const [locale, whatsNew] of Object.entries(notes)) {
    const loc = byLocale.get(locale)
    if (loc.attributes.whatsNew === whatsNew) continue
    await api('PATCH', '/v1/appStoreVersionLocalizations/' + loc.id, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew } }
    })
  }
}

// Reuses a review submission still being prepared (READY_FOR_REVIEW): App
// Store Connect keeps one per platform.
async function submitForReview (api, { appId, versionId }) {
  const drafts = await api('GET', '/v1/reviewSubmissions' + query({
    'filter[app]': appId,
    'filter[platform]': 'IOS',
    'filter[state]': 'READY_FOR_REVIEW',
    limit: 10
  }))
  let id
  let hasItem = false
  if (drafts.data.length) {
    id = drafts.data[0].id
    const items = await api('GET', '/v1/reviewSubmissions/' + id + '/items' + query({ include: 'appStoreVersion', limit: 50 }))
    hasItem = items.data.some((i) => i.relationships && i.relationships.appStoreVersion && i.relationships.appStoreVersion.data && i.relationships.appStoreVersion.data.id === versionId)
  } else {
    const res = await api('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: appId } } } }
    })
    id = res.data.id
  }
  if (!hasItem) {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } }
        }
      }
    })
  }
  await api('PATCH', '/v1/reviewSubmissions/' + id, {
    data: { type: 'reviewSubmissions', id, attributes: { submitted: true } }
  })
  return id
}

// -> { buildNumber } or { error }, from the stdout of `eas build --json`.
function readEasBuild (text, versionString) {
  let builds
  try { builds = JSON.parse(text) } catch { return { error: 'a saída do eas build não é JSON' } }
  const build = Array.isArray(builds) && builds.find((b) => b && b.platform === 'IOS')
  if (!build) return { error: 'a saída do eas build não tem um build iOS' }
  if (build.status !== 'FINISHED') return { error: 'o build da EAS terminou em ' + build.status }
  if (build.appVersion !== versionString) return { error: 'o build da EAS tem a versão ' + build.appVersion + ', e o projeto ' + versionString }
  if (!/^\d+$/.test(String(build.appBuildVersion || ''))) return { error: 'o build da EAS não tem número de build' }
  return { buildNumber: String(build.appBuildVersion) }
}

async function submit (api, { appId, versionString, buildNumber, notes, sleep, now, log = () => {}, waitMs, pollMs }) {
  const buildId = await waitForBuild(api, { appId, versionString, buildNumber, sleep, now, waitMs, pollMs, log })
  // The build took a while: someone may have sent the version by hand.
  const decision = await plan(api, appId, versionString)
  if (!decision.release) return { submitted: false, reason: decision.reason }
  const versionId = await attach(api, { appId, versionString, buildId, decision })
  await writeNotes(api, versionId, notes)
  const submissionId = await submitForReview(api, { appId, versionId })
  return { submitted: true, versionId, buildId, submissionId }
}

function output (env, pairs) {
  const lines = Object.entries(pairs).map(([k, v]) => k + '=' + v).join('\n') + '\n'
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines)
  else process.stdout.write(lines)
}

async function main (argv, { env = process.env, root = path.resolve(__dirname, '..'), fetch, sleep, now, log = console.log } = {}) {
  const [cmd, file] = argv
  const project = readProject(root)
  if (project.error) { log('::error::' + project.error); return 1 }
  const { version, appId, notes } = project
  const creds = credentials(env)
  if (cmd === 'plan') {
    if (!creds) {
      log('::warning::ASC_API_KEY_ID, ASC_API_ISSUER_ID ou ASC_API_KEY_P8 ausente no ambiente app-store: o build vai só para o TestFlight (veja docs/development.md, seção Envio para a App Store (EAS))')
      output(env, { version, release: 'false' })
      return 0
    }
    const decision = await plan(client({ creds, fetch }), appId, version)
    if (decision.release) {
      const missing = missingNotes(notes)
      if (missing.length) {
        log('::error::a versão ' + version + ' vai para a revisão, mas falta apple.info.<idioma>.releaseNotes em ' + FILES.storeConfig + ': ' + missing.join(', '))
        return 1
      }
      log('::notice::a versão ' + version + ' vai para a revisão da App Store depois do build')
    } else {
      log('::notice::' + decision.reason + ': o build vai só para o TestFlight')
    }
    output(env, { version, release: String(decision.release) })
    return 0
  }
  if (cmd === 'submit') {
    if (!creds) { log('::error::chave do App Store Connect ausente'); return 1 }
    const eas = readEasBuild(fs.readFileSync(file, 'utf8'), version)
    if (eas.error) { log('::error::' + eas.error); return 1 }
    const result = await submit(client({ creds, fetch }), {
      appId,
      versionString: version,
      buildNumber: eas.buildNumber,
      notes,
      sleep: sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now,
      log
    })
    if (!result.submitted) log('::notice::' + result.reason + ': nada a enviar')
    else log('::notice::versão ' + version + ' (build ' + eas.buildNumber + ') enviada para a revisão da App Store, com lançamento automático depois da aprovação')
    return 0
  }
  log('uso: node scripts/ios-app-review.js plan | submit <eas-build.json>')
  return 2
}

module.exports = { readProject, missingNotes, token, credentials, client, decide, plan, waitForBuild, attach, writeNotes, submitForReview, readEasBuild, submit, main, EDITABLE }

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.log('::error::' + err.message)
    process.exitCode = 1
  })
}
