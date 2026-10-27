'use strict'

// `mod apply --server <origin>`: signs, on the operator's machine, the
// decisions moderators took in the account service's panel (README
// "Aplicar as decisões do painel"). The moderator secret never leaves this
// machine; the server only ever sees two signed requests and the public
// snapshot:
//
// 1. pull: GET api/challenge (op 'pull') for a single-use nonce, then POST
//    api/pull { cert, nonce, signature } where the signature binds the
//    public origin, the association, the moderator, the nonce, the op and
//    the body bytes (packages/core/lib/mod-request.js). The answer is
//    exactly { changes: [{ id, op, member, at, actor }], published:
//    { snapshot } }, actor 'ia' (the AI triage decided) or 'pessoa'.
// 2. reconcile: the local blocklist.json must not be behind the published
//    snapshot (a restored old backup would otherwise sign a seq peers ignore
//    as stale, or undo newer blocks); the changes are walked in `at` order
//    on the local blocked set.
// 2b. review: nothing the server returns is signed unseen. The net change of
//    each member is printed ('bloquear <k>' / 'desbloquear <k>', an unblock
//    of a key whose block was not made in the panel marked ' (bloqueada pela
//    operação)', a block every block change of which the AI made marked
//    ' (ia)'; the AI never queues an unblock). At a terminal the operator
//    confirms (and confirms those marked unblocks a second time); without
//    one only --yes runs, and it applies human blocks only (at most
//    MAX_UNATTENDED_BLOCKS of them): every member whose net effect is an
//    unblock, and every block no person made (all its block changes 'ia'),
//    is held, none of its change ids signed or acknowledged, so they stay
//    pending on the server for the next run at a terminal. A phished panel
//    session or a compromised server can thus queue unblocks, but no cron
//    run publishes them; and a cron run never publishes a block nobody read:
//    the AI learns from human blocks as if they judged the post, so sybil
//    accounts can poison its precedents into queueing a whole-account block
//    of an innocent member. A block with at least one human block change is
//    a human block and goes through --yes as before.
// 3. one snapshot (commands/mod.js applySet, seq + 1), published to the
//    seeder by its Noise key (mod-publish.js). Only a delivered publish is
//    acknowledged: the panel's queue empties only for a list the seeder
//    holds. An undelivered publish leaves the new list written; the next run
//    finds the set unchanged and republishes the same bytes before the ack.
// 4. ack: challenge (op 'ack'), then POST api/ack { cert, nonce, signature,
//    changeIds, snapshot }.
//
// Every request: 10 s, no redirect, JSON only, bounded body. The caller
// (commands/mod.js) holds the data-dir lock through all of it, so two
// operator commands never sign two snapshots with one seq.
const b4a = require('b4a')
const { UsageError } = require('@varanda/core/lib/errors')
const { verifySnapshot, validateSnapshotShape, compareSnapshots, blockedSet } = require('@varanda/core/lib/blocklist')
const { signModRequest, canonicalBody, canonicalSnapshot, isOrigin, NONCE_RE, CHANGE_ID_RE } = require('@varanda/core/lib/mod-request')
const { jsonLine } = require('@varanda/core/lib/safe')
const mod = require('./commands/mod')

const REQUEST_TIMEOUT_MS = 10000
const BODY_CAP = 524288
// D1: at most MAX_PENDING (1000) changes of ~140 bytes plus one snapshot of
// up to MAX_SNAPSHOT_BYTES (393216) bytes.
const PULL_BODY_CAP = 1048576
const MAX_CHANGES = 1000
// --yes (cron) signs at most this many new (human) blocks per run.
const MAX_UNATTENDED_BLOCKS = 100
const HEX64_RE = /^[0-9a-f]{64}$/
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/
const ERROR_TOKEN_RE = /^[a-z-]{1,40}$/
const INVALID = 'resposta inválida do servidor'
const UNAVAILABLE = 'servidor indisponível'
const NOT_INTERACTIVE = 'rode num terminal para revisar, ou use --yes para aplicar só os bloqueios'
const TOO_MANY_BLOCKS = 'muitos bloqueios de uma vez; rode no terminal para revisar'
const REFUSED = 'nada assinado'
const OPERATOR_MARK = ' (bloqueada pela operação)'
// A block whose every change the AI triage made (actor 'ia').
const AI_MARK = ' (ia)'
// Appended under --yes to an AI block it holds for a terminal.
const AI_HELD = ' — aguarda revisão no terminal'
const CONFIRM = 'Assinar e publicar estas mudanças? [s/N] '
const CONFIRM_OPERATOR = 'Desbloquear também as chaves bloqueadas pela operação? [s/N] '
const NO_LIST_NET = 'há decisões pendentes que se anulam e este diretório não tem lista; rode mod apply uma vez com --new-list para assinar a primeira lista e confirmá-las'

