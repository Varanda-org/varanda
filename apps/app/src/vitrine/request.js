import rpc from '@varanda/rpc'
import { createVitrineMedia } from './media.js'
import { sealedTestimonial, signVitrineConsent, testimonialHash, verifyVitrineConsent } from './fixtures.js'
import { largeFeed } from './large.js'
import { testimonialPointers, useTestimonialSource } from './testimonialIndex.js'

const { validateParams, RpcError, feira, GROUP_REACTIONS_MAX, GROUP_REACTORS_MAX } = rpc
let currentFeira = null
let currentLive = null

// The index client has no node handle; explicit handles keep lab instances isolated.
export function vitrineFeiraState (request) {
  return request ? request.feira() : currentFeira?.() || null
}

// Live like and repost records of one instance, for the counts the index answers.
export function vitrineLiveRecords (request) {
  return request ? request.live() : currentLive?.() || []
}
const copy = (value) => JSON.parse(JSON.stringify(value))
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0
const comparePosition = (a, b, field) => Date.parse(a.at) - Date.parse(b.at) || compareText(a[field], b[field]) || a.seq - b.seq
const groupCursor = ({ at, writer, seq }) => ({ at, writer, seq })
const dmCursor = ({ at, peer }) => ({ at, peer })
const noticeCursor = ({ at, key, seq }) => ({ at, key, seq })
const compareDm = (a, b) => Date.parse(b.at) - Date.parse(a.at) || compareText(a.peer, b.peer)
const compareNotice = (a, b) => Date.parse(b.at) - Date.parse(a.at) || compareText(a.key, b.key) || b.seq - a.seq
const signature = '0'.repeat(128)
const keyOf = (n) => n.toString(16).padStart(64, '0')
const targetOf = (ref) => {
  const [author, seq] = ref.split(':')
  return { author, seq: Number(seq) }
}
const active = (entity) => ['creator', 'admin', 'member'].includes(entity.role)
const preview = (text, media) => text === '' && Array.isArray(media) && media.length > 0
  ? media.some((m) => (m.plainMime || m.mime) === 'audio/mp4') ? 'Áudio' : media.every((m) => (m.plainMime || m.mime) === 'image/gif') ? 'GIF' : 'Foto'
  : [...text].slice(0, 140).join('')
// The node's list label for a momento reaction (PREVIEW_MOMENT in
// packages/core/lib/dm-fold.js), so the demo list reads the same.
const MOMENT_PREVIEW = 'Reagiu a um momento'

function refuse (code, message) {
  throw new RpcError(code, message, { uncertain: false })
}

