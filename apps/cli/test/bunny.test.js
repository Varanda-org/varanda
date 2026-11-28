const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { tmpDir } = require('./helpers/net')

// scripts/bunny.js against a fake Bunny on 127.0.0.1: no network, no real
// account, a key and a secret made on the spot. The shapes the fake serves
// are those of Bunny's OpenAPI spec v3 that the script cites.
const SCRIPT = path.resolve(__dirname, '../../../scripts/bunny.js')
const bunny = require(SCRIPT)

const HOST = 'media.example.org'
const ORIGIN = 'https://example.org'
const NAME = 'varanda-media'

function hex (n) {
  return crypto.randomBytes(n).toString('hex')
}

// Bunny-like defaults for a new zone, most of them unlike what apply sets.
function newZone (id, name, origin = '') {
  return {
    Id: id,
    Name: name,
    OriginUrl: origin,
    OriginType: 0,
    Type: 0,
    EnableGeoZoneSA: true,
    EnableGeoZoneUS: true,
    EnableGeoZoneEU: true,
    EnableGeoZoneASIA: true,
    EnableGeoZoneAF: true,
    VerifyOriginSSL: false,
    AddHostHeader: false,
    UseStaleWhileOffline: true,
    UseStaleWhileUpdating: true,
    CacheErrorResponses: false,
    IgnoreQueryStrings: false,
    BlockPostRequests: false,
    BlockRootPathAccess: false,
    EnableAccessControlOriginHeader: true,
    EnableLogging: false,
    LoggingIPAnonymizationEnabled: true,
    LogAnonymizationType: 0,
    LoggingSaveToStorage: false,
    ZoneSecurityKey: 'zsk-' + hex(16),
    Hostnames: [{ Id: id * 10, Value: name + '.b-cdn.net', ForceSSL: false, IsSystemHostname: true, HasCertificate: true }],
    EdgeRules: []
  }
}

