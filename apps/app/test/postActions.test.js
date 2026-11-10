'use strict'

// Pure post actions (src/postActions.js). import() loads the ES module.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/postActions.js')

const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const PAGE = 'c'.repeat(64)
const URL = 'https://bora.varanda.app/@ana'
const SECRET = 'https://bora.varanda.app/dm/segredo'

const ids = (rows) => rows.map((row) => row.id)
const labels = (rows) => rows.map((row) => row.label)

test('public post: primary is reply, repost, like, share and the repost sheet is Republicar then Citar', async (t) => {
  const { primaryActions, repostActions, shareLink } = await load()
  const item = { author: THEM, seq: 4 }
  const caps = { link: URL, onReport: () => {} }
  t.is(shareLink(item, caps), URL)
  t.alike(primaryActions(item, caps), [
    { id: 'reply', icon: 'resposta', label: 'Responder' },
    { id: 'repost', icon: 'republicar', label: 'Republicar' },
    { id: 'like', icon: 'coracao', label: 'Curtir' },
    { id: 'share', icon: 'compartilhar', label: 'Compartilhar', href: URL }
  ])
  t.absent(ids(primaryActions(item, caps)).includes('quote'), 'quote is not an inline pencil')
  t.alike(repostActions(item, caps), [
    { id: 'repost', icon: 'republicar', label: 'Republicar' },
    { id: 'quote', icon: 'citar', label: 'Citar' }
  ])
})

test('no public link: the row stops at like and nothing is copied', async (t) => {
  const { primaryActions, moreActions, shareLink } = await load()
  const item = { author: THEM, seq: 4 }
  t.is(shareLink(item, {}), null)
  t.alike(ids(primaryActions(item)), ['reply', 'repost', 'like'])
  t.alike(moreActions(item, { onReport: true }), [
    { id: 'report', icon: 'bandeira', label: 'Denunciar' }
  ])
})

test('overflow order for someone else is Copiar link then Denunciar, never Apagar or Compartilhar', async (t) => {
  const { moreActions } = await load()
  const rows = moreActions({ author: THEM, seq: 4 }, { link: URL, onReport: true, ownKey: ME })
  t.alike(rows, [
    { id: 'copy', icon: 'link', label: 'Copiar link', href: URL },
    { id: 'report', icon: 'bandeira', label: 'Denunciar' }
  ])
  t.absent(labels(rows).includes('Apagar'))
  t.absent(labels(rows).includes('Compartilhar'))
  for (const row of rows) {
    t.absent(row.danger)
  }
})

test('overflow order for an own post is Copiar link then Apagar, and Apagar is the danger row', async (t) => {
  const { moreActions } = await load()
  const rows = moreActions({ author: ME, seq: 4 }, { link: URL, onReport: () => {}, ownKey: ME })
  t.alike(rows, [
    { id: 'copy', icon: 'link', label: 'Copiar link', href: URL },
    { id: 'delete', icon: 'lixeira', label: 'Apagar', danger: true }
  ])
  t.absent(labels(rows).includes('Denunciar'), 'own post is never Denunciar, even with onReport set')
  t.is(rows[1].danger, true)
})

test('own and other without a link', async (t) => {
  const { moreActions } = await load()
  t.alike(labels(moreActions({ author: ME, seq: 2 }, { ownKey: ME, onReport: true })), ['Apagar'])
  t.alike(labels(moreActions({ author: THEM, seq: 2 }, { ownKey: ME })), [])
  t.alike(labels(moreActions({ author: THEM, seq: 2 }, { ownKey: ME, onReport: true })), ['Denunciar'])
  t.alike(moreActions({ author: THEM, seq: 2 }, {}), [])
})

test('ownership is case-insensitive and accepts caps.own, and a bad seq is not Apagar', async (t) => {
  const { moreActions } = await load()
  t.alike(labels(moreActions({ author: ME.toUpperCase(), seq: 8 }, { own: ME.toUpperCase(), onReport: true })), ['Apagar'])
  t.alike(labels(moreActions({ author: ME, seq: 0 }, { ownKey: ME, onReport: true })), [])
  t.alike(labels(moreActions({ author: ME, seq: '3' }, { ownKey: ME, onReport: true })), [])
  t.alike(labels(moreActions({ author: ME }, { ownKey: ME, onReport: true })), [])
})

