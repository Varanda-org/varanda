'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const source = () => readFileSync(join(__dirname, '../src/indexClient.js'), 'utf8')
const refOf = (p) => `${p.author}:${p.seq}`
const cursorOf = (p) => `${Date.parse(p.at)}.${p.author}.${p.seq}`
const load = async () => {
  const client = await import('../src/indexClient.js')
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { vitrineIndex } = await import('../src/vitrine/indexResponder.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  return { client, fixtures, vitrineIndex, request: createVitrineRequest(fixtures) }
}

test('every index route and cursor returns a deterministic validated fixture body', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const ref = refOf(f.feed[0])
  const reply = f.noticePosts.find((p) => p.replyTo && refOf(p.replyTo) === ref)
  const cursor = cursorOf(reply)
  const following = { atMs: Date.parse(f.now), key: f.follows[0] }
  const group = f.groups[0]
  const community = f.communities[0].community
  const cases = [
    [c.postUrl(ref), (b) => c.validPostIndex(b, ref)],
    [c.postUrl(ref, cursor), (b) => c.validPostIndex(b, ref)],
    [c.rodaUrl(refOf(reply)), (b) => c.validRoda(b, refOf(reply))],
    [c.rodaUrl(refOf(reply), cursor), (b) => c.validRoda(b, refOf(reply))],
    [c.countsUrl(f.feed.slice(0, 31).map(refOf)), (b) => c.validCounts(b, f.feed.slice(0, 31).map(refOf))],
    [c.memberUrl(f.own), c.validMemberIndex],
    [c.memberUrl(f.own, 5), (b) => c.validMemberIndex(b, 5)],
    [c.memberUrl(f.pages[0].author), c.validMemberIndex],
    [c.eventsUrl(f.own), c.validEvents],
    [c.eventsUrl(f.members[1].author), c.validEvents],
    [c.topicUrl('praca'), c.validTopic],
    [c.topicUrl('praca', cursor), c.validTopic],
    [c.engagersUrl('likes', ref), (b) => c.validEngagers(b, ref, 'likes')],
    [c.engagersUrl('likes', ref, cursor), (b) => c.validEngagers(b, ref, 'likes')],
    [c.engagersUrl('reposts', refOf(f.feed[6])), (b) => c.validEngagers(b, refOf(f.feed[6]), 'reposts')],
    [c.engagersUrl('likes', ref).replace('/likes/', '/quotes/'), (b) => c.validEngagers(b, ref, 'quotes')],
    [c.followCountsUrl(f.own), c.validFollowCounts],
    [c.followsUrl(f.own, 'seguindo'), (b) => c.validFollows(b, f.own, 'seguindo')],
    [c.followsUrl(f.own, 'seguidores'), (b) => c.validFollows(b, f.own, 'seguidores')],
    [c.followsUrl(f.own, 'seguindo', following), (b) => c.validFollows(b, f.own, 'seguindo', following)],
    [c.searchUrl('joao'), c.validSearch],
    [c.searchUrl('biblioteca-praca'), c.validSearch],
    [c.groupUrl(group.group), c.validGroup],
    [c.groupUrl(group.group, group.items[0].writer), (b) => c.validGroup(b, group.items[0].writer)],
    [c.groupUrl(f.groups[3].group), c.validGroup],
    [c.groupsUrl(f.own), c.validGroups],
    [c.communityUrl(community), c.validCommunity],
    [c.communityGroupsUrl(community, group.group), (b) => c.validCommunityGroups(b, group.group)],
    [c.groupSearchUrl('bicicleta'), c.validGroupSearch],
    [c.testimonialsUrl(f.own), (b) => c.validTestimonials(b, f.own)],
    [c.testimonialsUrl(f.members[1].author), (b) => c.validTestimonials(b, f.members[1].author)],
    [c.scrapsUrl(f.own), (b) => c.validScraps(b, f.own)],
    [c.scrapsUrl(f.members[2].author), (b) => c.validScraps(b, f.members[2].author)],
    [c.profileUrl(f.own), c.validProfile],
    [c.profileUrl(f.members[2].author), c.validProfile],
    [c.followPairUrl(f.own, f.members[1].author), c.validFollowPair],
    [c.fansUrl(f.own), (b) => c.validFans(b, f.own)],
    [c.pollUrl(f.own, 60), (b) => c.validPoll(b, 3)],
    [c.pollVotersUrl(f.own, 60, 0), (b) => c.validPollVoters(b)],
    [c.pollVotersUrl(f.own, 60, 2), (b) => c.validPollVoters(b)]
  ]
  for (const [url, validate] of cases) {
    t.ok(url, 'builder accepts the fixture input')
    const body = respond(url)
    t.ok(validate(body), url + ' passes its validator')
    t.alike(respond(url), body, 'deterministic')
    t.alike(respond('https://example.invalid' + url + '?ignored=1#fragment'), body, 'origin and query ignored')
    t.alike(respond(url.slice(1)), body, 'relative path')
    body.indexing = true
    t.is(respond(url).indexing, false, 'fresh response')
  }
})

