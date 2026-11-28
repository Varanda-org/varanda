// Sets up the Bunny pull zone in front of /media/* (docs/cdn.md, "Bunny")
// through Bunny's API, so the maintainer does not click steps 1 to 6 and 8
// by hand. The maintainer runs it in their own terminal, with their own key:
// never an agent, never CI (AGENTS.md: agents do not touch third-party
// accounts). Only Node built-ins.
//
//   node scripts/bunny.js plan   --origin https://<domain> --hostname media.<domain> --env-file <path>
//   node scripts/bunny.js apply  (same flags) [--purge]
//   node scripts/bunny.js cert   --hostname media.<domain>
//   node scripts/bunny.js purge  --hostname media.<domain> /media/<author>/...
//   node scripts/bunny.js status [--hostname ...] [--origin ...] [--env-file ...]
//
// plan reads the zone and prints what apply would change. apply makes those
// changes, reads the zone back and exits 1 on any value Bunny did not keep;
// a second apply writes nothing. A purge that did not happen is not seen as
// a difference, so apply --purge forces one. cert asks for the free certificate only
// once the hostname's CNAME points at <zone>.b-cdn.net and the three rules
// are in place. purge removes cached
// /media/ paths. status is read only.
//
// Secrets: the API key comes from BUNNY_API_KEY or a prompt without echo,
// never an argument, and only ever goes in the AccessKey header. The zone
// JSON carries the X-Varanda-Edge secret and the zone's security key, so a
// response or a request body is never printed: errors show the status,
// ErrorKey and a short Message, and every printed line goes through one
// function that masks the key and the secrets as a backstop. No request is
// ever repeated on its own; a failed write stops the run, and apply, being
// idempotent, can simply be run again.
//
// Request shapes follow Bunny's OpenAPI spec v3
// (core-api-public-docs.b-cdn.net/docs/v3/public.json). The spec does not say
// what ActionParameter1/2 mean for each action type: header name and value,
// and seconds, follow Bunny's examples, and the read-back plus a look at the
// dashboard confirm them. apps/cli/test/bunny.test.js runs it against a fake
// Bunny on 127.0.0.1.
'use strict'

const fs = require('node:fs')

const API = 'https://api.bunny.net'
const TIMEOUT_MS = 30 * 1000
const DEFAULT_NAME = 'varanda-media'
const EDGE_HEADER = 'X-Varanda-Edge'
const PREFIX = 'varanda: '
const RULE_SECRET = PREFIX + EDGE_HEADER
const RULE_MEDIA = PREFIX + 'only /media/'
const RULE_CACHE = PREFIX + 'cache 60 s'
const CACHE_SECONDS = '60'
const MESSAGE_MAX = 200
const SECRET_RE = /^[0-9a-f]{64}$/
const COMMANDS = new Set(['plan', 'apply', 'cert', 'purge', 'status'])

// Bunny's enums (spec v3): EdgeRule ActionType, Trigger Type, and the
// matching types shared by triggers and rules.
const ACTION_OVERRIDE_CACHE_TIME = 3
const ACTION_BLOCK_REQUEST = 4
const ACTION_SET_REQUEST_HEADER = 6
const TRIGGER_URL = 0
const MATCH_ANY = 0
const MATCH_NONE = 2

class UsageError extends Error {}

class BunnyError extends Error {
  constructor (message, { status = 0, write = false } = {}) {
    super(message)
    this.status = status
    this.write = write
  }
}

// ---------------------------------------------------------------------------
// Pure functions

// The pull zone settings apply sets, and nothing else. Stale delivery off
// (step 5): a stale copy would outlive the 60 s. Logs on with "Drop"
// anonymization and no permanent storage (step 6). Bunny's own CORS header
// off (step 7): the origin already sends it for the installation only.
// Redirects not followed (the request carries X-Varanda-Edge), no log
// forwarding, no hostname vary: off is Bunny's default, written so that a
// zone changed by hand is put back.
function desiredSettings (origin) {
  return {
    OriginUrl: origin,
    OriginType: 0,
    Type: 0,
    EnableGeoZoneSA: true,
    EnableGeoZoneUS: true,
    EnableGeoZoneEU: true,
    EnableGeoZoneASIA: false,
    EnableGeoZoneAF: false,
    VerifyOriginSSL: true,
    AddHostHeader: false,
    UseStaleWhileOffline: false,
    UseStaleWhileUpdating: false,
    CacheErrorResponses: false,
    IgnoreQueryStrings: true,
    BlockPostRequests: true,
    BlockRootPathAccess: true,
    EnableAccessControlOriginHeader: false,
    EnableLogging: true,
    LoggingIPAnonymizationEnabled: true,
    LogAnonymizationType: 1,
    LoggingSaveToStorage: false,
    FollowRedirects: false,
    LogForwardingEnabled: false,
    EnableHostnameVary: false
  }
}

