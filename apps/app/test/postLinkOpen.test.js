'use strict'

// The post preview screens are read as text so this test never loads JSX;
// the copy module is pure and loads with import().
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')
const open = read('ui/PostLinkOpen.js')
const row = read('ui/PostLinkPreviewRow.js')
const sheet = read('ui/PostLinkSheet.js')
const copySource = read('postPreviewCopy.js')
const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
const testSource = fs.readFileSync(__filename, 'utf8')

// Same as platformGate.test.js: string literals are kept whole, so a '//'
// inside a URL never hides the rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const copy = () => import('../src/postPreviewCopy.js')

test('the preview copy says what waits', async (t) => {
  const c = await copy()
  t.is(c.PREVIEW_BAR_TITLE, 'Varanda')
  t.is(c.POST_LINK_TITLE, 'Você abriu o link de uma publicação')
  t.is(c.SEE_MORE_LABEL, 'Ver mais')
  t.is(c.SHEET_TITLE, 'Entre para ver mais')
  t.is(c.SHEET_BODY, 'Para ver mais, entre na Varanda ou crie sua conta. Pode ser preciso um convite.')
  t.is(c.REPLY_LINE, 'Em resposta a outra publicação')
  t.is(c.QUOTE_LINE, 'Cita outra publicação')
  t.is(c.VIDEO_LINE, 'Vídeo disponível na Varanda')
  t.is(c.A11Y_OPEN, 'Abrir publicação')
  t.is(c.A11Y_PROFILE, 'Ver perfil')
  t.is(c.A11Y_REPLY, 'Responder')
  t.is(c.A11Y_REPOST, 'Republicar')
  t.is(c.A11Y_LIKE, 'Curtir')
  t.is(c.A11Y_MORE, 'Mais opções')
  t.is(c.A11Y_CARD, 'Abrir link')
  t.is(c.A11Y_VIDEO_COVER, 'Capa do vídeo')
})

test('the copy builders', async (t) => {
  const c = await copy()
  t.is(c.morePhotosLine(1), 'Mais 1 foto na Varanda')
  t.is(c.morePhotosLine(2), 'Mais 2 fotos na Varanda')
  t.is(c.morePhotosLine(6), 'Mais 6 fotos na Varanda')
  for (const n of [0, -1, 1.5, NaN, '3', null, undefined]) t.is(c.morePhotosLine(n), '', String(n))
  t.is(c.relationLine('reply'), 'Em resposta a outra publicação')
  t.is(c.relationLine('quote'), 'Cita outra publicação')
  t.is(c.relationLine(null), '')
  t.is(c.relationLine('other'), '')
  t.is(c.photoLabel(1, false), 'Foto 1')
  t.is(c.photoLabel(3, false), 'Foto 3')
  t.is(c.photoLabel(1, true), 'Capa do vídeo')
})

test('photo tiles load one after another and retry once', async (t) => {
  const { TILE_START, tileStep, tileSettled, tileMayLoad, PHOTO_RETRY_MS } = await copy()
  t.is(PHOTO_RETRY_MS, 1000)
  t.ok(tileMayLoad(0, 0))
  t.absent(tileMayLoad(1, 0), 'the second tile waits for the first')
  t.ok(tileMayLoad(1, 1))
  t.absent(tileMayLoad(3, 2))
  t.absent(tileMayLoad(-1, 2))

  t.absent(tileSettled(TILE_START))
  const loaded = tileStep(TILE_START, 'load')
  t.is(loaded.phase, 'loaded')
  t.ok(tileSettled(loaded))
  t.is(tileStep(loaded, 'error'), loaded, 'a loaded tile stays loaded')

  const waiting = tileStep(TILE_START, 'error')
  t.is(waiting.phase, 'waiting')
  t.absent(tileSettled(waiting), 'a first error does not let the next tile start')
  t.is(tileStep(waiting, 'load'), waiting)
  const retry = tileStep(waiting, 'retry')
  t.is(retry.phase, 'loading')
  t.is(retry.attempt, 1)
  t.absent(tileSettled(retry))
  const failed = tileStep(retry, 'error')
  t.is(failed.phase, 'failed', 'the second error gives up')
  t.ok(tileSettled(failed))
  t.is(tileStep(failed, 'retry'), failed, 'no third try')
  t.is(tileStep(TILE_START, 'retry'), TILE_START, 'a retry only follows an error')

  const stalled = tileStep(TILE_START, 'stall')
  t.is(stalled.phase, 'loading', 'a stalled tile keeps loading')
  t.ok(tileSettled(stalled), 'and stops holding the next tile back')
  t.is(tileStep(waiting, 'stall'), waiting)
})

