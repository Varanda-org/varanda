// Root resolution and target seek for the Conversa screen, with every I/O
// injected (fetchPost, fetchRoda, read, loadPage, has) so the orchestration
// is tested by behavior. Trust: the seeder index only says where to look; a
// chain is followed only through records read by `read` (diary.peek,
// verified against each author's signed log), comparing their SIGNED
// replyTo. Never throws.

import { isRef } from './nav.js'

// Climb limit on a seeder without /index/roda: one fetchPost and one read
// per hop, so a long chain cannot keep the screen loading.
export const MAX_HOPS = 8
export const SEEK_PAGES = 4

// Failures of the transport itself: surfaced as they are, never retried
// here (the screen decides, after retryAfterMs when rate-limited).
const TRANSIENT = new Set(['network', 'timeout', 'rate-limited'])

const refOf = (t) => t.author + ':' + t.seq
const isPost = (item) => !!item && typeof item === 'object' && item.kind === 'post'
const parentRef = (item) => item.replyTo && typeof item.replyTo === 'object' ? refOf(item.replyTo) : null

function failure (reason, retryAfterMs) {
  return { status: 'error', reason, retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0 }
}

async function call (fn, ...args) {
  try {
    const r = await fn(...args)
    if (!r || typeof r !== 'object') return { ok: false, reason: 'malformed' }
    if (r.ok && (!r.value || typeof r.value !== 'object')) return { ok: false, reason: 'malformed' }
    return r
  } catch {
    return { ok: false, reason: 'network' }
  }
}

// The verified post items at `refs`, null for any that cannot be read.
async function readPosts (read, refs, hints) {
  let m = null
  try { m = await read(refs, hints && typeof hints === 'object' ? hints : {}) } catch { return null }
  const out = new Map()
  for (const ref of refs) {
    const item = m instanceof Map ? m.get(ref) : null
    out.set(ref, isPost(item) && refOf(item) === ref ? item : null)
  }
  return out
}

// resolveRoot({ key, seed, climbOnly }, { fetchPost, fetchRoda, read })
// resolves to
// - { status: 'ok', root, top, target, index, page, proven }: root has signed
//   replyTo null; top is the comment (direct reply to root) whose roda holds
//   target, null when key is the root; target is key, null when key is the
//   root; index is the root's post index when one was fetched, page the first
//   roda page of top when the seeder gave one (both null otherwise);
//   proven says whether signed records already link key to top (see below);
// - { status: 'orphan', root, top: null, target, index: null, page: null,
//   cut }: root is the top-most readable message of key's chain (a parent is
//   unreadable, or `cut` true after MAX_HOPS);
// - { status: 'error', reason, retryAfterMs }.
// `read(refs, hints)` resolves to Map(ref -> verified post item or null);
// hints are the index's author hints { <hex64>: { profileSeq, usernameSeq } }.
//
// Why `proven`: the seeder's { root, top } is checked to be a genuine signed
// root and comment, but on its own that does not show key belongs under that
// top: a seeder can pair key with an unrelated valid conversation. Proving it
// would cost one read per hop before the screen can paint, so the fast path
// answers with proven false instead, and the screen confirms key in the
// verified roda of top (seekTarget). If it is not there, the screen calls
// again with climbOnly true, which skips fetchRoda and walks the signed chain
// (proven true or 'orphan').
export async function resolveRoot (args, io) {
  const { key, seed = null, climbOnly = false } = args && typeof args === 'object' ? args : {}
  const { fetchPost, fetchRoda, read } = io && typeof io === 'object' ? io : {}
  if (!isRef(key)) return failure('invalid-input')
  if (isPost(seed) && seed.replyTo === null && refOf(seed) === key) return ok(key, null, null, null, null, true)

  const indexes = new Map()
  const first = await call(fetchPost, key)
  if (!first.ok && TRANSIENT.has(first.reason)) return failure(first.reason, first.retryAfterMs)
  if (first.ok) indexes.set(key, first.value)
  const own = await readPosts(read, [key], first.ok ? first.value.authors : null)
  if (own === null) return failure('network')
  const item = own.get(key)
  if (item === null) return failure('unavailable')
  if (item.replyTo === null) return ok(key, null, null, indexes.get(key) || null, null, true)

  // A seeder that does not know key has no roda for it either; any other
  // failure of fetchPost only cost the hints.
  if (!climbOnly && first.reason !== 'not-found') {
    const rd = await call(fetchRoda, key)
    if (!rd.ok && TRANSIENT.has(rd.reason)) return failure(rd.reason, rd.retryAfterMs)
    if (rd.ok) {
      const checked = await checkRoda(read, key, item, rd.value)
      if (checked === undefined) return failure('network')
      if (checked !== null) {
        const proven = checked.top === key || parentRef(item) === checked.top
        return ok(checked.root, checked.top, key, null, rd.value, proven)
      }
    }
  }
  return climb(key, item, indexes, { fetchPost, read })
}