// Zone features the script does not switch off, and refuses to work beside:
// Perma-Cache keeps copies in a storage zone past the 60 s and past a purge,
// and a script can change what reaches the origin or the visitor.
const ATTACHMENTS = ['PermaCacheStorageZoneId', 'EdgeScriptId', 'MiddlewareScriptId']

function attachments (zone) {
  if (!zone) return []
  return ATTACHMENTS.filter((f) => {
    const v = zone[f]
    return v !== undefined && v !== null && !(typeof v === 'number' && v <= 0)
  })
}

// Bunny may add a trailing slash or change the case of the origin's host;
// neither is a difference worth a write.
function sameSetting (field, current, desired) {
  if (field === 'OriginUrl') {
    const norm = (v) => typeof v === 'string' ? v.replace(/\/+$/, '').toLowerCase() : v
    return norm(current) === norm(desired)
  }
  return current === desired
}

// [{ field, current, desired }] for every desired setting the zone lacks.
function settingsDiff (zone, desired) {
  const out = []
  for (const field of Object.keys(desired)) {
    const current = zone ? zone[field] : undefined
    if (!sameSetting(field, current, desired[field])) out.push({ field, current, desired: desired[field] })
  }
  return out
}

// The three Edge Rules. hostname or secret may be undefined (status without
// those flags): the fields that depend on them are then not compared.
function desiredRules ({ secret, hostname }) {
  const media = hostname === undefined ? undefined : ['https://' + hostname + '/media/*']
  return [
    {
      Description: RULE_SECRET,
      ActionType: ACTION_SET_REQUEST_HEADER,
      ActionParameter1: EDGE_HEADER,
      ActionParameter2: secret,
      Triggers: [{ Type: TRIGGER_URL, PatternMatches: ['*'], PatternMatchingType: MATCH_ANY }],
      TriggerMatchingType: MATCH_ANY,
      Enabled: true
    },
    {
      Description: RULE_MEDIA,
      ActionType: ACTION_BLOCK_REQUEST,
      ActionParameter1: '',
      ActionParameter2: '',
      Triggers: [{ Type: TRIGGER_URL, PatternMatches: media, PatternMatchingType: MATCH_NONE }],
      TriggerMatchingType: MATCH_ANY,
      Enabled: true
    },
    {
      Description: RULE_CACHE,
      ActionType: ACTION_OVERRIDE_CACHE_TIME,
      ActionParameter1: CACHE_SECONDS,
      ActionParameter2: '',
      Triggers: [{ Type: TRIGGER_URL, PatternMatches: media, PatternMatchingType: MATCH_ANY }],
      TriggerMatchingType: MATCH_ANY,
      Enabled: true
    }
  ]
}

function param (v) {
  return v === null || v === undefined ? '' : String(v)
}

// Field names in which an existing rule differs from the desired one. A
// desired field left undefined is not compared. Extra actions count as a
// difference: one could undo what the rule does.
function ruleDiff (existing, desired) {
  const out = []
  for (const f of ['ActionType', 'Enabled', 'TriggerMatchingType']) {
    if (desired[f] !== undefined && existing[f] !== desired[f]) out.push(f)
  }
  for (const f of ['ActionParameter1', 'ActionParameter2']) {
    if (desired[f] !== undefined && param(existing[f]) !== param(desired[f])) out.push(f)
  }
  const want = desired.Triggers[0]
  const have = Array.isArray(existing.Triggers) ? existing.Triggers : []
  const t = have[0]
  const triggerOk = have.length === 1 && t && t.Type === want.Type &&
    t.PatternMatchingType === want.PatternMatchingType &&
    (want.PatternMatches === undefined || (Array.isArray(t.PatternMatches) &&
      t.PatternMatches.length === want.PatternMatches.length &&
      t.PatternMatches.every((p, i) => p === want.PatternMatches[i])))
  if (!triggerOk) out.push('Triggers')
  if (Array.isArray(existing.ExtraActions) && existing.ExtraActions.length > 0) out.push('ExtraActions')
  return out
}

// The EdgeRuleV2Model body for addOrUpdate. An existing rule's Guid makes it
// an update in place.
function ruleBody (desired, existing) {
  const body = {
    ActionType: desired.ActionType,
    ActionParameter1: desired.ActionParameter1 || null,
    ActionParameter2: desired.ActionParameter2 || null,
    ActionParameter3: null,
    Triggers: desired.Triggers.map((t) => ({
      Type: t.Type,
      PatternMatches: t.PatternMatches.slice(),
      PatternMatchingType: t.PatternMatchingType,
      Parameter1: null
    })),
    ExtraActions: [],
    TriggerMatchingType: desired.TriggerMatchingType,
    Description: desired.Description,
    Enabled: desired.Enabled
  }
  if (existing && existing.Guid) body.Guid = existing.Guid
  return body
}

