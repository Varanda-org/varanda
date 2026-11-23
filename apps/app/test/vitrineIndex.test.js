'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')

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
    [c.groupImagesUrl([group.group, community]), (b) => c.validGroupImages(b, [group.group, community])],
    [c.groupAboutsUrl([f.groups[2].group, f.communities[1].community]), (b) => c.validGroupAbouts(b, [f.groups[2].group, f.communities[1].community])],
    [c.groupBrowseUrl('members'), (b) => c.validGroupBrowse(b, 'members')],
    [c.groupBrowseUrl('recent'), (b) => c.validGroupBrowse(b, 'recent')],
    [c.groupBrowseUrl('trending'), (b) => c.validGroupBrowse(b, 'trending')],
    [c.publicGroupsUrl(f.own), (b) => c.validPublicGroups(b)],
    [c.publicGroupsUrl(f.own, group.group), (b) => c.validPublicGroups(b, group.group)],
    [c.topicTrendUrl(), c.validTopicTrend],
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

test('discovery lists show public groups only, told apart by community name', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const hidden = f.groups.filter((g) => g.visibility === 'private' || g.community === null).map((g) => g.group)
  t.is(hidden.length, 4, 'the fixture has private groups and groups without community')
  const publicGroups = f.groups.filter((g) => g.visibility === 'public' && g.community !== null)
  const lists = ['members', 'recent', 'trending'].map((order) => [order, c.validGroupBrowse(respond(c.groupBrowseUrl(order)), order)])
  const own = c.validPublicGroups(respond(c.publicGroupsUrl(f.own)))
  for (const [order, body] of [...lists, ['public-groups', own]]) {
    t.ok(body, order + ' validates')
    if (!body) continue
    t.ok(body.groups.length > 0, order + ' lists groups')
    t.absent(body.groups.some((g) => hidden.includes(g.group)), order + ': private and standalone groups absent')
    for (const row of body.groups) {
      const g = f.groups.find((x) => x.group === row.group)
      t.is(row.name, g.name)
      t.is(row.communityName, f.communities.find((x) => x.community === g.community).name)
    }
  }
  const members = lists[0][1]
  t.alike(members.groups.map((g) => g.group).sort(), publicGroups.map((g) => g.group).sort(), 'members lists every public group')
  const gerais = members.groups.filter((g) => g.name === 'Geral')
  t.is(gerais.length, 3)
  t.is(new Set(gerais.map((g) => g.communityName)).size, 3, 'the three Geral rows have distinct community names')
  t.ok(lists[2][1].groups.every((g) => g.active >= 2 && g.active <= g.writerCount), 'trending active within writerCount')
  const geralKeys = new Set(f.communities.map((x) => x.general))
  const nonGeral = publicGroups.filter((g) => g.join === 'open' && !geralKeys.has(g.group))
  t.alike(own.groups.map((g) => g.group), nonGeral.map((g) => g.group).sort(), 'own diary lists every open public group but the Geral ones')
  t.alike(own.groups.map((g) => g.name), ['Passeios de bicicleta'])
  t.is(own.hidden, false)
  t.is(own.next, null)
  t.alike(respond(c.publicGroupsUrl(f.own, '0'.repeat(64))).groups, own.groups, 'a cursor below every key keeps the list')
  t.alike(respond(c.publicGroupsUrl(f.own, own.groups[0].group)).groups, [], 'cursor advances past the last row')
  const member = f.groups[3].items[0].diary
  t.absent(respond(c.publicGroupsUrl(member)).groups.some((g) => hidden.includes(g.group)), 'a private group writer sees no private row')
  const trend = c.validTopicTrend(respond(c.topicTrendUrl()))
  t.ok(trend.topics.length > 0, 'fixture posts carry hashtags')
  t.ok(trend.topics[0].authors >= 2, 'one tag is used by two authors or more')
  t.exception(() => respond('/index/group-browse/popular'), /not-found/)
  t.exception(() => respond('/index/public-groups/' + f.own + '/nope'), /not-found/)
  t.exception(() => respond('/index/public-groups/' + 'ab'.repeat(32)), /not-found/)
  t.exception(() => respond('/index/topic-trend/x'), /not-found/)
})

