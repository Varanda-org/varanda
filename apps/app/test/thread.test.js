// Thread and member assembly from the index and diary.peek results
// (thread.js): signed links only, verified usernames only, unavailable
// counting and peek planning.
'use strict'

const test = require('brittle')
const { validateParams } = require('@varanda/rpc')
const load = () => import('../src/thread.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const AT = '2026-10-20T10:00:00.000Z'

const post = (text, replyTo = null, extra = {}) => ({ type: 'post', text, at: AT, replyTo, ...extra })
const AV = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: 'ef'.repeat(32), width: 512, height: 512 }

const peek = (key, entries, extra = {}) => ({ key, length: 100, entries, invalid: [], missing: [], profile: null, username: null, ...extra })

test('planPeeks groups by author, sorts, chunks at 36 with hints first', async (t) => {
  const { planPeeks, PEEK_SEQS_MAX } = await load()
  t.is(PEEK_SEQS_MAX, 36)
  const refs = [A + ':5', B + ':2', A + ':1', A + ':5', 'bad', A.toUpperCase() + ':3']
  for (let i = 100; i < 140; i++) refs.push(C + ':' + i)
  const plan = planPeeks({
    refs,
    authors: { [A]: { profileSeq: 1, usernameSeq: 2 }, [C]: { profileSeq: 3, usernameSeq: null } }
  })
  t.alike(plan[0], { author: A, seqs: [1, 5], profileSeq: 1, usernameSeq: 2 })
  t.alike(plan[1], { author: B, seqs: [2] }, 'no hints known: keys omitted')
  t.is(plan[2].author, C)
  t.is(plan[2].seqs.length, 36)
  t.is(plan[2].seqs[0], 100)
  t.is(plan[2].profileSeq, 3)
  t.absent('usernameSeq' in plan[2], 'null hint omitted')
  t.alike(plan[3], { author: C, seqs: [136, 137, 138, 139] }, 'hints only on the first chunk')
  t.is(plan.length, 4)
  for (const chunk of plan) {
    const v = validateParams('diary.peek', chunk)
    t.ok(v.ok, 'valid diary.peek params: ' + chunk.author.slice(0, 4) + ' ' + (v.message || ''))
  }
  t.alike(planPeeks({}), [])
})

test('assembleThread: parent only when linked, replies only to the focal post', async (t) => {
  const { assembleThread } = await load()
  const focal = A + ':5'
  const index = {
    ref: focal,
    parent: B + ':2',
    replies: [C + ':1', C + ':2', B + ':3', C + ':9', 'junk', C + ':1']
  }
  const peeked = new Map([
    [A, peek(A, [{ seq: 5, record: post('foco', { author: B, seq: 2 }) }], { profile: { name: 'Ana', bio: '' }, username: 'ana' })],
    [B, peek(B, [
      { seq: 2, record: post('pai') },
      { seq: 3, record: post('outra conversa', { author: A, seq: 4 }) },
      { seq: 7, record: post('não listada', { author: A, seq: 5 }) }
    ])],
    [C, peek(C, [
      { seq: 1, record: post('r1', { author: A, seq: 5 }) },
      { seq: 2, record: { type: 'profile', name: 'x', bio: '', at: AT } }
    ], { profile: { name: '@ana', bio: 'b' } })]
  ])
  const out = assembleThread({ focal, index, peeked })
  t.is(out.post.text, 'foco')
  t.is(out.post.name, 'Ana')
  t.is(out.post.username, 'ana')
  t.alike(out.post.replyTo, { author: B, seq: 2 })
  t.is(out.parent.text, 'pai')
  t.alike(out.replies.map((r) => r.text), ['r1'], 'other-thread reply, profile record and unlisted reply dropped')
  t.is(out.replies[0].name, '@ana')
  t.is(out.replies[0].username, null)
  t.is(out.unavailable, 4, 'C:2 not a post, B:3 elsewhere, C:9 missing, junk')

  const unlinked = assembleThread({ focal, index: { ...index, parent: C + ':1' }, peeked })
  t.is(unlinked.parent, null, 'parent the focal post does not reply to')

  const noFocal = assembleThread({ focal, index, peeked: new Map([[B, peeked.get(B)], [C, peeked.get(C)]]) })
  t.is(noFocal.post, null)
  t.is(noFocal.parent, null, 'parent unverifiable without the focal post')
  t.is(noFocal.replies.length, 1, 'replies still verified by their own replyTo')

  const other = assembleThread({ focal, index: { ...index, ref: B + ':2' }, peeked })
  t.alike(other.replies, [], 'index for another post is ignored')
  t.is(other.parent, null)

  const empty = assembleThread({})
  t.alike(empty, { parent: null, post: null, replies: [], unavailable: 0 })
})