// The fake Bunny. Holds zones in memory, records every request, answers 401
// to a wrong AccessKey. state.inject = { method, path, status, json } answers
// the next matching request with that error; state.ignore names settings a
// POST /pullzone/{id} silently drops, so a read-back can disagree.
async function fakeBunny (t, key) {
  const state = { zones: [], requests: [], nextId: 100, inject: null, ignore: new Set() }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1')
      let body = null
      if (raw) {
        try { body = JSON.parse(raw) } catch { body = raw }
      }
      state.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), url: req.url, accessKey: req.headers.accesskey, body })
      const send = (status, json) => {
        if (json === undefined) {
          res.writeHead(status)
          res.end()
        } else {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(json))
        }
      }
      if (req.headers.accesskey !== key) return send(401, { ErrorKey: 'unauthorized', Field: null, Message: 'Authorization has been denied for this request.' })
      const inj = state.inject
      if (inj && inj.method === req.method && inj.path.test(u.pathname)) {
        state.inject = null
        return send(inj.status, inj.json)
      }
      const byId = (id) => state.zones.find((z) => z.Id === Number(id))
      let m
      if (req.method === 'GET' && u.pathname === '/pullzone') {
        const s = u.searchParams.get('search') || ''
        return send(200, state.zones.filter((z) => z.Name.includes(s)))
      }
      if (req.method === 'POST' && u.pathname === '/pullzone') {
        if (!body || typeof body.OriginUrl !== 'string' || body.OriginUrl === '') {
          return send(400, { ErrorKey: 'pullzone.origin_url_required', Field: 'OriginUrl', Message: 'The Origin URL is required when creating a pull zone with origin type OriginUrl.' })
        }
        state.zones.push(newZone(state.nextId++, body.Name, body.OriginUrl))
        return send(201)
      }
      if (req.method === 'GET' && u.pathname === '/pullzone/loadFreeCertificate') {
        for (const z of state.zones) {
          for (const h of z.Hostnames) if (h.Value === u.searchParams.get('hostname')) h.HasCertificate = true
        }
        return send(200, {})
      }
      if ((m = /^\/pullzone\/(\d+)$/.exec(u.pathname))) {
        const z = byId(m[1])
        if (!z) return send(404, { ErrorKey: 'pullzone.not_found', Field: 'Id', Message: 'Not found' })
        if (req.method === 'GET') return send(200, z)
        for (const [k, v] of Object.entries(body)) if (!state.ignore.has(k)) z[k] = v
        return send(200, z)
      }
      if (req.method === 'POST' && (m = /^\/pullzone\/(\d+)\/addHostname$/.exec(u.pathname))) {
        const z = byId(m[1])
        z.Hostnames.push({ Id: z.Id * 10 + z.Hostnames.length, Value: body.Hostname, ForceSSL: false, IsSystemHostname: false, HasCertificate: false })
        return send(204)
      }
      if (req.method === 'POST' && (m = /^\/pullzone\/(\d+)\/edgerules\/addOrUpdate$/.exec(u.pathname))) {
        const z = byId(m[1])
        const rule = { ...body, Guid: body.Guid || crypto.randomUUID() }
        const i = z.EdgeRules.findIndex((r) => r.Guid === rule.Guid)
        if (i === -1) z.EdgeRules.push(rule)
        else z.EdgeRules[i] = rule
        return send(201)
      }
      if (req.method === 'POST' && (m = /^\/pullzone\/(\d+)\/setForceSSL$/.exec(u.pathname))) {
        const z = byId(m[1])
        for (const h of z.Hostnames) if (h.Value === body.Hostname) h.ForceSSL = body.ForceSSL
        return send(204)
      }
      if (req.method === 'POST' && u.pathname === '/purge') return send(200)
      if (req.method === 'POST' && /^\/pullzone\/(\d+)\/purgeCache$/.test(u.pathname)) return send(204)
      return send(404, { ErrorKey: 'not_found', Field: null, Message: 'No route' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  state.base = 'http://127.0.0.1:' + server.address().port
  state.writes = () => state.requests.filter((r) => r.method !== 'GET')
  return state
}

// A fake Bunny, a key, a secret in an env file, and a runner for the CLI as
// a child process (async: the fake lives in this process's event loop).
async function setup (t) {
  const key = 'k-' + hex(18)
  const secret = hex(32)
  const fake = await fakeBunny(t, key)
  const dir = tmpDir(t)
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, 'VARANDA_DOMAIN=example.org\nVARANDA_CDN_SECRET=' + secret + '\n')
  const secrets = [key, secret]
  function run (args, { env = {}, keyEnv = key } = {}) {
    return new Promise((resolve) => {
      const childEnv = { PATH: process.env.PATH, VARANDA_BUNNY_API: fake.base, ...env }
      if (keyEnv !== null) childEnv.BUNNY_API_KEY = keyEnv
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('close', (code) => {
        const res = { code, stdout, stderr, all: stdout + stderr }
        for (const s of secrets) t.absent(res.all.includes(s), 'no secret or key in the output')
        for (const r of fake.requests) {
          t.ok(!r.url.includes(key), 'key never in a URL')
          if (r.accessKey !== key && keyEnv === key) t.fail('AccessKey header is the key on every request')
        }
        resolve(res)
      })
    })
  }
  const full = ['--origin', ORIGIN, '--hostname', HOST, '--env-file', envFile]
  return { key, secret, fake, envFile, dir, secrets, run, full }
}

function zoneWithRules (fake, rules) {
  const z = newZone(fake.nextId++, NAME)
  z.EdgeRules = rules
  fake.zones.push(z)
  return z
}

test('bunny: plan on an empty account writes nothing and lists every change', async (t) => {
  const { fake, run, full } = await setup(t)
  const res = await run(['plan', ...full])
  t.is(res.code, 0, res.stderr)
  t.is(fake.writes().length, 0, 'no write')
  t.ok(res.stdout.includes('não existe; apply cria'))
  t.ok(res.stdout.includes('OriginUrl: (vazio) -> ' + ORIGIN))
  t.ok(res.stdout.includes('Hostname ' + HOST + ': adicionar'))
  t.ok(res.stdout.includes(bunny.RULE_SECRET + ': criar; segredo: muda'))
  t.ok(res.stdout.includes(bunny.RULE_MEDIA + ': criar'))
  t.ok(res.stdout.includes(bunny.RULE_CACHE + ': criar'))
})