test('split discovery validates every order and searches only open public standalone groups and public communities', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const standalone = f.groups.find((g) => g.community === null && g.visibility === 'public' && g.join === 'open')
  const groups = [...f.groups]
  const communities = [...f.communities]
  // Keep each exclusion independent: the private probe is open and the
  // approval probe is public, joined and active enough for trending.
  const probes = [
    { ...standalone, group: 'a1'.repeat(32), visibility: 'private' },
    { ...standalone, group: 'a2'.repeat(32), join: 'approval' },
    { ...standalone, group: 'a3'.repeat(32), community: communities[0].community }
  ]
  f.groups.push(...probes)
  f.communities.push({ ...communities[0], community: 'a4'.repeat(32), visibility: 'private' })
  try {
    for (const order of ['members', 'recent', 'trending']) {
      const body = respond(c.discoverGroupsUrl(order))
      t.ok(c.validDiscoverGroups(body, order), order + ' discovery validates exact keys and ranking')
      t.alike(body.groups.map((g) => g.group), [standalone.group], order + ' excludes community, private and approval groups')
      t.alike([body.more, body.indexing, body.complete], [false, false, true], order + ' discovery flags')
    }
    for (const order of ['members', 'recent']) {
      const body = respond(c.discoverCommunitiesUrl(order))
      t.ok(c.validDiscoverCommunities(body, order), order + ' communities validate')
      const expected = communities.filter((community) => order === 'members' || groups.some((g) => g.community === community.community && g.items.length > 0))
      t.alike(body.communities.map((r) => r.community).sort(), expected.map((r) => r.community).sort(), order + ' lists public communities, including approval communities')
      t.alike([body.more, body.indexing, body.complete], [false, false, true], order + ' community flags')
    }
    for (const [query, groupKeys, communityKeys] of [
      ['troca-de-mudas', [standalone.group], []],
      ['mu-tro', [standalone.group], []],
      ['clube-de-leitura', [], [communities[1].community]],
      ['horta-comunitaria', [], [communities[2].community]],
      ['nosso-bairro', [], [communities[0].community]],
      ['geral', [], []],
      ['bicicleta', [], []],
      ['coral', [], []],
      ['familia', [], []],
      ['inexistente', [], []],
      ['mudas-leitura', [], []]
    ]) {
      const body = respond(c.discoverSearchUrl(query))
      t.ok(c.validDiscoverSearch(body), query + ' search validates')
      t.alike(body.groups.map((r) => r.group), groupKeys, query + ' matches only eligible group names')
      t.alike(body.communities.map((r) => r.community), communityKeys, query + ' matches only public community names')
      t.alike([body.moreGroups, body.moreCommunities, body.indexing, body.complete], [false, false, false, true], query + ' search flags')
    }
    const own = respond(c.discoverOfUrl(f.own))
    t.ok(c.validDiscoverOf(own), 'per-diary discovery validates')
    t.alike(own.groups.map((r) => r.group), [standalone.group], 'per-diary discovery excludes each forbidden group kind')
  } finally {
    f.groups.splice(0, f.groups.length, ...groups)
    f.communities.splice(0, f.communities.length, ...communities)
  }
})

test('split discovery follows diary membership, leaves and the legacy profile opt-out', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const group = f.groups.find((g) => g.community === null && g.visibility === 'public' && g.join === 'open')
  for (const member of f.members) {
    const body = await respond(c.discoverOfUrl(member.author), request)
    t.ok(c.validDiscoverOf(body), 'each diary page validates')
    const joined = member.author === f.own || group.items.some((item) => item.diary === member.author)
    t.alike(body.groups.map((r) => r.group), joined ? [group.group] : [], 'lists only this diary membership')
    t.alike([body.hidden, body.next, body.indexing, body.complete], [false, null, false, true], 'complete visible diary page')
  }
  await request('groups.show', { on: false })
  for (const after of [null, '0'.repeat(64), group.group]) {
    const body = await respond(c.discoverOfUrl(f.own, after), request)
    t.ok(c.validDiscoverOf(body, after), 'hidden page validates with any cursor')
    t.alike(body, await respond(c.publicGroupsUrl(f.own, after), request), 'opt-out matches the legacy empty envelope')
    t.alike(body, { groups: [], next: null, hidden: true, indexing: false, complete: true }, 'opt-out hides rows and cursor')
  }
  await request('groups.show', { on: true })
  const shown = await respond(c.discoverOfUrl(f.own), request)
  t.ok(c.validDiscoverOf(shown), 'shown page validates')
  t.alike(shown.groups.map((r) => r.group), [group.group], 'latest opt-in restores the list')
  await request('group.leave', { group: group.group })
  const left = await respond(c.discoverOfUrl(f.own), request)
  t.ok(c.validDiscoverOf(left), 'left page validates')
  t.alike(left.groups, [], 'a left writer is absent')
})