test('the preview screen keeps the header, the invite card links and the sheet', (t) => {
  const code = withoutComments(open)
  t.ok(code.includes("accessibilityRole='header' style={styles.title}>{POST_LINK_TITLE}"))
  t.ok(code.includes("import { HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'"))
  t.ok(code.includes('onPress={onHow}'))
  t.ok(code.includes('onPress={onLater}'))
  t.ok(code.includes("import { TopBar } from './TopBar'"))
  t.ok(code.includes('<PostLinkSheet open={asking}'))
  t.ok(code.includes('<Btn block label={SEE_MORE_LABEL} onPress={ask} />'))
  t.ok(code.includes('answer.key === key ? answer.model : null'), 'a stale answer is never drawn')
  t.ok(code.includes('ctl.abort()'), 'the request is aborted on unmount or a new target')
  t.ok(/return \(\) => \{[^}]*setAnswer\(\{ key: null, model: null \}\)[^}]*\}/.test(code), 'leaving a target drops its answer')
  t.ok(/<View style=\{styles\.dim\}[^>]*\baria-hidden\b[^>]*>/.test(code), 'the dimmed skeleton rows are hidden from web screen readers too')
})

test('the sheet offers to create an account or sign in', (t) => {
  const code = withoutComments(sheet)
  t.ok(code.includes("import { CREATE_LABEL, ENTRAR_LABEL } from '../entrarCard'"))
  t.ok(code.includes('label={CREATE_LABEL}'))
  t.ok(code.includes('label={ENTRAR_LABEL}'))
  t.ok(code.includes('title={SHEET_TITLE}'))
  t.ok(code.includes('{SHEET_BODY}'))
})

test('the preview row only asks, never reaches a node, a URL or a menu', (t) => {
  const code = withoutComments(row)
  t.absent(code.includes('publicKey='), 'the avatar never fetches a photo')
  t.absent(code.includes('picture='))
  t.ok(code.includes('displayText(model.text, { multiline: true })'))
  t.ok(code.includes('photoUrl(origin, post, i + 1)'))
  t.ok(code.includes('numberOfLines={TEXT_LINES}'))
})

test('the preview never borrows a live row or touches the browser', (t) => {
  const banned = ['PostRow', 'MentionText', 'LinkCard', 'MediaGrid', 'MusicEmbedCard', 'Platform.OS', 'fetch(', 'window', 'document', 'globalThis']
  for (const [name, src] of [['PostLinkOpen.js', open], ['PostLinkPreviewRow.js', row], ['PostLinkSheet.js', sheet]]) {
    const code = withoutComments(src)
    for (const word of banned) t.absent(code.includes(word), name + ' ' + word)
  }
})

test('App hands the post and the installation to the preview', (t) => {
  t.ok(app.includes('<PostLinkOpen post={pendingPost} origin={ageOrigin} '))
  t.ok(/setPendingPost\(target\)\n\s+setPostOpenLater\(false\)/.test(app), 'a new link undoes an earlier Agora não')
})

test('no em dash in the preview files', (t) => {
  for (const src of [open, row, sheet, copySource, app, testSource]) t.absent(src.includes('\u2014'))
})