// An origin exactly as the server signs against it: https, or plain http
// on 127.0.0.1 (the loopback tests). No path, no trailing slash.
function checkServer (value) {
  if (value === null || value === undefined) throw new UsageError('informe --server <origem>')
  let url = null
  try {
    url = new URL(value)
  } catch {}
  if (url === null || url.origin !== value || !isOrigin(value)) throw new UsageError('server inválido')
  if (url.protocol === 'https:') return value
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return value
  throw new UsageError('server inválido')
}

// Without a terminal to review the changes, only --yes may run (blocks only).
function checkMode ({ yes = false, interactive = false } = {}) {
  if (!yes && !interactive) throw new Error(NOT_INTERACTIVE)
}

function accepted (answer) {
  const a = typeof answer === 'string' ? answer.trim().toLowerCase() : ''
  return a === 's' || a === 'sim'
}

// One question on the terminal; resolves the typed line ('' on end of input).
function askTerminal (question) {
  const readline = require('node:readline')
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let answered = false
    rl.on('close', () => { if (!answered) resolve('') })
    rl.question(question, (line) => {
      answered = true
      rl.close()
      resolve(line)
    })
  })
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function exactKeys (o, keys) {
  if (!isPlainObject(o)) return false
  const own = Object.keys(o).sort()
  const want = keys.slice().sort()
  return own.length === want.length && own.every((k, i) => k === want[i])
}

async function readCapped (res, cap) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      reader.cancel().catch(() => {})
      throw new Error(INVALID)
    }
    chunks.push(value)
  }
  return b4a.toString(b4a.concat(chunks), 'utf8')
}

// -> { status, value } with value the parsed JSON; throws UNAVAILABLE when
// the server cannot be reached in time, INVALID for anything but bounded JSON.
async function request (fetch, url, { body = null, cap = BODY_CAP } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let res
    try {
      res = await fetch(url, {
        method: body === null ? 'GET' : 'POST',
        headers: body === null ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === null ? undefined : body,
        redirect: 'error',
        signal: controller.signal
      })
    } catch {
      throw new Error(UNAVAILABLE)
    }
    const type = res.headers.get('content-type') || ''
    let text
    try {
      text = await readCapped(res, cap)
    } catch {
      throw new Error(controller.signal.aborted ? UNAVAILABLE : INVALID)
    }
    if (!/^application\/json(\s*;|$)/i.test(type)) throw new Error(INVALID)
    let value
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error(INVALID)
    }
    return { status: res.status, value }
  } finally {
    clearTimeout(timer)
  }
}

// A refusal carries { error: token } (T9 rule); anything else is malformed.
function refused (value) {
  if (exactKeys(value, ['error']) && typeof value.error === 'string' && ERROR_TOKEN_RE.test(value.error)) {
    return new Error('o servidor recusou o pedido (' + value.error + ')')
  }
  return new Error(INVALID)
}

async function challenge (ctx, op) {
  const url = ctx.server + '/account/mod/api/challenge?moderator=' + ctx.moderator + '&op=' + op
  const { status, value } = await request(ctx.fetch, url)
  if (status !== 200) throw refused(value)
  if (!exactKeys(value, ['nonce']) || typeof value.nonce !== 'string' || !NONCE_RE.test(value.nonce)) throw new Error(INVALID)
  return value.nonce
}

function sign (ctx, nonce, op, body) {
  return signModRequest({
    origin: ctx.server,
    association: ctx.association,
    moderator: ctx.moderator,
    nonce,
    op,
    body
  }, ctx.keyPair)
}

function validChange (c) {
  return exactKeys(c, ['id', 'op', 'member', 'at', 'actor']) &&
    (c.actor === 'ia' || c.actor === 'pessoa') &&
    typeof c.id === 'string' && CHANGE_ID_RE.test(c.id) &&
    (c.op === 'block' || c.op === 'unblock') &&
    typeof c.member === 'string' && HEX64_RE.test(c.member) &&
    typeof c.at === 'string' && ISO_RE.test(c.at) && new Date(c.at).toISOString() === c.at
}

// D1: exactly { changes, published: { snapshot } }, every change exactly
// { id, op, member, at, actor }, unique ids, a snapshot that is null or verifies
// for this association.
function checkPull (value, association) {
  if (!exactKeys(value, ['changes', 'published']) || !exactKeys(value.published, ['snapshot'])) return null
  const { changes } = value
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) return null
  const ids = new Set()
  for (const c of changes) {
    if (!validChange(c) || ids.has(c.id)) return null
    ids.add(c.id)
  }
  const snapshot = value.published.snapshot
  if (snapshot !== null) {
    if (validateSnapshotShape(snapshot) !== null || !verifySnapshot(snapshot, association).ok) return null
  }
  return { changes, published: snapshot === null ? null : canonicalSnapshot(snapshot) }
}