test('split discovery caps and ranks lists and search, and pages strictly after the last key', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const groups = [...f.groups]
  const communities = [...f.communities]
  const base = groups.find((g) => g.community === null && g.join === 'open')
  const key = (n) => n.toString(16).padStart(64, '0')
  const manyGroups = Array.from({ length: 35 }, (_, i) => ({
    ...base,
    group: key(1000 + i),
    name: i === 34 ? 'Múdas' : 'Mudas do bairro',
    creator: key(i < 3 ? 2000 : 2000 + i),
    items: base.items.map((item) => ({ ...item, at: new Date(Date.parse(f.now) - i * 1000).toISOString() }))
  }))
  const manyCommunities = Array.from({ length: 23 }, (_, i) => ({
    ...communities[0], community: key(3000 + i), name: i === 22 ? 'Mudas' : 'Mudas do bairro', creator: key(i < 3 ? 4000 : 4000 + i)
  }))
  const communityGroups = manyCommunities.map((community, i) => ({ ...manyGroups[i], group: key(5000 + i), community: community.community }))
  f.groups.splice(0, f.groups.length, ...manyGroups.slice().reverse(), ...communityGroups)
  f.communities.splice(0, f.communities.length, ...manyCommunities.slice().reverse())
  try {
    for (const order of ['members', 'recent', 'trending']) {
      const body = respond(c.discoverGroupsUrl(order))
      t.ok(c.validDiscoverGroups(body, order), order + ' capped groups validate')
      const expected = manyGroups.filter((g, i) => order !== 'recent' || i !== 2).slice(0, 20)
      t.alike(body.groups.map((g) => g.group), expected.map((g) => g.group), order + ' group order and cap')
      t.is(body.more, true, order + ' signals more groups')
    }
    for (const order of ['members', 'recent']) {
      const body = respond(c.discoverCommunitiesUrl(order))
      t.ok(c.validDiscoverCommunities(body, order), order + ' capped communities validate')
      const expected = manyCommunities.filter((g, i) => order !== 'recent' || i !== 2).slice(0, 20)
      t.alike(body.communities.map((r) => r.community), expected.map((r) => r.community), order + ' community order and cap')
      t.is(body.more, true, order + ' signals more communities')
    }
    const search = respond(c.discoverSearchUrl('mudas'))
    t.ok(c.validDiscoverSearch(search), 'capped mixed search validates')
    t.alike(search.groups.map((g) => g.group), [manyGroups[34], ...manyGroups.slice(0, 19)].map((g) => g.group), 'exact group name first, then count and key, capped at 20')
    t.alike(search.communities.map((r) => r.community), [manyCommunities[22], ...manyCommunities.slice(0, 19)].map((r) => r.community), 'exact community name first, then count and key, capped at 20')
    t.alike([search.moreGroups, search.moreCommunities], [true, true], 'both search overflow flags')
    let after = null
    for (const start of [0, 32, 35]) {
      const body = respond(c.discoverOfUrl(f.own, after))
      t.ok(c.validDiscoverOf(body, after), 'cursor page validates')
      t.alike(body.groups.map((g) => g.group), manyGroups.slice(start, start + 32).map((g) => g.group), '32 ascending rows strictly after cursor')
      t.is(body.next, start === 0 ? manyGroups[31].group : null, 'next exists only when another page follows')
      after = body.next || manyGroups[34].group
    }
  } finally {
    f.groups.splice(0, f.groups.length, ...groups)
    f.communities.splice(0, f.communities.length, ...communities)
  }
})

test('split discovery rejects malformed routes and unsupported orders', async (t) => {
  const { fixtures: f, vitrineIndex: respond } = await load()
  for (const path of [
    'groups', 'groups/popular', 'groups/members/extra', 'communities/trending', 'communities/recent/extra',
    'search', 'search/a', 'search/a--b', 'search/UPPER', 'search/' + 'a'.repeat(21), 'search/a-b-c-d-e', 'search/mudas/extra',
    'of/invalid', 'of/' + 'ab'.repeat(32), 'of/' + f.own + '/invalid', 'of/' + f.own + '/' + f.own + '/extra', 'unknown/members'
  ]) t.exception(() => respond('/index/discover/' + path), /not-found/, path + ' is not found')
})

