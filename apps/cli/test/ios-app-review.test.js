const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { tmpDir } = require('./helpers/net')

// scripts/ios-app-review.js against a fake App Store Connect API: no network,
// a key made on the spot. The request shapes asserted here are the ones of
// the App Store Connect API documentation the script cites.
const repoRoot = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(repoRoot, 'scripts/ios-app-review.js')
const asc = require(SCRIPT)

const APP = '6831662804'
const FILES = ['apps/app/app.json', 'apps/app/store.config.json', 'apps/app/ios/Varanda/Info.plist', 'apps/app/ios/Varanda.xcodeproj/project.pbxproj', 'apps/app/eas.json']

function keyPair () {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
}

function creds () {
  return { keyId: 'KEY123', issuerId: 'issuer-uuid', privateKey: keyPair().privateKey }
}

// A copy of the five files the script reads, set to one version.
function project (t, version, { notes = 'Novidades.', plist = version, store = version } = {}) {
  const root = tmpDir(t)
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, f), path.join(root, f))
  }
  const app = JSON.parse(fs.readFileSync(path.join(root, FILES[0]), 'utf8'))
  app.expo.version = version
  fs.writeFileSync(path.join(root, FILES[0]), JSON.stringify(app))
  const sc = JSON.parse(fs.readFileSync(path.join(root, FILES[1]), 'utf8'))
  sc.apple.version = store
  if (notes === null) delete sc.apple.info['pt-BR'].releaseNotes
  else sc.apple.info['pt-BR'].releaseNotes = notes
  fs.writeFileSync(path.join(root, FILES[1]), JSON.stringify(sc))
  const p = path.join(root, FILES[2])
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*/, '$1' + plist))
  const x = path.join(root, FILES[3])
  fs.writeFileSync(x, fs.readFileSync(x, 'utf8').replace(/MARKETING_VERSION = [^;]+;/g, 'MARKETING_VERSION = ' + version + ';'))
  return root
}

// Fake API: routes(method, pathWithQuery, body) -> [status, json]. Records
// every call with its decoded path and query.
function fakeApi (routes) {
  const calls = []
  async function fetch (url, opts) {
    const u = new URL(url)
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const call = { method: opts.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: opts.headers.authorization }
    calls.push(call)
    const [status, json] = routes(call)
    return { ok: status >= 200 && status < 300, status, text: async () => (json ? JSON.stringify(json) : '') }
  }
  return { calls, fetch, api: asc.client({ creds: creds(), fetch }) }
}

function version (id, versionString, state) {
  return { type: 'appStoreVersions', id, attributes: { versionString, appVersionState: state, releaseType: 'MANUAL' } }
}

test('the repository: one version everywhere and the app id of eas.json', (t) => {
  const p = asc.readProject(repoRoot)
  t.absent(p.error, p.error || 'no error')
  t.ok(/^\d+\.\d+\.\d+$/.test(p.version), 'version ' + p.version)
  t.is(p.appId, APP, 'ascAppId from eas.json')
  t.ok('pt-BR' in p.notes, 'release notes keyed by the locales of store.config.json')
})

test('readProject: a version that differs in one file is refused', (t) => {
  t.is(asc.readProject(project(t, '0.2.0')).version, '0.2.0', 'same version in every file')
  const plist = asc.readProject(project(t, '0.2.0', { plist: '0.1.0' }))
  t.ok(/Info\.plist CFBundleShortVersionString = 0\.1\.0/.test(plist.error), 'Info.plist named: ' + plist.error)
  const store = asc.readProject(project(t, '0.2.0', { store: '0.1.0' }))
  t.ok(/store\.config\.json apple\.version = 0\.1\.0/.test(store.error), 'store.config.json named')
  t.ok(/versão inválida/.test(asc.readProject(project(t, 'v1')).error), 'not a version number')
  t.alike(asc.missingNotes({ 'pt-BR': '' }), ['pt-BR'], 'empty notes')
  t.alike(asc.missingNotes({ 'pt-BR': 'x' }), [], 'notes present')
  t.is(asc.missingNotes({}).length, 1, 'no locale at all')
})

