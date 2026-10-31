'use strict'

// Confirms, before a moderator blocks a group root key, that the key a
// reporter wrote into a group report (report v2 `group`) really is a group
// the local seeder serves, and that the reported author (`target`) writes
// to it through the reported `writer` core. Without it a reporter could put
// any diary key in `group` and have 'Bloquear grupo' queue an
// association-wide block of that diary.
//
// It reads the seeder's public index route GET <baseUrl>/index/group/<G>
// [/<after>] (apps/cli/lib/seed-ws.js INDEX_GROUP_RE), whose body is
// { kind, visibility, join, name, creator, rootServed, writers: [{ key,
// diary, length, signed, seq, left }], next, indexing, complete } (`length`
// the writer's contiguous downloaded prefix, `signed` its signed length,
// absent on an older seeder): `kind` is
// non-null once the seeder verified the root's header (served, or purged
// or withheld while writers of G stay served, with `rootServed` false;
// an older seeder sends no `rootServed` and a kind only for a served
// root), `next` the cursor of the next page (a writer key) or null. At
// most MAX_PAGES pages are read; a writer beyond them is not confirmed.
//
// checkDiary({ diary }) reads GET <baseUrl>/index/groups/<D> the same way
// and resolves { ok: true } for a served diary, or { ok: false, code } with
// ausente for a 404 and config, timeout, recusado as below.
//
// createGroupCheck({ baseUrl, token, timeoutMs, maxPages })
// -> { check({ group, writer, diary, seq }), checkDiary }. check never
// throws, never retries and, once the index lists the writer, also reads
// the reported message (readPost below, Bearer `token`). It resolves either
// { ok: true, root, name, creator, texto, sealed? } (`sealed` true for a
// private group's block: texto null, only the structure confirmed; `root` true when the page
// carries the root header's kind, so G is a group root this seeder
// verified; the header's peer text and creator diary as the seeder holds
// them, or null; the message text the seeder decoded) or { ok: false,
// code } with code one of: config (no
// base URL or no token), timeout, recusado (refused, unreachable,
// redirected, oversized or malformed answer, or an absence on an index
// still being built), ausente (404, or neither a root header nor the
// writer listed), nao-membro
// (the writer is not listed with that diary), sem-mensagem (the writer is
// listed with that diary but its signed length, or on an older seeder its
// downloaded length, holds no block `seq`), nao-lida (the seeder did not
// hand out the message; never cached). Nothing is logged. Concurrent checks of one (group, writer,
// diary, seq) share a single read, a definite answer (ok, ausente,
// nao-membro, sem-mensagem)
// is reused for cacheMs (60 s by default), and at most MAX_RUNNING reads
// run at once per process.

// The index answers at most INDEX_MAX_BODY (seed-ws.js) bytes.
const MAX_BODY = 65536
const MAX_PAGES = 8
const HEX64_RE = /^[0-9a-f]{64}$/
// Loopback only, an explicit port, no path (as ai/read-post.js).
const BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/
const NAME_MAX = 256
// Bounded by MAX_BODY anyway; the panel renders it as untrusted text.
const TEXTO_MAX = 16384
const CACHE_MS = 60 * 1000
const MAX_CACHE = 1000
const MAX_RUNNING = 2
const MAX_WAITING = 32
const DEFINITE = ['ausente', 'nao-membro', 'sem-mensagem']

function fail (code) {
  return { ok: false, code }
}