test('trending browse requires two active diaries', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const [solo, ...others] = f.groups
  const request = createVitrineRequest({ ...f, groups: [{ ...solo, items: solo.items.slice(0, 1) }, ...others] })
  const trending = c.validGroupBrowse(await respond(c.groupBrowseUrl('trending'), request), 'trending')
  t.ok(trending.groups.length > 0)
  t.absent(trending.groups.some((g) => g.group === solo.group), 'a group with one active diary is left out')
})

test('an empty group has no creation date and is left out of recent browse', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const group = f.communities.find((c) => c.name === 'Horta Comunitária').general
  const members = c.validGroupBrowse(respond(c.groupBrowseUrl('members')), 'members')
  t.is(members.groups.find((g) => g.group === group).created, null)
  const recent = respond(c.groupBrowseUrl('recent'))
  t.absent(recent.groups.some((g) => g.group === group))
})

test('leaving a group or community withdraws the diary from its public group and counts', async (t) => {
  const { client: c, fixtures: f } = await load()
  const { createIndexedVitrineRequest, vitrineIndex: respond } = await import('../src/vitrine/indexResponder.js?live-groups')
  const { group, community } = f.groups.find((g) => g.name === 'Passeios de bicicleta')
  const profile = c.publicGroupsUrl(f.own)
  for (const [method, params] of [['group.leave', { group }], ['community.leave', { community }]]) {
    const request = createIndexedVitrineRequest(f)
    await request('group.post', { group, text: 'Até sábado!' })
    const active = async () => (await respond(c.groupBrowseUrl('trending'))).groups.find((g) => g.group === group).active
    const beforeActive = await active()
    const before = await respond(profile)
    const row = before.groups.find((g) => g.group === group)
    t.ok(row)
    t.is((await request(method, params)).state, 'left')
    t.alike((await respond(profile)).groups, [])
    const browse = await respond(c.groupBrowseUrl('members'))
    t.is(browse.groups.find((g) => g.group === group).writerCount, row.writerCount - 1)
    t.is(await active(), beforeActive - 1)
    const root = await respond(c.groupUrl(group))
    t.is(root.writers.find((w) => w.diary === f.own).left, true)
  }
})

test('a group whose only member left drops out of browse and the page still validates', async (t) => {
  const { client: c, fixtures: f } = await load()
  const { createIndexedVitrineRequest, vitrineIndex: respond } = await import('../src/vitrine/indexResponder.js?last-member')
  const group = f.communities.find((c) => c.name === 'Horta Comunitária').general
  const request = createIndexedVitrineRequest(f)
  t.ok((await respond(c.groupBrowseUrl('members'))).groups.some((g) => g.group === group))
  t.is((await request('group.leave', { group })).state, 'left')
  for (const order of ['members', 'recent', 'trending']) {
    const page = c.validGroupBrowse(await respond(c.groupBrowseUrl(order)), order)
    t.ok(page !== null, order + ' still validates')
    t.absent(page.groups.some((g) => g.group === group), order + ' leaves the group out')
  }
})

test('trending browse counts a distinct diary posting during the session', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const { group } = f.groups.find((g) => g.name === 'Passeios de bicicleta')
  const active = async () => (await respond(c.groupBrowseUrl('trending'), request)).groups.find((g) => g.group === group).active
  const before = await active()
  await request('group.post', { group, text: 'Vou levar água para o passeio.' })
  const { items } = await request('group.read', { group })
  t.ok(Date.parse(items[0].at) > Date.parse(f.now), 'the new post is past the fixture clock')
  t.is(await active(), before + 1)
  await request('group.post', { group, text: 'Até sábado!' })
  t.is(await active(), before + 1, 'each diary counts once')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const [boundary, ...otherGroups] = f.groups
  const day = 86400000
  const boundaryItems = boundary.items.map((item, i) => ({
    ...item,
    at: new Date(Date.parse(f.now) + [-7 * day, day, -7 * day - 1, day + 1][i]).toISOString()
  }))
  const boundaryRequest = createVitrineRequest({ ...f, groups: [{ ...boundary, items: boundaryItems }, ...otherGroups] })
  const trending = await respond(c.groupBrowseUrl('trending'), boundaryRequest)
  t.is(trending.groups.find((g) => g.group === boundary.group)?.active, 2, 'both time bounds are inclusive')
})