test('token: ES256 JWT with the claims Apple asks for', (t) => {
  const { privateKey, publicKey } = keyPair()
  const now = 1_800_000_000_000
  const jwt = asc.token({ keyId: 'KEY123', issuerId: 'issuer-uuid', privateKey, now })
  const [h, p, s] = jwt.split('.')
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString())
  t.alike(dec(h), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' }, 'header')
  t.alike(dec(p), { iss: 'issuer-uuid', iat: 1_800_000_000, exp: 1_800_000_600, aud: 'appstoreconnect-v1' }, 'payload: exp within the 20 minutes Apple allows')
  t.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'signature verifies')
  t.ok(!/[=+/]/.test(jwt), 'base64url without padding')
})

test('credentials: all three or none, and an escaped newline in the key', (t) => {
  const pem = keyPair().privateKey.export({ type: 'pkcs8', format: 'pem' })
  t.is(asc.credentials({ ASC_API_KEY_ID: 'K', ASC_API_ISSUER_ID: 'I' }), null, 'no key')
  t.is(asc.credentials({ ASC_API_KEY_ID: '', ASC_API_ISSUER_ID: 'I', ASC_API_KEY_P8: pem }), null, 'no key id')
  t.ok(asc.credentials({ ASC_API_KEY_ID: 'K', ASC_API_ISSUER_ID: 'I', ASC_API_KEY_P8: pem }).privateKey, 'PEM with newlines')
  t.ok(asc.credentials({ ASC_API_KEY_ID: 'K', ASC_API_ISSUER_ID: 'I', ASC_API_KEY_P8: pem.replace(/\n/g, '\\n') }).privateKey, 'PEM with \\n')
})

test('decide: only a version string nobody submitted yet goes to review', (t) => {
  t.alike(asc.decide('0.2.0', null, null), { release: true, version: null }, 'no version: create it')
  for (const s of ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'READY_FOR_REVIEW']) {
    t.is(asc.decide('0.2.0', version('v', '0.2.0', s), null).release, true, s + ': reuse it')
  }
  for (const s of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION', 'REJECTED', 'METADATA_REJECTED', 'ACCEPTED']) {
    const d = asc.decide('0.2.0', version('v', '0.2.0', s), null)
    t.is(d.release, false, s + ': TestFlight only')
    t.ok(d.reason.includes(s), 'reason names the state')
  }
  const renamed = asc.decide('0.3.0', null, version('e', '0.2.1', 'PREPARE_FOR_SUBMISSION'))
  t.alike(renamed.version, { id: 'e', versionString: '0.2.1', state: 'PREPARE_FOR_SUBMISSION' }, 'another editable version is reused')
  const legacy = { id: 'v', attributes: { versionString: '0.2.0', appStoreState: 'READY_FOR_SALE' } }
  t.is(asc.decide('0.2.0', legacy, null).release, false, 'appStoreState when appVersionState is absent')
})

test('plan: asks for the version string first, then for an editable version', async (t) => {
  const { calls, api } = fakeApi((c) => {
    if (c.query['filter[versionString]']) return [200, { data: [] }]
    return [200, { data: [version('e', '0.2.1', 'PREPARE_FOR_SUBMISSION')] }]
  })
  const d = await asc.plan(api, APP, '0.3.0')
  t.is(d.version.id, 'e', 'editable version found')
  t.is(calls.length, 2, 'two GETs')
  t.is(calls[0].path, '/v1/apps/' + APP + '/appStoreVersions', 'app versions endpoint')
  t.is(calls[0].query['filter[platform]'], 'IOS', 'iOS only')
  t.is(calls[0].query['filter[versionString]'], '0.3.0', 'by version string')
  t.is(calls[1].query['filter[appVersionState]'], 'PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,READY_FOR_REVIEW', 'editable states')
  t.ok(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(calls[0].auth), 'bearer JWT')
  t.ok(calls.every((c) => c.method === 'GET'), 'plan only reads')
})

