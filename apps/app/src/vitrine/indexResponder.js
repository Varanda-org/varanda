/* global URL */

import rpc from '@varanda/rpc'
import { findTags } from '../hashtags.js'
import { fixtures } from './fixtures.js'
import { createVitrineRequest, vitrineFeiraState, vitrineLiveRecords } from './request.js'
import { testimonialPointers, testimonialSource } from './testimonialIndex.js'

const { isKey, isRef } = rpc
let currentRequest

export function createIndexedVitrineRequest (data, options) {
  currentRequest = createVitrineRequest(data, options)
  return currentRequest
}

const flags = { indexing: false, complete: true }
const posts = [...fixtures.feed, ...fixtures.noticePosts]
const profiles = [...fixtures.members, ...fixtures.pages, ...fixtures.applicants]
const refOf = (p) => `${p.author}:${p.seq}`
const hint = () => ({ profileSeq: 1, usernameSeq: 2 })
const authorsOf = (keys) => Object.fromEntries([...new Set(keys)].map((key) => [key, hint()]))
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const matches = (text, segment) => {
  const words = fold(text).split(/[^a-z0-9]+/).filter(Boolean)
  return segment.split('-').every((token) => words.some((word) => word.startsWith(token)))
}
const pageHint = (author) => fixtures.pages.some((p) => p.author === author) ? { page: true, closed: false, moved: false } : {}
const edgeCursor = (p) => `${Date.parse(p.at)}.${p.author}.${p.seq}`
const oldestFirst = (a, b) => Date.parse(a.at) - Date.parse(b.at) || compare(a.author, b.author) || a.seq - b.seq
const quotesOrder = (a, b) => oldestFirst(b, a)
const newestFirst = (a, b) => Date.parse(b.at) - Date.parse(a.at) || compare(a.author, b.author) || b.seq - a.seq
const lastWrites = (entries, target) => {
  const latest = new Map()
  for (const e of entries) {
    const id = `${e.author}:${target(e.record)}`
    const previous = latest.get(id)
    if (!previous || e.seq > previous.seq) latest.set(id, e)
  }
  return [...latest.values()].filter((e) => e.record.on)
}

// Recados: the seeder's admission at read time, over the live Vitrine state
// (like the testimonials route), mirroring foldWall in packages/core/lib/scraps.js:
// deletes, the wall policy, owner hides, scraps dated over 24 h ahead dropped,
// and the reply exception (one reply per original, the lowest block, even when
// hidden; the reply no earlier than the original). Caps: 20 per writer, 500
// per page, over admitted scraps. Pointers only.
const SCRAP_CLOCK_MS = 3600000
const MAX_FUTURE_MS = 86400000
const badRequest = () => { throw Object.assign(new Error('status'), { reason: 'status' }) }

function liveEntries () {
  const { entries, deleted } = testimonialSource()
  return entries.filter((e) => !deleted.has(`${e.author}:${e.seq}`))
}

const liveFollowSeq = (live, author, target) => {
  const last = live.filter((e) => e.author === author && e.record.type === 'follow' && e.record.key === target).sort((a, b) => b.seq - a.seq)[0]
  return last && last.record.on ? last.seq : null
}

function scrapsIndex (owner, cursor) {
  requireProfile(owner)
  if (cursor !== undefined && !/^(0|[1-9][0-9]{0,5})$/.test(cursor)) badRequest()
  const live = liveEntries()
  const clock = Date.parse(fixtures.now) + SCRAP_CLOCK_MS
  const ownerLive = live.filter((e) => e.author === owner).sort((a, b) => a.seq - b.seq)
  const walls = ownerLive.filter((e) => e.record.type === 'scrap-wall')
  const latest = walls.reduce((best, e) => (best === null || e.seq > best.seq ? e : best), null)
  const who = latest === null ? 'following' : latest.record.who
  const hideRows = ownerLive.filter((e) => e.record.type === 'scrap-hide')
  const hidden = new Set(hideRows.map((e) => `${e.record.from}:${e.record.seq}`))
  const originals = new Map(ownerLive.filter((e) => e.record.type === 'scrap').map((e) => [e.seq, { to: e.record.to, t: Date.parse(e.record.at) }]))
  const admitted = []
  if (who !== 'nobody') {
    const writers = [...new Set(live.filter((e) => e.record.type === 'scrap' && e.record.to === owner && e.author !== owner).map((e) => e.author))]
    for (const author of writers) {
      const replied = new Set()
      const followSeq = who === 'everyone' ? null : liveFollowSeq(live, owner, author)
      const mine = live.filter((e) => e.author === author && e.record.type === 'scrap' && e.record.to === owner).sort((a, b) => a.seq - b.seq)
      const rows = []
      for (const e of mine) {
        const t = Date.parse(e.record.at)
        if (t - clock > MAX_FUTURE_MS) continue
        let answers = false
        if (who === 'following') {
          const rt = e.record.replyTo
          const original = rt !== null && rt.author === owner ? originals.get(rt.seq) : undefined
          if (original !== undefined && original.to === author && t >= original.t && !replied.has(rt.seq)) {
            answers = true
            replied.add(rt.seq)
          }
        }
        if (hidden.has(`${author}:${e.seq}`)) continue
        if (who === 'everyone' || followSeq !== null || answers) rows.push({ author, seq: e.seq, followSeq, t })
      }
      rows.sort((a, b) => b.t - a.t || b.seq - a.seq)
      admitted.push(...rows.slice(0, 20))
    }
  }
  admitted.sort((a, b) => b.t - a.t || compare(a.author, b.author) || b.seq - a.seq)
  const all = admitted.slice(0, 500)
  const start = cursor === undefined ? 0 : Number(cursor)
  const scraps = all.slice(start, start + 50).map(({ author, seq, followSeq }) => ({ author, seq, followSeq }))
  return { scraps, hides: hideRows.map((e) => e.seq).sort((a, b) => b - a).slice(0, 1000), wall: latest === null ? null : latest.seq, next: all.length > start + 50 ? String(start + 50) : null, ...flags }
}