test('bunny: apply sets up the zone, verifies it, and a second apply writes nothing', async (t) => {
  const { secret, fake, run, full } = await setup(t)
  const res = await run(['apply', ...full])
  t.is(res.code, 0, res.stderr)
  t.ok(res.stdout.includes('tudo conferido'))
  const writes = fake.writes()
  t.alike(writes.map((r) => r.path), [
    '/pullzone',
    '/pullzone/100/edgerules/addOrUpdate',
    '/pullzone/100/edgerules/addOrUpdate',
    '/pullzone/100/edgerules/addOrUpdate',
    '/pullzone/100',
    '/pullzone/100/addHostname'
  ], 'the rules go in before the origin is set')
  t.alike(writes[0].body, { Name: NAME, OriginUrl: bunny.CREATE_ORIGIN }, 'create sends the name and an origin that never resolves')
  t.ok(new URL(bunny.CREATE_ORIGIN).hostname.endsWith('.invalid'), 'the create origin is under .invalid')
  t.is(writes[1].body.Description, bunny.RULE_MEDIA, 'the block rule is the first write after the create')
  t.alike(writes[4].body, bunny.desiredSettings(ORIGIN), 'only the settings we set')
  t.alike(writes[5].body, { Hostname: HOST })
  const byDescription = new Map(writes.slice(1, 4).map((r) => [r.body.Description, r.body]))
  const [a, b, c] = [bunny.RULE_SECRET, bunny.RULE_MEDIA, bunny.RULE_CACHE].map((d) => byDescription.get(d))
  t.is(a.Guid, undefined, 'a new rule has no Guid')
  t.is(a.ActionType, 6)
  t.is(a.ActionParameter1, 'X-Varanda-Edge')
  t.is(a.ActionParameter2, secret)
  t.alike(a.Triggers, [{ Type: 0, PatternMatches: ['*'], PatternMatchingType: 0, Parameter1: null }])
  t.is(b.ActionType, 4)
  t.alike(b.Triggers[0].PatternMatches, ['https://' + HOST + '/media/*'])
  t.is(b.Triggers[0].PatternMatchingType, 2, 'block everything that is not /media/')
  t.is(c.ActionType, 3)
  t.is(c.ActionParameter1, '60')
  t.is(c.Triggers[0].PatternMatchingType, 0)
  for (const r of [a, b, c]) {
    t.is(r.TriggerMatchingType, 0)
    t.is(r.Enabled, true)
  }

  const before = fake.requests.length
  const again = await run(['apply', ...full])
  t.is(again.code, 0, again.stderr)
  t.ok(again.stdout.includes('nenhuma escrita'))
  t.is(fake.requests.slice(before).filter((r) => r.method !== 'GET').length, 0, 'second apply: zero writes')

  const plan = await run(['plan', ...full])
  t.is(plan.code, 0)
  t.ok(plan.stdout.includes('Nada a mudar.'))
  t.ok(plan.stdout.includes('segredo: igual'))

  const status = await run(['status', '--hostname', HOST, '--origin', ORIGIN])
  t.is(status.code, 0, status.stderr)
  t.ok(status.stdout.includes(bunny.RULE_MEDIA + ': ok'))
  t.ok(status.stdout.includes(bunny.RULE_CACHE + ': ok'))
  t.ok(status.stdout.includes('segredo não conferido'))
  t.absent(status.stdout.includes('padrão não conferido'), 'patterns compared with --hostname')
  t.absent(status.all.includes(fake.zones[0].ZoneSecurityKey), 'status never prints the zone security key')

  const bare = await run(['status'])
  t.is(bare.code, 0, bare.stderr)
  t.ok(bare.stdout.includes(bunny.RULE_MEDIA + ': ok; padrão não conferido (sem --hostname)'))
  t.ok(bare.stdout.includes(bunny.RULE_CACHE + ': ok; padrão não conferido (sem --hostname)'))
})