test('waitForBuild: polls until VALID, tolerates a busy API, stops on a refusal or the deadline', async (t) => {
  let clock = 0
  const sleep = async (ms) => { clock += ms }
  const now = () => clock
  const states = [[503, null], [200, { data: [] }], [200, { data: [{ id: 'b1', attributes: { processingState: 'PROCESSING' } }] }], [200, { data: [{ id: 'b1', attributes: { processingState: 'VALID' } }] }]]
  const ok = fakeApi(() => states.shift())
  t.is(await asc.waitForBuild(ok.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', sleep, now }), 'b1', 'build id once VALID')
  t.is(ok.calls.length, 4, 'four polls')
  const q = ok.calls[0].query
  t.is(ok.calls[0].path, '/v1/builds', 'builds endpoint')
  t.alike([q['filter[app]'], q['filter[version]'], q['filter[preReleaseVersion.version]'], q['filter[preReleaseVersion.platform]']], [APP, '41', '0.2.0', 'IOS'], 'by app, build number, version and platform')

  const failed = fakeApi(() => [200, { data: [{ id: 'b', attributes: { processingState: 'INVALID' } }] }])
  await t.exception(asc.waitForBuild(failed.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', sleep, now }), /INVALID/, 'INVALID stops')
  const denied = fakeApi(() => [401, { errors: [{ code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.' }] }])
  await t.exception(asc.waitForBuild(denied.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', sleep, now }), /401 \(NOT_AUTHORIZED/, '401 stops at once')
  clock = 0
  const never = fakeApi(() => [200, { data: [] }])
  await t.exception(asc.waitForBuild(never.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', sleep, now, waitMs: 60_000, pollMs: 30_000 }), /a tempo/, 'deadline')
  t.is(never.calls.length, 3, 'polled until the deadline')
})

// The full App Store Connect side of a release, from a processed build.
function releaseRoutes ({ own = null, editable = null, draft = null, draftItems = [], locales = [{ id: 'l1', attributes: { locale: 'pt-BR', whatsNew: null } }] } = {}) {
  return (c) => {
    const k = c.method + ' ' + c.path
    if (k === 'GET /v1/builds') return [200, { data: [{ id: 'build-1', attributes: { processingState: 'VALID', version: '41' } }] }]
    if (k === 'GET /v1/apps/' + APP + '/appStoreVersions') {
      if (c.query['filter[versionString]']) return [200, { data: own ? [own] : [] }]
      return [200, { data: editable ? [editable] : [] }]
    }
    if (k === 'POST /v1/appStoreVersions') return [201, { data: { type: 'appStoreVersions', id: 'new-v' } }]
    if (c.method === 'PATCH' && c.path.startsWith('/v1/appStoreVersions/')) return [200, { data: { id: c.path.split('/').pop() } }]
    if (c.method === 'GET' && c.path.endsWith('/appStoreVersionLocalizations')) return [200, { data: locales }]
    if (c.method === 'PATCH' && c.path.startsWith('/v1/appStoreVersionLocalizations/')) return [200, { data: {} }]
    if (k === 'GET /v1/reviewSubmissions') return [200, { data: draft ? [draft] : [] }]
    if (c.method === 'GET' && /^\/v1\/reviewSubmissions\/[^/]+\/items$/.test(c.path)) return [200, { data: draftItems }]
    if (k === 'POST /v1/reviewSubmissions') return [201, { data: { type: 'reviewSubmissions', id: 'rs-1' } }]
    if (k === 'POST /v1/reviewSubmissionItems') return [201, { data: { id: 'item-1' } }]
    if (c.method === 'PATCH' && c.path.startsWith('/v1/reviewSubmissions/')) return [200, { data: {} }]
    return [404, { errors: [{ code: 'NOT_FOUND', detail: k }] }]
  }
}

const sleep = async () => {}

test('submit: a new version string is created with the build, notes and AFTER_APPROVAL, then submitted', async (t) => {
  const { calls, api } = fakeApi(releaseRoutes())
  const r = await asc.submit(api, { appId: APP, versionString: '0.2.0', buildNumber: '41', notes: { 'pt-BR': 'Novidades.' }, sleep })
  t.alike(r, { submitted: true, versionId: 'new-v', buildId: 'build-1', submissionId: 'rs-1' }, 'result')
  const writes = calls.filter((c) => c.method !== 'GET').map((c) => [c.method + ' ' + c.path, c.body])
  t.alike(writes, [
    ['POST /v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: '0.2.0', releaseType: 'AFTER_APPROVAL' }, relationships: { app: { data: { type: 'apps', id: APP } }, build: { data: { type: 'builds', id: 'build-1' } } } } }],
    ['PATCH /v1/appStoreVersionLocalizations/l1', { data: { type: 'appStoreVersionLocalizations', id: 'l1', attributes: { whatsNew: 'Novidades.' } } }],
    ['POST /v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP } } } } }],
    ['POST /v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: 'rs-1' } }, appStoreVersion: { data: { type: 'appStoreVersions', id: 'new-v' } } } } }],
    ['PATCH /v1/reviewSubmissions/rs-1', { data: { type: 'reviewSubmissions', id: 'rs-1', attributes: { submitted: true } } }]
  ], 'the writes, in order')
  const drafts = calls.find((c) => c.method === 'GET' && c.path === '/v1/reviewSubmissions')
  t.alike([drafts.query['filter[app]'], drafts.query['filter[platform]'], drafts.query['filter[state]']], [APP, 'IOS', 'READY_FOR_REVIEW'], 'looks for a draft submission first')
})

test('submit: reuses an editable version (renamed) and a draft that already holds it', async (t) => {
  const { calls, api } = fakeApi(releaseRoutes({
    editable: version('e', '0.2.1', 'PREPARE_FOR_SUBMISSION'),
    draft: { type: 'reviewSubmissions', id: 'rs-old', attributes: { state: 'READY_FOR_REVIEW' } },
    draftItems: [{ id: 'i', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'e' } } } }],
    locales: [{ id: 'l1', attributes: { locale: 'pt-BR', whatsNew: 'Novidades.' } }]
  }))
  const r = await asc.submit(api, { appId: APP, versionString: '0.3.0', buildNumber: '41', notes: { 'pt-BR': 'Novidades.' }, sleep })
  t.is(r.versionId, 'e', 'editable version reused')
  t.is(r.submissionId, 'rs-old', 'draft reused')
  const writes = calls.filter((c) => c.method !== 'GET').map((c) => [c.method + ' ' + c.path, c.body])
  t.alike(writes, [
    ['PATCH /v1/appStoreVersions/e', { data: { type: 'appStoreVersions', id: 'e', attributes: { releaseType: 'AFTER_APPROVAL', versionString: '0.3.0' }, relationships: { build: { data: { type: 'builds', id: 'build-1' } } } } }],
    ['PATCH /v1/reviewSubmissions/rs-old', { data: { type: 'reviewSubmissions', id: 'rs-old', attributes: { submitted: true } } }]
  ], 'no rewrite of equal notes and no second item')
  const items = calls.find((c) => c.path === '/v1/reviewSubmissions/rs-old/items')
  t.is(items.query.include, 'appStoreVersion', 'items read with their version')
})

test('submit: same string, editable, keeps its versionString; a version sent meanwhile is left alone', async (t) => {
  const same = fakeApi(releaseRoutes({ own: version('v', '0.2.0', 'DEVELOPER_REJECTED') }))
  await asc.submit(same.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', notes: { 'pt-BR': 'x' }, sleep })
  const patch = same.calls.find((c) => c.method === 'PATCH' && c.path === '/v1/appStoreVersions/v')
  t.alike(patch.body.data.attributes, { releaseType: 'AFTER_APPROVAL' }, 'no versionString when it already matches')

  const sent = fakeApi(releaseRoutes({ own: version('v', '0.2.0', 'WAITING_FOR_REVIEW') }))
  const r = await asc.submit(sent.api, { appId: APP, versionString: '0.2.0', buildNumber: '41', notes: { 'pt-BR': 'x' }, sleep })
  t.is(r.submitted, false, 'not submitted')
  t.ok(sent.calls.every((c) => c.method === 'GET'), 'no write')
})

test('submit: a locale missing in App Store Connect stops before the review submission', async (t) => {
  const { calls, api } = fakeApi(releaseRoutes({ locales: [{ id: 'l2', attributes: { locale: 'en-US' } }] }))
  await t.exception(asc.submit(api, { appId: APP, versionString: '0.2.0', buildNumber: '41', notes: { 'pt-BR': 'x' }, sleep }), /pt-BR/)
  t.absent(calls.some((c) => c.path.startsWith('/v1/reviewSubmission')), 'nothing submitted')
})

test('submit: an API error is reported once, never repeated', async (t) => {
  let posts = 0
  const routes = releaseRoutes()
  const { api } = fakeApi((c) => {
    if (c.method === 'POST' && c.path === '/v1/appStoreVersions') { posts++; return [409, { errors: [{ code: 'ENTITY_ERROR', detail: 'conflict' }] }] }
    return routes(c)
  })
  await t.exception(asc.submit(api, { appId: APP, versionString: '0.2.0', buildNumber: '41', notes: { 'pt-BR': 'x' }, sleep }), /409 \(ENTITY_ERROR: conflict\)/)
  t.is(posts, 1, 'one POST')
})

test('readEasBuild: the build number of the finished iOS build', (t) => {
  const out = (b) => JSON.stringify([{ platform: 'IOS', status: 'FINISHED', appVersion: '0.2.0', appBuildVersion: '41', ...b }])
  t.alike(asc.readEasBuild(out({}), '0.2.0'), { buildNumber: '41' }, 'build number')
  t.ok(/ERRORED/.test(asc.readEasBuild(out({ status: 'ERRORED' }), '0.2.0').error), 'unfinished build')
  t.ok(/0\.1\.0/.test(asc.readEasBuild(out({ appVersion: '0.1.0' }), '0.2.0').error), 'another version')
  t.ok(asc.readEasBuild(out({ appBuildVersion: null }), '0.2.0').error, 'no build number')
  t.ok(asc.readEasBuild('not json', '0.2.0').error, 'not JSON')
  t.ok(asc.readEasBuild('[]', '0.2.0').error, 'no iOS build')
})

test('main plan: without the key the build goes to TestFlight only', async (t) => {
  const root = project(t, '0.2.0')
  const out = path.join(root, 'out')
  const log = []
  const code = await asc.main(['plan'], { env: { GITHUB_OUTPUT: out }, root, log: (l) => log.push(l), fetch: () => { throw new Error('no call') } })
  t.is(code, 0, 'exit 0')
  t.is(fs.readFileSync(out, 'utf8'), 'version=0.2.0\nrelease=false\n', 'outputs')
  t.ok(/^::warning::/.test(log[0]), 'warning')
})

function envWithKey (out) {
  return { GITHUB_OUTPUT: out, ASC_API_KEY_ID: 'K', ASC_API_ISSUER_ID: 'I', ASC_API_KEY_P8: keyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

test('main plan: release decided by App Store Connect; release notes required', async (t) => {
  const root = project(t, '0.2.0')
  const out = path.join(root, 'out')
  const { fetch } = fakeApi(releaseRoutes())
  t.is(await asc.main(['plan'], { env: envWithKey(out), root, log: () => {}, fetch }), 0, 'exit 0')
  t.is(fs.readFileSync(out, 'utf8'), 'version=0.2.0\nrelease=true\n', 'goes to review')

  const released = project(t, '0.1.0')
  const out2 = path.join(released, 'out')
  const done = fakeApi(releaseRoutes({ own: version('v', '0.1.0', 'READY_FOR_DISTRIBUTION') }))
  t.is(await asc.main(['plan'], { env: envWithKey(out2), root: released, log: () => {}, fetch: done.fetch }), 0, 'exit 0')
  t.is(fs.readFileSync(out2, 'utf8'), 'version=0.1.0\nrelease=false\n', 'already released: TestFlight only')

  const noNotes = project(t, '0.2.0', { notes: null })
  const log = []
  const again = fakeApi(releaseRoutes())
  t.is(await asc.main(['plan'], { env: envWithKey(path.join(noNotes, 'out')), root: noNotes, log: (l) => log.push(l), fetch: again.fetch }), 1, 'exit 1 before the build')
  t.ok(/releaseNotes/.test(log.join('\n')), 'names releaseNotes')

  const mismatch = project(t, '0.2.0', { plist: '0.1.0' })
  t.is(await asc.main(['plan'], { env: {}, root: mismatch, log: () => {} }), 1, 'a version mismatch fails even without the key')
})

test('main submit: reads the eas output and submits', async (t) => {
  const root = project(t, '0.2.0')
  const file = path.join(root, 'eas.json.out')
  fs.writeFileSync(file, JSON.stringify([{ platform: 'IOS', status: 'FINISHED', appVersion: '0.2.0', appBuildVersion: '41' }]))
  const { calls, fetch } = fakeApi(releaseRoutes())
  const log = []
  t.is(await asc.main(['submit', file], { env: envWithKey(path.join(root, 'out')), root, log: (l) => log.push(l), fetch, sleep }), 0, 'exit 0')
  t.ok(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/reviewSubmissions/rs-1'), 'submitted')
  t.ok(/^::notice::versão 0\.2\.0 \(build 41\)/.test(log[log.length - 1]), 'notice')
  t.is(await asc.main(['submit', file], { env: {}, root, log: () => {} }), 1, 'no key: exit 1')
})
