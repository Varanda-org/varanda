'use strict'

// The public post link on every diary row and the 'Página pública na web' row
// on the member's own posts: socialRowProps (A Rua, Diário, Busca,
// Espiadinha), rowProps (Conversa, Membro) and PostRow's 'mais' sheet.
// The two builders run here from their source, with the screen-only helpers
// stubbed and postLink, canDelete and cachedRow real.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `function <name>`, braces matched, without `export`.
function fnText (src, name) {
  let start = src.indexOf('\nfunction ' + name + ' (')
  if (start < 0) {
    start = src.indexOf('\nexport function ' + name + ' (')
    if (start >= 0) start += 'export '.length
  }
  if (start < 0) throw new Error('no function ' + name)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

const RUA = withoutComments(read('screens/ARua.js'))
const CONVERSA = withoutComments(read('screens/Conversa.js'))
const ROW = read('ui/PostRow.js')

const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const PAGE = 'c'.repeat(64)
const ORIGIN = 'https://bora.varanda.app'

// What the stubs answer: the page acted as and the installation origin.
const env = { acting: null, origin: ORIGIN }

async function builders () {
  const { postLink } = await import('../src/postLink.js')
  const { canDelete } = await import('../src/deletion.js')
  const { cachedRow } = await import('../src/namesCache.js')
  const actingPageKey = () => env.acting
  const installationOrigin = () => env.origin
  const pickAvatar = () => null
  // eslint-disable-next-line no-new-func
  const rua = new Function(
    'postLink', 'canDelete', 'cachedRow', 'actingPageKey', 'installationOrigin', 'pickAvatar', 'replyMarkOf',
    [fnText(RUA, 'refOf'), fnText(RUA, 'withActions'), fnText(RUA, 'socialRowProps'), 'return socialRowProps'].join('\n')
  )(postLink, canDelete, cachedRow, actingPageKey, installationOrigin, pickAvatar, () => null)
  // eslint-disable-next-line no-new-func
  const conversa = new Function(
    'postLink', 'canDelete', 'actingPageKey', 'installationOrigin', 'pickAvatar', 'replyNameOf', 'postAt',
    [fnText(CONVERSA, 'refOf'), fnText(CONVERSA, 'identityOf'), fnText(CONVERSA, 'rowProps'), 'return rowProps'].join('\n')
  )(postLink, canDelete, actingPageKey, installationOrigin, pickAvatar, () => null, () => null)
  return { socialRowProps: rua, rowProps: conversa }
}

const post = (author, seq, extra = {}) => ({ kind: 'post', author, seq, at: '2026-11-01T10:00:00.000Z', text: 'oi', replyTo: null, quote: null, media: null, preview: null, name: null, username: null, ...extra })

const social = () => ({
  social: { flags: { indexing: false }, counts: new Map(), eng: { liked: new Set(), reposted: new Set() }, pending: new Map(), originals: new Map() },
  original: () => undefined,
  transient: () => false,
  pending: () => false,
  persistOf: () => true
})

const profiles = { [PAGE]: { name: 'Página', username: 'pagina', page: true } }
const profileOf = (key) => profiles[key] || null

function ruaRow (socialRowProps, p, more = {}) {
  return socialRowProps({ post: p, ref: p.author + ':' + p.seq, social: social(), profileOf, now: 0, ownKey: ME, h: {}, ...more })
}

function conversaRow (rowProps, item, more = {}) {
  return rowProps({ item, names: { profileOf }, peeked: null, now: 0, ownKey: ME, follows: null, eng: null, handlers: { onOpenThread () {}, onOpenMember () {} }, ...more })
}

const reset = () => {
  env.acting = null
  env.origin = ORIGIN
}

test('socialRowProps: every diary post links to its public page, only the own one is publishable', async (t) => {
  reset()
  const { socialRowProps } = await builders()
  const theirs = ruaRow(socialRowProps, post(THEM, 4))
  t.is(theirs.link, ORIGIN + '/p/' + THEM + '/4')
  t.is(theirs.publishable, false, 'someone else\'s post')
  const mine = ruaRow(socialRowProps, post(ME, 7))
  t.is(mine.link, ORIGIN + '/p/' + ME + '/7')
  t.is(mine.publishable, true, 'the member\'s own diary post')
  t.is(ruaRow(socialRowProps, post(ME, 7), { ownKey: ME.toUpperCase() }).publishable, true, 'the own key compares lowercase')
  t.is(ruaRow(socialRowProps, post(ME, 7), { ownKey: null }).publishable, false, 'no own key yet')
})

test('socialRowProps: repost, page diary, other kinds and a missing origin', async (t) => {
  reset()
  const { socialRowProps } = await builders()
  const repost = ruaRow(socialRowProps, post(ME, 3), { repostedBy: { author: THEM, name: 'Bia', username: null } })
  t.is(repost.publishable, false, 'the original under a repost is not published from that row')
  t.is(repost.link, ORIGIN + '/p/' + ME + '/3', 'it still links to the original')
  const page = ruaRow(socialRowProps, post(PAGE, 2), { ownKey: PAGE })
  t.is(page.link, null, 'a page\'s diary has no public post page')
  t.is(page.publishable, false)
  for (const kind of ['dm', 'repost', 'moment', undefined]) {
    const row = ruaRow(socialRowProps, post(ME, 5, { kind }))
    t.is(row.link, null, 'kind ' + kind + ' has no link')
    t.is(row.publishable, false, 'kind ' + kind + ' is not publishable')
  }
  t.is(ruaRow(socialRowProps, post(ME, 0)).publishable, false, 'no seq')
  t.is(ruaRow(socialRowProps, post(ME, '7')).link, null, 'a string seq')
  env.origin = null
  const offline = ruaRow(socialRowProps, post(ME, 7))
  t.is(offline.link, null, 'no origin, no link')
  t.is(offline.publishable, true, 'publishing does not need the link')
  env.origin = 'https://bora.varanda.app/'
  t.is(ruaRow(socialRowProps, post(ME, 7)).link, null, 'postLink refuses an origin with a path')
})

test('socialRowProps: never the page acted as', async (t) => {
  reset()
  const { socialRowProps } = await builders()
  env.acting = PAGE
  t.is(ruaRow(socialRowProps, post(PAGE, 2), { ownKey: PAGE }).publishable, false, 'ownKey holding the acting page')
  t.is(ruaRow(socialRowProps, post(PAGE, 2)).publishable, false, 'the page\'s own post while acting as it')
  t.is(ruaRow(socialRowProps, post(ME, 2)).publishable, true, 'the member\'s own diary post stays publishable')
  reset()
})

test('socialRowProps: the row cache keys on link, origin and publishable', async (t) => {
  reset()
  const { socialRowProps } = await builders()
  const cache = new Map()
  const p = post(ME, 9)
  const s = social()
  const at = (more = {}) => socialRowProps({ post: p, ref: ME + ':9', social: s, profileOf, now: 0, ownKey: ME, h: {}, cache, rowKey: ME + ':9', ...more })
  const first = at()
  t.is(at(), first, 'same inputs, same props object')
  env.acting = ME
  const acting = at()
  t.not(acting, first, 'a change of publishable builds new props')
  t.is(acting.publishable, false)
  env.acting = null
  const back = at()
  t.is(back.publishable, true)
  env.origin = 'https://outra.varanda.app'
  const moved = at()
  t.not(moved, back, 'a new origin builds new props')
  t.is(moved.link, 'https://outra.varanda.app/p/' + ME + '/9')
  reset()
})

test('rowProps: diary link, own publishable, repost and an offer link', async (t) => {
  reset()
  const { rowProps } = await builders()
  const theirs = conversaRow(rowProps, post(THEM, 4))
  t.is(theirs.link, ORIGIN + '/p/' + THEM + '/4')
  t.is(theirs.publishable, false)
  const mine = conversaRow(rowProps, post(ME, 7))
  t.is(mine.link, ORIGIN + '/p/' + ME + '/7')
  t.is(mine.publishable, true)
  t.is(conversaRow(rowProps, post(ME, 7), { ownKey: ME.toUpperCase() }).publishable, true, 'lowercase compare')
  t.is(conversaRow(rowProps, post(ME.toUpperCase(), 7)).link, ORIGIN + '/p/' + ME + '/7', 'the ref is lowercased')
  t.is(conversaRow(rowProps, post(ME, 7), { extra: { repostedBy: { author: THEM } } }).publishable, false, 'Membro\'s repost row')
  t.is(conversaRow(rowProps, post(ME, 7), { extra: { repostedBy: null } }).publishable, true)
  t.is(conversaRow(rowProps, post(THEM, 4), { extra: { link: 'https://bora.varanda.app/feira/x' } }).link, 'https://bora.varanda.app/feira/x', 'a link the caller passes wins')
  const page = conversaRow(rowProps, post(PAGE, 2), { ownKey: PAGE })
  t.is(page.link, null)
  t.is(page.publishable, false)
  for (const kind of ['dm', 'repost', undefined]) {
    const row = conversaRow(rowProps, post(ME, 5, { kind }))
    t.is(row.link, null)
    t.is(row.publishable, false)
  }
  t.is(conversaRow(rowProps, post(ME, null)).publishable, false, 'no seq')
  env.acting = PAGE
  t.is(conversaRow(rowProps, post(PAGE, 2), { ownKey: PAGE }).publishable, false, 'ownKey holding the acting page')
  t.is(conversaRow(rowProps, post(ME, 2)).publishable, true, 'the member\'s own post while acting as a page')
  reset()
})

test('builders: the link comes from the colon ref through postLink', (t) => {
  const props = fnText(RUA, 'socialRowProps')
  t.ok(props.includes('const postRef = diaryPost ? refOf(post) : null'), 'socialRowProps: the colon ref of a diary post')
  t.ok(props.includes('const link = postRef !== null ? postLink(origin, postRef) : null'))
  t.ok(props.includes('const origin = installationOrigin() || globalThis.location?.origin || null'), 'the origin precedent')
  t.ok(props.includes("const diaryPost = post.kind === 'post' && !(prof && prof.page === true)"), 'not a page, not another kind')
  t.ok(props.includes('authorKey === own && authorKey !== actingPageKey()'), 'own key, never the acting page')
  t.ok(props.includes('repostedBy === null && Number.isSafeInteger(post.seq)'))
  const inputs = props.slice(props.indexOf('const inputs = {'), props.indexOf('return cachedRow('))
  t.ok(/\n\s+link,\n\s+origin,\n\s+publishable,\n/.test(inputs), 'the cache inputs carry link, origin and publishable')
  const rows = fnText(CONVERSA, 'rowProps')
  t.ok(rows.includes("const diaryPost = item.kind === 'post' && hasSeq && !(authorProfile && authorProfile.page === true)"))
  t.ok(rows.includes("const postRef = diaryPost ? authorKey + ':' + item.seq : null"))
  t.ok(rows.includes('postLink(installationOrigin() || globalThis.location?.origin || null, postRef)'))
  t.ok(rows.includes('authorKey !== actingPageKey() && (extra.repostedBy === undefined || extra.repostedBy === null)'))
  t.ok(rows.indexOf('    publishable,\n') < rows.indexOf('    ...extra\n'), 'extra (an offer link) is spread last')
})

test('PostRow: the public row needs publishable and enabled, and opens the colon ref', (t) => {
  t.ok(ROW.includes("import { usePostPublic } from '../postPublicContext'"))
  t.ok(ROW.includes('const postPublic = usePostPublic()'))
  t.ok(ROW.includes('const publicRow = publishable === true && postPublic.enabled === true && fn(postPublic.open) && Number.isSafeInteger(seq) && seq > 0'), 'behind publishable && enabled')
  t.ok(ROW.includes("...(publicRow ? [{ id: 'public', icon: 'link', label: 'Página pública na web' }] : []),"), 'the row only then')
  t.ok(ROW.includes("if (row.id === 'public') return () => postPublic.open(String(author).toLowerCase() + ':' + seq)"), 'runMore opens the colon ref')
  t.ok(ROW.indexOf("id: 'public'") < ROW.indexOf("id: 'delete'"), 'Apagar stays the last row')
  t.absent(/moreActions\([^)]*publishable/.test(ROW), 'not through moreActions(null, ...): ownsAuthor(null) is false')
  t.ok(ROW.includes('// - publishable: '), 'the prop is documented')
  t.ok(/\n {2}seq, onMessage, publishable\n\}\) \{/.test(ROW), 'the prop is read')
  t.ok(read('ui/Icon.js').includes("link: 'link'"), 'the link icon exists')
})

test('sources have no em dash', (t) => {
  for (const file of ['ui/PostRow.js', 'screens/ARua.js', 'screens/Conversa.js']) t.absent(read(file).includes('\u2014'), file)
  t.absent(fs.readFileSync(__filename, 'utf8').includes('\u2014'))
})