// Splits a zone's rules into ours (by exact Description), duplicates of ours,
// and everything else (by Description only).
function sortRules (zone) {
  const ours = new Map()
  const duplicates = []
  const others = []
  const known = new Set([RULE_SECRET, RULE_MEDIA, RULE_CACHE])
  const rules = zone && Array.isArray(zone.EdgeRules) ? zone.EdgeRules : []
  for (const r of rules) {
    const d = r && typeof r.Description === 'string' ? r.Description : ''
    if (known.has(d)) {
      if (ours.has(d)) {
        if (!duplicates.includes(d)) duplicates.push(d)
      } else {
        ours.set(d, r)
      }
    } else {
      others.push(d)
    }
  }
  return { ours, duplicates, others }
}

function hasHostname (zone, hostname) {
  const list = zone && Array.isArray(zone.Hostnames) ? zone.Hostnames : []
  return list.some((h) => h && typeof h.Value === 'string' && h.Value.toLowerCase() === hostname.toLowerCase())
}

// Everything apply would write on this zone (null: the zone does not exist).
function planChanges (zone, { origin, hostname, secret }) {
  const sorted = sortRules(zone)
  const settings = settingsDiff(zone, desiredSettings(origin))
  const rules = desiredRules({ secret, hostname }).map((desired) => {
    const existing = sorted.ours.get(desired.Description) || null
    const fields = existing ? ruleDiff(existing, desired) : null
    const secretRule = desired.Description === RULE_SECRET
    return {
      desired,
      existing,
      action: existing === null ? 'criar' : fields.length > 0 ? 'atualizar' : null,
      fields: fields || [],
      secretChanges: secretRule ? (existing === null || fields.includes('ActionParameter2')) : null
    }
  })
  // A copy cached before the block or cache rule (or under another origin)
  // can carry the origin's one-year lifetime: an existing zone whose rules or
  // settings change is purged once. A new zone has no origin until its rules
  // are in, so nothing to purge.
  const cacheChanges = settings.length > 0 ||
    rules.some((r) => r.action !== null && r.desired.Description !== RULE_SECRET)
  return {
    create: zone === null,
    settings,
    addHostname: !hasHostname(zone, hostname),
    rules,
    purge: zone !== null && cacheChanges,
    duplicates: sorted.duplicates,
    others: sorted.others,
    attachments: attachments(zone)
  }
}

function writeCount (plan) {
  return (plan.create ? 1 : 0) + (plan.settings.length > 0 ? 1 : 0) + (plan.addHostname ? 1 : 0) +
    plan.rules.filter((r) => r.action !== null).length + (plan.purge ? 1 : 0)
}

// Names of every value the zone does not hold after apply.
function verifyZone (zone, ctx) {
  const p = planChanges(zone, ctx)
  const out = p.settings.map((s) => s.field)
  if (p.addHostname) out.push('Hostnames (' + ctx.hostname + ')')
  for (const d of p.duplicates) out.push('regra duplicada "' + d + '"')
  for (const f of p.attachments) out.push(f + ' ligado')
  for (const r of p.rules) {
    if (r.action === 'criar') out.push('regra "' + r.desired.Description + '" ausente')
    else if (r.action === 'atualizar') out.push('regra "' + r.desired.Description + '" (' + r.fields.join(', ') + ')')
  }
  return out
}

// The value of VARANDA_CDN_SECRET in an env file, parsed exactly as
// deploy/seeder/deploy.sh does: the last assignment line, every CR removed,
// a " #comment" removed, then trimmed. '' when there is none.
function parseEnvSecret (text) {
  let last = null
  for (const line of String(text).split('\n')) {
    const m = /^[ \t\v\f\r]*VARANDA_CDN_SECRET[ \t\v\f\r]*=([\s\S]*)$/.exec(line)
    if (m) last = m[1]
  }
  if (last === null) return ''
  return last.replace(/\r/g, '')
    .replace(/[ \t\v\f]#[\s\S]*$/, '')
    .replace(/^[ \t\v\f]+/, '')
    .replace(/[ \t\v\f]+$/, '')
}

function validSecret (s) {
  return typeof s === 'string' && SECRET_RE.test(s)
}

// A bare lowercase DNS name with at least two labels.
function validHostname (h) {
  return typeof h === 'string' && h.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h)
}

function validName (n) {
  return typeof n === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(n)
}