test('Vitrine groups.show invalidates the version snapshot after a successful write', async (t) => {
  const { fixtures: f, request } = await load()
  const { isMutating } = require('@varanda/rpc')
  const { bumpGroupVersion } = await import('../src/groupVersions.js')
  const code = readFileSync(join(__dirname, '../src/node.js'), 'utf8')
  const start = code.indexOf('  const vitrineRequest = useCallback')
  const end = code.indexOf('  const getGroupVersion', start)
  const before = Object.freeze({ [f.groups[0].group]: 1 })
  let versions = before
  const call = runInNewContext(code.slice(start, end) + '\nvitrineRequest', {
    fixtureRequest: request,
    useCallback: (fn) => fn,
    setGroupVersions: (update) => { versions = update(versions) },
    bumpGroupVersion,
    isMutating
  })
  await t.exception(call('groups.show', { on: 'false' }), /parâmetro inválido/)
  t.is(versions, before)
  t.is((await call('groups.show', { on: false })).on, false)
  t.not(versions, before, 'profile readers see a new version snapshot')
  t.alike({ ...versions }, before, 'individual group versions are preserved')
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

test('groups without community answer /index/group with community null and stay out of the legacy lists', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const standalone = f.groups.filter((g) => g.community === null)
  t.is(standalone.length, 3)
  for (const g of standalone) {
    const body = c.validGroup(respond(c.groupUrl(g.group)))
    t.ok(body, g.name + ' validates')
    if (body) t.is(body.community, null)
  }
  t.alike(respond(c.groupSearchUrl('troca')).groups, [], 'search leaves a standalone group out')
  const keys = new Set(standalone.map((g) => g.group))
  for (const order of ['members', 'recent', 'trending']) {
    t.absent(respond(c.groupBrowseUrl(order)).groups.some((g) => keys.has(g.group)), order + ' leaves standalone groups out')
  }
  for (const m of f.members) {
    t.absent(respond(c.publicGroupsUrl(m.author)).groups.some((g) => keys.has(g.group)), 'public groups leave standalone groups out')
  }
  const left = standalone.find((g) => g.role === 'left')
  const { request } = await load()
  const { members, total } = await request('group.members', { group: left.group })
  t.absent(members.some((m) => m.member === f.own), 'a fresh session does not list the own member of a left group')
  t.is((await request('group.info', { group: left.group })).members, total, 'info count matches the roster')
  for (const body of [respond(c.groupsUrl(f.own)), await respond(c.groupsUrl(f.own), request)]) {
    t.is(body.groups.find((g) => g.group === left.group)?.left, true, 'own writer of a left group is reported left')
  }
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
    () => c.fetchDiscoverSearch('geral', deps),
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

// The Barraquinha as the app reads it: the /mimos pointers, every block they
// name peeked from the demo node, then assembleStall at the demo clock.
async function stallOf (c, respond, request, f) {
  const { planStallPeeks, assembleStall } = await import('../src/gardenStall.js')
  const index = c.validGardenStall(respond(c.gardenStallUrl(f.own)), f.own)
  const plan = planStallPeeks({ owner: f.own, index })
  const peek = (b) => request('diary.peek', { author: b.author, seqs: b.seqs, profileSeq: 1, usernameSeq: 2 })
  const ownerReads = await Promise.all(plan.owner.map(peek))
  const giverReads = new Map()
  for (const g of plan.givers) giverReads.set(g.author, await Promise.all(g.batches.map(peek)))
  const since = c.validGarden(respond(c.gardenUrl(f.own)), f.own).on
  return { index, stall: assembleStall({ owner: f.own, since, now: Date.parse(f.now), index, ownerReads, giverReads }) }
}

test('the mimos route passes validGardenStall and assembles to one shelf row and one pending row', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [cecilia, andre] = [f.members[2].author, f.members[3].author]
  const body = respond(c.gardenStallUrl(f.own))
  t.alike(Object.keys(body).sort(), ['complete', 'decor', 'indexing', 'pending', 'shelf'])
  for (const row of body.pending) t.alike(Object.keys(row).sort(), ['author', 'followSeq', 'seq'])
  for (const row of body.shelf) t.alike(Object.keys(row).sort(), ['from', 'gseq', 'seq'])
  const { index, stall } = await stallOf(c, respond, request, f)
  t.alike(index, { decor: 54, pending: [{ author: andre, seq: 135, followSeq: 132 }], shelf: [{ seq: 55, from: cecilia, gseq: 135 }], indexing: false, complete: true })
  t.is(stall.incomplete, false)
  t.alike(stall.decor, ['rede', 'pisca'])
  t.alike(stall.shelf.map((r) => [r.from, r.gseq, r.item]), [[cecilia, 135, 'manjericao']])
  t.alike(stall.pending.map((r) => [r.author, r.seq, r.item]), [[andre, 135, 'tomate']])
  t.alike(c.validGardenStall(respond(c.gardenStallUrl(andre)), andre), { decor: 134, pending: [], shelf: [], indexing: false, complete: true })
  t.exception(() => respond(c.gardenStallUrl(f.own) + '/x'), /not-found/)
})

test('a take moves the mimo from pending to the shelf, and dropping it returns it to pending', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  const [cecilia, andre] = [f.members[2].author, f.members[3].author]
  const took = await request('garden.take', { from: andre, seq: 135 })
  let { index, stall } = await stallOf(c, respond, request, f)
  t.alike(index.pending, [], 'the taken mimo leaves pending')
  t.alike(index.shelf, [{ seq: took.seq, from: andre, gseq: 135 }, { seq: 55, from: cecilia, gseq: 135 }])
  t.alike(stall.shelf.map((r) => r.from).sort(), [cecilia, andre].sort())
  t.alike(stall.pending, [])
  await request('garden.drop', { kind: 'take', seq: took.seq })
  ;({ index, stall } = await stallOf(c, respond, request, f))
  t.alike(index.pending, [{ author: andre, seq: 135, followSeq: 132 }], 'a dropped take is pending again')
  t.alike(stall.pending.map((r) => r.author), [andre])
  t.alike(stall.shelf.map((r) => r.from), [cecilia])
})

test('a left balcony lists no mimo and no decor on the mimos route', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond, request } = await load()
  await request('garden.set', { on: false })
  t.alike(c.validGardenStall(respond(c.gardenStallUrl(f.own)), f.own), { decor: null, pending: [], shelf: [], indexing: false, complete: true })
  t.is(c.validProfile(respond(c.profileUrl(f.own))).garden > 51, true, 'the profile answer still names the newest flag')
})