test('post, member, search, engagement and follow references resolve through diary.peek', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  async function peek (author, seqs) {
    const result = await request('diary.peek', { author, seqs: seqs.length ? [...seqs].sort((a, b) => a - b) : [1, 2], profileSeq: 1, usernameSeq: 2 })
    t.alike(result.missing, [], 'all referenced blocks exist')
    t.alike(result.invalid, [])
    t.ok(result.profile && result.username, 'profile hints resolve')
    return { ...result, entries: result.entries.filter((e) => seqs.includes(e.seq)) }
  }
  async function record (ref) {
    const [author, seq] = ref.split(':')
    return (await peek(author, [Number(seq)])).entries[0].record
  }
  const posts = [...f.feed, ...f.noticePosts]
  // The counts route takes at most 31 refs a call.
  const counts = {}
  for (let i = 0; i < posts.length; i += 31) Object.assign(counts, respond(c.countsUrl(posts.slice(i, i + 31).map(refOf))).counts)
  for (const post of posts) {
    const ref = refOf(post)
    const body = respond(c.postUrl(ref))
    t.is((await record(body.ref)).type, 'post')
    t.is(body.parent, post.replyTo ? refOf(post.replyTo) : null)
    if (body.parent) t.is((await record(body.parent)).type, 'post')
    for (const [kind, field] of [['replies', 'replyTo'], ['quotes', 'quote']]) {
      const expected = posts.filter((p) => p[field] && refOf(p[field]) === ref).map(refOf)
      t.alike([...body[kind]].sort(), expected.sort(), kind + ' use fixture targets')
      for (const target of body[kind]) t.is(refOf((await record(target))[field]), ref)
      t.is(counts[ref][kind], expected.length)
    }
    for (const kind of ['likes', 'reposts']) {
      const engagement = respond(c.engagersUrl(kind, ref))
      t.is(engagement.total, counts[ref][kind])
      t.is(body[kind], counts[ref][kind])
      for (const target of engagement.items) {
        const r = await record(target)
        t.is(r.type, kind.slice(0, -1))
        t.is(refOf(r.to), ref)
        t.is(r.on, true)
      }
    }
  }
  for (const profile of [...f.members, ...f.pages, ...f.applicants]) {
    const author = profile.author
    const body = respond(c.memberUrl(author))
    const reposts = f.diaryRecords.filter((e) => e.author === author && e.record.type === 'repost' && e.record.on).map((e) => e.seq)
    const expected = [...new Set([...posts.filter((p) => p.author === author).map((p) => p.seq), ...reposts])].sort((a, b) => b - a)
    t.alike(body.posts, expected)
    t.is(body.postsTotal, expected.length)
    const result = await peek(author, body.posts)
    t.is(body.length, result.length)
    t.ok(result.entries.every((e) => e.record.type === 'post' || (e.record.type === 'repost' && reposts.includes(e.seq))))
    const before = body.posts[0] || 3
    t.alike(respond(c.memberUrl(author, before)).posts, body.posts.filter((seq) => seq < before), 'exclusive member cursor')
    const total = respond(c.followCountsUrl(author))
    for (const kind of ['seguindo', 'seguidores']) {
      const follows = respond(c.followsUrl(author, kind))
      t.is(follows.total, total[kind])
      t.ok(c.validFollows(follows, author, kind))
      for (const item of follows.items) {
        const r = await record(`${kind === 'seguindo' ? author : item.key}:${item.seq}`)
        t.is(r.type, 'follow')
        t.is(r.key, kind === 'seguindo' ? item.key : author)
        t.is(r.on, true)
      }
    }
  }
  t.alike(respond(c.followsUrl(f.own, 'seguindo')).items.map((r) => r.key).sort(), [...f.follows].sort())
  for (const segment of ['lia', 'joao', 'cecilia', 'biblioteca-praca', 'horta-do-bairro']) {
    const result = respond(c.searchUrl(segment))
    t.ok(result.members.length > 0, segment + ' is populated')
    for (const member of result.members) await peek(member.author, [member.profileSeq, member.usernameSeq])
  }
  t.is(respond(c.searchUrl('biblioteca')).members[0].page, true)
  t.alike(respond(c.searchUrl('inexistente')).members, [])
  const topic = respond(c.topicUrl('praca'))
  t.ok(topic.items.length > 0)
  for (const ref of topic.items) t.ok((await record(ref)).text.includes('praça'))
  const first = posts.find((p) => refOf(p) === topic.items[0])
  t.alike(respond(c.topicUrl('praca', cursorOf(first))).items, topic.items.slice(1), 'topic cursor advances')
  const reply = f.noticePosts.find((p) => p.replyTo)
  t.alike(respond(c.postUrl(refOf(reply.replyTo), cursorOf(reply))).replies, [], 'reply cursor advances')
})

test('group and community indexes match the Vitrine RPC and preserve private names', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  t.alike(respond(c.groupsUrl(f.own)).groups.map((g) => g.group), f.groups.map((g) => g.group))
  for (const group of f.groups) {
    const body = respond(c.groupUrl(group.group))
    const info = await request('group.info', { group: group.group })
    t.is(body.community, info.community)
    t.is(body.join, info.join)
    t.is(body.visibility, info.visibility)
    t.is(body.name, group.visibility === 'private' ? null : info.name)
    t.ok(body.writers.some((w) => w.key === group.writer && w.diary === f.own))
    const after = body.writers[0].key
    t.alike(respond(c.groupUrl(group.group, after)).writers, body.writers.slice(1))
  }
  for (const community of f.communities) {
    const body = respond(c.communityUrl(community.community))
    const info = await request('community.info', { community: community.community })
    t.is(body.name, info.name)
    t.is(body.members, info.members)
    t.alike(body.groups.map((g) => g.group), f.groups.filter((g) => g.community === community.community).map((g) => g.group))
    const after = body.groups[0].group
    t.alike(respond(c.communityGroupsUrl(community.community, after)).groups, body.groups.slice(1))
    t.ok(c.validCommunity(body))
  }
  const reposter = f.diaryRecords.find((e) => e.record.type === 'repost' && e.record.on)
  t.ok(respond(c.memberUrl(reposter.author)).posts.includes(reposter.seq), 'active repost listed on the profile')
  const names = (segment) => respond(c.searchUrl(segment)).members.map((m) => m.author)
  const byName = (name) => f.members.find((m) => m.name === name).author
  t.ok(names('lia').includes(byName('Lia Oliveira')), 'prefix finds Lia')
  t.absent(names('lia').includes(byName('Cecília Ramos')), 'lia is not inside Cecília')
  t.alike(respond(c.groupSearchUrl('icleta')).groups, [], 'substring is not a match')
  t.alike(respond(c.groupSearchUrl('bici')).groups.map((g) => g.name), ['Passeios de bicicleta'])
  const clube = f.groups[2]
  const distinct = new Set([f.own, ...clube.items.map((i) => i.diary)]).size
  t.ok(clube.items.length + 1 > distinct, 'fixture has a writer core and a message row for one diary')
  t.is(respond(c.communityUrl(clube.community)).groups.find((g) => g.group === clube.group).writerCount, distinct, 'distinct diaries')
  t.is(respond(c.groupSearchUrl('geral')).groups.find((g) => g.group === clube.group).writerCount, distinct)
  t.alike(respond(c.groupSearchUrl('bicicleta')).groups.map((g) => g.group), [f.groups[1].group])
  t.alike(respond(c.groupSearchUrl('organizacao')).groups, [])
})