function loopbackOrigin (baseUrl) {
  if (typeof baseUrl !== 'string') return null
  const m = BASE_RE.exec(baseUrl)
  if (m === null) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return 'http://' + m[1] + ':' + port
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isTimeout (err) {
  return err !== null && typeof err === 'object' && (err.name === 'TimeoutError' || err.code === 23)
}

// The body as a Buffer, or null beyond MAX_BODY. Timeouts propagate.
async function readCapped (res) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (res.body === null) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

function createGroupCheck ({ baseUrl, token = null, timeoutMs = 5000, maxPages = MAX_PAGES, cacheMs = CACHE_MS, now = Date.now } = {}) {
  const origin = loopbackOrigin(baseUrl)
  // VARANDA_TRIAGE_TOKEN; never logged or echoed.
  if (typeof token !== 'string' || !HEX64_RE.test(token)) token = null
  const configured = origin !== null &&
    Number.isFinite(timeoutMs) && timeoutMs > 0 &&
    Number.isSafeInteger(maxPages) && maxPages >= 1 && maxPages <= MAX_PAGES &&
    Number.isFinite(cacheMs) && cacheMs >= 0

  // The seeder's public index shares one token bucket with every visitor:
  // repeated panel loads and decisions about the same report must not
  // drain it, so one triple is read once at a time (inflight), its answer
  // reused for cacheMs (cache), and at most MAX_RUNNING different triples
  // read at once (the rest wait, up to MAX_WAITING).
  const inflight = new Map()
  const cache = new Map()
  const waiting = []
  let running = 0

  async function fetchPage (group, after, signal) {
    const r = await fetchJson('/index/group/' + group + (after === null ? '' : '/' + after), signal)
    if (!r.ok) return r
    const json = r.json
    if (!Array.isArray(json.writers)) return fail('recusado')
    if (json.next !== null && (typeof json.next !== 'string' || !HEX64_RE.test(json.next))) return fail('recusado')
    return { ok: true, page: json }
  }

  // -> { ok: true, json } (a plain object) | { ok: false, code }.
  async function fetchJson (pathname, signal) {
    let res
    try {
      // With the token the seeder charges these reads to its moderation
      // bucket, so visitors draining the public index bucket cannot starve
      // a moderator's checks (the body is the same; origin is loopback).
      res = await fetch(origin + pathname, {
        method: 'GET',
        redirect: 'error',
        headers: token === null ? {} : { authorization: 'Bearer ' + token },
        signal
      })
    } catch (err) {
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    let body
    try {
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return res.status === 404 ? fail('ausente') : fail('recusado')
      }
      body = await readCapped(res)
    } catch (err) {
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    if (body === null) return fail('recusado')
    let json
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      return fail('recusado')
    }
    if (!isPlainObject(json)) return fail('recusado')
    return { ok: true, json }
  }

  // One read per key at a time, a definite answer cached (see above).
  async function once (key, fn) {
    const t = now()
    const hit = cache.get(key)
    if (hit !== undefined) {
      if (t - hit.at < cacheMs) return hit.result
      cache.delete(key)
    }
    let p = inflight.get(key)
    if (p === undefined) {
      p = limited(fn).then((out) => {
        const { result, transient } = out.result === undefined ? { result: out, transient: false } : out
        // Only a definite answer is kept: a timeout or a refused read is
        // asked again next time, so a seeder back up is seen at once.
        if (!transient && (result.ok || DEFINITE.includes(result.code))) remember(key, result)
        return result
      }).finally(() => { inflight.delete(key) })
      inflight.set(key, p)
    }
    return await p
  }

  async function check (args) {
    try {
      const { group, writer, diary, seq } = args !== null && typeof args === 'object' ? args : {}
      if (!configured) return fail('config')
      for (const k of [group, writer, diary]) {
        if (typeof k !== 'string' || !HEX64_RE.test(k)) return fail('config')
      }
      if (!Number.isSafeInteger(seq) || seq < 1) return fail('config')
      // Without the token the message cannot be read: fail closed.
      if (token === null) return fail('config')
      return await once('g:' + group + writer + diary + ':' + seq, () => read(group, writer, diary, seq))
    } catch {
      return fail('recusado')
    }
  }

  // Whether the seeder serves `diary` as a diary: GET /index/groups/<D>
  // answers 200 only for a served, unblocked diary and 404 otherwise (a
  // group root key included), so a report without a group cannot have
  // 'Bloquear' queue a block of a group root.
  async function checkDiary (args) {
    try {
      const { diary } = args !== null && typeof args === 'object' ? args : {}
      if (!configured) return fail('config')
      if (typeof diary !== 'string' || !HEX64_RE.test(diary)) return fail('config')
      return await once('d:' + diary, async () => {
        const r = await fetchJson('/index/groups/' + diary, AbortSignal.timeout(timeoutMs))
        if (!r.ok) return r
        return Array.isArray(r.json.groups) ? { ok: true } : fail('recusado')
      })
    } catch {
      return fail('recusado')
    }
  }

  function remember (key, result) {
    const t = now()
    if (cache.size >= MAX_CACHE) {
      for (const [k, v] of cache) if (t - v.at >= cacheMs) cache.delete(k)
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
    }
    cache.set(key, { at: t, result })
  }

  async function limited (fn) {
    if (running >= MAX_RUNNING) {
      if (waiting.length >= MAX_WAITING) return fail('recusado')
      await new Promise((resolve) => waiting.push(resolve))
    }
    running++
    try {
      return await fn()
    } finally {
      running--
      const next = waiting.shift()
      if (next !== undefined) next()
    }
  }

  // The reported message itself, through the seeder's token-gated loopback
  // route GET /moderation-group-post/<writer>/<seq> (seed-ws.js): a block
  // rests on what the seeder holds, never on the reporter's quote alone.
  // ok only when the seeder decoded a group-post of exactly this group,
  // bound to exactly this diary. A 404 (not held yet, not a post) is
  // nao-lida, asked again later; no token is config.
  async function readPost (group, writer, diary, seq, signal) {
    let res
    try {
      res = await fetch(origin + '/moderation-group-post/' + writer + '/' + seq, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + token },
        signal
      })
    } catch (err) {
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    let body
    try {
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return res.status === 404 ? fail('nao-lida') : fail('recusado')
      }
      body = await readCapped(res)
    } catch (err) {
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    if (body === null) return fail('recusado')
    let json
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      return fail('recusado')
    }
    if (!isPlainObject(json) || json.group !== group || json.diary !== diary || json.seq !== seq) return fail('recusado')
    // A block of a private group: the seeder holds ciphertext only and
    // answers the structural fact, never text. The caller accepts it only
    // for a root the index shows as private.
    if (json.sealed === true) return json.writer === writer && json.texto === undefined ? { ok: true, sealed: true } : fail('recusado')
    if (typeof json.texto !== 'string' || json.texto.length > TEXTO_MAX) return fail('recusado')
    return { ok: true, texto: json.texto }
  }

  async function read (group, writer, diary, seq) {
    try {
      // One deadline for every page, so a slow seeder cannot hold a
      // moderator's decision for maxPages * timeoutMs.
      const signal = AbortSignal.timeout(timeoutMs)
      let after = null
      let header = null
      let headerless = false
      // An index still being built may simply not list the root or the
      // writer yet: that absence is asked again later, never cached as a
      // definite refusal.
      let partial = false
      for (let i = 0; i < maxPages; i++) {
        const r = await fetchPage(group, after, signal)
        if (!r.ok) return r
        const page = r.page
        if (page.indexing === true || page.complete !== true) partial = true
        // A writer row binds that writer to G and to its diary (the seeder
        // verified both), so the reported diary can be confirmed even when
        // the root header is missing; only `root` (the header's kind)
        // proves G itself is a group, which a 'grupo' block requires.
        if (typeof page.kind !== 'string' || page.kind === '') {
          headerless = true
        } else if (header === null) {
          header = {
            visibility: typeof page.visibility === 'string' ? page.visibility : null,
            name: typeof page.name === 'string' && page.name.length <= NAME_MAX ? page.name : null,
            creator: typeof page.creator === 'string' && HEX64_RE.test(page.creator) ? page.creator : null
          }
        }
        for (const w of page.writers) {
          if (isPlainObject(w) && w.key === writer) {
            if (w.diary !== diary) return fail('nao-membro')
            // The reported block must exist on that writer (block 0 is its
            // header), so a report cannot pin an invented message on a
            // writer the diary really holds.
            // A partial index may lag behind the writer's real length.
            // `length` is only the prefix the seeder downloaded: an author
            // withholding an earlier block must not make a later, real
            // reported post look nonexistent, so below the signed length
            // the message is still asked for and its absence never cached.
            // A row without `signed` (older seeder) keeps the prefix rule.
            let hole = false
            if (!Number.isSafeInteger(w.length) || w.length <= seq) {
              if (partial) return fail('recusado')
              if (w.signed !== undefined && !Number.isSafeInteger(w.signed)) return fail('recusado')
              if (w.signed === undefined || w.signed <= seq) return fail('sem-mensagem')
              hole = true
            }
            const post = await readPost(group, writer, diary, seq, signal)
            if (!post.ok) return hole ? { result: post, transient: true } : post
            if (post.sealed === true) {
              // Structural confirmation only: a sealed answer counts for a
              // verified private root, and a public group never answers so.
              if (header === null || header.visibility !== 'private') return header === null && partial ? { result: fail('recusado'), transient: true } : fail('recusado')
              return { ok: true, root: true, sealed: true, name: null, creator: header.creator, texto: null }
            }
            const result = { ok: true, root: header !== null, name: header?.name ?? null, creator: header?.creator ?? null, texto: post.texto }
            // A missing header on an index still being built may only lag:
            // asked again next time instead of holding 'root: false'.
            return header === null && partial ? { result, transient: true } : result
          }
        }
        // A cursor that does not move would loop to maxPages for nothing.
        if (page.next === null || page.next === after) break
        after = page.next
      }
      if (partial) return fail('recusado')
      return fail(header === null && headerless ? 'ausente' : 'nao-membro')
    } catch {
      return fail('recusado')
    }
  }

  return { check, checkDiary }
}

module.exports = {
  MAX_BODY,
  MAX_PAGES,
  MAX_RUNNING,
  CACHE_MS,
  createGroupCheck
}