// Varandinha (docs/protocol.md "Seeder Varandinha index"): pointers read from
// the live Vitrine records, at most one help per helper per Brasilia day and
// only helpers whose own live follow of the owner exists.
const newestSeq = (rows, type) => {
  const seqs = rows.filter((e) => e.record.type === type).map((e) => e.seq)
  return seqs.length === 0 ? null : Math.max(...seqs)
}

function gardenIndex (owner) {
  const live = liveEntries()
  const mine = live.filter((e) => e.author === owner)
  const flag = mine.filter((e) => e.record.type === 'garden').sort((a, b) => b.seq - a.seq)[0]
  const on = flag === undefined ? null : flag.seq
  // An off or never opened balcony names no state, helper or given help.
  if (flag === undefined || flag.record.on !== true) return { on, state: null, helps: [], given: [], ...flags }
  const days = new Map()
  for (const e of live.filter((x) => x.author !== owner && x.record.type === 'garden-help' && x.record.to === owner)) {
    const id = `${e.author}/${rpc.garden.dayStart(Date.parse(e.record.at))}`
    const previous = days.get(id)
    if (!previous || e.seq < previous.seq) days.set(id, e)
  }
  const helps = []
  for (const e of [...days.values()].sort((a, b) => Date.parse(b.record.at) - Date.parse(a.record.at) || compare(a.author, b.author) || a.seq - b.seq)) {
    const followSeq = liveFollowSeq(live, e.author, owner)
    if (followSeq !== null) helps.push({ author: e.author, seq: e.seq, followSeq })
  }
  const given = mine.filter((e) => e.record.type === 'garden-help').map((e) => e.seq).sort((a, b) => b - a)
  return { on, state: newestSeq(mine, 'garden-state'), helps: helps.slice(0, rpc.garden.GARDEN_HELP_ROWS), given: given.slice(0, rpc.garden.GARDEN_HELP_ROWS), ...flags }
}

// The Barraquinha pointers (docs/protocol.md "Seeder Varandinha index"), at
// the demo clock: only blocks above the owner's live on flag count. Pending
// reuses foldPending so the pick and the order match what the app folds.
function gardenStall (owner) {
  const live = liveEntries()
  const now = Date.parse(fixtures.now)
  const mine = live.filter((e) => e.author === owner)
  const flag = mine.filter((e) => e.record.type === 'garden').sort((a, b) => b.seq - a.seq)[0]
  if (flag === undefined || flag.record.on !== true) return { decor: null, pending: [], shelf: [], ...flags }
  const above = mine.filter((e) => e.seq > flag.seq)
  const takes = above.filter((e) => e.record.type === 'garden-take' && e.record.from !== owner).sort((a, b) => b.seq - a.seq)
  const giftOf = (author, seq) => live.find((e) => e.author === author && e.seq === seq && e.record.type === 'garden-gift')
  const shelf = takes.filter((e) => {
    const g = giftOf(e.record.from, e.record.seq)
    return g !== undefined && g.record.to === owner && rpc.garden.offerListable(Date.parse(g.record.at), now)
  }).map((e) => ({ seq: e.seq, from: e.record.from, gseq: e.record.seq }))
  const gifts = live.filter((e) => e.author !== owner && e.record.type === 'garden-gift' && e.record.to === owner).flatMap((e) => {
    const followSeq = liveFollowSeq(live, e.author, owner)
    const follow = followSeq === null ? undefined : live.find((x) => x.author === e.author && x.seq === followSeq)
    return follow === undefined ? [] : [{ author: e.author, seq: e.seq, record: e.record, follow: follow.record, followSeq }]
  })
  const followed = new Set(lastWrites(mine.filter((e) => e.record.type === 'follow'), (r) => r.key).map((e) => e.record.key))
  const taken = takes.map((e) => ({ from: e.record.from, seq: e.record.seq }))
  const rows = rpc.garden.foldPending({ owner, now, gifts, taken, followed }).rows
  const pending = rows.map((r) => ({ author: r.author, seq: r.seq, followSeq: gifts.find((g) => g.author === r.author && g.seq === r.seq).followSeq }))
  return { decor: newestSeq(above, 'garden-decor'), pending, shelf: shelf.slice(0, rpc.garden.GARDEN_SHELF_ROWS), ...flags }
}