test('bunny: an existing zone whose rules change is purged once, after the writes', async (t) => {
  const { fake, run, full } = await setup(t)
  const z = zoneWithRules(fake, [])
  Object.assign(z, bunny.desiredSettings(ORIGIN))
  z.Hostnames.push({ Id: 1, Value: HOST, ForceSSL: true, IsSystemHostname: false, HasCertificate: true })

  const plan = await run(['plan', ...full])
  t.is(plan.code, 0, plan.stderr)
  t.ok(plan.stdout.includes('limpa a zona inteira'))
  t.ok(plan.stdout.includes('apply faria 4 escrita(s)'))

  fake.inject = { method: 'POST', path: /\/purgeCache$/, status: 503, json: { ErrorKey: 'busy', Message: 'later' } }
  const res = await run(['apply', ...full])
  t.is(res.code, 1)
  t.ok(res.stderr.includes('rode apply --purge'), 'a failed purge says how to finish it')
  const writes = fake.writes()
  t.alike(writes.map((r) => r.path), [
    '/pullzone/' + z.Id + '/edgerules/addOrUpdate',
    '/pullzone/' + z.Id + '/edgerules/addOrUpdate',
    '/pullzone/' + z.Id + '/edgerules/addOrUpdate',
    '/pullzone/' + z.Id + '/purgeCache'
  ], 'the purge comes after the rules')
  t.is(writes[3].body, null, 'the purge sends no body')

  const again = await run(['apply', ...full])
  t.is(again.code, 0, again.stderr)
  t.is(fake.writes().length, 4, 'no purge without a change')

  const forced = await run(['apply', '--purge', ...full])
  t.is(forced.code, 0, forced.stderr)
  t.alike(fake.writes().slice(4).map((r) => r.path), ['/pullzone/' + z.Id + '/purgeCache'], '--purge purges and writes nothing else')
  t.ok(forced.stdout.includes('tudo conferido'))

  const misuse = await run(['plan', '--purge', ...full])
  t.is(misuse.code, 1)
  t.ok(misuse.stderr.includes('--purge só vale com apply'))

  // A stop after the cache changes but before the purge (here the hostname
  // write) also owes the purge: the next plain apply does not do it.
  z.EdgeRules = []
  z.Hostnames = z.Hostnames.filter((h) => h.Value !== HOST)
  fake.inject = { method: 'POST', path: /\/addHostname$/, status: 500, json: { ErrorKey: 'x', Message: 'y' } }
  const stop = await run(['apply', ...full])
  t.is(stop.code, 1)
  t.ok(stop.stdout.includes('se parar antes, rode apply --purge'), 'said before the first write')
  t.ok(stop.stderr.includes('rode apply --purge'), 'a stop before the purge says --purge')
  const n = fake.writes().length
  const resumed = await run(['apply', ...full])
  t.is(resumed.code, 0, resumed.stderr)
  t.alike(fake.writes().slice(n).map((r) => r.path), ['/pullzone/' + z.Id + '/addHostname'], 'the rerun only adds the hostname')
})

test('bunny: a run that stops right after the create leaves a zone that reaches nothing, and apply finishes it', async (t) => {
  const { fake, run, full } = await setup(t)
  fake.inject = { method: 'POST', path: /\/edgerules\/addOrUpdate$/, status: 500, json: { ErrorKey: 'x', Message: 'y' } }
  const stop = await run(['apply', ...full])
  t.is(stop.code, 1)
  t.ok(stop.stderr.includes('pela metade'), 'says the state may be partial')
  t.is(fake.zones.length, 1)
  const z = fake.zones[0]
  t.is(z.OriginUrl, bunny.CREATE_ORIGIN, 'only the origin that never resolves')
  t.alike(z.EdgeRules, [], 'no rule yet')

  const resumed = await run(['apply', ...full])
  t.is(resumed.code, 0, resumed.stderr)
  t.ok(resumed.stdout.includes('tudo conferido'))
  t.is(fake.zones.length, 1, 'no second zone')
  t.is(z.OriginUrl, ORIGIN, 'the real origin is set')
  t.alike(z.EdgeRules.map((r) => r.Description).sort(), [bunny.RULE_SECRET, bunny.RULE_MEDIA, bunny.RULE_CACHE].sort(), 'the three rules are in')
})

test('bunny: Perma-Cache or a script on the zone stops plan and apply before any write', async (t) => {
  const { fake, run, full } = await setup(t)
  const z = zoneWithRules(fake, [])
  z.PermaCacheStorageZoneId = 7
  z.EdgeScriptId = 0
  for (const cmd of ['plan', 'apply']) {
    const res = await run([cmd, ...full])
    t.is(res.code, 1, cmd)
    t.ok(res.stderr.includes('PermaCacheStorageZoneId'), cmd)
    t.absent(res.stderr.includes('EdgeScriptId'), 'an id of 0 is off')
  }
  t.is(fake.writes().length, 0, 'zero writes')
  const status = await run(['status'])
  t.ok(status.stdout.includes('não desliga: PermaCacheStorageZoneId'))

  t.alike(bunny.attachments({ PermaCacheStorageZoneId: -1, EdgeScriptId: null, MiddlewareScriptId: 3 }), ['MiddlewareScriptId'])
  t.alike(bunny.attachments({ EdgeScriptId: '5' }), ['EdgeScriptId'], 'an unexpected shape counts as on')
  t.alike(bunny.attachments(null), [])
})