test('last write wins per author, writer seqs follow records and each route keeps its tie order', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const posts = [...f.feed, ...f.noticePosts]
  const target = refOf(f.feed[0])
  const [tAuthor, tSeq] = [f.feed[0].author, f.feed[0].seq]
  const to = { author: tAuthor, seq: tSeq }
  const [a, b] = ['a'.repeat(64), 'b'.repeat(64)]
  const base = respond(c.countsUrl([target])).counts[target]
  const saved = [...f.diaryRecords]
  const stamp = '2026-11-20T10:00:00.000Z'
  const add = (author, seq, record) => f.diaryRecords.push({ author, seq, record })
  try {
    add(a, 900, { type: 'like', to, on: true, at: stamp })
    add(a, 901, { type: 'like', to, on: false, at: stamp })
    add(b, 902, { type: 'like', to, on: true, at: stamp })
    add(b, 903, { type: 'like', to, on: true, at: stamp })
    const likes = respond(c.engagersUrl('likes', target))
    t.ok(c.validEngagers(likes, target, 'likes'), 'no duplicate engagers')
    t.absent(likes.items.includes(`${a}:900`) || likes.items.includes(`${a}:901`), 'unliked author is not listed')
    t.is(likes.items.filter((r) => r.startsWith(b + ':')).length, 1, 'two likes list the author once')
    t.is(likes.total, base.likes + 1, 'only the second author is counted')
    t.is(respond(c.countsUrl([target])).counts[target].likes, base.likes + 1)
    // a tie on at: likers go author ascending, then seq descending
    const tied = likes.items.filter((r) => r.startsWith(b + ':'))
    t.alike(tied, [`${b}:903`])
    add(a, 904, { type: 'like', to, on: true, at: stamp })
    const order = respond(c.engagersUrl('likes', target)).items.filter((r) => /:90[34]$/.test(r))
    t.alike(order, [`${a}:904`, `${b}:903`], 'tie on at: author ascending')

    // follows: a later unfollow cancels the follow, a repeat counts once
    const page = f.pages[0].author
    const before = respond(c.followCountsUrl(page)).seguidores
    add(a, 910, { type: 'follow', key: page, on: true, at: stamp })
    add(a, 911, { type: 'follow', key: page, on: false, at: stamp })
    add(b, 912, { type: 'follow', key: page, on: true, at: stamp })
    add(b, 913, { type: 'follow', key: page, on: true, at: stamp })
    const followers = respond(c.followsUrl(page, 'seguidores'))
    t.ok(c.validFollows(followers, page, 'seguidores'))
    t.is(respond(c.followCountsUrl(page)).seguidores, before + 1)
    t.absent(followers.items.some((r) => r.key === a && r.seq === 910), 'unfollowed author is not listed')
    t.is(followers.items.filter((r) => r.key === b).length, 1)
    const member = f.members[1].author
    const kept = respond(c.followCountsUrl(member)).seguindo
    add(member, 920, { type: 'follow', key: page, on: true, at: stamp })
    add(member, 921, { type: 'follow', key: page, on: false, at: stamp })
    t.is(respond(c.followCountsUrl(member)).seguindo, kept, 'seguindo drops the cancelled follow')
  } finally {
    f.diaryRecords.length = 0
    f.diaryRecords.push(...saved)
  }

  // quote pages are the exact reverse of (at, author, seq); likers are not
  const quoted = posts.filter((p) => p.quote)
  for (const q of quoted) {
    const ref = refOf(q.quote)
    const rows = posts.filter((p) => p.quote && refOf(p.quote) === ref)
    const expected = [...rows].sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (x.author < y.author ? 1 : x.author > y.author ? -1 : 0) || y.seq - x.seq).map(refOf)
    t.alike(respond(c.engagersUrl('likes', ref).replace('/likes/', '/quotes/')).items, expected, 'quotes: author descending on ties')
  }

  // writer rows: seq is the newest record on that writer, length and signed agree
  for (const group of f.groups) {
    const body = respond(c.groupUrl(group.group))
    t.ok(c.validGroup(body))
    for (const item of group.items) {
      const w = body.writers.find((x) => x.key === item.writer)
      t.is(w.seq, item.seq, 'writer seq is the newest record seq')
      t.is(w.length, w.seq + 1)
      t.is(w.signed, w.length)
    }
    const own = respond(c.groupsUrl(f.own)).groups.find((g) => g.group === group.group)
    t.is(own.seq, body.writers.find((x) => x.key === own.writer).seq, 'groups index agrees')
  }
})