function ok (root, top, target, index, page, proven) {
  return { status: 'ok', root, top, target, index, page, proven }
}

// The seeder's { root, top } when the signed records agree: root's replyTo is
// null and top's replyTo is root. Null when they do not, undefined when the
// read itself failed.
async function checkRoda (read, key, item, page) {
  if (!page || typeof page !== 'object' || page.ref !== key) return null
  const { root, top } = page
  if (!isRef(root) || !isRef(top) || root === top || root === key) return null
  const refs = top === key ? [root] : [root, top]
  const got = await readPosts(read, refs, page.authors)
  if (got === null) return undefined
  const rootItem = got.get(root)
  const topItem = top === key ? item : got.get(top)
  if (rootItem === null || rootItem.replyTo !== null) return null
  if (topItem === null || parentRef(topItem) !== root) return null
  return { root, top }
}

// Walks up by SIGNED replyTo from key's verified item; the fetchPost per hop
// is only for the parent's author hints (its failure, other than a transient
// one, just means no hints).
async function climb (key, item, indexes, { fetchPost, read }) {
  let child = key
  let childItem = item
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const up = parentRef(childItem)
    const fp = await call(fetchPost, up)
    if (!fp.ok && TRANSIENT.has(fp.reason)) return failure(fp.reason, fp.retryAfterMs)
    if (fp.ok) indexes.set(up, fp.value)
    const got = await readPosts(read, [up], fp.ok ? fp.value.authors : null)
    if (got === null) return failure('network')
    const parent = got.get(up)
    if (parent === null) return orphan(child, key, false)
    if (parent.replyTo === null) return ok(up, child, key, indexes.get(up) || null, null, true)
    child = up
    childItem = parent
  }
  return orphan(child, key, true)
}

function orphan (root, target, cut) {
  return { status: 'orphan', root, top: null, target, index: null, page: null, cut }
}

// Pages the roda of top until `has(target)`, the cursor runs out or
// maxPages pages were loaded. loadPage(cursor) resolves to { next }, or null
// on failure, which stops the seek with `failed` and keeps the cursor of the
// page that failed in `next`. The first call uses `cursor` (null: the first
// page). A `has` that throws or is missing counts as not found.
export async function seekTarget (args, io) {
  const { target, maxPages = SEEK_PAGES, cursor = null } = args && typeof args === 'object' ? args : {}
  const { loadPage, has: probe } = io && typeof io === 'object' ? io : {}
  const has = (ref) => { try { return !!probe(ref) } catch { return false } }
  let next = cursor
  if (has(target)) return { found: true, next, failed: false }
  for (let i = 0; i < maxPages; i++) {
    let page = null
    try { page = await loadPage(next) } catch { page = null }
    if (!page || typeof page !== 'object') return { found: false, next, failed: true }
    next = typeof page.next === 'string' ? page.next : null
    if (has(target)) return { found: true, next, failed: false }
    if (next === null) break
  }
  return { found: false, next, failed: false }
}
