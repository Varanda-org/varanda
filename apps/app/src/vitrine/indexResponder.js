/* global URL */

import rpc from '@varanda/rpc'
import { fixtures, testimonialHash } from './fixtures.js'
import { createVitrineRequest, vitrineFeiraState } from './request.js'

const { isKey, isRef } = rpc
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

function edges (ref, kind) {
  if (kind === 'replies' || kind === 'quotes') {
    const field = kind === 'replies' ? 'replyTo' : 'quote'
    return posts.filter((p) => p[field] && refOf(p[field]) === ref)
  }
  const type = kind.slice(0, -1)
  return lastWrites(fixtures.diaryRecords.filter((e) => e.record.type === type && refOf(e.record.to) === ref), (r) => refOf(r.to))
    .map((e) => ({ author: e.author, seq: e.seq, at: e.record.at }))
}

function counts (ref) {
  return Object.fromEntries(['replies', 'reposts', 'likes', 'quotes'].map((kind) => [kind, edges(ref, kind).length]))
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

function followRows (author, kind) {
  const related = fixtures.diaryRecords.filter(({ author: from, record: r }) => r.type === 'follow' && (kind === 'seguindo' ? from === author : r.key === author))
  return lastWrites(related, (r) => r.key)
    .map(({ author: from, seq, record }) => ({ key: kind === 'seguindo' ? record.key : from, seq, at: record.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || compare(a.key, b.key))
}

function writersOf (group) {
  const rows = new Map([[group.writer, { key: group.writer, diary: fixtures.own, seq: 1, length: 2, signed: 2, left: false }]])
  for (const item of group.items) {
    const previous = rows.get(item.writer)
    const seq = Math.max(previous ? previous.seq : 1, item.seq)
    rows.set(item.writer, { key: item.writer, diary: item.diary, seq, length: seq + 1, signed: seq + 1, left: false })
  }
  return [...rows.values()].sort((a, b) => compare(a.key, b.key))
}

const diaryCount = (group) => new Set(writersOf(group).map((w) => w.diary)).size

function activeReposts (author) {
  const latest = new Map()
  for (const e of fixtures.diaryRecords) {
    if (e.author !== author || e.record.type !== 'repost') continue
    const target = refOf(e.record.to)
    const previous = latest.get(target)
    if (!previous || e.seq > previous.seq) latest.set(target, e)
  }
  return [...latest.values()].filter((e) => e.record.on).map((e) => e.seq)
}

function communityRows (community, after) {
  return fixtures.groups.filter((g) => g.community === community && (after === undefined || g.group > after))
    .sort((a, b) => compare(a.group, b.group))
    .map((g) => ({ group: g.group, join: g.join, visibility: g.visibility, name: g.visibility === 'private' ? null : g.name, writerCount: g.visibility === 'private' ? null : diaryCount(g) }))
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

// Only fixture references are returned: screens verify them through diary.peek.
// The seeder's testimonial index (packages/core/lib/engagement-index.js),
// over { author, seq, record } entries and the tombstoned 'author:seq' refs:
// the owner's newest show per writer while its writer block is live, and
// the newest live block per writer never shown, even by a removed show.
export function testimonialPointers (entries, deleted, owner) {
  const live = (e) => !deleted.has(`${e.author}:${e.seq}`)
  const blocks = new Map()
  for (const e of entries) {
    if (e.record.type === 'testimonial' && e.record.to === owner && e.author !== owner && live(e)) blocks.set(`${e.author}:${e.seq}`, e)
  }
  const everShown = new Set()
  const newestShow = new Map()
  for (const e of entries) {
    if (e.author !== owner || e.record.type !== 'testimonial-show') continue
    everShown.add(`${e.record.from}:${e.record.seq}`)
    const prev = newestShow.get(e.record.from)
    if (!prev || e.seq > prev.seq) newestShow.set(e.record.from, e)
  }
  const shown = [...newestShow.values()]
    .filter((e) => live(e) && e.record.from !== owner && blocks.get(`${e.record.from}:${e.record.seq}`)?.record.hash === testimonialHash(e.record.from, e.record.nonce, e.record.text))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 64)
    .map((e) => ({ seq: e.seq, from: e.record.from, wseq: e.record.seq }))
  const newestBlock = new Map()
  for (const e of blocks.values()) {
    const prev = newestBlock.get(e.author)
    if (!prev || e.seq > prev.seq) newestBlock.set(e.author, e)
  }
  const pending = [...newestBlock.values()]
    .filter((e) => !everShown.has(`${e.author}:${e.seq}`))
    .sort((a, b) => Date.parse(b.record.at) - Date.parse(a.record.at) || compare(a.author, b.author))
    .slice(0, 64)
    .map((e) => ({ from: e.author, seq: e.seq }))
  return { shown, pending }
}

// A live Vitrine request registers its diaries here, so the route follows
// what the lab writes; without one, the route reads the fixtures.
let testimonialSource = () => ({ entries: fixtures.diaryRecords, deleted: new Set() })
export function useTestimonialSource (source) {
  testimonialSource = source
}

export function vitrineIndex (url, request) {
  let path
  try { path = new URL(url, 'https://vitrine.invalid').pathname } catch { notFound() }
  const segments = path.split('/')
  if (segments[1] === 'index' && segments[2] === 'feira') return feiraIndex(segments.slice(3), request)
  const [, index, route, key, part, cursor, ...extra] = segments
  if (index !== 'index' || !key || extra.length) notFound()

  if (['post', 'likes', 'reposts', 'quotes'].includes(route) && part !== undefined) {
    const ref = `${key}:${part}`
    if (!isRef(ref)) notFound()
    const post = requirePost(ref)
    if (route !== 'post') {
      const rows = edges(ref, route)
      const page = edgePage(rows, cursor, 20, route === 'quotes' ? quotesOrder : newestFirst)
      return { ...flags, ref, kind: route, ...page, total: rows.length, authors: authorsOf(page.items.map((r) => r.split(':')[0])) }
    }
    const page = edgePage(edges(ref, 'replies'), cursor, 50)
    const quotes = edgePage(edges(ref, 'quotes'), undefined, 50, quotesOrder).items
    const parent = post.replyTo ? refOf(post.replyTo) : null
    const c = counts(ref)
    return { ...flags, ref, parent, replies: page.items, next: page.next, quotes, likes: c.likes, reposts: c.reposts, repliesTotal: c.replies, quotesTotal: c.quotes, authors: authorsOf([ref, parent, ...page.items, ...quotes].filter(Boolean).map((r) => r.split(':')[0])) }
  }

  if (route === 'counts' && part === undefined) {
    const refs = key.split(',')
    if (refs.length > 31 || !refs.every((ref) => isRef(ref))) notFound()
    return { ...flags, counts: Object.fromEntries(refs.filter((ref) => posts.some((p) => refOf(p) === ref)).map((ref) => [ref, counts(ref)])) }
  }

  if (route === 'member' && cursor === undefined) {
    requireProfile(key)
    if (part !== undefined && !/^[1-9][0-9]*$/.test(part)) notFound()
    const seqs = [...new Set([...posts.filter((p) => p.author === key).map((p) => p.seq), ...activeReposts(key)])].sort((a, b) => b - a)
    const records = [...fixtures.diaryRecords, ...fixtures.listings, ...fixtures.rates].filter((e) => e.author === key)
    return { ...flags, ...hint(), ...pageHint(key), length: Math.max(2, ...seqs, ...records.map((e) => e.seq)) + 1, posts: seqs.filter((seq) => part === undefined || seq < Number(part)).slice(0, 100), postsTotal: seqs.length }
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

  if (route === 'search' && part === undefined) {
    const rows = profiles.filter((p) => matches(p.name + ' ' + p.username, key))
    return { ...flags, members: rows.slice(0, 20).map((p) => ({ author: p.author, ...hint(), ...pageHint(p.author) })), more: rows.length > 20 }
  }

  if (route === 'group' && cursor === undefined) {
    const g = fixtures.groups.find((g) => g.group === key)
    if (!g || (part !== undefined && !isKey(part))) notFound()
    const rows = writersOf(g).filter((w) => part === undefined || w.key > part)
    const writers = rows.slice(0, 64)
    return { ...flags, kind: 'group', visibility: g.visibility, join: g.join, name: g.visibility === 'private' ? null : g.name, creator: g.creator, community: g.community, attached: true, rootServed: true, writers, next: rows.length > 64 ? writers[writers.length - 1].key : null }
  }

  if (route === 'groups' && part === undefined) {
    requireProfile(key)
    const groups = fixtures.groups.flatMap((g) => {
      const writer = writersOf(g).find((w) => w.diary === key)
      return writer ? [{ group: g.group, writer: writer.key, seq: writer.seq, left: writer.left }] : []
    })
    return { ...flags, groups }
  }

  if (route === 'community') {
    const c = fixtures.communities.find((c) => c.community === key)
    if (!c || (part !== undefined && (part !== 'groups' || !isKey(cursor)))) notFound()
    const rows = communityRows(key, cursor)
    const groups = rows.slice(0, 32)
    const body = { ...flags, groups, next: rows.length > 32 ? groups[groups.length - 1].group : null }
    return part === undefined ? { ...body, name: c.name, join: c.join, creator: c.creator, members: fixtures.members.length } : body
  }

  if (route === 'testimonials' && part === undefined) {
    requireProfile(key)
    const { entries, deleted } = testimonialSource()
    return { ...testimonialPointers(entries, deleted, key), ...flags }
  }

  if (route === 'group-search' && part === undefined) {
    const rows = fixtures.groups.filter((g) => g.visibility === 'public' && matches(g.name, key))
    return { ...flags, groups: rows.slice(0, 20).map((g) => ({ group: g.group, name: g.name, writerCount: diaryCount(g) })), more: rows.length > 20 }
  }

  notFound()
}