test('the index client statically imports only the enable check and guards the responder require', (t) => {
  const code = source()
  const imports = [...code.matchAll(/\bimport\s+[^\n]+from\s+['"]([^'"]*vitrine\/[^'"]+)['"]/g)].map((m) => m[1])
  t.alike(imports, ['./vitrine/enabled.js'])
  t.ok(/const VITRINE = vitrineEnabled\(\{ EXPO_PUBLIC_VARANDA_VITRINE: process\.env\.EXPO_PUBLIC_VARANDA_VITRINE \}, typeof __DEV__ !== 'undefined' && __DEV__\)/.test(code))
  t.ok(/if \(typeof __DEV__ !== 'undefined' && __DEV__ && process\.env\.EXPO_PUBLIC_VARANDA_VITRINE === '1' && VITRINE\) \{\s*const { vitrineIndex: respond \} = require\('\.\/vitrine\/indexResponder'\)/.test(code))
  t.is((code.match(/require\('\.\/vitrine\/indexResponder'\)/g) || []).length, 1)
  t.ok(/async function getJson \(url, deps = \{\}\) \{\s*if \(VITRINE\) return vitrineIndex\(url\)/.test(code))
})

let serial = 0
async function guardedClient (dev, flag, respond, onRequire) {
  const savedDev = Object.getOwnPropertyDescriptor(globalThis, '__DEV__')
  const savedRequire = Object.getOwnPropertyDescriptor(globalThis, 'require')
  const savedFlag = process.env.EXPO_PUBLIC_VARANDA_VITRINE
  globalThis.__DEV__ = dev
  globalThis.require = (name) => {
    onRequire(name)
    return { vitrineIndex: respond }
  }
  process.env.EXPO_PUBLIC_VARANDA_VITRINE = flag
  try {
    // Metro supplies require in the app's ESM modules; Node needs this bridge.
    return await import('../src/indexClient.js?guard=' + ++serial)
  } finally {
    if (savedDev) Object.defineProperty(globalThis, '__DEV__', savedDev)
    else delete globalThis.__DEV__
    if (savedRequire) Object.defineProperty(globalThis, 'require', savedRequire)
    else delete globalThis.require
    if (savedFlag === undefined) delete process.env.EXPO_PUBLIC_VARANDA_VITRINE
    else process.env.EXPO_PUBLIC_VARANDA_VITRINE = savedFlag
  }
}

test('Vitrine fetchers bypass HTTP and the scheduler, and map unknown fixtures to not-found', async (t) => {
  const { fixtures: f, vitrineIndex: respond } = await load()
  const c = await guardedClient(true, '1', respond, (name) => t.is(name, './vitrine/indexResponder'))
  let fetched = 0
  const deps = { fetch: async () => { fetched++; throw new Error('unexpected network') }, setTimeout: () => { throw new Error('unexpected timer') } }
  const ref = refOf(f.feed[0])
  const calls = [
    () => c.fetchPost(ref, null, deps),
    () => c.fetchRoda(refOf(f.noticePosts.find((p) => p.replyTo)), null, deps),
    () => c.fetchCounts([ref], deps),
    () => c.fetchMember(f.own, null, deps),
    () => c.fetchTopic('praca', null, deps),
    () => c.fetchEngagers('likes', ref, null, deps),
    () => c.fetchFollowCounts(f.own, deps),
    () => c.fetchFollows(f.own, 'seguindo', null, deps),
    () => c.fetchSearch('lia', deps),
    () => c.fetchGroup(f.groups[0].group, null, deps),
    () => c.fetchGroups(f.own, deps),
    () => c.fetchCommunity(f.communities[0].community, deps),
    () => c.fetchCommunityGroups(f.communities[0].community, f.groups[0].group, deps),
    () => c.fetchGroupSearch('geral', deps),
    () => c.fetchTestimonials(f.own, deps)
  ]
  for (let pass = 0; pass < 2; pass++) {
    for (const call of calls) t.is((await call()).ok, true, 'validated result without HTTP or timers')
  }
  const unknown = 'f'.repeat(64)
  for (const result of [await c.fetchPost(unknown + ':3', null, deps), await c.fetchRoda(unknown + ':3', null, deps), await c.fetchRoda(ref, null, deps), await c.fetchMember(unknown, null, deps), await c.fetchGroup(unknown, null, deps), await c.fetchCommunity(unknown, deps)]) {
    t.alike(result, { ok: false, reason: 'not-found' })
  }
  t.alike(await c.fetchPost('invalid', null, deps), { ok: false, reason: 'invalid-input' })
  t.exception(() => respond('/index/unknown/value'), /not-found/)
  t.exception(() => respond('/other/post/' + f.own + '/3'), /not-found/)
  t.is(fetched, 0)
})

test('the testimonials route answers pointers from the live Vitrine state', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [joao, cecilia, bia] = [f.members[1].author, f.members[2].author, f.members[4].author]
  const body = () => respond(c.testimonialsUrl(f.own))
  t.alike(body(), { shown: [{ seq: 37, from: cecilia, wseq: 60 }, { seq: 36, from: joao, wseq: 60 }], pending: [{ from: bia, seq: 60 }], indexing: false, complete: true })
  t.ok(c.validTestimonials(body(), f.own))
  t.alike(respond(c.testimonialsUrl(joao)).shown, [{ seq: 61, from: f.own, wseq: 38 }])
  t.alike(respond(c.testimonialsUrl(f.members[3].author)), { shown: [], pending: [], indexing: false, complete: true })
  t.exception(() => respond(c.testimonialsUrl('f'.repeat(64))), /not-found/)
  t.exception(() => respond('/index/testimonials/' + f.own + '/extra'), /not-found/)

  const shown = await request('testimonial.show', { from: bia, seq: 60 })
  t.alike(body().shown[0], { seq: shown.seq, from: bia, wseq: 60 })
  t.alike(body().pending, [])
  t.ok(c.validTestimonials(body(), f.own), 'never one block both shown and pending')
  await request('testimonial.delete', { to: shown.ref })
  t.absent(body().shown.some((row) => row.from === bia), 'a removed show leaves the profile')
  t.alike(body().pending, [], 'and never returns to pending')
  await request('testimonial.delete', { to: f.own + ':38' })
  t.alike(respond(c.testimonialsUrl(joao)).shown, [], 'a revoked writer block hides the show')
  const written = await request('testimonial.write', { to: cecilia, text: 'Obrigada pelas mudas!' })
  t.alike(respond(c.testimonialsUrl(cecilia)).pending, [{ from: f.own, seq: written.seq }])
})

test('the recados routes answer admitted pointers, hides, the wall and the follow seq', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const [joao, cecilia, andre, bia] = [f.members[1].author, f.members[2].author, f.members[3].author, f.members[4].author]
  const own = () => respond(c.scrapsUrl(f.own))
  const rows = own().scraps
  t.is(rows.length, 3, 'two followed writers and one reply')
  t.alike(rows.find((r) => r.author === joao), { author: joao, seq: 90, followSeq: 7 })
  t.alike(rows.find((r) => r.author === cecilia), { author: cecilia, seq: 90, followSeq: 8 })
  t.alike(rows.find((r) => r.author === bia), { author: bia, seq: 90, followSeq: null }, 'admitted by the reply exception')
  t.alike(own().hides, [])
  t.is(own().wall, null)
  t.alike(respond(c.scrapsUrl(joao)).scraps.map((r) => r.author), [], "João follows nobody, so Lia's recado is not admitted")
  t.alike(respond(c.scrapsUrl(andre)), { scraps: [], hides: [], wall: null, next: null, indexing: false, complete: true })
  t.alike(respond(c.followPairUrl(f.own, joao)), { seq: 7, indexing: false })
  t.alike(respond(c.followPairUrl(f.own, bia)), { seq: null, indexing: false })
  const walled = respond(c.scrapsUrl(cecilia))
  t.alike(walled.scraps.map((r) => r.author + ':' + r.seq), [bia + ':91', andre + ':90'], 'everyone may write, the hidden one is left out')
  t.alike(walled.scraps.map((r) => r.followSeq), [null, null])
  t.alike([walled.hides, walled.wall], [[92], 91])
  t.exception(() => respond('/index/scraps/' + f.own + '/abc'), /status/, 'a malformed cursor is a 400')
  t.exception(() => respond('/index/scraps/' + f.own + '/01'), /status/)
  t.exception(() => respond(c.scrapsUrl('f'.repeat(64))), /not-found/)
  t.exception(() => respond('/index/follow/' + f.own), /not-found/)
  t.exception(() => respond(c.followPairUrl('f'.repeat(64), joao)), /not-found/)
})

test('the recados routes follow the live Vitrine state and page with a cursor', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [joao, cecilia, bia] = [f.members[1].author, f.members[2].author, f.members[4].author]
  const rows = () => respond(c.scrapsUrl(f.own)).scraps.map((r) => r.author + ':' + r.seq)
  t.alike(rows(), [bia + ':90', cecilia + ':90', joao + ':90'])
  await request('scrap.wall', { who: 'nobody' })
  t.alike(rows(), [], 'nobody shows nothing')
  t.ok(respond(c.scrapsUrl(f.own)).wall > 0)
  await request('scrap.wall', { who: 'following' })
  await request('scrap.hide', { from: bia, seq: 90 })
  t.alike(rows(), [cecilia + ':90', joao + ':90'], 'a hidden reply leaves the page')
  t.is(respond(c.scrapsUrl(f.own)).hides.length, 1)
  await request('follow.remove', { key: cecilia })
  t.alike(rows(), [joao + ':90'], 'an unfollowed writer is no longer admitted')
  const written = await request('scrap.write', { to: joao, text: 'Oi, João!' })
  await request('scrap.delete', { seq: 49 })
  t.ok(written.seq > 49)
  t.alike(respond(c.followPairUrl(f.own, cecilia)), { seq: null, indexing: false })

  const wide = respond(c.scrapsUrl(cecilia))
  t.is(wide.next, null, 'one page holds them all')
  t.alike(respond('/index/scraps/' + cecilia + '/1').scraps, wide.scraps.slice(1), 'the cursor is an offset into the admitted rows')
  t.alike(respond('/index/scraps/' + cecilia + '/50').scraps, [], 'past the end is empty')
})

test('release bundles and development without the opt-in retain HTTP behavior', async (t) => {
  let fetched = 0
  for (const [dev, flag] of [[false, '1'], [true, '0'], [undefined, '1']]) {
    const c = await guardedClient(dev, flag, () => t.fail('unexpected fixture response'), () => t.fail('unexpected fixture require'))
    const result = await c.fetchPost('a'.repeat(64) + ':3', null, { fetch: async () => { fetched++; return { status: 404 } } })
    t.alike(result, { ok: false, reason: 'not-found' })
  }
  t.is(fetched, 3)
})

test('the testimonials route reads the Vitrine instance used last', async (t) => {
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const { vitrineIndex } = await import('../src/vitrine/indexResponder.js')
  const a = createVitrineRequest(fixtures)
  createVitrineRequest(fixtures)
  const before = vitrineIndex('/index/testimonials/' + fixtures.own)
  t.ok(before.pending.length > 0, 'a pending depoimento in the fixtures')
  const { from, seq } = before.pending[0]
  await a('testimonial.show', { from, seq })
  const after = vitrineIndex('/index/testimonials/' + fixtures.own)
  t.absent(after.pending.some((p) => p.from === from && p.seq === seq), 'the instance that showed it is the one the route reads')
})

test('Feira city, author and rating routes validate and hydrate their fixture refs', async (t) => {
  const { client: c, fixtures: f, vitrineIndex, request } = await load()
  const respond = (url) => vitrineIndex(url, request)
  const { hydrate, ratingRefs, ratings } = await import('../src/feiraClient.js')
  const cityUrl = c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo' })
  const body = respond(cityUrl)
  t.ok(c.validFeira(body))
  const city = await hydrate(request, body)
  t.is(city.dropped, 0)
  t.is(city.unavailable, 0)
  t.ok(city.items.length > 0)
  t.absent(city.items.some((i) => i.status === 'vendido' || i.kind === 'procura'))
  t.ok(city.items.some((i) => i.status === 'reservado'))
  t.ok(city.items.some((i) => i.page))
  t.ok(city.items.some((i) => i.kind === 'servico' && i.unit === 'hora'))
  const author = respond(c.feiraAuthorUrl(f.own))
  t.ok(c.validFeira(author, { author: f.own }))
  const own = await hydrate(request, author)
  t.ok(own.items.some((i) => i.status === 'vendido'))
  t.ok(own.items.some((i) => i.kind === 'procura'))
  const wanted = respond(c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo', kind: 'procura' }))
  t.is(wanted.items.length, 1)
  const filtered = respond(c.feiraUrl({ uf: 'SP', cityKey: 'sao-paulo', kind: 'produto', cat: 'esporte', tokens: 'azul+revisada' }))
  t.alike(filtered.items.map((i) => i.ref), [`${f.own}:40`])
  t.alike(respond(c.feiraUrl({ uf: 'RJ', cityKey: 'rio-de-janeiro' })).items, [])
  const rateBody = respond(c.feiraRatingsUrl(f.own))
  t.ok(c.validFeira(rateBody, { ratings: true }))
  t.alike(rateBody.items.map((i) => i.ref).sort(), f.rates.map(refOf).sort())
  for (const item of rateBody.items) t.alike(Object.keys(item), ['ref'])
  const refs = await ratingRefs(f.own, null, { fetchFeiraRatings: async () => ({ ok: true, value: rateBody }) })
  const verified = await ratings(request, { author: f.own, seq: 40, refs: refs.refs })
  t.is(verified.items.length, 1)
  body.items[0].status = 'vendido'
  t.absent(respond(cityUrl).items.some((i) => i.status === 'vendido'), 'responses cannot mutate the instance')
})

test('Feira cursors are exclusive across authors and live edits and statuses refresh index hints', async (t) => {
  const { client: c, fixtures: f, vitrineIndex, request } = await load()
  const sample = f.listings.find((e) => e.author === f.own && e.seq === 40).record
  const { type, at, ...fields } = sample
  for (let i = 0; i < 27; i++) await request('listing.create', fields)
  const query = { uf: 'SP', cityKey: 'sao-paulo' }
  const first = vitrineIndex(c.feiraUrl(query), request)
  t.is(first.items.length, 30)
  t.ok(first.next)
  t.ok(c.validFeira(first))
  const second = vitrineIndex(c.feiraUrl({ ...query, cursor: first.next }), request)
  t.is(second.items.length, 1)
  t.is(second.next, null)
  t.ok(c.validFeira(second))
  t.is(new Set([...first.items, ...second.items].map((i) => i.ref)).size, 31)
  const searched = vitrineIndex(c.feiraUrl({ ...query, tokens: 'bicicleta' }), request)
  t.ok(c.validFeira(searched))
  const cursor = `${Date.parse(sample.at)}.${f.own}.40`
  t.ok(c.validFeira(vitrineIndex(c.feiraUrl({ ...query, tokens: 'bicicleta', cursor }), request)))
  t.ok(c.validFeira(vitrineIndex(c.feiraAuthorUrl(f.own, cursor), request), { author: f.own }))
  const rating = f.rates[1]
  const rateCursor = `${Date.parse(rating.record.at)}.${rating.author}.${rating.seq}`
  const ratings = vitrineIndex(c.feiraRatingsUrl(f.own, rateCursor), request)
  t.is(ratings.items.length, 1)
  t.ok(c.validFeira(ratings, { ratings: true }))
  const to = `${f.own}:40`
  const { kind, ...snapshot } = fields
  const edited = await request('listing.edit', { to, expectedRevision: 44, ...snapshot, title: 'Bicicleta amarela' })
  const status = await request('listing.status', { to, status: 'reservado' })
  const refreshed = vitrineIndex(c.feiraUrl({ ...query, tokens: 'amarela' }), request)
  t.alike(refreshed.items, [{ ref: to, editSeq: edited.seq, status: 'reservado', statusSeq: status.seq }])
})

test('Feira probe sees the offline demo index as enabled and malformed routes refuse', async (t) => {
  const { fixtures: f, vitrineIndex, request } = await load()
  const { search, byAuthor } = await import('../src/feiraClient.js')
  const { createFeiraProbe } = await import('../src/feiraScreen.js')
  const probe = createFeiraProbe((request, author) => byAuthor(request, author, null, {
    fetchFeiraAuthor: async () => ({ ok: true, value: vitrineIndex('/index/feira/autor/' + author, request) })
  }))
  t.alike(await probe(request, f.own), { enabled: true })
  const result = await search(request, { uf: 'SP', cityKey: 'sao-paulo' }, {
    fetchFeira: async () => ({ ok: true, value: vitrineIndex('/index/feira/sp/sao-paulo/todos/todas', request) })
  })
  t.is(result.ok, true)
  t.absent(result.off)
  for (const path of [
    '/index/feira',
    '/index/feira/sp',
    '/index/feira/xx/sao-paulo/todos/todas',
    '/index/feira/sp/sao-paulo/todos/inexistente',
    '/index/feira/sp/sao-paulo/todos/todas/a',
    '/index/feira/sp/sao-paulo/todos/todas/a/b/c',
    '/index/feira/autor/nope',
    '/index/feira/avaliacoes/' + f.own + '/invalid'
  ]) t.exception(() => vitrineIndex(path, request), /not-found/)
})

test('live likes and reposts move the counts and the member repost index', async (t) => {
  const { fixtures: f, vitrineIndex: respond, request } = await load()
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const other = createVitrineRequest(f)
  const mine = (type) => new Set(f.diaryRecords.filter((e) => e.author === f.own && e.record.type === type).map((e) => refOf(e.record.to)))
  const post = f.feed.find((p) => p.author !== f.own && !mine('like').has(refOf(p)) && !mine('repost').has(refOf(p)))
  const ref = refOf(post)
  const countsOf = (req, url = `/index/counts/${ref}`) => respond(url, req).counts[ref]
  const base = countsOf(request)
  const memberSeqs = (req) => respond(`/index/member/${f.own}`, req).posts

  await request('like.set', { to: ref, on: true })
  t.is(countsOf(request).likes, base.likes + 1, 'like adds one')
  await request('like.set', { to: ref, on: true })
  t.is(countsOf(request).likes, base.likes + 1, 'repeated like does not inflate')
  t.is(countsOf(other).likes, base.likes, 'a second instance keeps its baseline')
  await request('like.set', { to: ref, on: false })
  t.is(countsOf(request).likes, base.likes, 'unlike returns to the baseline')

  const before = memberSeqs(request)
  const { seq } = await request('repost.set', { to: ref, on: true })
  t.is(countsOf(request).reposts, base.reposts + 1, 'repost adds one')
  t.ok(memberSeqs(request).includes(seq), 'member index lists the repost')
  t.is(countsOf(other).reposts, base.reposts, 'other instance repost count unchanged')
  t.absent(memberSeqs(other).includes(seq), 'other instance member index unchanged')
  await request('repost.set', { to: ref, on: false })
  t.is(countsOf(request).reposts, base.reposts, 'unrepost returns to the baseline')
  t.alike(memberSeqs(request), before, 'member index returns to the baseline')
})

test('the topic route answers folded hashtag tokens, including a post with the bare word only', async (t) => {
  const { fixtures: f, vitrineIndex: respond } = await load()
  const textOf = (ref) => [...f.feed, ...f.noticePosts].find((p) => refOf(p) === ref).text
  const festa = respond('/index/topic/festajunina', undefined).items
  t.ok(festa.length >= 3, 'hashtag posts are found by the folded token')
  t.ok(festa.some((ref) => textOf(ref).includes('#festajunina')), 'a hit carries the hash')
  t.ok(festa.some((ref) => !textOf(ref).includes('#')), 'a hit has the bare word only, for the client filter to drop')
  t.ok(respond('/index/topic/paodequeijo', undefined).items.some((ref) => textOf(ref).includes('#pãodequeijo')), 'accents fold away')
  t.ok(respond('/index/topic/ceu', undefined).items.some((ref) => textOf(ref).includes('#Céu')), 'case and accents fold away')
  t.ok(respond('/index/topic/festajunina+paodequeijo', undefined).items.map(textOf).every((x) => /pãodequeijo/.test(x) && /festajunina/.test(x)), 'a phrase needs every token')
  t.is(respond('/index/topic/naoexiste', undefined).items.length, 0)
})

test('the profile route answers the fan count and the top friends with one pending pick', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const body = c.validProfile(respond(c.profileUrl(f.own)))
  t.is(body.fans.count, 3)
  t.is(body.top.seq, 50)
  const [back, pending] = [f.members[4].author, f.members[1].author]
  t.is(typeof body.top.back[back], 'number')
  t.is(body.top.back[pending], null, 'one pick does not follow back')
  t.is(c.validProfile(respond(c.profileUrl(f.members[2].author))).top, null)
})

test('poll route: totals and voter pointers follow the live choice records', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const poll = { author: f.own, seq: 60 }
  t.alike(c.validPoll(respond(c.pollUrl(poll.author, poll.seq)), 3).totals, [3, 1, 0], 'the seeded votes: the last choice of each voter')
  const zero = c.validPollVoters(respond(c.pollVotersUrl(poll.author, poll.seq, 0)))
  t.is(zero.total, 3)
  t.alike(zero.items.map((i) => i.key).sort(), [f.own, f.members[1].author, f.members[2].author].sort())
  t.is(zero.next, null)
  t.is(c.validPollVoters(respond(c.pollVotersUrl(poll.author, poll.seq, 2))).total, 0)
  await request('choice.set', { to: `${f.own}:60`, pick: 2 })
  t.alike(c.validPoll(respond(c.pollUrl(poll.author, poll.seq)), 3).totals, [2, 1, 1], 'a new vote shows')
  await request('choice.set', { to: `${f.own}:60`, pick: null })
  t.alike(c.validPoll(respond(c.pollUrl(poll.author, poll.seq)), 3).totals, [2, 1, 0], 'a withdrawal shows')
  const first = c.validPollVoters(respond(c.pollVotersUrl(poll.author, poll.seq, 0)))
  const page = respond(c.pollVotersUrl(poll.author, poll.seq, 0, { atMs: Date.parse(first.items[0].at), key: first.items[0].key }))
  t.ok(c.validPollVoters(page, { atMs: Date.parse(first.items[0].at), key: first.items[0].key }), 'a cursor page validates')
  for (const url of ['/index/poll/' + f.own + '/3', '/index/poll/' + f.own + '/60/3', '/index/poll/' + f.own + '/60/x', '/index/poll/' + f.own + '/60/0/zz', '/index/poll/' + f.own, '/index/poll/' + f.own + '/60/0/1.' + f.own + '/x', '/index/poll/nope/60', '/index/poll/' + f.own + '/1000000000000000', '/index/poll/' + f.own + '/1000000000000000/0']) {
    t.exception(() => respond(url), url + ' is not found')
  }
})