test('acting as a page: Apagar on the page post, Denunciar on anyone else', async (t) => {
  const { moreActions } = await load()
  const caps = { ownKey: ME, page: PAGE.toUpperCase(), onReport: true, link: URL }
  t.alike(labels(moreActions({ author: PAGE, seq: 2 }, caps)), ['Copiar link', 'Apagar'])
  t.ok(moreActions({ author: PAGE, seq: 2 }, caps)[1].danger)
  t.alike(labels(moreActions({ author: THEM, seq: 2 }, caps)), ['Copiar link', 'Denunciar'])
  t.alike(labels(moreActions({ author: PAGE, seq: 2 }, { ownKey: ME, page: 'nope', onReport: true })), ['Denunciar'])
})

test('a repost row never offers Apagar', async (t) => {
  const { moreActions } = await load()
  const caps = { ownKey: ME, onReport: true, link: URL }
  t.alike(labels(moreActions({ author: ME, seq: 4, repostedBy: { author: THEM } }, caps)), ['Copiar link'])
  t.alike(labels(moreActions({ author: ME, seq: 4, type: 'repost' }, caps)), ['Copiar link'])
  t.alike(labels(moreActions({ author: THEM, seq: 4, repostedBy: { author: ME } }, caps)), ['Copiar link', 'Denunciar'])
  t.alike(labels(moreActions({ author: PAGE, seq: 3, type: 'repost' }, { ...caps, page: PAGE })), ['Copiar link'])
})

test('private chat never produces a share link', async (t) => {
  const { primaryActions, moreActions, repostActions, shareLink } = await load()
  const shapes = [
    [{ dm: true, author: THEM, seq: 1 }, { link: SECRET, onReport: true }],
    [{ private: true, author: ME, seq: 1 }, { link: SECRET, ownKey: ME, onReport: true }],
    [{ visibility: 'private', author: THEM, seq: 1 }, { url: SECRET, onReport: true }],
    [{ kind: 'dm', author: THEM, seq: 1 }, { publicLink: SECRET }],
    [{ kind: 'mensagem', author: THEM, seq: 1 }, { link: SECRET, onReport: true }],
    [{ channel: 'dm', author: THEM, seq: 1 }, { link: SECRET }],
    [{ author: THEM, seq: 1 }, { link: SECRET, private: true, onReport: true }],
    [{ author: ME, seq: 1 }, { link: SECRET, dm: true, ownKey: ME }],
    [{ author: THEM, seq: 1, publicLink: SECRET, sealed: true }, { onReport: true }]
  ]
  for (const [item, caps] of shapes) {
    t.is(shareLink(item, caps), null)
    t.alike(ids(primaryActions(item, caps)), ['reply', 'repost', 'like'])
    t.alike(repostActions(item, caps), [])
    t.absent(labels(moreActions(item, caps)).includes('Copiar link'))
    t.absent(labels(moreActions(item, caps)).includes('Compartilhar'))
    const dumped = JSON.stringify({
      primary: primaryActions(item, caps),
      more: moreActions(item, caps),
      repost: repostActions(item, caps),
      link: shareLink(item, caps)
    })
    t.absent(dumped.includes('segredo'), 'the private url is not copied into an action')
    t.absent(dumped.includes(SECRET))
  }
})

test('a public group post can still be shared', async (t) => {
  const { shareLink, primaryActions } = await load()
  const item = { author: THEM, seq: 2, visibility: 'public' }
  t.is(shareLink(item, { link: URL }), URL)
  t.is(ids(primaryActions(item, { link: URL }))[3], 'share')
})

test('only a clean http(s) url is a share link, and the first valid candidate wins', async (t) => {
  const { shareLink } = await load()
  const item = { author: THEM, seq: 1, url: URL }
  const bare = { author: THEM, seq: 1 }
  t.is(shareLink(item, { link: 'not a url' }), null, 'a url riding on the post item is never the share link')
  t.is(shareLink(item, { link: URL + '/p/1' }), URL + '/p/1', 'only the screen-provided link counts')
  t.is(shareLink(bare, { link: URL + '/p/3' }), URL + '/p/3')
  t.is(shareLink(bare, { link: 'http://bora.varanda.app/@ana' }), 'http://bora.varanda.app/@ana')
  t.is(shareLink(bare, { link: ' https://bora.varanda.app/@ana' }), null)
  t.is(shareLink(bare, { link: 'https://' }), null)
  t.is(shareLink(bare, { link: 'javascript:alert(1)' }), null)
  t.is(shareLink(bare, { link: 'ftp://bora.varanda.app/@ana' }), null)
  t.is(shareLink(bare, { link: 'https://bora.varanda.app/@ana\n' }), null)
  t.is(shareLink(bare, { link: 'https://x' + 'a'.repeat(2048) }), null)
  t.is(shareLink(bare, { link: ['https://bora.varanda.app/@ana'] }), null)
  t.is(shareLink(null, null), null)
  t.is(shareLink(undefined, { link: URL }), URL)
})