function gardenStreet (owner, cursor) {
  if (cursor !== undefined && !isKey(cursor)) notFound()
  const live = liveEntries()
  const follows = lastWrites(live.filter((e) => e.author === owner && e.record.type === 'follow'), (r) => r.key).map((e) => e.record.key)
  const rows = []
  for (const key of [...new Set(follows)].sort(compare)) {
    if (cursor !== undefined && key <= cursor) continue
    const theirs = live.filter((e) => e.author === key)
    const flag = theirs.filter((e) => e.record.type === 'garden').sort((a, b) => b.seq - a.seq)[0]
    if (flag && flag.record.on === true) rows.push({ key, on: flag.seq, state: newestSeq(theirs, 'garden-state') })
  }
  const items = rows.slice(0, rpc.garden.GARDEN_STREET_PAGE)
  return { items, next: rows.length > items.length ? items[items.length - 1].key : null, ...flags }
}

function notFound () {
  throw Object.assign(new Error('not-found'), { reason: 'not-found' })
}

function requireProfile (author) {
  if (!profiles.some((p) => p.author === author)) notFound()
}

function requirePost (ref) {
  const post = posts.find((p) => refOf(p) === ref)
  if (!post) notFound()
  return post
}

const diaryRows = (request) => [...fixtures.diaryRecords, ...vitrineLiveRecords(request)]

function edges (ref, kind, request) {
  if (kind === 'replies' || kind === 'quotes') {
    const field = kind === 'replies' ? 'replyTo' : 'quote'
    return posts.filter((p) => p[field] && refOf(p[field]) === ref)
  }
  const type = kind.slice(0, -1)
  return lastWrites(diaryRows(request).filter((e) => e.record.type === type && refOf(e.record.to) === ref), (r) => refOf(r.to))
    .map((e) => ({ author: e.author, seq: e.seq, at: e.record.at }))
}

function counts (ref, request) {
  return Object.fromEntries(['replies', 'reposts', 'likes', 'quotes'].map((kind) => [kind, edges(ref, kind, request).length]))
}

function edgePage (rows, cursor, limit, order = oldestFirst) {
  let after = null
  if (cursor !== undefined) {
    if (!/^[0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}$/.test(cursor)) notFound()
    const [at, author, seq] = cursor.split('.')
    after = { at: new Date(Number(at)).toISOString(), author, seq: Number(seq) }
  }
  const ordered = rows.filter((p) => after === null || order(p, after) > 0).sort(order)
  const page = ordered.slice(0, limit)
  return { items: page.map(refOf), next: ordered.length > limit ? edgeCursor(page[page.length - 1]) : null }
}

// The seeder's roda (packages/core/lib/engagement-index.js): root and top by
// walking replyTo up, then top's subtree breadth first, each reply keyed at
// max(own at, its parent's key + 1) so it sorts after its parent, ordered by
// (key, author, seq) and paged 50 strictly after the cursor. A post that is
// not a reply, or whose chain breaks or loops, is not-found.
function roda (ref, cursor) {
  const post = requirePost(ref)
  if (!post.replyTo) notFound()
  const seenUp = new Set([ref])
  let top = ref
  let parent = refOf(post.replyTo)
  let root = null
  while (root === null) {
    if (seenUp.has(parent)) notFound()
    seenUp.add(parent)
    const p = requirePost(parent)
    if (p.replyTo) {
      top = parent
      parent = refOf(p.replyTo)
    } else {
      root = parent
    }
  }
  const kept = []
  const keyOf = new Map()
  const seenDown = new Set([top])
  const queue = [top]
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]
    const base = keyOf.get(node)
    for (const child of posts.filter((p) => p.replyTo && refOf(p.replyTo) === node).sort(oldestFirst)) {
      const childRef = refOf(child)
      if (seenDown.has(childRef)) continue
      seenDown.add(childRef)
      const atMs = base === undefined ? Date.parse(child.at) : Math.max(Date.parse(child.at), base + 1)
      keyOf.set(childRef, atMs)
      kept.push({ atMs, author: child.author, seq: child.seq, ref: childRef, to: node })
      queue.push(childRef)
    }
  }
  const order = (a, b) => a.atMs - b.atMs || compare(a.author, b.author) || a.seq - b.seq
  kept.sort(order)
  let start = 0
  if (cursor !== undefined) {
    if (!/^[0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}$/.test(cursor)) notFound()
    const [at, author, seq] = cursor.split('.')
    const after = { atMs: Number(at), author, seq: Number(seq) }
    while (start < kept.length && order(kept[start], after) <= 0) start++
  }
  const page = kept.slice(start, start + 50)
  const last = page[page.length - 1]
  return {
    ...flags,
    ref,
    root,
    top,
    items: page.map(({ ref, to }) => ({ ref, to })),
    next: page.length > 0 && start + page.length < kept.length ? `${last.atMs}.${last.author}.${last.seq}` : null,
    total: kept.length,
    authors: authorsOf([ref, root, top, ...page.map((item) => item.ref)].map((r) => r.split(':')[0]))
  }
}