async function pull (ctx) {
  const nonce = await challenge(ctx, 'pull')
  const signature = sign(ctx, nonce, 'pull', canonicalBody('pull'))
  const body = JSON.stringify({ cert: ctx.certificate, nonce, signature })
  const { status, value } = await request(ctx.fetch, ctx.server + '/account/mod/api/pull', { body, cap: PULL_BODY_CAP })
  if (status !== 200) throw refused(value)
  const result = checkPull(value, ctx.association)
  if (result === null) throw new Error(INVALID)
  return result
}

async function ack (ctx, changeIds, snapshot) {
  const nonce = await challenge(ctx, 'ack')
  const signature = sign(ctx, nonce, 'ack', canonicalBody('ack', { changeIds, snapshot }))
  const body = JSON.stringify({ cert: ctx.certificate, nonce, signature, changeIds, snapshot: canonicalSnapshot(snapshot) })
  const { status, value } = await request(ctx.fetch, ctx.server + '/account/mod/api/ack', { body })
  if (status === 409 && isPlainObject(value) && value.error === 'defasado') {
    throw new Error('o servidor tem uma lista mais nova; restaure o backup')
  }
  if (status !== 200) throw refused(value)
  if (!isPlainObject(value) || value.ok !== true) throw new Error(INVALID)
  if ('seq' in value && value.seq !== snapshot.seq) throw new Error(INVALID)
}

async function publishOrFail (publish, snapshot) {
  const result = await publish(snapshot)
  if (!result || result.delivered !== true) throw new Error(mod.publishFailedMessage(result, snapshot))
}