test('the roda route answers the seeder shape: root, top and the subtree parents first', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const posts = [...f.feed, ...f.noticePosts]
  for (const reply of posts.filter((p) => p.replyTo)) {
    const asked = refOf(reply)
    const body = respond(c.rodaUrl(asked))
    t.ok(c.validRoda(body, asked), asked + ' passes validRoda')
    let top = reply
    while (posts.find((p) => refOf(p) === refOf(top.replyTo)).replyTo) top = posts.find((p) => refOf(p) === refOf(top.replyTo))
    t.is(body.top, refOf(top))
    t.is(body.root, refOf(top.replyTo))
    t.is(body.total, body.items.length)
  }
  t.exception(() => respond(c.rodaUrl(refOf(f.feed[0]))), /not-found/, 'a post that is not a reply')
  t.exception(() => respond(c.rodaUrl('f'.repeat(64) + ':3')), /not-found/, 'an unknown post')
  t.exception(() => respond('/index/roda/' + f.feed[0].author + '/1234567890123456'), /not-found/, 'a seq past the route grammar')
  t.exception(() => respond(c.rodaUrl(refOf(posts.find((p) => p.replyTo))) + '/x'), /not-found/, 'a bad cursor')

  // A deeper tree, added to the fixtures only while a fresh responder loads.
  const root = f.feed[0]
  const hex = (n) => n.toString(16).padStart(2, '0').repeat(32)
  const at = (ms) => new Date(Date.parse('2026-11-05T00:00:00.000Z') + ms).toISOString()
  const reply = (author, seq, ms, to) => ({ author, seq, at: at(ms), text: 'roda', replyTo: { author: to.author, seq: to.seq } })
  const top = reply(hex(0x50), 1, 1000, root)
  const c1 = reply(hex(0x60), 1, 5000, top)
  const c3 = reply(hex(0x40), 1, 5000, top)
  const c2 = reply(hex(0x30), 1, 2000, c1)
  const c4 = reply(hex(0x30), 2, 9000, c2)
  const flat = Array.from({ length: 51 }, (_, i) => reply(hex(0x70), i + 1, 20000 + i, top))
  const extra = [top, c1, c2, c3, c4, ...flat]
  f.feed.push(...extra)
  let fresh
  try {
    fresh = (await import('../src/vitrine/indexResponder.js?roda=1')).vitrineIndex
  } finally {
    f.feed.splice(f.feed.length - extra.length, extra.length)
  }
  const first = fresh(c.rodaUrl(refOf(c4)))
  t.ok(c.validRoda(first, refOf(c4)), 'the first page passes validRoda')
  t.is(first.root, refOf(root))
  t.is(first.top, refOf(top))
  t.is(first.total, 55)
  t.is(first.items.length, 50)
  t.alike(first.items.slice(0, 4), [
    { ref: refOf(c3), to: refOf(top) },
    { ref: refOf(c1), to: refOf(top) },
    { ref: refOf(c2), to: refOf(c1) },
    { ref: refOf(c4), to: refOf(c2) }
  ], 'equal times by author, a child dated before its parent still after it')
  t.alike(Object.keys(first.authors).sort(), [...new Set([c4, root, top, ...extra.slice(0, 50)].map((p) => p.author))].sort())
  t.is(first.next, Date.parse(flat[45].at) + '.' + flat[45].author + '.' + flat[45].seq, 'next names the last row')
  const second = fresh(c.rodaUrl(refOf(c4), first.next))
  t.ok(c.validRoda(second, refOf(c4)), 'the second page passes validRoda')
  t.alike(second.items, flat.slice(46).map((p) => ({ ref: refOf(p), to: refOf(top) })))
  t.is(second.next, null)
  t.is(second.total, 55)
  t.alike(fresh(c.rodaUrl(refOf(top))).items, first.items, 'asked for the comment itself')
})