test('username only from the verified peek field, never from a raw record', async (t) => {
  const { assembleThread } = await load()
  const focal = A + ':1'
  const peeked = new Map([[A, peek(A, [
    { seq: 1, record: post('oi') },
    { seq: 2, record: { type: 'username', username: 'falso' } }
  ], { username: null })]])
  const out = assembleThread({ focal, index: { ref: focal, parent: null, replies: [] }, peeked })
  t.is(out.post.username, null)
  t.is(out.post.name, null)
  const wrongKey = new Map([[A, peek(B, [{ seq: 1, record: post('oi') }])]])
  t.is(assembleThread({ focal, index: null, peeked: wrongKey }).post, null, 'peek for another key ignored')
})

test('items carry quote and media, and malformed posts are dropped', async (t) => {
  const { assembleThread } = await load()
  const focal = A + ':1'
  const media = [{ core: 'dd'.repeat(32) }]
  const peeked = new Map([
    [A, peek(A, [{ seq: 1, record: post('citação', null, { quote: { author: B, seq: 4 }, media }) }])],
    [B, peek(B, [
      { seq: 1, record: post('r', { author: A, seq: 1 }, { quote: { author: C, seq: 1 } }) },
      { seq: 2, record: post(5, { author: A, seq: 1 }) },
      { seq: 3, record: post('ok', { author: A, seq: 1 }) }
    ])]
  ])
  const out = assembleThread({ focal, index: { ref: focal, parent: null, replies: [B + ':1', B + ':2', B + ':3'] }, peeked })
  t.alike(out.post.quote, { author: B, seq: 4 })
  t.alike(out.post.media, media)
  t.not(out.post.media, media, 'media copied')
  t.alike(out.replies.map((r) => r.seq), [3])
  t.is(out.replies[0].quote, null)
  t.is(out.replies[0].media, null)
  t.is(out.unavailable, 2)
})

test('assembleMember: posts and reposts in index order', async (t) => {
  const { assembleMember } = await load()
  const peeked = new Map([[A, peek(A, [
    { seq: 9, record: { type: 'repost', to: { author: B, seq: 2 }, on: true, at: AT } },
    { seq: 7, record: post('olá') },
    { seq: 6, record: { type: 'repost', to: { author: B, seq: 3 }, on: false, at: AT } },
    { seq: 3, record: { type: 'like', to: { author: B, seq: 2 }, on: true, at: AT } }
  ], { profile: { name: 'Ana', bio: 'oi', avatar: AV }, username: 'ana' })]])
  const out = assembleMember({ author: A, index: { posts: [9, 7, 6, 3, 2] }, peeked })
  t.alike(out.profile, { name: 'Ana', bio: 'oi', avatar: AV })
  t.not(out.profile.avatar, AV, 'a copy, never the peer object')
  t.is(out.username, 'ana')
  t.alike(out.items.map((i) => [i.kind, i.seq]), [['repost', 9], ['post', 7]])
  t.alike(out.items[0], { kind: 'repost', author: A, seq: 9, at: AT, to: { author: B, seq: 2 }, name: 'Ana', username: 'ana', avatar: AV })
  t.alike(out.items[1].avatar, AV)
  t.is(out.unavailable, 3, 'repost off, like, missing')
  t.alike(assembleMember({ author: 'x' }), { profile: null, username: null, items: [], unavailable: 0 })
  t.alike(assembleMember({ author: A, index: null, peeked: new Map() }), { profile: null, username: null, items: [], unavailable: 0 })
})

test('avatar: a valid peeked one is copied, an invalid one or none gives null', async (t) => {
  const { assembleThread, assembleMember } = await load()
  const at = (profile) => {
    const peeked = new Map([[A, peek(A, [{ seq: 5, record: post('foco') }], { profile })]])
    const thread = assembleThread({ focal: A + ':5', index: { ref: A + ':5', parent: null, replies: [] }, peeked })
    const member = assembleMember({ author: A, index: { posts: [5] }, peeked })
    return { item: thread.post.avatar, member: member.profile && member.profile.avatar, memberItem: member.items[0].avatar }
  }
  t.alike(at({ name: 'Ana', bio: '', avatar: AV }), { item: AV, member: AV, memberItem: AV })
  t.alike(at({ name: 'Ana', bio: '' }), { item: null, member: null, memberItem: null }, 'no avatar')
  t.alike(at({ name: 'Ana', bio: '', avatar: { ...AV, width: 256 } }), { item: null, member: null, memberItem: null }, 'not 512x512')
  t.alike(at({ name: 'Ana', bio: '', avatar: { ...AV, mime: 'image/gif' } }), { item: null, member: null, memberItem: null }, 'bad mime')
  t.alike(at({ name: 'Ana', bio: '', avatar: { ...AV, extra: 1 } }), { item: null, member: null, memberItem: null }, 'extra key')
  t.alike(at(null), { item: null, member: null, memberItem: null }, 'no profile')
})