function sameSet (a, b) {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

// -> 0 (or throws: Error -> exit 1, UsageError -> exit 2). `publish` is
// (snapshot) -> mod-publish.js { delivered, conflict, peers }. `print`
// receives each output line (stdout by default). `yes`: unattended (blocks
// only); `interactive`: a terminal is there to review (stdin and stdout are
// TTYs by default); `ask(question)` resolves the typed answer.
async function apply ({
  dir,
  association,
  server,
  fetch = globalThis.fetch,
  publish,
  newList = false,
  json = false,
  yes = false,
  interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
  ask = askTerminal,
  print = (line) => process.stdout.write(line + '\n'),
  now = () => new Date()
} = {}) {
  checkServer(server)
  if (typeof publish !== 'function') throw new TypeError('publish must be a function')
  checkMode({ yes, interactive })
  const reviewing = !yes
  const { keyPair, publicKey, certificate } = mod.loadModerator(dir, association)
  const local = mod.loadSnapshot(dir, association)
  if (local !== null && newList) throw new Error('este diretório já tem uma lista')
  const ctx = { fetch, server, association, moderator: publicKey, keyPair, certificate }
  // At a terminal the review is always shown, also with --json (whose JSON
  // stays the last line).
  const say = (line) => { if (!json || reviewing) print(line) }
  let held = []
  const done = (outcome, changeIds, snapshot, line) => {
    if (json) print(jsonLine({ op: 'apply', outcome, changeIds, snapshot, held: held.length }))
    else print(line)
    return 0
  }

  const { changes, published } = await pull(ctx)

  // Reconcile before writing anything: a local list behind the published
  // one (an old backup) would sign a seq the nodes reject, or drop blocks.
  if (published !== null) {
    const order = local === null ? -1 : compareSnapshots(local, published)
    if (order < 0) throw new Error('lista local atrás da publicada; restaure o backup da moderação')
    if (order === 0 && local.signature !== published.signature) {
      throw new Error('lista local diferente da publicada com o mesmo número; restaure o backup da moderação')
    }
  }
  const base = blockedSet(local)

  // The net effect of each member's changes, walked in the SERVER's order
  // (the store's insertion order, which its ack checks): never re-sorted by
  // `at`, since a wall clock that steps back would reverse a block and its
  // cancellation. member -> { blocked (final state), ids, ai (no block
  // change made by a person: every block is the AI triage's) }, in the
  // order members first appear. A person's unblock between two AI blocks
  // endorses no block, so it leaves `ai` set.
  const ordered = changes
  const members = new Map()
  for (const c of ordered) {
    let entry = members.get(c.member)
    if (!entry) {
      entry = { blocked: base.has(c.member), ids: [], ai: true }
      members.set(c.member, entry)
    }
    entry.blocked = c.op === 'block'
    if (c.op === 'block' && c.actor !== 'ia') entry.ai = false
    entry.ids.push(c.id)
  }
  const blocks = []
  const unblocks = []
  for (const [member, entry] of members) {
    if (entry.blocked && !base.has(member)) blocks.push(member)
    else if (!entry.blocked && base.has(member)) unblocks.push(member)
  }
  const sources = unblocks.length > 0 ? mod.blockSources(dir, unblocks) : new Map()
  const byOperator = unblocks.filter((k) => sources.get(k) !== mod.SOURCE_PANEL)
  // Unattended, the AI's blocks wait for a terminal (header 2b).
  const aiBlocks = yes ? blocks.filter((k) => members.get(k).ai) : []

  // The review: one line per member.
  for (const [member, entry] of members) {
    if (entry.blocked) {
      if (base.has(member)) say('já estava bloqueada ' + member)
      else say('bloquear ' + member + (entry.ai ? AI_MARK : '') + (aiBlocks.includes(member) ? AI_HELD : ''))
    } else if (base.has(member)) say('desbloquear ' + member + (byOperator.includes(member) ? OPERATOR_MARK : ''))
    else say('não estava bloqueada ' + member)
  }

  if (yes) {
    // Unattended: human blocks only, a bounded number of them; every unblock
    // and every AI block waits for a terminal.
    if (blocks.length - aiBlocks.length > MAX_UNATTENDED_BLOCKS) throw new Error(TOO_MANY_BLOCKS)
    held = [...unblocks, ...aiBlocks]
  } else if (blocks.length + unblocks.length > 0) {
    if (!accepted(await ask(CONFIRM))) throw new Error(REFUSED)
    if (byOperator.length > 0 && !accepted(await ask(CONFIRM_OPERATOR))) held = byOperator
  }
  const heldUnblocks = held.length - aiBlocks.length
  if (heldUnblocks > 0) say('desbloqueios aguardando revisão no terminal: ' + heldUnblocks)
  const holding = new Set(held)

  const next = new Set(base)
  const changeIds = []
  for (const [member, entry] of members) {
    if (holding.has(member)) continue
    if (entry.blocked) next.add(member)
    else next.delete(member)
    changeIds.push(...entry.ids)
  }

  if (sameSet(next, base)) {
    if (local === null) {
      if (changeIds.length === 0) return done('nada', [], null, 'nada a aplicar')
      // Pending changes that cancel out (a claimed block and its
      // compensating unblock, D6) in a dir with no list: they stay pending
      // until a list is acknowledged, and the first list of a dir is signed
      // only with --new-list (signNext: never from empty sets by accident).
      if (!newList) throw new Error(NO_LIST_NET)
      return signPublishAck(ctx, dir, changeIds, { association, newList, publish, now }, done)
    }
    // After a moderator rotation (README: blocklist.json copied into the new
    // dir) the stored list is signed by the OLD moderator; the server refuses
    // an ack whose snapshot names another moderator than the certificate, so
    // the same sets are signed again here (seq + 1, this dir's certificate,
    // whose newer moderatorDate wins on every node).
    if (local.moderator !== ctx.moderator) {
      return signPublishAck(ctx, dir, changeIds, { association, newList, publish, now }, done)
    }
    if (published === null || compareSnapshots(local, published) > 0) {
      // A list signed here that the panel has not acknowledged yet (a B2
      // list from before the panel, or a run whose publish failed): send
      // the same bytes again, then acknowledge it.
      await publishOrFail(publish, local)
      await ack(ctx, changeIds, local)
      return done('confirmado', changeIds, local, 'confirmado: seq ' + local.seq)
    }
    if (changeIds.length === 0) return done('nada', [], local, 'nada a aplicar')
    await ack(ctx, changeIds, local)
    return done('aplicado', changeIds, local, 'aplicado: seq ' + local.seq + ', ' + local.blocked.length + ' chaves bloqueadas')
  }

  const block = [...next].filter((k) => !base.has(k))
  const unblock = [...base].filter((k) => !next.has(k))
  return signPublishAck(ctx, dir, changeIds, { association, newList, publish, now }, done, { block, unblock })
}

// ONE new snapshot (commands/mod.js applySet, seq + 1, or seq 1 with
// --new-list), published, then acknowledged only once delivered.
async function signPublishAck (ctx, dir, changeIds, opts, done, edits = {}) {
  const { snapshot, published: delivered, result } = await mod.applySet(dir, edits, opts)
  if (!delivered) throw new Error(mod.publishFailedMessage(result, snapshot))
  await ack(ctx, changeIds, snapshot)
  return done('aplicado', changeIds, snapshot, 'aplicado: seq ' + snapshot.seq + ', ' + snapshot.blocked.length + ' chaves bloqueadas')
}

module.exports = { apply, checkServer, checkMode, REQUEST_TIMEOUT_MS, BODY_CAP, PULL_BODY_CAP, MAX_CHANGES, MAX_UNATTENDED_BLOCKS }