test('poll route: an event post answers its going and maybe totals', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  t.alike(c.validPoll(respond(c.pollUrl(f.own, 61)), 2).totals, [0, 0])
  await request('choice.set', { to: `${f.own}:61`, pick: 0 })
  t.alike(c.validPoll(respond(c.pollUrl(f.own, 61)), 2).totals, [1, 0], 'an RSVP shows')
})

test('the garden routes pass the client checks and every help pointer resolves through diary.peek', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [cecilia, andre, bia] = [f.members[2].author, f.members[3].author, f.members[4].author]
  const garden = c.validGarden(respond(c.gardenUrl(f.own)), f.own)
  t.ok(garden, 'the owner pointers validate')
  t.is(garden.on, 51)
  t.is(garden.state, 52)
  t.alike(garden.given, [53])
  t.is(garden.helps.length, 2)
  t.alike(garden.helps.map((h) => h.author).sort(), [cecilia, andre].sort())
  for (const h of garden.helps) {
    const help = await request('diary.peek', { author: h.author, seqs: [h.seq], profileSeq: 1, usernameSeq: 2 })
    t.is(help.entries[0].record.type, 'garden-help')
    t.is(help.entries[0].record.to, f.own, 'the help is to the owner')
    const follow = await request('diary.peek', { author: h.author, seqs: [h.followSeq], profileSeq: 1, usernameSeq: 2 })
    t.is(follow.entries[0].record.type, 'follow')
    t.is(follow.entries[0].record.key, f.own)
    t.is(follow.entries[0].record.on, true)
  }
  const mine = await request('diary.peek', { author: f.own, seqs: [garden.on, garden.state, ...garden.given], profileSeq: 1, usernameSeq: 2 })
  t.alike(mine.entries.map((e) => e.record.type), ['garden', 'garden-state', 'garden-help'])
  t.alike(c.validGarden(respond(c.gardenUrl(bia)), bia), { on: 130, state: null, helps: [], given: [], indexing: false, complete: true }, 'an off flag still has a seq, and lists nothing')
  t.alike(c.validGarden(respond(c.gardenUrl(f.members[1].author)), f.members[1].author), { on: null, state: null, helps: [], given: [], indexing: false, complete: true })
  const played = await request('garden.play', { acts: [{ op: 'plant', pot: 4, plant: 'tomate' }] })
  t.is(c.validGarden(respond(c.gardenUrl(f.own)), f.own).state, played.seq, 'a play moves the state pointer')
  t.exception(() => respond('/index/garden/' + 'f'.repeat(64)), /not-found/, 'an owner with no profile is not-found')
  t.exception(() => respond('/index/garden/' + f.own + '/other'), /not-found/)
  t.exception(() => respond('/index/garden/' + f.own + '/rua/abc'), /not-found/)
  t.exception(() => respond('/index/garden/abc'), /not-found/)
})