function followRows (author, kind) {
  const related = fixtures.diaryRecords.filter(({ author: from, record: r }) => r.type === 'follow' && (kind === 'seguindo' ? from === author : r.key === author))
  return lastWrites(related, (r) => r.key)
    .map(({ author: from, seq, record }) => ({ key: kind === 'seguindo' ? record.key : from, seq, at: record.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compare(a.key, b.key))
}

function fanRows (author) {
  const related = liveEntries().filter(({ record: r }) => r.type === 'fan' && r.key === author)
  return lastWrites(related, (r) => r.key)
    .map(({ author: from, seq, record }) => ({ key: from, seq, at: record.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compare(a.key, b.key))
}

async function readGroupItems (request, group) {
  const items = []
  let before = null
  do {
    const page = await request('group.read', { group, limit: rpc.GROUP_LIMIT_MAX, ...(before && { before }) })
    items.push(...page.items)
    before = page.next
  } while (before !== null)
  return items
}

function withGroups (request, groups, answer) {
  if (!request) return answer(groups)
  // Read the roster and posts from the fixture node to pick up session changes.
  return Promise.all(groups.map(async (g) => {
    const [{ members }, items] = await Promise.all([
      request('group.members', { group: g.group }),
      readGroupItems(request, g.group)
    ])
    return { ...g, items, roster: new Set(members.map((m) => m.member)) }
  })).then(answer)
}

const hasJoined = (group, diary) => group.roster === undefined ? !(diary === fixtures.own && group.role === 'left') : group.roster.has(diary)

function writersOf (group) {
  const rows = new Map([[group.writer, { key: group.writer, diary: fixtures.own, seq: 1, length: 2, signed: 2, left: !hasJoined(group, fixtures.own) }]])
  for (const item of group.items) {
    const previous = rows.get(item.writer)
    const seq = Math.max(previous ? previous.seq : 1, item.seq)
    rows.set(item.writer, { key: item.writer, diary: item.diary, seq, length: seq + 1, signed: seq + 1, left: !hasJoined(group, item.diary) })
  }
  return [...rows.values()].sort((a, b) => compare(a.key, b.key))
}

const diaryCount = (group) => new Set(writersOf(group).filter((w) => !w.left).map((w) => w.diary)).size

function activeReposts (author, request) {
  const latest = new Map()
  for (const e of diaryRows(request)) {
    if (e.author !== author || e.record.type !== 'repost') continue
    const target = refOf(e.record.to)
    const previous = latest.get(target)
    if (!previous || e.seq > previous.seq) latest.set(target, e)
  }
  return [...latest.values()].filter((e) => e.record.on).map((e) => e.seq)
}

function communityRows (groups) {
  return groups.sort((a, b) => compare(a.group, b.group))
    .map((g) => ({ group: g.group, join: g.join, visibility: g.visibility, name: g.visibility === 'private' ? null : g.name, writerCount: g.visibility === 'private' ? null : diaryCount(g) }))
}

// Discovery rows (/index/group-browse, /index/public-groups): public groups
// of a community only; groups without community are listed only by the newer routes. The fixtures carry no header date, so a group can only be dated
// from its first post. Activity uses the seeder's time bounds at the fixture clock.
const ACTIVE_WINDOW_MS = 7 * 86400000
const TREND_MIN_ACTIVE = 2
const BROWSE_MAX = 20
const PUBLIC_GROUPS_PAGE = 32
const legacyListed = (g) => g.visibility === 'public' && g.community !== null
const RECENT_PER_CREATOR = 2

function publicRow (g) {
  const c = fixtures.communities.find((c) => c.community === g.community)
  return { group: g.group, name: g.name, creator: g.creator, community: g.community, communityName: c ? c.name : null, writerCount: diaryCount(g) }
}

function groupCreated (g) {
  const dates = g.items.map((item) => Date.parse(item.at))
  return dates.length === 0 ? null : Math.min(...dates)
}

function groupActive (g) {
  const now = Date.parse(fixtures.now)
  const diaries = g.items.filter((item) => {
    const ms = Date.parse(item.at)
    return hasJoined(g, item.diary) && ms >= now - ACTIVE_WINDOW_MS && ms <= now + MAX_FUTURE_MS
  }).map((item) => item.diary)
  return new Set(diaries).size
}

function groupBrowse (order, groups) {
  // As the seeder, a group whose last counted member left is not listed:
  // the client refuses a whole page with a row of writerCount 0.
  let rows = groups.map((g) => ({ ...publicRow(g), created: groupCreated(g), active: order === 'trending' ? groupActive(g) : null })).filter((r) => r.writerCount >= 1)
  if (order === 'members') rows.sort((a, b) => b.writerCount - a.writerCount || compare(a.group, b.group))
  if (order === 'trending') rows = rows.filter((r) => r.active >= TREND_MIN_ACTIVE).sort((a, b) => b.active - a.active || compare(a.group, b.group))
  if (order === 'recent') {
    const perCreator = new Map()
    rows = rows.filter((r) => r.created !== null).sort((a, b) => b.created - a.created || compare(a.group, b.group)).filter((r) => {
      const n = (perCreator.get(r.creator) || 0) + 1
      perCreator.set(r.creator, n)
      return n <= RECENT_PER_CREATOR
    })
  }
  return { ...flags, groups: rows.slice(0, BROWSE_MAX), more: rows.length > BROWSE_MAX }
}

function publicGroupsOf (diary, after, request) {
  const setting = liveEntries().filter((e) => e.author === diary && e.record.type === 'groups-show').sort((a, b) => b.seq - a.seq)[0]
  if (setting?.record.on === false) return { ...flags, groups: [], next: null, hidden: true }
  // A community's Geral is left out, as the seeder does.
  const gerais = new Set(fixtures.communities.map((c) => c.general))
  const candidates = fixtures.groups.filter((g) => legacyListed(g) && g.join === 'open' && !gerais.has(g.group) && (after === undefined || g.group > after))
  return withGroups(request, candidates, (live) => {
    const rows = live.filter((g) => writersOf(g).some((w) => w.diary === diary && !w.left))
      .sort((a, b) => compare(a.group, b.group))
      .map(publicRow)
    const groups = rows.slice(0, PUBLIC_GROUPS_PAGE)
    return { ...flags, groups, next: rows.length > PUBLIC_GROUPS_PAGE ? groups[groups.length - 1].group : null, hidden: false }
  })
}

const standaloneListed = (g) => g.visibility === 'public' && g.join === 'open' && g.community === null
const standaloneRow = (g) => ({ group: g.group, name: g.name, creator: g.creator, writerCount: diaryCount(g) })

function discoverCommunities () {
  // Community fixtures are public unless marked otherwise. Like the existing
  // community route, counts use the demo members; dates use the first post.
  return fixtures.communities.filter((c) => c.visibility !== 'private').map((c) => ({
    community: c.community,
    name: c.name,
    creator: c.creator,
    join: c.join,
    members: fixtures.members.length,
    created: groupCreated({ items: fixtures.groups.filter((g) => g.community === c.community).flatMap((g) => g.items) })
  }))
}

function discoverCommunityBrowse (order) {
  let rows = discoverCommunities()
  if (order === 'members') rows.sort((a, b) => b.members - a.members || compare(a.community, b.community))
  else {
    const perCreator = new Map()
    rows = rows.filter((r) => r.created !== null).sort((a, b) => b.created - a.created || compare(a.community, b.community)).filter((r) => {
      const n = (perCreator.get(r.creator) || 0) + 1
      perCreator.set(r.creator, n)
      return n <= RECENT_PER_CREATOR
    })
  }
  return { communities: rows.slice(0, BROWSE_MAX), more: rows.length > BROWSE_MAX, ...flags }
}

function discoverSearch (segment, request) {
  if (!/^[a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3}$/.test(segment || '') || segment.replace(/-/g, '').length < 2) notFound()
  const query = segment.split('-')
  const hits = (rows, key, count) => rows.map((r) => ({ ...r, tokens: fold(r.name).split(/[^a-z0-9]+/).filter(Boolean) }))
    .filter((r) => query.every((q) => r.tokens.some((token) => token.startsWith(q))))
    .sort((a, b) => Number(b.tokens.join('-') === segment) - Number(a.tokens.join('-') === segment) || b[count] - a[count] || compare(a[key], b[key]))
  return withGroups(request, fixtures.groups.filter(standaloneListed), (live) => {
    const groups = hits(live.map(standaloneRow).filter((r) => r.writerCount >= 1), 'group', 'writerCount')
    const communities = hits(discoverCommunities(), 'community', 'members')
    return {
      groups: groups.slice(0, BROWSE_MAX).map(({ group, name, writerCount }) => ({ group, name, writerCount })),
      communities: communities.slice(0, BROWSE_MAX).map(({ community, name, members }) => ({ community, name, members })),
      moreGroups: groups.length > BROWSE_MAX,
      moreCommunities: communities.length > BROWSE_MAX,
      ...flags
    }
  })
}

function discoverGroupsOf (diary, after, request) {
  const setting = liveEntries().filter((e) => e.author === diary && e.record.type === 'groups-show').sort((a, b) => b.seq - a.seq)[0]
  if (setting?.record.on === false) return { ...flags, groups: [], next: null, hidden: true }
  const candidates = fixtures.groups.filter((g) => standaloneListed(g) && (after === undefined || g.group > after))
  return withGroups(request, candidates, (live) => {
    const rows = live.filter((g) => writersOf(g).some((w) => w.diary === diary && !w.left))
      .sort((a, b) => compare(a.group, b.group)).map(standaloneRow)
    const groups = rows.slice(0, PUBLIC_GROUPS_PAGE)
    return { ...flags, groups, next: rows.length > PUBLIC_GROUPS_PAGE ? groups[groups.length - 1].group : null, hidden: false }
  })
}

// Assuntos do momento: per tag, the distinct fixture authors whose posts
// carry it. The seeder keeps a tag only from 3 authors; the Vitrine has few,
// so 1 is enough here.
const TOPIC_TREND_MAX = 10

function topicTrend () {
  const authors = new Map()
  for (const p of posts) {
    for (const { tag } of findTags(p.text)) {
      if (!authors.has(tag)) authors.set(tag, new Set())
      authors.get(tag).add(p.author)
    }
  }
  const topics = [...authors].map(([tag, set]) => ({ tag, authors: set.size }))
    .sort((a, b) => b.authors - a.authors || compare(a.tag, b.tag))
  return { topics: topics.slice(0, TOPIC_TREND_MAX), ...flags }
}

function feiraIndex (segments, request) {
  let state = vitrineFeiraState(request)
  if (state === null) state = vitrineFeiraState(createVitrineRequest(fixtures))
  let rows, cursor
  const [route, key, kind, cat, ...tail] = segments
  const ratings = route === 'avaliacoes'
  if (route === 'autor' || ratings) {
    if (!isKey(key) || segments.length > 3) notFound()
    cursor = kind
    rows = ratings
      ? state.rates.filter((e) => e.record.to.author === key).map((e) => ({ ...e, at: e.record.at }))
      : state.listings.filter((e) => e.author === key).map((e) => ({ ...e, at: e.record.at }))
  } else {
    if (!rpc.feira.isUf(route?.toUpperCase()) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ||
        !['todos', ...rpc.feira.KINDS].includes(kind) || !['todas', ...rpc.feira.CATS].includes(cat) || tail.length > 2) notFound()
    let tokens = null
    if (tail[0]?.includes('.')) cursor = tail[0]
    else { tokens = tail[0]; cursor = tail[1] }
    if ((tail.length === 2 && tokens === null) || (tokens !== undefined && tokens !== null && !/^[a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}$/.test(tokens))) notFound()
    rows = state.listings.filter((e) => {
      const r = e.record
      const words = fold(r.title + ' ' + r.text).split(/[^a-z0-9]+/)
      return e.status !== 'vendido' && r.place.uf.toLowerCase() === route && rpc.feira.cityKey(r.place.city) === key &&
        (kind === 'todos' ? r.kind !== 'procura' : r.kind === kind) && (cat === 'todas' || r.cat === cat) &&
        (!tokens || tokens.split('+').every((token) => words.includes(token)))
    }).map((e) => ({ ...e, at: e.record.at }))
  }
  const page = edgePage(rows, cursor, 30, newestFirst)
  const items = page.items.map((ref) => {
    if (ratings) return { ref }
    const { status, statusSeq, editSeq } = rows.find((e) => refOf(e) === ref)
    return { ref, status, statusSeq, editSeq }
  })
  const authors = Object.fromEntries([...new Set(items.map((i) => i.ref.split(':')[0]))].map((author) => [author, { ...hint(), ...pageHint(author) }]))
  return { ...flags, items, next: page.next, authors }
}

// Enquetes: pointers and totals read from the live choice records (the
// seeder's claim, like the testimonial route). The last in-range choice of each
// voter counts and a null pick withdraws it (packages/core/lib/polls.js).
function pollIndex (author, seqText, pickText, cursorText) {
  if (!isKey(author) || !/^[1-9][0-9]{0,14}$/.test(seqText || '')) notFound()
  const seq = Number(seqText)
  const live = liveEntries()
  const root = live.find((e) => e.author === author && e.seq === seq && e.record.type === 'post' && (Array.isArray(e.record.poll) || e.record.event))
  if (!root) notFound()
  // An event post is a 2-option poll (going, maybe).
  const count = Array.isArray(root.record.poll) ? root.record.poll.length : 2
  const picks = new Map()
  for (const e of live.filter((x) => x.record.type === 'choice' && x.record.to.author === author && x.record.to.seq === seq).sort((a, b) => a.seq - b.seq)) {
    const pick = e.record.pick
    if (pick === null) picks.delete(e.author)
    else if (pick < count) picks.set(e.author, { pick, seq: e.seq, at: e.record.at })
  }
  if (pickText === undefined) {
    const totals = new Array(count).fill(0)
    for (const v of picks.values()) totals[v.pick]++
    return { ...flags, totals }
  }
  if (!/^[0-3]$/.test(pickText) || Number(pickText) >= count) notFound()
  let after = null
  if (cursorText !== undefined) {
    if (!/^[0-9]+\.[0-9a-f]{64}$/.test(cursorText)) notFound()
    const [atMs, key] = cursorText.split('.')
    after = { atMs: Number(atMs), key }
  }
  const rows = [...picks].filter(([, v]) => v.pick === Number(pickText)).map(([key, v]) => ({ key, seq: v.seq, at: v.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compare(a.key, b.key))
  const remaining = rows.filter((r) => after === null || Date.parse(r.at) < after.atMs || (Date.parse(r.at) === after.atMs && r.key > after.key))
  const items = remaining.slice(0, 20)
  const last = items[items.length - 1]
  return { ...flags, items, next: remaining.length > 20 ? { atMs: Date.parse(last.at), key: last.key } : null, total: rows.length, authors: authorsOf(items.map((r) => r.key)) }
}

// Only fixture references are returned: screens verify them through diary.peek.
export function vitrineIndex (url, request = currentRequest) {
  let path
  try { path = new URL(url, 'https://vitrine.invalid').pathname } catch { notFound() }
  const segments = path.split('/')
  if (segments[1] === 'index' && segments[2] === 'feira') return feiraIndex(segments.slice(3), request)
  if (segments[1] === 'index' && segments[2] === 'poll') {
    if (segments.length < 5 || segments.length > 7) notFound()
    return pollIndex(segments[3], segments[4], segments[5], segments[6])
  }
  if (segments.length === 3 && segments[1] === 'index' && segments[2] === 'topic-trend') return topicTrend()
  const [, index, route, key, part, cursor, ...extra] = segments
  if (index !== 'index' || !key || extra.length) notFound()

  if (route === 'discover') {
    if (key === 'groups' && cursor === undefined && ['members', 'recent', 'trending'].includes(part)) {
      return withGroups(request, fixtures.groups.filter(standaloneListed), (live) => {
        const page = groupBrowse(part, live)
        return { ...page, groups: page.groups.map(({ group, name, creator, writerCount, created, active }) => ({ group, name, creator, writerCount, created, active })) }
      })
    }
    if (key === 'communities' && cursor === undefined && ['members', 'recent'].includes(part)) return discoverCommunityBrowse(part)
    if (key === 'search' && cursor === undefined) return discoverSearch(part, request)
    if (key === 'of' && isKey(part) && (cursor === undefined || isKey(cursor))) {
      requireProfile(part)
      return discoverGroupsOf(part, cursor, request)
    }
    notFound()
  }

  if (['post', 'likes', 'reposts', 'quotes'].includes(route) && part !== undefined) {
    const ref = `${key}:${part}`
    if (!isRef(ref)) notFound()
    const post = requirePost(ref)
    if (route !== 'post') {
      const rows = edges(ref, route, request)
      const page = edgePage(rows, cursor, 20, route === 'quotes' ? quotesOrder : newestFirst)
      return { ...flags, ref, kind: route, ...page, total: rows.length, authors: authorsOf(page.items.map((r) => r.split(':')[0])) }
    }
    const page = edgePage(edges(ref, 'replies', request), cursor, 50)
    const quotes = edgePage(edges(ref, 'quotes', request), undefined, 50, quotesOrder).items
    const parent = post.replyTo ? refOf(post.replyTo) : null
    const c = counts(ref, request)
    return { ...flags, ref, parent, replies: page.items, next: page.next, quotes, likes: c.likes, reposts: c.reposts, repliesTotal: c.replies, quotesTotal: c.quotes, authors: authorsOf([ref, parent, ...page.items, ...quotes].filter(Boolean).map((r) => r.split(':')[0])) }
  }

  if (route === 'roda' && part !== undefined) {
    const ref = `${key}:${part}`
    if (!isRef(ref) || part.length > 15) notFound()
    return roda(ref, cursor)
  }

  if (route === 'counts' && part === undefined) {
    const refs = key.split(',')
    if (refs.length > 31 || !refs.every((ref) => isRef(ref))) notFound()
    return { ...flags, counts: Object.fromEntries(refs.filter((ref) => posts.some((p) => refOf(p) === ref)).map((ref) => [ref, counts(ref, request)])) }
  }

  if (route === 'member' && cursor === undefined) {
    requireProfile(key)
    if (part !== undefined && !/^[1-9][0-9]*$/.test(part)) notFound()
    const seqs = [...new Set([...posts.filter((p) => p.author === key).map((p) => p.seq), ...activeReposts(key, request)])].sort((a, b) => b - a)
    const records = [...fixtures.diaryRecords, ...fixtures.listings, ...fixtures.rates].filter((e) => e.author === key)
    return { ...flags, ...hint(), ...pageHint(key), length: Math.max(2, ...seqs, ...records.map((e) => e.seq)) + 1, posts: seqs.filter((seq) => part === undefined || seq < Number(part)).slice(0, 100), postsTotal: seqs.length }
  }

  if (route === 'events' && cursor === undefined) {
    requireProfile(key)
    if (part !== undefined && !/^[1-9][0-9]*$/.test(part)) notFound()
    const seqs = posts.filter((p) => p.author === key && p.event).map((p) => p.seq).sort((a, b) => b - a).filter((seq) => part === undefined || seq < Number(part))
    return { ...flags, posts: seqs.slice(0, 30), next: seqs.length > 30 ? seqs[29] : null, total: seqs.length }
  }

  if (route === 'topic' && cursor === undefined) {
    const tokens = key.split('+')
    const rows = posts.filter((p) => tokens.every((token) => fold(p.text).split(/[^a-z0-9]+/).includes(token)))
    const page = edgePage(rows, part, 30, newestFirst)
    return { ...flags, ...page, authors: authorsOf(page.items.map((r) => r.split(':')[0])) }
  }

  if (route === 'follows') {
    requireProfile(key)
    if (part === undefined) return { ...flags, seguindo: followRows(key, 'seguindo').length, seguidores: followRows(key, 'seguidores').length }
    if (part !== 'seguindo' && part !== 'seguidores') notFound()
    const rows = followRows(key, part)
    let after = null
    if (cursor !== undefined) {
      if (!/^[0-9]+\.[0-9a-f]{64}$/.test(cursor)) notFound()
      const [atMs, key] = cursor.split('.')
      after = { atMs: Number(atMs), key }
    }
    const remaining = rows.filter((r) => after === null || Date.parse(r.at) < after.atMs || (Date.parse(r.at) === after.atMs && r.key > after.key))
    const items = remaining.slice(0, 20)
    const last = items[items.length - 1]
    return { ...flags, author: key, kind: part, items, total: rows.length, next: remaining.length > 20 ? { atMs: Date.parse(last.at), key: last.key } : null, authors: authorsOf(items.map((r) => r.key)) }
  }

  if (route === 'fans') {
    requireProfile(key)
    const rows = fanRows(key)
    let after = null
    const raw = part
    if (raw !== undefined) {
      if (!/^[0-9]+\.[0-9a-f]{64}$/.test(raw)) notFound()
      const [atMs, k] = raw.split('.')
      after = { atMs: Number(atMs), key: k }
    }
    const remaining = rows.filter((r) => after === null || Date.parse(r.at) < after.atMs || (Date.parse(r.at) === after.atMs && r.key > after.key))
    const items = remaining.slice(0, 20)
    const last = items[items.length - 1]
    return { ...flags, author: key, items, total: rows.length, next: remaining.length > 20 ? { atMs: Date.parse(last.at), key: last.key } : null, authors: authorsOf(items.map((r) => r.key)) }
  }

  if (route === 'search' && part === undefined) {
    const rows = profiles.filter((p) => matches(p.name + ' ' + p.username, key))
    return { ...flags, members: rows.slice(0, 20).map((p) => ({ author: p.author, ...hint(), ...pageHint(p.author) })), more: rows.length > 20 }
  }

  if ((route === 'group-image' || route === 'group-about') && part === undefined) {
    const keys = key.split(',')
    if (keys.length > 32 || !keys.every(isKey) || new Set(keys).size !== keys.length) notFound()
    if (route === 'group-image') return { images: [], indexing: false }
    const abouts = keys.flatMap((group) => {
      const root = fixtures.communities.find((c) => c.community === group) || fixtures.groups.find((g) => g.group === group && g.visibility === 'public')
      return typeof root?.about === 'string' && root.about !== '' ? [{ group, about: root.about }] : []
    })
    return { abouts, indexing: false }
  }

  if (route === 'group' && cursor === undefined) {
    const g = fixtures.groups.find((g) => g.group === key)
    if (!g || (part !== undefined && !isKey(part))) notFound()
    return withGroups(request, [g], ([group]) => {
      const rows = writersOf(group).filter((w) => part === undefined || w.key > part)
      const writers = rows.slice(0, 64)
      return { ...flags, kind: 'group', visibility: g.visibility, join: g.join, name: g.visibility === 'private' ? null : g.name, creator: g.creator, community: g.community, attached: true, rootServed: true, writers, next: rows.length > 64 ? writers[writers.length - 1].key : null }
    })
  }

  if (route === 'groups' && part === undefined) {
    requireProfile(key)
    return withGroups(request, fixtures.groups, (live) => {
      const groups = live.flatMap((g) => {
        const writer = writersOf(g).find((w) => w.diary === key)
        return writer ? [{ group: g.group, writer: writer.key, seq: writer.seq, left: writer.left }] : []
      })
      return { ...flags, groups }
    })
  }

  if (route === 'community') {
    const c = fixtures.communities.find((c) => c.community === key)
    if (!c || (part !== undefined && (part !== 'groups' || !isKey(cursor)))) notFound()
    const candidates = fixtures.groups.filter((g) => g.community === key && (cursor === undefined || g.group > cursor))
    return withGroups(request, candidates, (live) => {
      const rows = communityRows(live)
      const groups = rows.slice(0, 32)
      const body = { ...flags, groups, next: rows.length > 32 ? groups[groups.length - 1].group : null }
      return part === undefined ? { ...body, name: c.name, join: c.join, creator: c.creator, members: fixtures.members.length } : body
    })
  }

  if (route === 'testimonials' && part === undefined) {
    requireProfile(key)
    const { entries, deleted } = testimonialSource()
    // unshown is the demo node's own view; the seeder answer has no such key.
    const { shown, pending } = testimonialPointers(entries, deleted, key)
    return { shown, pending, ...flags }
  }

  if (route === 'scraps' && cursor === undefined) {
    if (!isKey(key)) notFound()
    return scrapsIndex(key, part)
  }

  if (route === 'profile' && part === undefined) {
    requireProfile(key)
    const latest = (type) => {
      const rows = liveEntries().filter((e) => e.author === key && e.record.type === type)
      return rows.length === 0 ? null : Math.max(...rows.map((e) => e.seq))
    }
    const rows = (type) => liveEntries().filter((e) => e.author === key && e.record.type === type).sort((a, b) => b.seq - a.seq)
    const fans = fanRows(key)
    const top = rows('top-friends')[0]
    const back = top ? Object.fromEntries(top.record.keys.map((k) => [k, liveFollowSeq(liveEntries(), k, key)])) : null
    return { about: latest('profile-about'), mood: latest('mood'), visits: latest('visits'), garden: latest('garden'), fans: { count: fans.length, indexing: false }, top: top ? { seq: top.seq, back } : null, ...flags }
  }

  if (route === 'garden') {
    if (!isKey(key) || (part !== undefined && part !== 'rua' && part !== 'mimos') || (part !== 'rua' && cursor !== undefined)) notFound()
    requireProfile(key)
    if (part === 'mimos') return gardenStall(key)
    return part === undefined ? gardenIndex(key) : gardenStreet(key, cursor)
  }

  if (route === 'follow' && cursor === undefined) {
    if (!isKey(key) || !isKey(part)) notFound()
    requireProfile(key)
    return { seq: liveFollowSeq(liveEntries(), key, part), indexing: false }
  }

  if (route === 'group-search' && part === undefined) {
    const rows = fixtures.groups.filter((g) => legacyListed(g) && matches(g.name, key))
    return withGroups(request, rows.slice(0, 20), (live) => ({
      ...flags, groups: live.map((g) => ({ group: g.group, name: g.name, writerCount: diaryCount(g) })), more: rows.length > 20
    }))
  }

  if (route === 'group-browse' && part === undefined) {
    if (!['members', 'recent', 'trending'].includes(key)) notFound()
    return withGroups(request, fixtures.groups.filter(legacyListed), (live) => groupBrowse(key, live))
  }

  if (route === 'public-groups' && cursor === undefined) {
    requireProfile(key)
    if (part !== undefined && !isKey(part)) notFound()
    return publicGroupsOf(key, part, request)
  }

  notFound()
}