test('bunny: a rule with an old secret is updated through its Guid (rotation)', async (t) => {
  const { secret, fake, run, full } = await setup(t)
  const old = hex(32)
  const rules = bunny.desiredRules({ secret: old, hostname: HOST }).map((d, i) => ({ ...bunny.ruleBody(d), Guid: 'guid-' + i }))
  rules.push({ Guid: 'guid-x', Description: 'someone else', ActionType: 4, Triggers: [], Enabled: true })
  const z = zoneWithRules(fake, rules)
  Object.assign(z, bunny.desiredSettings(ORIGIN))
  z.Hostnames.push({ Id: 1, Value: HOST, ForceSSL: true, IsSystemHostname: false, HasCertificate: true })

  const plan = await run(['plan', ...full])
  t.is(plan.code, 0, plan.stderr)
  t.ok(plan.stdout.includes(bunny.RULE_SECRET + ': atualizar; segredo: muda'))
  t.absent(plan.all.includes(old), 'the old secret is not printed')
  t.ok(plan.stdout.includes('Outras regras (1)'))
  t.ok(plan.stdout.includes('someone else'))
  t.ok(plan.stdout.includes('apply faria 1 escrita(s)'))

  const res = await run(['apply', ...full])
  t.is(res.code, 0, res.stderr)
  t.absent(res.all.includes(old))
  const writes = fake.writes()
  t.is(writes.length, 1)
  t.is(writes[0].path, '/pullzone/' + z.Id + '/edgerules/addOrUpdate')
  t.is(writes[0].body.Guid, 'guid-0', 'updated in place')
  t.is(writes[0].body.ActionParameter2, secret)
  t.is(z.EdgeRules.length, 4, 'no rule added, the foreign rule kept')
})

test('bunny: two rules with the same description stop the run before any write', async (t) => {
  const { fake, run, full } = await setup(t)
  const [d] = bunny.desiredRules({ secret: hex(32), hostname: HOST })
  zoneWithRules(fake, [{ ...bunny.ruleBody(d), Guid: 'g1' }, { ...bunny.ruleBody(d), Guid: 'g2' }])
  const res = await run(['apply', ...full])
  t.is(res.code, 1)
  t.ok(res.stderr.includes('mesma descrição'))
  t.is(fake.writes().length, 0, 'zero writes')
  const plan = await run(['plan', ...full])
  t.is(plan.code, 1)
})

test('bunny: a value Bunny does not keep fails the read-back, by field name', async (t) => {
  const { fake, run, full } = await setup(t)
  fake.ignore.add('EnableLogging')
  const res = await run(['apply', ...full])
  t.is(res.code, 1)
  t.ok(res.stderr.includes('Conferência falhou'))
  t.ok(res.stderr.includes('EnableLogging'))
  t.absent(res.stderr.includes('VerifyOriginSSL'), 'only the field that differs')
})

test('bunny: an error whose message carries the key and the secret prints neither', async (t) => {
  const { key, secret, fake, run, full } = await setup(t)
  fake.inject = { method: 'POST', path: /^\/pullzone\/\d+$/, status: 400, json: { ErrorKey: 'pullzone.validation', Field: 'OriginUrl', Message: 'bad ' + key + ' and ' + secret } }
  const res = await run(['apply', ...full])
  t.is(res.code, 1)
  t.ok(res.stderr.includes('400 pullzone.validation'))
  t.ok(res.stderr.includes('bad *** and ***'))
  t.ok(res.stderr.includes('pela metade'), 'says the state may be partial')
  t.is(fake.requests.filter((r) => r.path === '/pullzone' && r.method === 'POST').length, 1, 'no retry')

  // A secret that crosses the cut of a long message: masked before the cut,
  // so not even its prefix is printed.
  fake.inject = { method: 'POST', path: /^\/pullzone\/\d+$/, status: 400, json: { ErrorKey: 'k', Message: 'x'.repeat(180) + secret } }
  const cut = await run(['apply', ...full])
  t.is(cut.code, 1)
  t.absent(cut.all.includes(secret.slice(0, 16)), 'no prefix of the secret')
  t.absent(bunny.errorText(400, { Message: 'y'.repeat(190) + key }, [key]).includes(key.slice(0, 8)), 'errorText masks before it cuts')
})