test('the garden street lists only followed keys that opted in, in key order, and pages with a cursor', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [cecilia, andre] = [f.members[2].author, f.members[3].author].sort()
  const page = c.validGardenStreet(respond(c.gardenStreetUrl(f.own)))
  t.ok(page, 'the street page validates')
  t.alike(page.items.map((i) => i.key), [cecilia, andre].sort())
  for (const i of page.items) {
    const peek = await request('diary.peek', { author: i.key, seqs: [i.on, i.state], profileSeq: 1, usernameSeq: 2 })
    t.alike(peek.entries.map((e) => e.record.type), ['garden', 'garden-state'])
    t.is(peek.entries[0].record.on, true)
  }
  t.is(page.next, null)
  const after = c.validGardenStreet(respond(c.gardenStreetUrl(f.own, page.items[0].key)), page.items[0].key)
  t.alike(after.items.map((i) => i.key), [page.items[1].key], 'the cursor is exclusive')
  t.alike(c.validGardenStreet(respond(c.gardenStreetUrl(f.own, 'f'.repeat(64))), 'f'.repeat(64)).items, [])
  t.alike(c.validGardenStreet(respond(c.gardenStreetUrl(f.members[1].author))).items, [], 'João follows nobody')
  await request('follow.add', { key: f.members[4].author })
  t.absent(c.validGardenStreet(respond(c.gardenStreetUrl(f.own))).items.some((i) => i.key === f.members[4].author), 'a followed key whose flag is off is left out')
  await request('garden.set', { on: false })
  t.alike(c.validGardenStreet(respond(c.gardenStreetUrl(f.members[2].author))).items.map((i) => i.key), [], 'Cecília follows nobody')
  t.exception(() => respond(c.gardenStreetUrl('f'.repeat(64))), /not-found/)
})

test('the profile route carries the newest garden flag seq, on or off, or null', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  t.is(c.validProfile(respond(c.profileUrl(f.own))).garden, 51)
  t.is(c.validProfile(respond(c.profileUrl(f.members[4].author))).garden, 130, 'an off flag has a seq')
  t.is(c.validProfile(respond(c.profileUrl(f.members[1].author))).garden, null)
  await request('garden.set', { on: false })
  const left = c.validProfile(respond(c.profileUrl(f.own))).garden
  t.ok(left > 51, 'leaving writes a newer off flag')
  const peek = await request('diary.peek', { author: f.own, seqs: [left], profileSeq: 1, usernameSeq: 2 })
  t.is(peek.entries[0].record.on, false)
  const after = c.validGarden(respond(c.gardenUrl(f.own)), f.own)
  t.is(after.state, null, 'a leave tombstones the state')
  t.is(after.on, left, 'the off flag still has a seq')
  t.alike([after.helps, after.given], [[], []], 'a left balcony names no helper and no given help')
  const old = await request('diary.peek', { author: f.own, seqs: [51], profileSeq: 1, usernameSeq: 2 })
  t.alike(old.missing, [51], 'the off flag tombstones the previous flag, as the node does')
})