// Like the app's node.request: resolve a result, reject a client error.
// Each instance owns its state, so reopening a lab scenario resets it.
export function createVitrineRequest (fixtures, options) {
  const data = copy(fixtures)
  const blockedKeys = new Set()
  const profiles = [...data.members, ...data.pages, ...data.applicants]
  const extraFeed = data.noticePosts.filter((p) => !data.follows.includes(p.author))
  let tick = 0
  let serial = 1000
  let runId = 0
  let sync = { state: 'idle' }
  let dmEnabled = false
  let pullCursor = 0
  let mediaStart = 1
  const age = { ageVerifiedDate: data.now, ageSince: null, ageSinceUntil: null }
  const phone = { phoneVerifiedDate: data.now, phoneSince: null }
  const reactions = { like: new Map(), repost: new Map() }
  const live = []
  const deleted = new Map()
  const logs = new Map()
  const roster = new Map()
  const association = data.association
  const signed = () => ({ signature })
  const unavailable = () => refuse('USAGE', 'indisponível no modo vitrine')
  let messageId = Math.max(0, ...data.conversations.flatMap((c) => c.messages.map((m) => parseInt(m.id, 16))))
  const stamp = () => new Date(Date.parse(data.now) + ++tick * 1000).toISOString()
  const profileOf = (author) => profiles.find((p) => p.author === author)
  const conversationOf = (peer) => data.conversations.find((c) => c.peer === peer)
  const groupOf = (key) => data.groups.find((g) => g.group === key) || refuse('NOT_FOUND', 'grupo não encontrado')
  const communityOf = (key) => data.communities.find((c) => c.community === key) || refuse('NOT_FOUND', 'comunidade não encontrada')
  const groupReactors = new Map()
  const reactionKey = (group, target) => group + ':' + target.writer + ':' + target.seq
  // As the core fold: every member's reaction is kept, and only the 12
  // emojis with the most reactors (ties by emoji) are shown.
  const shownReactions = (rows) => rows.slice().sort((a, b) => b.count - a.count || compareText(a.emoji, b.emoji)).slice(0, GROUP_REACTIONS_MAX)
  for (const g of data.groups) {
    for (const item of g.items) {
      const others = data.members.filter((m) => m.author !== data.own).map((m) => m.author)
      groupReactors.set(reactionKey(g.group, item), (item.reactions || []).map(({ emoji, count, mine }) => ({
        emoji, count, by: [...(mine ? [data.own] : []), ...others.splice(0, count - (mine ? 1 : 0))]
      })))
    }
  }
  const reactionPost = (group, target) => {
    const item = groupOf(group).items.find((p) => p.writer === target.writer && p.seq === target.seq)
    if (!item || item.hidden) refuse('USAGE', 'mensagem não encontrada')
    return item
  }
  const orderedItems = (g) => [...g.items].sort((a, b) => comparePosition(a, b, 'writer'))

  function usernameRecord (p) {
    return { type: 'username', username: p.username, member: p.author, date: data.now, association, issuer: association, issuerDate: data.now, issuerSignature: signature, signature }
  }

  function postRecord ({ text, at, replyTo, quote, media }) {
    return { type: 'post', text, at, replyTo, ...(quote ? { quote } : {}), ...(media ? { media } : {}) }
  }

  for (const p of profiles) {
    logs.set(p.author, [
      { seq: 0, record: { v: 1, member: p.author, ageBand: '18+', method: 'vitrine', date: new Date(Date.parse(data.now) - 8 * 86400000).toISOString(), association, signature } },
      { seq: 1, record: { type: 'profile', name: p.name, bio: p.bio, at: data.now } },
      { seq: 2, record: usernameRecord(p) },
      ...[...data.feed, ...data.noticePosts].filter((post) => post.author === p.author).map((post) => ({ seq: post.seq, record: postRecord(post) })),
      ...[...(data.listings || []), ...(data.rates || []), ...data.diaryRecords].filter((entry) => entry.author === p.author).map(({ seq, record }) => ({ seq, record }))
    ].sort((a, b) => a.seq - b.seq))
  }

  // The own likes and reposts the fixtures already wrote, so the buttons,
  // engagement.read and a later toggle agree with the log and the counts.
  for (const { seq, record } of logs.get(data.own) || []) {
    if ((record.type === 'like' || record.type === 'repost') && record.to) {
      reactions[record.type].set(`${record.to.author}:${record.to.seq}`, { seq, on: record.on === true })
    }
  }

  // Timing rows are registered in the author logs so open, peek and delete
  // behave like a fixture post. Reposts have no diary post record.
  if (options && options.large === true) {
    const rows = largeFeed(data, 200)
    data.feed.push(...rows)
    for (const row of rows) {
      if (row.kind !== 'post') continue
      const entries = logs.get(row.author)
      entries.push({ seq: row.seq, record: postRecord(row) })
      entries.sort((a, b) => a.seq - b.seq)
    }
  }

  // Depoimentos: `sealed` opens a writer block as the recipient's key would.
  const sealed = new Map(data.sealed.map((s) => [`${s.author}:${s.seq}`, { text: s.text, nonce: s.nonce }]))
  const allEntries = () => [...logs].flatMap(([author, entries]) => entries.map(({ seq, record }) => ({ author, seq, record })))
  const testimonialPointersOf = (owner) => testimonialPointers(allEntries(), new Set(deleted.keys()), owner)
  // The index route has no handle on an instance: the one used last is the
  // one it reads (the app has one; tests may build several).
  const testimonialSource = () => ({ entries: allEntries(), deleted: new Set(deleted.keys()) })
  useTestimonialSource(testimonialSource)
  const liveEntry = (author, seq) => deleted.has(`${author}:${seq}`) ? null : (logs.get(author) || []).find((e) => e.seq === seq) || null
  // A post-share target: a live own post, with the refusals of 5.121.
  const shareTarget = (to) => {
    const target = targetOf(to)
    const entry = target.author === data.own ? liveEntry(data.own, target.seq) : null
    if (!entry) refuse('USAGE', 'referência inválida')
    if (entry.record.type !== 'post') refuse('USAGE', 'o registro não é uma publicação')
    return target.seq
  }
  // The live post-share seqs for one post, ascending.
  const liveShares = (seq) => logs.get(data.own).filter((e) => e.record.type === 'post-share' && e.record.seq === seq && liveEntry(data.own, e.seq)).map((e) => e.seq)
  // The web node's verifyShow: a show stands only while the writer block is
  // live, addressed to the show's diary and commits to the shown text.
  function showHolds (author, record) {
    if (record.from === author) return false
    const block = liveEntry(record.from, record.seq)
    return !!block && block.record.type === 'testimonial' && block.record.to === author && block.record.hash === testimonialHash(record.from, record.nonce, record.text)
  }
  // eslint-disable-next-line no-control-regex
  const badText = (text) => /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

  // Momentos (5.113), on the demo clock: a moment shows while
  // at - MOMENT_SKEW_MS <= now < at + MOMENT_TTL_MS (packages/core/lib/moments.js)
  // and is past once its 24 h are over. The app hides a moment by the
  // device clock, so options.clock (a function answering milliseconds), when
  // given, moves every answered date by the same distance: the ages stay
  // those of the demo clock.
  const MOMENT_TTL_MS = 86400000
  const MOMENT_SKEW_MS = 600000
  const demoNow = () => Date.parse(data.now) + tick * 1000
  const clock = options && typeof options.clock === 'function' ? options.clock : null
  const shown = (at) => {
    const offset = clock === null ? 0 : clock() - demoNow()
    return Number.isFinite(offset) ? new Date(Date.parse(at) + offset).toISOString() : at
  }
  const newestFirst = (a, b) => Date.parse(b.record.at) - Date.parse(a.record.at) || b.seq - a.seq
  const momentsOf = (author) => (logs.get(author) || []).filter((e) => e.record.type === 'moment' && !deleted.has(`${author}:${e.seq}`)).sort(newestFirst)
  const showing = (record) => {
    const t = Date.parse(record.at)
    const now = demoNow()
    return t - now <= MOMENT_SKEW_MS && t + MOMENT_TTL_MS > now
  }
  const momentRow = (author, { seq, record }) => ({ seq, ref: `${author}:${seq}`, text: record.text, at: shown(record.at), media: record.media, music: record.music || null })
  data.momentMedia = (author, seq) => {
    const entry = typeof author === 'string' && Number.isSafeInteger(seq) ? momentsOf(author).find((e) => e.seq === seq) : null
    return entry && showing(entry.record) ? entry.record.media : null
  }

  function append (record) {
    const entries = logs.get(data.own)
    const seq = entries[entries.length - 1].seq + 1
    entries.push({ seq, record })
    if (record.type === 'like' || record.type === 'repost') live.push({ author: data.own, seq, record: { type: record.type, to: record.to, on: record.on, at: record.at } })
    return { seq, ref: `${data.own}:${seq}` }
  }

  function folded (author) {
    const entries = logs.get(author) || []
    const gone = new Set(entries.filter((e) => e.record.type === 'delete').map((e) => e.record.seq))
    const roots = entries.filter((e) => !gone.has(e.seq) && feira.checkListingShape(e.record) === null)
    return roots.map(({ seq, record: root }) => {
      let record = root
      let editSeq = null
      let editedAt = null
      let status = 'disponivel'
      let statusSeq = null
      for (const e of entries) {
        const r = e.record
        if (gone.has(e.seq) || r.seq !== seq) continue
        if (feira.checkEditShape(r, e.seq) === null && feira.unitAllowed(root.kind, r.price, r.unit)) {
          const { type, seq: target, at, ...fields } = r
          record = { type: 'listing', kind: root.kind, ...fields, at: root.at }
          editSeq = e.seq
          editedAt = at
        }
        if (feira.checkStatusShape(r, e.seq) === null && !(root.kind === 'procura' && r.status === 'reservado')) {
          status = r.status
          statusSeq = e.seq
        }
      }
      return { author, seq, record, editSeq, editedAt, status, statusSeq }
    }).sort((a, b) => b.seq - a.seq)
  }

  function ownListing (to) {
    const target = targetOf(to)
    const item = target.author === data.own && folded(data.own).find((item) => item.seq === target.seq)
    if (!item) refuse('USAGE', 'o registro não é um anúncio')
    return item
  }

  function ratingRows ({ author, seq, refs }) {
    const best = new Map()
    let dropped = 0
    let incomplete = false
    for (const ref of refs) {
      if (ref.rater === author) { dropped++; continue }
      const entries = logs.get(ref.rater)
      const entry = entries?.find((e) => e.seq === ref.seq)
      if (!entry) { incomplete = true; continue }
      const r = entry.record
      const cert = entries.find((e) => e.seq === 0)?.record
      const first = entries.find((e) => e.record.type === 'listing-rate' && e.record.offer === r.offer)
      if (deleted.has(`${ref.rater}:${ref.seq}`) || feira.checkRateShape(r) !== null || r.to.author !== author || r.to.seq !== seq ||
          !(Date.parse(data.now) - Date.parse(cert?.date) >= feira.RATE_MIN_AGE_MS) || first.seq !== ref.seq ||
          !verifyVitrineConsent(author, seq, ref.rater, r.offer, r.consent)) {
        dropped++
        continue
      }
      const previous = best.get(ref.rater)
      if (!previous || ref.seq > previous.seq) best.set(ref.rater, { rater: ref.rater, seq: ref.seq, listingSeq: seq, stars: r.stars, text: r.text, at: r.at })
    }
    return { items: [...best.values()].sort((a, b) => compareText(b.at, a.at)), dropped, incomplete }
  }

  function publish (params, kind) {
    const record = { type: 'post', text: params.text, at: stamp(), replyTo: kind === 'reply' ? targetOf(params.to) : null, ...(kind === 'quote' ? { quote: targetOf(params.to) } : {}), ...(params.media ? { media: params.media } : {}), ...(params.preview ? { preview: params.preview } : {}) }
    const result = append(record)
    const p = profileOf(data.own)
    data.feed.push({ kind: 'post', author: data.own, name: p.name, username: p.username, seq: result.seq, at: record.at, text: record.text, replyTo: record.replyTo, quote: record.quote || null, media: record.media || null, preview: record.preview || null })
    return kind === 'quote' ? { seq: result.seq } : result
  }

  function updateNames () {
    for (const item of [...data.feed, ...data.noticePosts, ...data.groups.flatMap((g) => g.items)]) {
      const p = profileOf(item.author || item.diary)
      if (p) { item.name = p.name; item.username = p.username }
    }
  }

  function changeFollow (key, on) {
    if (key === data.own) refuse('USAGE', 'não é possível seguir a própria chave')
    const changed = data.follows.includes(key) !== on
    if (changed) {
      data.follows = data.follows.filter((k) => k !== key)
      if (on) data.follows.push(key)
      data.follows.sort(compareText)
      append({ type: 'follow', key, on, at: stamp() })
    }
    const c = conversationOf(key)
    if (c) updateFolder(c)
    return { changed, followCount: data.follows.length }
  }

  function toggle (type, { to, on }) {
    const previous = reactions[type].get(to)
    const changed = (previous ? previous.on : false) !== on
    if (!changed) return { seq: previous ? previous.seq : null, on, changed }
    const at = stamp()
    const { seq } = append({ type, to: targetOf(to), on, at })
    reactions[type].set(to, { seq, on })
    if (type === 'repost') {
      data.feed = data.feed.filter((item) => item.kind !== 'repost' || item.author !== data.own || `${item.to.author}:${item.to.seq}` !== to)
      if (on) {
        const p = profileOf(data.own)
        data.feed.push({ kind: 'repost', author: data.own, name: p.name, username: p.username, seq, at, to: targetOf(to), text: null, replyTo: null, quote: null, media: null })
      }
    }
    return { seq, on, changed }
  }

  function updateFolder (c) {
    c.folder = c.messages.length && !c.accepted && !data.follows.includes(c.peer) && !c.messages.some((m) => m.mine) ? 'request' : 'inbox'
  }

  function initRoster (entity, initial = data.members) {
    const rows = initial.map((p) => ({ member: p.author, admin: p.author === entity.creator || (p.author === data.own && entity.role === 'admin'), state: 'member', at: data.now }))
    if (entity.join === 'approval') rows.push(...data.applicants.map((p) => ({ member: p.author, admin: false, state: 'requested', at: data.now })))
    roster.set(entity.group || entity.community, rows)
    entity.memberInvite = false
    entity.dropped = []
  }
  for (const entity of [...data.groups, ...data.communities]) initRoster(entity)

  const rowsOf = (entity) => roster.get(entity.group || entity.community)
  const memberCount = (entity) => rowsOf(entity).filter((m) => m.state === 'member').length
  function setMember (entity, member, state, admin) {
    let row = rowsOf(entity).find((m) => m.member === member)
    if (!row) { row = { member, admin: false, state: 'left', at: stamp() }; rowsOf(entity).push(row) }
    if (state) row.state = state
    if (admin !== undefined) row.admin = admin
    if (member === data.own) entity.role = row.state === 'member' ? member === entity.creator ? 'creator' : row.admin ? 'admin' : 'member' : row.state
    if (entity.group) entity.members = memberCount(entity)
  }

  function memberPage (entity, offset, limit, requests) {
    const rows = rowsOf(entity).filter((m) => requests ? m.state === 'requested' : ['member', 'banned'].includes(m.state)).sort((a, b) => compareText(a.member, b.member))
    return {
      [requests ? 'requests' : 'members']: rows.slice(offset, offset + limit).map((m) => {
        const p = profileOf(m.member)
        const names = { member: m.member, name: p ? p.name : null, username: p ? p.username : null }
        return requests ? { ...names, at: m.at } : { ...names, admin: m.admin, banned: m.state === 'banned', joinedAt: m.at }
      }),
      total: rows.length
    }
  }

  function joinEntity (entity) {
    if (!active(entity)) setMember(entity, data.own, entity.join === 'approval' ? 'requested' : 'member')
    return { state: active(entity) ? 'member' : entity.role }
  }

  function createGroup ({ name, join, visibility = 'public', community }) {
    communityOf(community)
    const group = keyOf(++serial)
    const g = { group, name, join: visibility === 'private' ? 'approval' : join, visibility, community, creator: data.own, role: 'creator', members: 1, writer: group, seen: null, items: [] }
    data.groups.push(g)
    initRoster(g, [profileOf(data.own)])
    return { group }
  }

  function pageSign ({ action, page, op }) {
    const base = { page, gen: op.gen, at: op.at, nonce: op.nonce }
    const recordOf = (type, fields) => ({ type, ...fields, signature })
    const rosterOf = (fields) => recordOf('page-roster', { ...fields, association })
    if (action === 'accept') return { record: recordOf('page-accept', { ...base, rosterSignature: op.rosterSignature, actor: data.own }) }
    if (action === 'offer') return { record: recordOf('page-offer', { ...base, to: op.to, exp: op.exp, actor: data.own }) }
    if (action === 'close') return { record: recordOf('page-close', { ...base, actor: data.own, association }) }
    if (action === 'remove' || action === 'transfer-accept') return { record: rosterOf({ ...base, owner: op.owner, admins: op.admins, prev: op.prev }) }
    if (action === 'create' || action === 'invite') {
      const r = op.roster
      return { signature, record: rosterOf({ page, gen: action === 'create' ? 1 : op.gen, owner: action === 'create' ? data.own : r.owner, admins: r.admins, prev: r.prev, at: r.at, nonce: r.nonce }) }
    }
    if (action === 'move') {
      return {
        record: recordOf('page-moved', { ...base, to: op.to, actor: data.own, association }),
        origin: recordOf('page-origin', { ...base, page: op.to, from: page, fromSeq: op.fromSeq, owner: op.owner, admins: op.admins, actor: data.own, association }),
        roster: rosterOf({ ...base, page: op.to, gen: 1, owner: op.owner, admins: op.admins, prev: null })
      }
    }
    return signed()
  }

  function groupSummary (g) {
    const items = orderedItems(g)
    const last = active(g) ? items[items.length - 1] : null
    return {
      group: g.group,
      name: g.name,
      visibility: g.visibility,
      join: g.join,
      role: g.role,
      general: data.communities.some((c) => c.general === g.group),
      last: last
        ? {
            name: last.name,
            username: last.username,
            preview: last.hidden ? '' : preview(last.text, last.media),
            at: last.at,
            mine: last.diary === data.own,
            hidden: last.hidden
          }
        : null,
      unread: !last ? 0 : Math.min(99, items.filter((item) => !item.hidden && item.diary !== data.own && (!g.seen || comparePosition(item, g.seen, 'writer') > 0)).length)
    }
  }

  function groupRow ({ group, name, join, role, members, community }) {
    return { group, name, join, role, members, community }
  }

  function communityRow ({ community, name, join, state, role, general }) {
    return { community, name, join, state, role, general }
  }

  const handlers = {
    'session.open': () => ({ protocol: 1 }),
    'identity.show': () => ({ publicKey: data.own, association }),
    'identity.create': unavailable,
    'identity.install': unavailable,
    'identity.clear': unavailable,
    'identity.reset': unavailable,
    'identity.forget': unavailable,
    // A Página's keys and sealed posts live only on a device holding them.
    'group.seal': unavailable,
    'dm.pageGenerate': unavailable,
    'dm.pageShare': unavailable,
    'dm.pageSecrets': unavailable,
    'dm.pageDraft': unavailable,
    'dm.pageSend': unavailable,
    'dm.pageLegacyChunk': unavailable,
    'dm.pageLegacyBlocks': unavailable,
    'dm.pageForget': unavailable,
    'identity.sessionSaved': () => ({}),
    'identity.recoveryLookup': unavailable,
    'identity.recoveryOpen': unavailable,
    'identity.recoveryWrap': unavailable,
    'identity.recoveryBind': unavailable,
    'profile.delete': unavailable,
    'listing.create': (params) => {
      if (folded(data.own).length >= feira.MAX_LISTINGS) refuse('USAGE', 'limite')
      const record = { type: 'listing', ...params, at: stamp() }
      if (feira.checkListingShape(record) !== null) refuse('USAGE', 'anúncio inválido')
      return append(record)
    },
    'listing.edit': ({ to, expectedRevision, ...fields }) => {
      const item = ownListing(to)
      if ((item.editSeq || 0) !== expectedRevision) refuse('USAGE', 'conflito')
      if (!feira.unitAllowed(item.record.kind, fields.price, fields.unit)) refuse('USAGE', 'parâmetro inválido: unit')
      if (fields.media === null) delete fields.media
      const record = { type: 'listing-edit', seq: item.seq, ...fields, at: stamp() }
      const next = logs.get(data.own).at(-1).seq + 1
      if (feira.checkEditShape(record, next) !== null) refuse('USAGE', 'anúncio inválido')
      const result = append(record)
      if (item.editSeq !== null) {
        const tomb = append({ type: 'delete', seq: item.editSeq, at: record.at })
        deleted.set(`${data.own}:${item.editSeq}`, tomb)
      }
      return { seq: result.seq, ref: to }
    },
    'listing.status': ({ to, status }) => {
      const item = ownListing(to)
      if (item.record.kind === 'procura' && status === 'reservado') refuse('USAGE', 'uma procura não fica reservada')
      return { seq: append({ type: 'listing-status', seq: item.seq, status, at: stamp() }).seq, ref: to }
    },
    'listing.delete': ({ to }) => {
      const target = targetOf(to)
      const root = logs.get(data.own).find((e) => e.seq === target.seq)
      if (target.author !== data.own || root?.record.type !== 'listing') refuse('USAGE', 'o registro não é um anúncio')
      if (deleted.has(to)) return { ...deleted.get(to), changed: false, deleted: [target.seq] }
      const edits = logs.get(data.own).filter((e) => e.record.type === 'listing-edit' && e.record.seq === target.seq && !deleted.has(`${data.own}:${e.seq}`))
      const targets = [target.seq, ...edits.map((e) => e.seq)]
      let result
      for (const seq of targets) {
        const tomb = append({ type: 'delete', seq, at: stamp() })
        deleted.set(`${data.own}:${seq}`, tomb)
        if (!result) result = tomb
      }
      return { ...result, changed: true, deleted: targets }
    },
    'listing.consent': ({ to, rater, offer }) => {
      const item = ownListing(to)
      const proposal = conversationOf(rater)?.messages.find((m) => m.id === offer && m.from === rater && !m.mine)
      const found = proposal && [proposal.card?.url, proposal.text].some((url) => {
        const ref = feira.parseOfferRef(url)
        return ref && ref.author === data.own && ref.seq === item.seq && !ref.aceite && !ref.recusada
      })
      if (!found) refuse('USAGE', 'oferta ausente')
      return { consent: signVitrineConsent(data.own, item.seq, rater, offer) }
    },
    'listing.rate': ({ to, offer, consent, stars, text }) => {
      const target = targetOf(to)
      if (!verifyVitrineConsent(target.author, target.seq, data.own, offer, consent)) refuse('USAGE', 'consentimento inválido')
      if (logs.get(data.own).some((e) => e.record.type === 'listing-rate' && e.record.offer === offer)) refuse('USAGE', 'oferta já avaliada')
      return append({ type: 'listing-rate', to: target, offer, consent, stars, text, at: stamp() })
    },
    'listing.mine': ({ before, limit }) => {
      const rows = folded(data.own).filter((item) => before === undefined || item.seq < before)
      const page = rows.slice(0, limit)
      const items = page.map(({ seq, record: r, editSeq, editedAt, status, statusSeq }) => ({ seq, editSeq, editedAt, status, statusSeq, kind: r.kind, title: r.title, text: r.text, price: r.price, unit: r.unit, cat: r.cat, place: r.place, media: r.media || [], at: r.at }))
      return { items, next: rows.length > limit ? page.at(-1).seq : null }
    },
    'listing.ratings': ratingRows,
    'cert.add': () => ({ seq: 0 }),
    'account.sign': signed,
    'age.sign': signed,
    'phone.sign': signed,
    'invite.sign': signed,
    'inviteCard.sign': signed,
    // The development build never attributes an arbitrary card.
    'inviteCard.verify': () => ({ ok: false, reason: 'bad-signature' }),
    'push.sign': signed,
    // No seen sync offline: a signature the account call never uses, and a
    // merge that changes nothing.
    'seen.sign': () => ({ signature, prevHash: '0'.repeat(64) }),
    'seen.merge': () => ({ avisos: { own: [], pages: {} }, pending: false, dmChanged: false, groupChanged: false, blocksChanged: false, caughtUp: [] }),
    'report.sign': signed,
    'appeal.sign': signed,
    'dm.reportSign': signed,
    'terms.sign': signed,
    'recovery.sign': signed,
    'page.sign': pageSign,
    'page.register': () => ({ actor: data.own }),
    'age.proof': ({ verified, since }) => {
      const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
      if (verified) age.ageVerifiedDate = iso(verified.date) ? verified.date : data.now
      if (since !== undefined) {
        age.ageSince = since === null ? null : iso(since.since) ? since.since : data.now
        age.ageSinceUntil = since === null ? null : iso(since.date) ? since.date : data.now
      }
      return age
    },
    'phone.proof': ({ verified, since }) => {
      const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
      if (verified !== undefined) phone.phoneVerifiedDate = verified === null ? null : iso(verified.date) ? verified.date : data.now
      if (since !== undefined) phone.phoneSince = since === null ? null : iso(since.since) ? since.since : data.now
      return phone
    },
    'sync.status': () => sync,
    'sync.start': ({ once }) => {
      if (sync.state === 'running') refuse('USAGE', 'sincronização já em andamento')
      runId++
      sync = once ? { state: 'idle' } : { state: 'running', runId, once }
      return { runId }
    },
    'sync.stop': () => {
      const stopped = sync.state === 'running'
      sync = { state: 'idle' }
      return { stopped }
    },
    'node.close': () => { sync = { state: 'idle' }; return { closed: true } },
    'profile.set': (params) => {
      Object.assign(profileOf(data.own), params)
      updateNames()
      const p = profileOf(data.own)
      return append({ type: 'profile', name: p.name, bio: p.bio, at: stamp(), ...(p.avatar ? { avatar: p.avatar } : {}) })
    },
    'username.add': ({ record }) => {
      const p = profileOf(data.own)
      if (typeof record.username !== 'string' || !/^[a-z][a-z0-9_]{2,19}$/.test(record.username) || /^[0-9a-f]{6}$/.test(record.username)) refuse('USAGE', 'registro de nome inválido')
      if (p.username === record.username) return { changed: false, username: p.username }
      p.username = record.username
      const { seq } = append({ ...usernameRecord(p), date: stamp() })
      updateNames()
      return { changed: true, username: p.username, seq }
    },
    'post.create': (params) => publish(params, 'post'),
    'post.reply': (params) => publish(params, 'reply'),
    'post.quote': (params) => publish(params, 'quote'),
    'post.delete': ({ to }) => {
      const target = targetOf(to)
      if (target.author !== data.own) refuse('USAGE', 'referência inválida')
      if (deleted.has(to)) return { ...deleted.get(to), changed: false, deleted: [target.seq] }
      const entry = logs.get(data.own).find((e) => e.seq === target.seq)
      if (!entry || entry.record.type !== 'post') refuse('USAGE', 'referência inválida')
      const result = append({ type: 'delete', seq: target.seq, at: stamp() })
      deleted.set(to, result)
      // As the real feed (packages/core/lib/feed.js), a repost whose target
      // is deleted leaves the feed with it.
      data.feed = data.feed.filter((p) => (p.author !== data.own || p.seq !== target.seq) &&
        !(p.kind === 'repost' && p.to && p.to.author === target.author && p.to.seq === target.seq))
      return { ...result, changed: true, deleted: [target.seq] }
    },
    // Public share (5.121 to 5.123): the newest live post-share decides.
    'post.shared': ({ to }) => {
      const shares = liveShares(shareTarget(to))
      return { shareSeq: shares.length > 0 ? shares[shares.length - 1] : null }
    },
    'post.share': ({ to }) => {
      const seq = shareTarget(to)
      const shares = liveShares(seq)
      if (shares.length > 0) return { shareSeq: shares[shares.length - 1], created: false }
      return { shareSeq: append({ type: 'post-share', seq, at: stamp() }).seq, created: true }
    },
    'post.unshare': ({ to }) => {
      const shares = liveShares(shareTarget(to))
      for (const seq of shares) deleted.set(`${data.own}:${seq}`, append({ type: 'delete', seq, at: stamp() }))
      return { ok: true, changed: shares.length > 0 }
    },
    'like.set': (params) => toggle('like', params),
    'repost.set': (params) => toggle('repost', params),
    'engagement.read': ({ refs }) => ({ liked: refs.filter((ref) => reactions.like.get(ref)?.on), reposted: refs.filter((ref) => reactions.repost.get(ref)?.on) }),
    'block.set': ({ key, on }) => {
      const changed = on !== blockedKeys.has(key)
      if (on) {
        blockedKeys.add(key)
        changeFollow(key, false)
      } else {
        blockedKeys.delete(key)
      }
      return { changed, total: blockedKeys.size }
    },
    'block.list': () => ({ keys: [...blockedKeys] }),
    'follow.add': ({ key }) => changeFollow(key, true),
    'follow.remove': ({ key }) => changeFollow(key, false),
    'follow.list': ({ offset, limit }) => ({ follows: data.follows.slice(offset, offset + limit), total: data.follows.length }),
    'log.read': ({ author = data.own, limit, before }) => {
      const all = logs.get(author)
      if (!all) refuse('NOT_FOUND', 'sem dados locais para este diário')
      const candidates = all.filter((e) => before === undefined || e.seq < before)
      const page = candidates.slice(-limit)
      return { key: author, entries: page.filter((e) => !deleted.has(`${author}:${e.seq}`)), invalid: page.filter((e) => deleted.has(`${author}:${e.seq}`)).map((e) => ({ seq: e.seq, reason: 'deleted' })), entriesTruncated: Math.max(0, candidates.length - limit) }
    },
    'peek.read': ({ limit, after }) => {
      const compare = (a, b) => a.round - b.round || Date.parse(b.at) - Date.parse(a.at) || compareText(a.author, b.author)
      const authors = profiles.filter((p) => p.author !== data.own && !data.follows.includes(p.author))
      const rows = authors.flatMap((p) => [...data.feed, ...data.noticePosts].filter((post) => post.author === p.author).sort((a, b) => b.seq - a.seq).slice(0, 3).map((post, round) => ({ ...post, round, avatar: p.avatar }))).sort(compare)
      const candidates = rows.filter((item) => !after || compare(item, after) > 0)
      const items = candidates.slice(0, limit)
      const last = items[items.length - 1]
      return { items, next: candidates.length > limit ? { round: last.round, at: last.at, author: last.author, seq: last.seq } : null, diaries: new Set(rows.map((r) => r.author)).size, skipped: 0, incomplete: false }
    },
    'page.read': ({ key }) => {
      if (!data.pages.some((p) => p.author === key)) {
        if (!profileOf(key) && !conversationOf(key)) refuse('NOT_FOUND', 'sem dados locais para este diário')
        return { page: key, owner: null, admins: [], gen: null, seq: null, isOwner: false, isAdmin: false, complete: !!profileOf(key) && !data.incompleteDiaries.includes(key), follows: [], followsCount: 0, followsTruncated: false, closed: false, movedTo: null, movedFrom: null, links: [] }
      }
      const follows = data.members.filter((p) => p.author !== data.own).map((p, i) => ({ key: p.author, seq: 30 + i })).reverse()
      return { page: key, owner: data.own, admins: [data.members[1].author], gen: 1, seq: 1, isOwner: true, isAdmin: false, complete: true, follows, followsCount: follows.length, followsTruncated: false, closed: false, movedTo: null, movedFrom: null, links: [] }
    },
    'page.feed': ({ keys, limit }) => ({ items: [...data.feed, ...data.noticePosts].filter((p) => keys.includes(p.author)).sort((a, b) => comparePosition(a, b, 'author')).slice(-limit), incomplete: false }),
    // IPC-only calls of the in-app web node (docs/rpc.md 5.88, 5.89). The
    // Vitrine screens go through the handle of ./media.js; these answers only
    // keep the documented shapes.
    'dm.putMedia': async ({ to, width, height }) => {
      const item = data.listings.find((e) => e.record.media?.length)?.record.media[0]
      const photo = await request.media.read({ kind: 'listing', item })
      return request.media.putDm({ to, bytes: photo.bytes, mime: photo.mime, width, height })
    },
    'media.readFile': () => ({ name: '0'.repeat(32) + '.bin', mime: 'image/jpeg', w: null, h: null }),
    'media.uploadFile': ({ mime, width, height }) => ({ core: keyOf(950), mime, start: mediaStart++, blocks: 1, bytes: 2048, sha256: keyOf(951), width, height }),
    'dm.enable': () => {
      const seq = dmEnabled ? null : append({ type: 'dm-key', box: data.own, gen: 1, at: stamp() }).seq
      dmEnabled = true
      return { box: data.own, gen: 1, seq }
    },
    'dm.pull': () => {
      pullCursor = Math.max(pullCursor, messageId)
      return { added: 0, cursor: pullCursor, incomplete: false }
    },
    'dm.set': ({ peer, state }) => {
      let c = conversationOf(peer)
      if (!c) { c = { peer, folder: 'inbox', unread: false, blocked: false, messages: [] }; data.conversations.push(c) }
      if (state === 'accepted') c.accepted = true
      if (state === 'blocked' || state === 'unblocked') c.blocked = state === 'blocked'
      if (state === 'declined' || state === 'deleted') { c.messages = []; c.unread = false; c.accepted = false }
      updateFolder(c)
      return { ok: true }
    },
    'group.create': createGroup,
    'group.join': ({ group, community }) => {
      const g = groupOf(group)
      if (community && g.community !== community) refuse('USAGE', 'o grupo não é dessa comunidade')
      if (!active(communityOf(g.community))) refuse('USAGE', 'entre na comunidade primeiro')
      if (g.role === 'banned') refuse('USAGE', 'sem permissão no grupo')
      return joinEntity(g)
    },
    'group.leave': ({ group }) => { setMember(groupOf(group), data.own, 'left'); return { state: 'left' } },
    'group.hide': ({ group, target, on }) => {
      const item = groupOf(group).items.find((p) => p.writer === target.writer && p.seq === target.seq)
      if (!item) refuse('NOT_FOUND', 'mensagem não encontrada')
      item.hidden = on
      return { ok: true }
    },
    'group.react': ({ group, target, emoji }) => {
      const g = groupOf(group)
      if (!active(g) || !active(communityOf(g.community)) || communityOf(g.community).dropped.includes(group)) refuse('USAGE', 'sem permissão no grupo')
      const item = reactionPost(group, target)
      const key = reactionKey(group, target)
      const rows = groupReactors.get(key) || []
      if ((rows.find((r) => r.by.includes(data.own))?.emoji || '') === emoji) return { ok: true }
      for (const row of rows) {
        if (row.by.includes(data.own)) {
          row.by = row.by.filter((key) => key !== data.own)
          row.count--
        }
      }
      if (emoji !== '') {
        let row = rows.find((r) => r.emoji === emoji)
        if (!row) { row = { emoji, count: 0, by: [] }; rows.push(row) }
        row.by.push(data.own)
        row.count++
      }
      const next = rows.filter((r) => r.count > 0)
      groupReactors.set(key, next)
      const shown = shownReactions(next)
      if (shown.length) item.reactions = shown.map(({ emoji, count, by }) => ({ emoji, count, mine: by.includes(data.own) }))
      else delete item.reactions
      return { ok: true }
    },
    'group.reactors': ({ group, target }) => {
      reactionPost(group, target)
      return { reactions: shownReactions(groupReactors.get(reactionKey(group, target)) || []).map(({ emoji, count, by }) => ({ emoji, count, by: by.slice(0, GROUP_REACTORS_MAX) })) }
    },
    'group.rekey': ({ group }) => {
      const g = groupOf(group)
      if (g.visibility !== 'private') refuse('USAGE', 'grupo público não usa chave')
      g.epoch = (g.epoch || 1) + 1
      return { group, epoch: { writer: g.group, seq: g.epoch } }
    },
    'community.create': ({ name, join }) => {
      const community = keyOf(++serial)
      const c = { community, name, join, state: 'ready', role: 'creator', general: null, creator: data.own }
      data.communities.push(c)
      initRoster(c, [profileOf(data.own)])
      const { group } = createGroup({ name: 'Geral', join: 'open', community })
      c.general = group
      return { community, group }
    },
    'community.join': ({ community }) => {
      const c = communityOf(community)
      if (c.role === 'banned') refuse('USAGE', 'sem permissão na comunidade')
      const result = joinEntity(c)
      if (result.state === 'member') setMember(groupOf(c.general), data.own, 'member')
      return { ...result, group: result.state === 'member' ? c.general : null }
    },
    'community.leave': ({ community }) => {
      setMember(communityOf(community), data.own, 'left')
      for (const g of data.groups.filter((g) => g.community === community)) setMember(g, data.own, 'left')
      return { state: 'left' }
    },
    'community.removeGroup': ({ community, group, undo }) => {
      const c = communityOf(community)
      if (c.general === group) refuse('USAGE', 'o grupo Geral só sai com a comunidade')
      if (groupOf(group).community !== community) refuse('USAGE', 'o grupo não é dessa comunidade')
      c.dropped = c.dropped.filter((k) => k !== group)
      if (!undo) c.dropped.push(group)
      c.dropped.sort(compareText)
      return { ok: true }
    },
    'node.info': () => ({
      publicKey: data.own,
      memberCert: true,
      memberCertDate: data.now,
      ...age,
      ...phone,
      followCount: data.follows.length,
      sync,
      publicDht: false,
      groups: true
    }),
    'identity.status': () => ({
      exists: true,
      publicKey: data.own,
      legacy: false,
      unlocked: true,
      synced: true,
      resumed: false,
      passkeyKnown: false,
      credentialId: null,
      rpId: null,
      signedOut: false
    }),
    'dm.list': ({ folder, limit, before }) => {
      const rows = data.conversations.filter((c) => !c.blocked && c.messages.length > 0).map((c) => {
        const last = c.messages[c.messages.length - 1]
        return { peer: c.peer, folder: c.folder, preview: Number.isSafeInteger(last.moment) && last.moment >= 1 ? MOMENT_PREVIEW + ' ' + last.text : preview(last.text, last.media), at: last.at, unread: c.unread, mine: last.mine }
      })
      const candidates = rows.filter((c) => c.folder === folder && (!before || compareDm(c, before) > 0)).sort(compareDm)
      const conversations = candidates.slice(0, limit)
      return {
        conversations,
        next: candidates.length > limit ? dmCursor(conversations[conversations.length - 1]) : null,
        requests: rows.some((c) => c.folder === 'request' && c.unread),
        inboxUnread: rows.some((c) => c.folder === 'inbox' && c.unread)
      }
    },
    'dm.thread': ({ peer, before, limit }) => {
      const c = conversationOf(peer)
      const all = c ? c.messages : []
      let end = all.length
      if (before) {
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].id === before) { end = i; break }
        }
      }
      const start = Math.max(0, end - limit)
      const messages = all.slice(start, end)
      return { messages, next: start > 0 ? messages[0].id : null, folder: c ? c.folder : 'inbox', blocked: c ? c.blocked : false }
    },
    'dm.seen': ({ peer }) => {
      const c = conversationOf(peer)
      if (c) c.unread = false
      return { ok: true }
    },
    'dm.send': ({ to, text, replyTo, media, card, moment }) => {
      if (to === data.own) refuse('USAGE', 'não é possível enviar para si')
      let c = conversationOf(to)
      if (c && c.blocked) refuse('USAGE', 'você bloqueou esta pessoa')
      if (!c && !profileOf(to)) refuse('USAGE', 'esta pessoa ainda não recebe mensagens')
      if (replyTo && (!c || !c.messages.some((m) => m.id === replyTo))) refuse('USAGE', 'responda uma mensagem desta conversa')
      // Like the node: a reaction only names a momento of `to` that is showing.
      if (moment !== undefined && moment !== null && data.momentMedia(to, moment) === null) refuse('USAGE', 'momento não encontrado')
      if (!c) {
        c = { peer: to, folder: 'inbox', unread: false, blocked: false, messages: [] }
        data.conversations.push(c)
      }
      const id = (++messageId).toString(16).padStart(32, '0')
      const at = stamp()
      c.messages.push({ id, from: data.own, text, replyTo: replyTo || null, at, mine: true, media: media || null, ...(card ? { card } : {}), ...(Number.isSafeInteger(moment) && moment >= 1 ? { moment } : {}) })
      c.folder = 'inbox'
      return { id, at }
    },
    'dm.react': ({ to, target, emoji }) => {
      const c = conversationOf(to)
      if (c && c.blocked) refuse('USAGE', 'você bloqueou esta pessoa')
      const item = c?.messages.find((m) => m.from === target.from && m.id === target.id && !m.deleted)
      if (!item) refuse('USAGE', 'mensagem não encontrada')
      if (item.reactable === false) refuse('USAGE', 'esta mensagem não aceita reações')
      const rows = item.reactions || []
      if ((rows.find((r) => r.mine)?.emoji || '') === emoji) return { ok: true }
      const next = rows.filter((r) => !r.mine)
      if (emoji !== '') next.push({ emoji, mine: true })
      if (next.length > 0) item.reactions = next
      else delete item.reactions
      return { ok: true }
    },
    'dm.lookup': ({ member }) => ({ box: profileOf(member) || conversationOf(member) ? member : null, gen: profileOf(member) || conversationOf(member) ? 1 : null }),
    'group.list': ({ offset, limit }) => {
      const groups = data.groups.filter((g) => !communityOf(g.community).dropped.includes(g.group))
      return { groups: groups.slice(offset, offset + limit).map(groupRow), total: groups.length }
    },
    'group.read': ({ group, limit, before }) => {
      const g = groupOf(group)
      const candidates = orderedItems(g).reverse().filter((item) => !before || comparePosition(item, before, 'writer') < 0)
      const items = candidates.slice(0, limit).map((item) => {
        if (!item.hidden) return item
        const { reactions, ...hidden } = item
        return { ...hidden, text: '', media: null, card: null }
      })
      return {
        items,
        next: candidates.length > limit ? groupCursor(items[items.length - 1]) : null,
        hidden: items.filter((item) => item.hidden).length,
        incomplete: false,
        sealed: 0,
        epoch: g.visibility === 'private' ? { writer: g.group, seq: g.epoch || 1 } : null,
        state: 'ok'
      }
    },
    'group.info': ({ group }) => {
      const g = groupOf(group)
      return { ...groupRow(g), creator: g.creator, state: active(g) ? 'member' : g.role, orphan: communityOf(g.community).dropped.includes(g.group), visibility: g.visibility, memberInvite: g.memberInvite, writerHere: true, canWrite: active(g) && active(communityOf(g.community)) && !communityOf(g.community).dropped.includes(g.group), writersBound: 1 }
    },
    'group.seen': ({ group, upTo }) => {
      const g = groupOf(group)
      const items = orderedItems(g)
      const item = upTo ? items.find((item) => item.writer === upTo.writer && item.seq === upTo.seq) : items[items.length - 1]
      if (item && (!g.seen || comparePosition(item, g.seen, 'writer') > 0)) g.seen = groupCursor(item)
      return { ok: true }
    },
    'group.post': ({ group, text, replyTo, media }) => {
      const g = groupOf(group)
      if (!active(g) || !active(communityOf(g.community)) || communityOf(g.community).dropped.includes(group)) refuse('USAGE', 'sem permissão no grupo')
      const seq = Math.max(1, ...g.items.filter((item) => item.writer === g.writer).map((item) => item.seq)) + 1
      const p = profileOf(data.own)
      g.items.push({ writer: g.writer, diary: data.own, seq, at: stamp(), text, replyTo: replyTo || null, hidden: false, media: media || null, name: p.name, username: p.username })
      return { seq }
    },
    'community.list': () => {
      const roles = ['creator', 'admin', 'member']
      const rank = (role) => roles.includes(role) ? roles.indexOf(role) : roles.length
      const communities = data.communities.map(communityRow).sort((a, b) => rank(a.role) - rank(b.role) || compareText(a.name, b.name) || compareText(a.community, b.community))
      return { communities }
    },
    'community.info': ({ community }) => {
      const c = data.communities.find((c) => c.community === community)
      if (!c) refuse('NOT_FOUND', 'comunidade não encontrada')
      return {
        ...communityRow(c),
        creator: c.creator,
        members: memberCount(c),
        admins: rowsOf(c).filter((m) => m.admin && m.state === 'member').length,
        groups: data.groups.filter((g) => g.community === community && !c.dropped.includes(g.group)).sort((a, b) => compareText(a.group, b.group)).map(groupSummary),
        incomplete: false,
        dropped: c.dropped,
        repair: false,
        leavePending: false,
        memberInvite: c.memberInvite,
        writerHere: true,
        canWrite: active(c),
        rootHere: c.creator === data.own,
        authorityHere: active(c) && (c.role === 'admin' || c.role === 'creator'),
        writersBound: 1,
        generalWritersBound: 1
      }
    },
    'feed.read': ({ limit, before }) => ({
      items: [...data.feed, ...extraFeed].filter((item) => (item.author === data.own || data.follows.includes(item.author)) && (!before || comparePosition(item, before, 'author') < 0)).sort((a, b) => comparePosition(a, b, 'author')).slice(-limit),
      skipped: [],
      skippedTruncated: 0,
      future: [],
      futureTruncated: 0,
      incomplete: [],
      incompleteTruncated: 0
    }),
    'notices.list': ({ limit, after }) => {
      const candidates = [...data.notices].sort(compareNotice).filter((n) => !after || compareNotice(n, { seq: 1, ...after }) > 0)
      const notices = candidates.slice(0, limit)
      return { notices, next: candidates.length > limit ? noticeCursor(notices[notices.length - 1]) : null, incomplete: false, supported: true, activity: true }
    },
    'profile.read': ({ authors }) => {
      const profiles = []
      const missing = []
      for (const author of new Set(authors)) {
        const p = profileOf(author)
        if (p) profiles.push(p)
        else missing.push(author)
      }
      return { profiles, missing }
    },
    'testimonial.write': ({ to, text }) => {
      if (to === data.own) refuse('USAGE', 'não pode escrever um depoimento para si')
      if (!profileOf(to) && !conversationOf(to)) refuse('USAGE', 'a pessoa ainda não recebe mensagens')
      if (badText(text)) refuse('USAGE', 'registro inválido: malformed')
      const nonce = keyOf(++serial)
      const result = append(sealedTestimonial({ from: data.own, to, text, nonce, at: stamp() }))
      sealed.set(result.ref, { text, nonce })
      return result
    },
    'testimonial.pending': () => ({
      items: testimonialPointersOf(data.own).pending.flatMap(({ from, seq }) => {
        const opened = sealed.get(`${from}:${seq}`)
        const block = liveEntry(from, seq)
        return opened && block ? [{ from, seq, text: opened.text, at: block.record.at }] : []
      }),
      incomplete: false
    }),
    'testimonial.show': ({ from, seq }) => {
      const opened = sealed.get(`${from}:${seq}`)
      const block = from === data.own ? null : liveEntry(from, seq)
      if (!opened || !block || block.record.type !== 'testimonial' || block.record.to !== data.own || block.record.hash !== testimonialHash(from, opened.nonce, opened.text)) refuse('USAGE', 'depoimento não encontrado')
      const existing = logs.get(data.own).find((e) => e.record.type === 'testimonial-show' && e.record.from === from && e.record.seq === seq && !deleted.has(`${data.own}:${e.seq}`))
      if (existing) return { seq: existing.seq, ref: `${data.own}:${existing.seq}` }
      return append({ type: 'testimonial-show', from, seq, text: opened.text, nonce: opened.nonce, at: stamp() })
    },
    'testimonial.delete': ({ to, about }) => {
      const target = targetOf(to)
      if (target.author !== data.own) refuse('USAGE', 'referência inválida')
      if (deleted.has(to)) return { seq: deleted.get(to).seq, deleted: [target.seq] }
      const entry = liveEntry(data.own, target.seq)
      if (!entry || !['testimonial', 'testimonial-show'].includes(entry.record.type)) refuse('USAGE', 'referência inválida')
      // `about`: a depoimento to that person, never a show or one to someone else.
      if (about !== undefined && (entry.record.type !== 'testimonial' || entry.record.to !== about)) refuse('USAGE', 'referência inválida')
      // Removing a show removes every show of that writer, so an older one
      // never comes back.
      const seqs = entry.record.type === 'testimonial'
        ? [target.seq]
        : logs.get(data.own).filter((e) => e.record.type === 'testimonial-show' && e.record.from === entry.record.from && !deleted.has(`${data.own}:${e.seq}`)).map((e) => e.seq)
      let last
      for (const seq of seqs) {
        last = append({ type: 'delete', seq, at: stamp() })
        deleted.set(`${data.own}:${seq}`, last)
      }
      return { seq: last.seq, deleted: seqs }
    },
    'moment.putMedia': ({ mime, width, height }) => {
      const n = mediaStart++
      return { id: keyOf(0xe80 + n), key: keyOf(0xf80 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), chunks: 1, bytes: 2048, sha256: keyOf(0x880 + n), mime, w: width, h: height, ms: 0 }
    },
    // Only an item the Vitrine media handle's putMoment answered and no
    // moment published yet, as the web node's entry check.
    'moment.create': ({ text, media, music }) => {
      const prepared = data.momentUploads ? data.momentUploads.get(media.id) : null
      if (!prepared || JSON.stringify(prepared) !== JSON.stringify(media)) refuse('USAGE', 'prepare a mídia de novo')
      if (badText(text)) refuse('USAGE', 'registro inválido: malformed')
      data.momentUploads.delete(media.id)
      return append({ type: 'moment', text, at: stamp(), media, ...(music ? { music } : {}) })
    },
    'moments.read': () => {
      const authors = data.follows.filter((author) => author !== data.own).flatMap((author) => {
        const items = momentsOf(author).filter((e) => showing(e.record)).slice(0, 4)
        return items.length > 0 ? [{ author, newest: Date.parse(items[0].record.at), items: items.map((e) => momentRow(author, e)) }] : []
      }).sort((a, b) => b.newest - a.newest || compareText(a.author, b.author)).slice(0, 32).map(({ author, items }) => ({ author, items }))
      const ownMoments = momentsOf(data.own)
      return {
        authors,
        own: ownMoments.filter((e) => showing(e.record)).slice(0, 4).map((e) => momentRow(data.own, e)),
        past: ownMoments.filter((e) => Date.parse(e.record.at) + MOMENT_TTL_MS <= demoNow()).slice(0, 16).map((e) => ({ seq: e.seq, ref: `${data.own}:${e.seq}`, text: e.record.text, at: shown(e.record.at) }))
      }
    },
    'moment.lookup': ({ author, seq }) => {
      const entry = momentsOf(author).find((e) => e.seq === seq)
      if (!entry || !showing(entry.record)) refuse('NOT_FOUND', 'foto indisponível')
      const { mime, w, h } = entry.record.media
      return { mime, w, h, ms: 0, at: shown(entry.record.at) }
    },
    'moment.delete': ({ to }) => {
      const target = targetOf(to)
      if (target.author !== data.own) refuse('USAGE', 'referência inválida')
      if (deleted.has(to)) return { seq: deleted.get(to).seq, deleted: [target.seq] }
      const entry = liveEntry(data.own, target.seq)
      if (!entry || entry.record.type !== 'moment') refuse('USAGE', 'referência inválida')
      const tombstone = append({ type: 'delete', seq: target.seq, at: stamp() })
      deleted.set(to, tombstone)
      return { seq: tombstone.seq, deleted: [target.seq] }
    },
    'diary.peek': ({ author, seqs, profileSeq, usernameSeq }) => {
      const p = profileOf(author)
      if (!p) refuse('NOT_FOUND', 'diário indisponível')
      const all = logs.get(author)
      const entries = []
      const invalid = []
      const missing = []
      for (const seq of seqs) {
        const entry = all.find((e) => e.seq === seq)
        if (deleted.has(`${author}:${seq}`)) missing.push(seq)
        else if (entry && entry.record.type === 'testimonial-show' && !showHolds(author, entry.record)) invalid.push(seq)
        else if (entry) entries.push(entry)
        else missing.push(seq)
      }
      const profile = all.find((e) => e.seq === profileSeq && e.record.type === 'profile')?.record
      const username = all.find((e) => e.seq === usernameSeq && e.record.type === 'username')?.record
      return {
        key: author,
        length: all[all.length - 1].seq + 1,
        entries,
        invalid,
        missing,
        profile: profile ? { name: profile.name, bio: profile.bio, avatar: profile.avatar || null } : null,
        username: username ? username.username : null
      }
    }
  }

  for (const kind of ['group', 'community']) {
    const entityOf = (params) => kind === 'group' ? groupOf(params.group) : communityOf(params.community)
    handlers[`${kind}.members`] = (params) => memberPage(entityOf(params), params.offset, params.limit, false)
    handlers[`${kind}.requests`] = (params) => memberPage(entityOf(params), params.offset, params.limit, true)
    handlers[`${kind}.meta`] = (params) => {
      const entity = entityOf(params)
      if (entity.visibility === 'private' && params.join === 'open') refuse('USAGE', 'grupo privado exige aprovação')
      if (params.name !== undefined) entity.name = params.name
      if (params.join !== undefined) entity.join = params.join
      return { ok: true }
    }
    handlers[`${kind}.invitePolicy`] = (params) => { entityOf(params).memberInvite = params.members; return { ok: true } }
    for (const action of ['admin', 'ban', 'admit']) {
      handlers[`${kind}.${action}`] = (params) => {
        const entity = entityOf(params)
        if (action === 'admin') setMember(entity, params.member, null, params.on)
        else setMember(entity, params.member, action === 'ban' ? params.on ? 'banned' : 'member' : params.on ? 'member' : 'requested')
        return kind === 'community' && action === 'admin' ? { community: params.community, member: params.member, on: params.on } : { ok: true }
      }
    }
  }

  const request = async (method, params = {}) => {
    useTestimonialSource(testimonialSource)
    if (!Object.hasOwn(handlers, method)) refuse('USAGE', 'método desconhecido')
    const checked = validateParams(method, params)
    if (!checked.ok) refuse(checked.code, checked.message)
    return copy(await handlers[method](copy(checked.value)))
  }
  // The node handle's chat media calls, over the same live state.
  request.media = createVitrineMedia(data)
  request.feira = () => copy({
    listings: [...logs.keys()].flatMap(folded),
    rates: [...logs].flatMap(([author, entries]) => entries.filter((e) => e.record.type === 'listing-rate' && !deleted.has(`${author}:${e.seq}`)).map((e) => ({ author, ...e })))
  })
  request.live = () => copy(live)
  currentFeira = request.feira
  currentLive = request.live
  return request
}