test('bunny: a response cut off after a 2xx status is an error, not a success', async (t) => {
  const fetch = async () => ({ status: 200, text: () => Promise.reject(new Error('reset')) })
  const api = bunny.client({ base: 'http://127.0.0.1:1', key: 'k'.repeat(16), fetch })
  await t.exception(() => api.request('POST', '/purge', { query: { url: 'https://' + HOST + '/media/a' } }), /interrompida/)
  await t.exception(() => api.request('GET', '/pullzone/1'), /interrompida/)
})

test('bunny: a wrong key gets 401 and stops', async (t) => {
  const { fake, run, full } = await setup(t)
  const res = await run(['plan', ...full], { keyEnv: 'wrong-' + hex(8) })
  t.is(res.code, 1)
  t.ok(res.stderr.includes('401'))
  t.is(fake.writes().length, 0)
})

test('bunny: a zone list of an unexpected shape is an error, not a missing zone', async (t) => {
  const { fake, run, full } = await setup(t)
  fake.inject = { method: 'GET', path: /^\/pullzone$/, status: 200, json: { Zones: [] } }
  const res = await run(['apply', ...full])
  t.is(res.code, 1)
  t.ok(res.stderr.includes('Resposta inesperada'))
  t.is(fake.writes().length, 0, 'no zone created')
})

test('bunny: VARANDA_BUNNY_API other than http://127.0.0.1:<port> is refused before any request', async (t) => {
  const { fake, run, full } = await setup(t)
  for (const api of ['http://example.com', 'http://127.0.0.1.evil:1', 'https://127.0.0.1:1/x', 'http://127.0.0.1:1/x', 'http://localhost:1', 'http://127.0.0.1']) {
    const res = await run(['plan', ...full], { env: { VARANDA_BUNNY_API: api } })
    t.is(res.code, 1, api)
    t.ok(res.stderr.includes('VARANDA_BUNNY_API recusado'), api)
  }
  t.is(fake.requests.length, 0, 'the fake received nothing')
})