test('the singular group-image route keeps fixtures without images on initials', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const keys = [f.groups[0].group, f.communities[0].community]
  t.is(c.groupImagesUrl(keys), '/index/group-image/' + keys.join(','))
  t.alike(respond(c.groupImagesUrl(keys)), { images: [], indexing: false })
  t.alike(c.validGroupImages(respond(c.groupImagesUrl(keys)), keys), new Map())
  for (const path of [
    '/index/group-images/' + keys[0],
    '/index/group-image/invalid',
    '/index/group-image/' + keys[0] + ',' + keys[0],
    '/index/group-image/' + keys[0] + '/extra',
    '/index/group-image/' + Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, '0')).join(',')
  ]) t.exception(() => respond(path), /not-found/, 'refuses malformed group image route')
})

test('group-about serves public fixture descriptions and validates the key batch', async (t) => {
  const { client: c, fixtures: f, vitrineIndex: respond } = await load()
  const group = f.groups.find((g) => g.visibility === 'public' && g.about)
  const community = f.communities.find((c) => c.about)
  const privateGroup = f.groups.find((g) => g.visibility === 'private')
  const privateAbout = Object.getOwnPropertyDescriptor(privateGroup, 'about')
  privateGroup.about = 'Descrição privada'
  t.teardown(() => {
    if (privateAbout) Object.defineProperty(privateGroup, 'about', privateAbout)
    else delete privateGroup.about
  })
  const withoutAbout = f.groups.find((g) => g.visibility === 'public' && !g.about)
  const unknown = 'ab'.repeat(32)
  const route = '/index/group-about/'
  const keys = [privateGroup.group, group.group, unknown, community.community, withoutAbout.group]
  t.is(c.groupAboutsUrl(keys), route + keys.join(','))
  t.alike(respond(c.groupAboutsUrl(keys)), {
    abouts: [{ group: group.group, about: group.about }, { group: community.community, about: community.about }],
    indexing: false
  })
  const max = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(64, '0'))
  t.alike(respond(route + max.join(',')), { abouts: [], indexing: false })
  for (const path of [
    route,
    route + 'invalid',
    route + unknown + ',' + unknown,
    route + unknown + '/extra',
    route + [...max, unknown].join(',')
  ]) t.exception(() => respond(path), /not-found/, 'refuses malformed group about route')
})