test('callers cannot mutate the input or a previously returned row', async (t) => {
  const { primaryActions, moreActions } = await load()
  const item = Object.freeze({ author: THEM, seq: 4 })
  const caps = Object.freeze({ link: URL, onReport: true, ownKey: ME })
  const before = JSON.stringify({ item, caps })
  const first = moreActions(item, caps)
  first[0].label = 'mudou'
  t.alike(labels(moreActions(item, caps)), ['Copiar link', 'Denunciar'])
  t.alike(ids(primaryActions(item, caps)), ['reply', 'repost', 'like', 'share'])
  t.is(JSON.stringify({ item, caps }), before)
})

test('sources have no em dash', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/postActions.js'), 'utf8')
  const testSrc = fs.readFileSync(__filename, 'utf8')
  t.absent(src.includes('\u2014'))
  t.absent(testSrc.includes('\u2014'))
})

test('Mensagem em particular sits in the mais sheet only on a hosted node, for someone else and not a page', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  const row = read('ui/PostRow.js')
  t.ok(row.includes('const messageable = fn(onMessage) && hosted === true && Number.isSafeInteger(seq) && seq > 0'), 'hosted, with a handler and a post seq')
  t.ok(row.includes('const hosted = useHosted()'), 'the flag comes from the stable hosted context')
  t.ok(row.includes("...(messageable ? [{ id: 'message', icon: 'mensagem', label: 'Mensagem em particular' }] : []),"), 'the row only when messageable')
  t.ok(row.includes("if (row.id === 'message') return () => onMessage(author, { context: { author, seq, at, text, hasMedia } })"), 'the post goes as context, never sent')
  const conversa = read('screens/Conversa.js')
  t.ok(conversa.includes('String(item.author).toLowerCase() !== ownKey.toLowerCase() && !(authorProfile && authorProfile.page === true)'), 'rowProps: not own, not a page')
  t.ok(conversa.includes('onMessage: messageable ? onMessage : undefined,'), 'rowProps hands the handler only then')
  const rua = read('screens/ARua.js')
  t.ok(rua.includes('message: fnOf(h.onMessage) && own !== null && String(post.author).toLowerCase() !== own && !(prof && prof.page === true)'), 'socialRowProps: not own, not a page')
  t.ok(rua.includes('onMessage: offers.message ? (author, options) => live.h.onMessage(author, options) : undefined'), 'a cached row reads the newest handler from its live box')
  t.ok(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8').includes('<PageNoticeSheet'), 'App.js shows the page notice for a post of a page')
})

test('more: Bloquear sits after Denunciar, only with a handler, never on the own post', async (t) => {
  const { moreActions } = await load()
  const item = { author: THEM, seq: 4 }
  t.alike(ids(moreActions(item, { onReport: true, onBlock: true })), ['report', 'block'])
  t.alike(moreActions(item, { onBlock: () => {} }), [{ id: 'block', icon: 'bloquear', label: 'Bloquear' }])
  t.alike(ids(moreActions(item, { onReport: true })), ['report'], 'no handler, no row')
  t.alike(ids(moreActions({ author: ME, seq: 4 }, { ownKey: ME, onBlock: true })), ['delete'], 'never the own post')
  t.alike(ids(moreActions({ author: PAGE, seq: 4 }, { ownKey: ME, page: PAGE, onBlock: true })), ['delete'], 'never the page acted as')
})

test('touch targets: the photo viewer stops clicks and post actions are 44 pt', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  const grid = read('ui/MediaGrid.js')
  const modal = grid.slice(grid.indexOf('<Modal'), grid.indexOf('styles.viewerTop'))
  t.ok(modal.includes('onClick={stopClick}'), 'viewer root stops clicks bubbling through the portal')
  t.ok(modal.includes('onStartShouldSetResponder={() => true}'), 'viewer root claims the responder')
  const row = read('ui/PostRow.js')
  t.ok(/\n {2}action: \{[^\n]*minHeight: layout\.hit/.test(row), 'action is 44 pt tall')
  t.ok(/\n {2}countAction: \{[^\n]*minHeight: layout\.hit/.test(row), 'countAction is 44 pt tall')
})