test('bunny: a secret in the wrong format is refused without printing it', async (t) => {
  const { fake, run, dir } = await setup(t)
  for (const bad of [hex(32).toUpperCase(), hex(31), '"' + hex(32) + '"', hex(32) + 'g']) {
    const envFile = path.join(dir, 'bad.env')
    fs.writeFileSync(envFile, 'VARANDA_CDN_SECRET=' + bad + '\n')
    const res = await run(['plan', '--origin', ORIGIN, '--hostname', HOST, '--env-file', envFile])
    t.is(res.code, 1)
    t.ok(res.stderr.includes('VARANDA_CDN_SECRET inválido'))
    t.absent(res.all.includes(bad.replace(/"/g, '')), 'value not printed')
  }
  t.is(fake.requests.length, 0)
})

test('bunny: no key and no terminal exits 1; the key is never an argument', async (t) => {
  const { fake, run, full, key } = await setup(t)
  const res = await run(['plan', ...full], { keyEnv: null })
  t.is(res.code, 1)
  t.ok(res.stderr.includes('BUNNY_API_KEY'))
  const arg = await run(['plan', ...full, '--api-key=' + key])
  t.is(arg.code, 1)
  t.ok(arg.stderr.includes('nunca vão como argumento'))
  t.is(fake.requests.length, 0)
})

test('bunny: purge refuses paths outside /media/ and tricks, and purges the rest one by one', async (t) => {
  const { fake, run } = await setup(t)
  for (const p of ['/seeder', '/media/../x', '/media//x', '/media/a?b', '/media/a#b', '/media/a b', '/media/%2e%2e/x', '/media\\x', '/media/a*b', 'media/a']) {
    const res = await run(['purge', '--hostname', HOST, p])
    t.is(res.code, 1, p)
    t.ok(res.stderr.includes('Caminho recusado'), p)
  }
  t.is(fake.requests.length, 0, 'nothing sent for a refused path')
  const ok = await run(['purge', '--hostname', HOST, '/media/a/b', '/media/a/*'])
  t.is(ok.code, 0, ok.stderr)
  t.alike(fake.requests.map((r) => [r.method, r.path, r.query]), [
    ['POST', '/purge', { url: 'https://' + HOST + '/media/a/b', async: 'false' }],
    ['POST', '/purge', { url: 'https://' + HOST + '/media/a/*', async: 'false' }]
  ])
})

test('bunny: cert needs the CNAME on the zone, then loads the certificate and forces SSL', async (t) => {
  const { key, fake } = await setup(t)
  const z = zoneWithRules(fake, [])
  z.Hostnames.push({ Id: 2, Value: HOST, ForceSSL: false, IsSystemHostname: false, HasCertificate: false })
  const lines = []
  const sink = { write: (s) => lines.push(s) }
  const out = bunny.output({ stdout: sink, stderr: sink })
  const api = bunny.client({ base: fake.base, key, out })
  const ctx = { name: NAME, hostname: HOST }

  for (const resolve of [
    async () => { const e = new Error('nodata'); e.code = 'ENODATA'; throw e },
    async () => [],
    async () => ['other.b-cdn.net'],
    async () => ['varanda-media.b-cdn.net.evil.com']
  ]) {
    t.is(await bunny.runCert(api, out, ctx, resolve), 1)
  }
  t.is(fake.requests.length, 0, 'no request before the CNAME matches')
  t.ok(lines.join('').includes('ainda não aponta para ' + NAME + '.b-cdn.net'))

  const cname = async () => [NAME + '.b-cdn.net']
  const rulesFor = (hostname) => bunny.desiredRules({ secret: hex(32), hostname }).map((d, i) => ({ ...bunny.ruleBody(d), Guid: 'g' + i }))
  await t.exception(() => bunny.runCert(api, out, ctx, cname), /Rode apply antes do cert/, 'no rules, no certificate')
  z.EdgeRules = rulesFor('other.example.org')
  await t.exception(() => bunny.runCert(api, out, ctx, cname), /only \/media\//, 'rules for another hostname are not enough')
  t.is(fake.writes().length, 0, 'nothing written while the rules are missing')
  t.absent(fake.requests.some((r) => r.path === '/pullzone/loadFreeCertificate'), 'no certificate asked for')
  z.EdgeRules = rulesFor(HOST)

  t.is(await bunny.runCert(api, out, ctx, async (h) => { t.is(h, HOST); return ['VARANDA-MEDIA.b-cdn.net.'] }), 0)
  const calls = fake.requests.filter((r) => r.path !== '/pullzone' && !/^\/pullzone\/\d+$/.test(r.path))
  t.alike(calls.map((r) => [r.method, r.path]), [
    ['GET', '/pullzone/loadFreeCertificate'],
    ['POST', '/pullzone/' + z.Id + '/setForceSSL']
  ])
  t.alike(calls[0].query, { hostname: HOST })
  t.alike(calls[1].body, { Hostname: HOST, ForceSSL: true })
  for (const r of fake.requests) t.is(r.accessKey, key)
  t.absent(lines.join('').includes(key))
})

test('bunny: parseEnvSecret reads the env file as deploy.sh does', (t) => {
  const s = hex(32)
  t.is(bunny.parseEnvSecret(''), '')
  t.is(bunny.parseEnvSecret('OTHER=1\n'), '')
  t.is(bunny.parseEnvSecret('VARANDA_CDN_SECRET=' + s), s)
  t.is(bunny.parseEnvSecret('VARANDA_CDN_SECRET=' + s + '\r\n'), s, 'CRLF')
  t.is(bunny.parseEnvSecret('  VARANDA_CDN_SECRET = ' + s + '  # rotated 2026\n'), s, 'spaces and a comment')
  t.is(bunny.parseEnvSecret('VARANDA_CDN_SECRET=aaa\nVARANDA_CDN_SECRET=' + s + '\n'), s, 'last line wins')
  t.is(bunny.parseEnvSecret('VARANDA_CDN_SECRET=' + s + '\nVARANDA_CDN_SECRET=\n'), '', 'a last empty line empties it')
  t.is(bunny.parseEnvSecret('VARANDA_CDN_SECRET=ab#cd\n'), 'ab#cd', 'a # without a space before it stays')
  t.is(bunny.parseEnvSecret('export VARANDA_CDN_SECRET=' + s + '\n'), '', 'export form is not read, as in deploy.sh')
  t.is(bunny.parseEnvSecret('#VARANDA_CDN_SECRET=' + s + '\n'), '', 'a commented line is not read')
})

test('bunny: the diff compares each setting and each rule field', (t) => {
  const desired = bunny.desiredSettings(ORIGIN)
  t.alike(bunny.settingsDiff({ ...desired, OriginUrl: ORIGIN + '/' }, desired), [], 'a trailing slash is the same origin')
  t.alike(bunny.settingsDiff({ ...desired, EnableLogging: false, LogAnonymizationType: 0 }, desired).map((d) => d.field), ['EnableLogging', 'LogAnonymizationType'])
  t.is(bunny.settingsDiff(null, desired).length, Object.keys(desired).length)

  const secret = hex(32)
  const [a, b, c] = bunny.desiredRules({ secret, hostname: HOST })
  const same = (d) => bunny.ruleBody(d)
  t.alike(bunny.ruleDiff(same(a), a), [])
  t.alike(bunny.ruleDiff(same(b), b), [])
  t.alike(bunny.ruleDiff(same(c), c), [])
  t.alike(bunny.ruleDiff({ ...same(a), ActionParameter2: hex(32) }, a), ['ActionParameter2'])
  t.alike(bunny.ruleDiff({ ...same(c), ActionParameter1: '3600', Enabled: false }, c), ['Enabled', 'ActionParameter1'])
  t.alike(bunny.ruleDiff({ ...same(b), Triggers: [{ ...same(b).Triggers[0], PatternMatchingType: 0 }] }, b), ['Triggers'])
  t.alike(bunny.ruleDiff({ ...same(b), Triggers: [{ ...same(b).Triggers[0], PatternMatches: ['https://other/media/*'] }] }, b), ['Triggers'])
  t.alike(bunny.ruleDiff({ ...same(b), Triggers: [...same(b).Triggers, same(a).Triggers[0]] }, b), ['Triggers'])
  t.alike(bunny.ruleDiff({ ...same(b), TriggerMatchingType: 1 }, b), ['TriggerMatchingType'])
  t.alike(bunny.ruleDiff({ ...same(c), ExtraActions: [{ ActionType: 1 }] }, c), ['ExtraActions'])
  t.alike(bunny.ruleDiff({ ...same(a), ActionParameter2: hex(32) }, bunny.desiredRules({ hostname: HOST })[0]), [], 'status without a secret skips it')

  const zone = { EdgeRules: [{ ...same(a), Guid: 'g' }, { Description: 'x' }, { Description: 'varanda: old' }], Hostnames: [{ Value: 'MEDIA.example.org' }] }
  const plan = bunny.planChanges(zone, { origin: ORIGIN, hostname: HOST, secret })
  t.is(plan.addHostname, false, 'hostnames compare case-insensitively')
  t.alike(plan.others, ['x', 'varanda: old'])
  t.alike(plan.rules.map((r) => r.action), [null, 'criar', 'criar'])
  t.is(plan.rules[0].secretChanges, false)
})

test('bunny: input checks', (t) => {
  t.is(bunny.apiBase(undefined), bunny.API)
  t.is(bunny.apiBase(''), bunny.API)
  t.is(bunny.apiBase('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  t.is(bunny.apiBase('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
  for (const v of ['http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://127.0.0.1:1/x', 'http://127.0.0.1:1?x', 'http://u@127.0.0.1:1', 'https://api.bunny.net', 'http://[::1]:1']) {
    t.is(bunny.apiBase(v), null, v)
  }
  t.is(bunny.parseOrigin('https://example.org'), 'https://example.org')
  t.is(bunny.parseOrigin('https://example.org/'), 'https://example.org')
  for (const v of ['http://example.org', 'https://example.org/x', 'https://u:p@example.org', 'https://example.org?a', 'example.org']) {
    t.is(bunny.parseOrigin(v), null, v)
  }
  t.ok(bunny.validHostname('media.example.org'))
  for (const v of ['Media.example.org', 'media', 'https://media.example.org', 'media.example.org/', 'a..b', '-a.b']) {
    t.absent(bunny.validHostname(v), v)
  }
  t.ok(bunny.validPurgePath('/media/a/b'))
  t.ok(bunny.validPurgePath('/media/a/*'))
  t.ok(bunny.cnameMatches(['varanda-media.b-cdn.net.'], 'varanda-media'))
  t.absent(bunny.cnameMatches(['xvaranda-media.b-cdn.net'], 'varanda-media'))
  t.is(bunny.redact('a SECRET b\u001b[31m', ['SECRET']), 'a *** b?[31m', 'masks and strips control characters')
  t.is(bunny.errorText(400, { ErrorKey: 'k', Message: 'x'.repeat(500) }).length < 260, true, 'message truncated')
})