// https://<host>[:port] with no path, query, fragment or credentials;
// returns the normalized origin or null.
function parseOrigin (s) {
  if (typeof s !== 'string' || !/^https:\/\/[^/?#@\s]+\/?$/.test(s)) return null
  let u
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  if (u.pathname !== '/' && u.pathname !== '') return null
  if (!validHostname(u.hostname)) return null
  return 'https://' + u.host
}

// The API base: Bunny, or (tests only) http://127.0.0.1:<port>. Anything
// else is refused, so no flag or variable can send the key elsewhere.
function apiBase (value) {
  if (value === undefined || value === '') return API
  const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/.exec(value)
  if (!m) return null
  const port = Number(m[1])
  if (port < 1 || port > 65535) return null
  return 'http://127.0.0.1:' + port
}

// A cached path to purge: under /media/, printable ASCII, no traversal, no
// query, no encoding tricks. A trailing * purges the prefix.
function validPurgePath (p) {
  if (typeof p !== 'string' || p.length > 1024 || !p.startsWith('/media/')) return false
  const body = p.endsWith('*') ? p.slice(0, -1) : p
  if (!/^[\x21-\x7e]+$/.test(body)) return false
  if (/[*\\?#%]/.test(body)) return false
  if (body.includes('..') || body.includes('//')) return false
  return true
}

// A CNAME answer points at the zone when one target is <name>.b-cdn.net.
function cnameMatches (targets, name) {
  const want = (name + '.b-cdn.net').toLowerCase()
  return Array.isArray(targets) && targets.some((t) => typeof t === 'string' && t.toLowerCase().replace(/\.$/, '') === want)
}

// Masks first, then cuts: a cut first could leave a secret's prefix that the
// mask no longer recognizes.
function clip (text, max, secrets) {
  const s = redact(text, secrets)
  return s.length > max ? s.slice(0, max) + '...' : s
}

// An error line: status, ErrorKey and a short Message, never a body.
function errorText (status, json, secrets = []) {
  let s = 'Bunny respondeu ' + status
  if (json && typeof json === 'object') {
    if (typeof json.ErrorKey === 'string' && json.ErrorKey) s += ' ' + clip(json.ErrorKey, 80, secrets)
    if (typeof json.Message === 'string' && json.Message) s += ': ' + clip(json.Message, MESSAGE_MAX, secrets)
  }
  if (status === 401) s += ' (chave da API recusada)'
  if (status === 429) s += ' (limite de pedidos do Bunny: espere e rode de novo)'
  return s
}

// Replaces every secret with *** and every control character with ?.
function redact (line, secrets) {
  let s = String(line)
  const list = [...secrets].filter((x) => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length)
  for (const x of list) s = s.split(x).join('***')
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '?')
}

function parseArgs (argv) {
  const opts = { name: DEFAULT_NAME, paths: [] }
  let cmd = null
  const flags = new Map([['--name', 'name'], ['--origin', 'origin'], ['--hostname', 'hostname'], ['--env-file', 'envFile']])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--purge') {
      opts.forcePurge = true
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const flag = eq === -1 ? a : a.slice(0, eq)
      if (!flags.has(flag)) {
        if (/key|token|secret/i.test(flag)) {
          throw new UsageError('Opção ' + flag + ' recusada: a chave e o segredo nunca vão como argumento (use BUNNY_API_KEY ou a pergunta, e --env-file)')
        }
        throw new UsageError('Opção desconhecida: ' + flag.slice(0, 40))
      }
      let value
      if (eq !== -1) value = a.slice(eq + 1)
      else {
        value = argv[++i]
        if (value === undefined) throw new UsageError(flag + ' precisa de um valor')
      }
      opts[flags.get(flag)] = value
    } else if (cmd === null && COMMANDS.has(a)) {
      cmd = a
    } else if (cmd === 'purge') {
      opts.paths.push(a)
    } else {
      throw new UsageError('Comando desconhecido (use plan, apply, cert, purge ou status)')
    }
  }
  opts.cmd = cmd || 'plan'
  if (opts.forcePurge && opts.cmd !== 'apply') throw new UsageError('--purge só vale com apply')
  return opts
}

// ---------------------------------------------------------------------------
// I/O

// Every printed line goes through here. secrets grows as the run learns of
// more (the zone's security key, an old secret on a rule).
function output ({ stdout, stderr }) {
  const secrets = new Set()
  return {
    secrets,
    add (s) { if (typeof s === 'string' && s.length >= 4) secrets.add(s) },
    say (line) { stdout.write(redact(line, secrets) + '\n') },
    warn (line) { stderr.write(redact(line, secrets) + '\n') }
  }
}

// One request, never repeated. Returns the parsed JSON (or null) on 2xx.
function client ({ base, key, fetch = globalThis.fetch, out }) {
  async function request (method, path, { query, body } = {}) {
    const url = new URL(base + path)
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const headers = { AccessKey: key, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const write = method !== 'GET'
    let res
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (err) {
      const why = err && err.name === 'TimeoutError' ? 'sem resposta em ' + (TIMEOUT_MS / 1000) + ' s' : 'falha de rede (' + ((err && err.cause && err.cause.code) || (err && err.name) || 'erro') + ')'
      throw new BunnyError(method + ' ' + path + ': ' + why, { write })
    }
    // A body cut off after the status is not a success: the write may or may
    // not have happened.
    let text
    try {
      text = await res.text()
    } catch {
      throw new BunnyError(method + ' ' + path + ': resposta interrompida depois do status ' + res.status +
        (write ? '; o pedido pode ter sido feito ou não' : ''), { status: res.status, write })
    }
    let json = null
    if (text) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    if (json && typeof json === 'object' && out) {
      for (const z of [json].concat(Array.isArray(json) ? json : [])) learnSecrets(z, out)
    }
    if (res.status < 200 || res.status > 299) {
      throw new BunnyError(method + ' ' + path + ': ' + errorText(res.status, json, out ? out.secrets : []), { status: res.status, write })
    }
    return json
  }
  return { request }
}

// Masks a zone's security key and any value of our header rule, even an old
// one, in everything printed afterwards.
function learnSecrets (zone, out) {
  if (!zone || typeof zone !== 'object') return
  out.add(zone.ZoneSecurityKey)
  if (Array.isArray(zone.EdgeRules)) {
    for (const r of zone.EdgeRules) {
      if (r && r.ActionType === ACTION_SET_REQUEST_HEADER) out.add(r.ActionParameter2)
    }
  }
}

// The zone named exactly `name`, in full, or null.
async function findZone (api, name) {
  const list = await api.request('GET', '/pullzone', { query: { search: name } })
  const items = Array.isArray(list) ? list : list && Array.isArray(list.Items) ? list.Items : null
  // An answer of another shape must not read as "no zone": apply would
  // create a second one.
  if (items === null) throw new BunnyError('Resposta inesperada do Bunny para a lista de zonas')
  const exact = items.filter((z) => z && z.Name === name)
  if (exact.length > 1) throw new BunnyError('Mais de uma zona com o nome ' + name + ': resolva no painel antes')
  if (exact.length === 0) return null
  return getZone(api, exact[0].Id)
}

async function getZone (api, id) {
  if (!Number.isSafeInteger(id)) throw new BunnyError('Id de zona inválido na resposta do Bunny')
  const zone = await api.request('GET', '/pullzone/' + id)
  if (!zone || typeof zone !== 'object' || zone.Id !== id) throw new BunnyError('Resposta inesperada do Bunny para a zona ' + id)
  return zone
}

function show (v) {
  if (v === null || v === undefined || v === '') return '(vazio)'
  return String(v)
}

function printPlan (out, plan, { name, hostname, zone }) {
  out.say(plan.create ? 'Zona ' + name + ': não existe; apply cria.' : 'Zona ' + name + ' (id ' + zone.Id + ')')
  if (plan.settings.length === 0) out.say('Ajustes: iguais')
  else {
    out.say('Ajustes:')
    for (const s of plan.settings) out.say('  ' + s.field + ': ' + show(s.current) + ' -> ' + show(s.desired))
  }
  out.say('Hostname ' + hostname + ': ' + (plan.addHostname ? 'adicionar' : 'já está'))
  out.say('Regras:')
  for (const r of plan.rules) {
    let line = '  ' + r.desired.Description + ': ' + (r.action || 'igual')
    const fields = r.fields.filter((f) => f !== 'ActionParameter2' || r.secretChanges === null)
    if (r.action === 'atualizar' && fields.length > 0) line += ' (' + fields.join(', ') + ')'
    if (r.secretChanges !== null) line += '; segredo: ' + (r.secretChanges ? 'muda' : 'igual')
    out.say(line)
  }
  if (plan.purge) out.say('Cache: apply limpa a zona inteira depois das mudanças.')
  printOthers(out, plan.others)
}

function printOthers (out, others) {
  if (others.length === 0) return
  out.say('Outras regras (' + others.length + '), que o script não mexe e que podem desfazer as nossas:')
  for (const d of others) out.say('  ' + (d ? clip(d, 120, out.secrets) : '(sem descrição)'))
}

function dupError (duplicates) {
  return new BunnyError('Regras com a mesma descrição: ' + duplicates.map((d) => '"' + d + '"').join(', ') +
    '. Apague as repetidas no painel; nada foi escrito.')
}

function attachError (fields) {
  return new BunnyError('A zona tem ' + fields.join(', ') + ' ligado, que o script não desliga e que pode ' +
    'guardar cópias além dos 60 s ou mudar os pedidos. Desligue no painel; nada foi escrito.')
}

async function runPlan (api, out, ctx) {
  const zone = await findZone(api, ctx.name)
  const plan = planChanges(zone, ctx)
  printPlan(out, plan, { ...ctx, zone })
  if (plan.duplicates.length > 0) throw dupError(plan.duplicates)
  if (plan.attachments.length > 0) throw attachError(plan.attachments)
  const n = writeCount(plan)
  out.say(n === 0 ? 'Nada a mudar.' : 'apply faria ' + n + ' escrita(s).')
  return 0
}

async function runApply (api, out, ctx) {
  let zone = await findZone(api, ctx.name)
  let plan = planChanges(zone, ctx)
  if (plan.duplicates.length > 0) {
    printPlan(out, plan, { ...ctx, zone })
    throw dupError(plan.duplicates)
  }
  if (plan.attachments.length > 0) throw attachError(plan.attachments)
  const purge = plan.purge || (ctx.forcePurge && zone !== null)
  if (writeCount(plan) === 0 && !purge) {
    printOthers(out, plan.others)
    out.say('Nada a mudar: nenhuma escrita.')
    return 0
  }
  let writes = 0
  // Once the writes start, the purge is owed until it succeeds: a later plain
  // apply may see no difference left and skip it, so any stop says --purge.
  ctx.purgePending = purge
  if (purge) out.say('Esta execução termina limpando o cache da zona; se parar antes, rode apply --purge.')
  if (plan.create) {
    await api.request('POST', '/pullzone', { body: { Name: ctx.name } })
    writes++
    out.say('Zona ' + ctx.name + ' criada.')
    zone = await findZone(api, ctx.name)
    if (zone === null) throw new BunnyError('A zona criada não aparece na lista do Bunny; rode apply de novo em instantes', { write: true })
    plan = planChanges(zone, ctx)
  }
  const id = zone.Id
  // The rules go in before the origin: a run that stops halfway must not
  // leave a zone (its b-cdn.net hostname is live at once) proxying the whole
  // installation, cookies and /account/* included. The block rule goes first.
  const rules = plan.rules.filter((r) => r.action !== null)
    .sort((a, b) => (b.desired.Description === RULE_MEDIA) - (a.desired.Description === RULE_MEDIA))
  for (const r of rules) {
    await api.request('POST', '/pullzone/' + id + '/edgerules/addOrUpdate', { body: ruleBody(r.desired, r.existing) })
    writes++
    out.say('Regra "' + r.desired.Description + '": ' + (r.action === 'criar' ? 'criada' : 'atualizada') +
      (r.secretChanges ? ' (segredo novo)' : ''))
  }
  if (plan.settings.length > 0) {
    await api.request('POST', '/pullzone/' + id, { body: desiredSettings(ctx.origin) })
    writes++
    out.say('Ajustes gravados: ' + plan.settings.map((s) => s.field).join(', '))
  }
  if (plan.addHostname) {
    await api.request('POST', '/pullzone/' + id + '/addHostname', { body: { Hostname: ctx.hostname } })
    writes++
    out.say('Hostname ' + ctx.hostname + ' adicionado.')
  }
  if (purge) {
    await api.request('POST', '/pullzone/' + id + '/purgeCache')
    ctx.purgePending = false
    writes++
    out.say('Cache da zona limpo.')
  }
  const after = await getZone(api, id)
  const bad = verifyZone(after, ctx)
  printOthers(out, sortRules(after).others)
  if (bad.length > 0) {
    out.warn('Conferência falhou depois de ' + writes + ' escrita(s): o Bunny não guardou ' + bad.join('; '))
    out.warn('Confira no painel. apply pode rodar de novo com segurança.')
    return 1
  }
  out.say('Feito: ' + writes + ' escrita(s), tudo conferido.')
  return 0
}

async function runStatus (api, out, ctx) {
  const zone = await findZone(api, ctx.name)
  if (zone === null) {
    out.say('Zona ' + ctx.name + ': não existe.')
    return 0
  }
  out.say('Zona ' + ctx.name + ' (id ' + zone.Id + ')')
  out.say('Origem: ' + show(zone.OriginUrl))
  out.say('Hostnames:')
  for (const h of Array.isArray(zone.Hostnames) ? zone.Hostnames : []) {
    out.say('  ' + show(h.Value) + (h.IsSystemHostname ? ' (do Bunny)' : '') +
      ', certificado: ' + (h.HasCertificate ? 'sim' : 'não') + ', ForceSSL: ' + (h.ForceSSL ? 'sim' : 'não'))
  }
  const desired = desiredSettings(ctx.origin)
  if (ctx.origin === undefined) delete desired.OriginUrl
  out.say('Ajustes:')
  for (const field of Object.keys(desired)) {
    const ok = sameSetting(field, zone[field], desired[field])
    out.say('  ' + field + ': ' + show(zone[field]) + (ok ? '' : ' (esperado ' + show(desired[field]) + ')'))
  }
  const sorted = sortRules(zone)
  out.say('Regras:')
  for (const d of desiredRules({ secret: ctx.secret, hostname: ctx.hostname })) {
    const r = sorted.ours.get(d.Description)
    let line = '  ' + d.Description + ': '
    if (!r) line += 'ausente'
    else {
      const fields = ruleDiff(r, d)
      line += fields.length === 0 ? 'ok' : 'difere (' + fields.join(', ') + ')'
      if (d.Description === RULE_SECRET && ctx.secret === undefined) line += '; segredo não conferido (sem --env-file)'
      if (d.Description !== RULE_SECRET && ctx.hostname === undefined) line += '; padrão não conferido (sem --hostname)'
    }
    out.say(line)
  }
  for (const d of sorted.duplicates) out.say('  repetida: ' + d)
  const att = attachments(zone)
  if (att.length > 0) out.say('Ligado na zona, que o script não desliga: ' + att.join(', '))
  printOthers(out, sorted.others)
  return 0
}

async function runCert (api, out, ctx, resolveCname) {
  let targets = []
  try {
    targets = await resolveCname(ctx.hostname)
  } catch {
    targets = []
  }
  if (!cnameMatches(targets, ctx.name)) {
    out.warn('O CNAME de ' + ctx.hostname + ' ainda não aponta para ' + ctx.name + '.b-cdn.net. Crie esse registro no DNS, espere propagar e rode cert de novo.')
    return 1
  }
  const zone = await findZone(api, ctx.name)
  if (zone === null) throw new BunnyError('Zona ' + ctx.name + ' não existe: rode apply antes')
  if (!hasHostname(zone, ctx.hostname)) throw new BunnyError('Hostname ' + ctx.hostname + ' não está na zona: rode apply antes')
  // The certificate opens the hostname over HTTPS: not before the rules that
  // keep everything but /media/ off it and send the header. The secret's
  // value is not compared here (cert does not read it).
  const sorted = sortRules(zone)
  if (sorted.duplicates.length > 0) throw dupError(sorted.duplicates)
  const missing = desiredRules({ hostname: ctx.hostname })
    .filter((d) => !sorted.ours.has(d.Description) || ruleDiff(sorted.ours.get(d.Description), d).length > 0)
    .map((d) => d.Description)
  if (missing.length > 0) {
    throw new BunnyError('Regras ausentes ou diferentes: ' + missing.join(', ') + '. Rode apply antes do cert; nada foi escrito.')
  }
  await api.request('GET', '/pullzone/loadFreeCertificate', { query: { hostname: ctx.hostname } })
  out.say('Certificado pedido para ' + ctx.hostname + '.')
  await api.request('POST', '/pullzone/' + zone.Id + '/setForceSSL', { body: { Hostname: ctx.hostname, ForceSSL: true } })
  out.say('ForceSSL ligado em ' + ctx.hostname + '.')
  return 0
}

async function runPurge (api, out, ctx) {
  let done = 0
  for (const p of ctx.paths) {
    try {
      await api.request('POST', '/purge', { query: { url: 'https://' + ctx.hostname + p, async: 'false' } })
    } catch (err) {
      if (done > 0) out.warn('Já purgados: ' + done + ' de ' + ctx.paths.length + '.')
      throw err
    }
    done++
    out.say('Purgado: ' + p)
  }
  return 0
}

// Reads the key from the terminal without echo. The terminal goes back to
// normal on Enter, Ctrl-C, Ctrl-D and process exit.
function promptKey ({ stdin = process.stdin, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const restore = () => {
      try { stdin.setRawMode(false) } catch {}
      stdin.pause()
      stdin.removeListener('data', onData)
      process.removeListener('exit', restore)
    }
    function onData (chunk) {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          restore()
          stderr.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003' || ch === '\u0004') {
          restore()
          stderr.write('\n')
          reject(new UsageError('Cancelado.'))
          return
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    process.once('exit', restore)
    stderr.write('Chave da API do Bunny (não aparece): ')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function readKey (env, io) {
  let key = env.BUNNY_API_KEY
  if (key === undefined || key === '') {
    if (!io.stdin.isTTY || typeof io.stdin.setRawMode !== 'function') {
      throw new UsageError('Sem chave: defina BUNNY_API_KEY ou rode num terminal para digitá-la')
    }
    key = await promptKey({ stdin: io.stdin, stderr: io.stderr })
  }
  key = key.trim()
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new UsageError('Chave da API em formato inválido')
  return key
}

function readSecret (opts, env) {
  let secret
  if (opts.envFile !== undefined) {
    let text
    try { text = fs.readFileSync(opts.envFile, 'utf8') } catch {
      throw new UsageError('Não consegui ler ' + opts.envFile)
    }
    secret = parseEnvSecret(text)
    if (secret === '') throw new UsageError('VARANDA_CDN_SECRET vazio ou ausente em ' + opts.envFile)
  } else {
    secret = env.VARANDA_CDN_SECRET || ''
    if (secret === '') throw new UsageError('Falta o segredo: use --env-file <caminho do .env> ou VARANDA_CDN_SECRET')
  }
  if (!validSecret(secret)) {
    throw new UsageError('VARANDA_CDN_SECRET inválido: só 64 dígitos hexadecimais minúsculos (openssl rand -hex 32)')
  }
  return secret
}

const dnsResolveCname = (h) => require('node:dns/promises').resolveCname(h)

async function main (argv, {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  fetch = globalThis.fetch,
  resolveCname = dnsResolveCname
} = {}) {
  const out = output({ stdout, stderr })
  out.add(env.BUNNY_API_KEY)
  out.add(env.VARANDA_CDN_SECRET)
  let opts
  let ctx = null
  try {
    opts = parseArgs(argv)
    const base = apiBase(env.VARANDA_BUNNY_API)
    if (base === null) throw new UsageError('VARANDA_BUNNY_API recusado: só http://127.0.0.1:<porta>, para os testes')
    if (!validName(opts.name)) throw new UsageError('--name inválido: letras minúsculas, dígitos e hífens')
    ctx = { name: opts.name, paths: opts.paths, forcePurge: opts.forcePurge === true }
    const needsHost = opts.cmd !== 'status' || opts.hostname !== undefined
    if (needsHost) {
      if (opts.hostname === undefined) throw new UsageError('Falta --hostname (ex.: media.<domínio>)')
      if (!validHostname(opts.hostname)) throw new UsageError('--hostname inválido: só o nome, em minúsculas, sem esquema nem caminho')
      ctx.hostname = opts.hostname
    }
    if (opts.cmd === 'plan' || opts.cmd === 'apply' || (opts.cmd === 'status' && opts.origin !== undefined)) {
      if (opts.origin === undefined) throw new UsageError('Falta --origin https://<domínio>')
      const origin = parseOrigin(opts.origin)
      if (origin === null) throw new UsageError('--origin inválido: https://<domínio>, sem caminho')
      ctx.origin = origin
    }
    if (opts.cmd === 'plan' || opts.cmd === 'apply' ||
        (opts.cmd === 'status' && (opts.envFile !== undefined || env.VARANDA_CDN_SECRET))) {
      ctx.secret = readSecret(opts, env)
      out.add(ctx.secret)
    }
    if (opts.cmd === 'purge') {
      if (opts.paths.length === 0) throw new UsageError('purge precisa de pelo menos um caminho /media/...')
      for (const p of opts.paths) {
        if (!validPurgePath(p)) throw new UsageError('Caminho recusado: ' + p.slice(0, 120) + ' (só /media/..., sem "..", "//", "?", "#", "%", "\\" nem espaços; * só no fim)')
      }
    } else if (opts.paths.length > 0) {
      throw new UsageError('Só purge aceita caminhos')
    }
    const key = await readKey(env, { stdin, stderr })
    out.add(key)
    const api = client({ base, key, fetch, out })
    if (opts.cmd === 'plan') return await runPlan(api, out, ctx)
    if (opts.cmd === 'apply') return await runApply(api, out, ctx)
    if (opts.cmd === 'status') return await runStatus(api, out, ctx)
    if (opts.cmd === 'cert') return await runCert(api, out, ctx, resolveCname)
    return await runPurge(api, out, ctx)
  } catch (err) {
    if (err instanceof UsageError || err instanceof BunnyError) {
      out.warn('Erro: ' + err.message)
      if (err instanceof BunnyError && ctx && ctx.purgePending) {
        out.warn('A limpeza do cache não foi confirmada, e um apply comum pode não repeti-la: rode apply --purge, com as mesmas opções, até ela dar certo.')
      } else if (err instanceof BunnyError && err.write && opts && opts.cmd === 'apply') {
        out.warn('O estado pode ter ficado pela metade. apply pode rodar de novo com segurança: ele só grava o que falta.')
      }
    } else {
      out.warn('Erro inesperado: ' + ((err && err.name) || 'erro'))
    }
    return 1
  }
}

module.exports = {
  API,
  RULE_SECRET,
  RULE_MEDIA,
  RULE_CACHE,
  desiredSettings,
  settingsDiff,
  desiredRules,
  ruleDiff,
  ruleBody,
  sortRules,
  planChanges,
  writeCount,
  attachments,
  verifyZone,
  parseEnvSecret,
  validSecret,
  validHostname,
  parseOrigin,
  apiBase,
  validPurgePath,
  cnameMatches,
  errorText,
  redact,
  parseArgs,
  output,
  client,
  findZone,
  runCert,
  main
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
