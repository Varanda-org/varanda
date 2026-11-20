// Perfil rico, the screen side: the pure view model of the profile-about and
// mood records. No React, no request. The editor turns a draft into the exact
// params of profile.about and profile.mood; the readers turn the seeder's
// pointers into diary.peek reads and check what comes back. The seeder only
// names seqs: every record is re-read from the author's diary and judged here,
// so a seeder cannot make a profile say something it did not sign.
import rpc from '@varanda/rpc'
import { aboutView, moodView, MOOD_TTL_MS } from './profileAbout.js'
import { isThemeId, themeColors } from './profileThemes.js'
import { peekBatches } from './scraps.js'
import { refusalOf } from './wordCheck.js'

const { LOG_LIMIT_MAX, isBirthday, isReaction, profileExtra } = rpc

export const TEXTS = Object.freeze({
  aboutTitle: 'Sobre mim',
  aboutSave: 'Salvar sobre mim',
  aboutSaved: 'Sobre mim salvo.',
  themeTitle: 'Tema do perfil',
  themeNone: 'Padrão',
  moodTitle: 'Humor do dia',
  moodHint: 'Aparece no seu perfil por 24 horas. O registro continua no seu diário público até você tocar em Apagar humor, que apaga todas as versões. Um humor novo substitui o anterior no perfil.',
  moodPublish: 'Publicar humor',
  moodSaved: 'Humor publicado.',
  aboutDelete: 'Apagar sobre mim',
  moodDelete: 'Apagar humor',
  deleteConfirm: 'Apagar',
  deleteCancel: 'Cancelar',
  aboutDeleteAsk: 'Apagar o sobre mim? Todas as versões somem do seu diário e o tema volta ao padrão. Cópias que outras pessoas já fizeram podem continuar existindo.',
  moodDeleteAsk: 'Apagar o humor? Todas as versões somem do seu diário. Cópias que outras pessoas já fizeram podem continuar existindo.',
  aboutDeleted: 'Sobre mim apagado.',
  moodDeleted: 'Humor apagado.',
  checkedDeleted: 'Conferido: foi apagado.',
  checkedNotDeleted: 'Ainda aparece no seu perfil. Pode ter sido apagado: espere um pouco e confira de novo, ou apague outra vez.',
  sorteTitle: 'Sorte do dia',
  check: 'Conferir',
  uncertain: 'Não sabemos se foi publicado. Toque em Conferir antes de tentar de novo.',
  checkedSame: 'Conferido: já está no seu perfil.',
  checkedDiffers: 'Ainda não aparece no seu perfil. Pode ter sido publicado: espere um pouco e confira de novo, ou publique outra vez.',
  checkFailed: 'Não deu para conferir agora. Tente de novo daqui a pouco.',
  badBirthday: 'Use dia e mês que existam, como 15/03.',
  badText: 'Há um caractere que não pode ser publicado. Tire-o e tente de novo.',
  noMood: 'Escolha um emoji ou escreva algo, ou toque em Apagar humor.'
})

// Emoji offered for the mood, each one a valid reaction (a test checks it).
export const MOODS = Object.freeze([
  { e: '😊', name: 'feliz' },
  { e: '🥰', name: 'carinhoso' },
  { e: '😎', name: 'de boa' },
  { e: '🤩', name: 'empolgado' },
  { e: '🥳', name: 'comemorando' },
  { e: '😌', name: 'tranquilo' },
  { e: '🤔', name: 'pensativo' },
  { e: '😴', name: 'com sono' },
  { e: '😢', name: 'triste' },
  { e: '😤', name: 'determinado' },
  { e: '🙏', name: 'grato' }
])

// ---- the draft ----------------------------------------------------------

export function emptyAboutDraft () {
  return { about: '', city: '', work: '', studies: '', interests: '', birthday: '', theme: null }
}

// 'MM-DD' to the 'DD/MM' the person types.
export function birthdayToInput (value) {
  return typeof value === 'string' && isBirthday(value) ? value.slice(3) + '/' + value.slice(0, 2) : ''
}

// What the person typed ('15/03', '5-3') to { ok, value }: value is 'MM-DD',
// or null when the field is empty. A date that does not exist is not ok.
export function birthdayFromInput (input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { ok: true, value: null }
  const m = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})$/.exec(text)
  if (m === null) return { ok: false, value: null }
  const value = m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0')
  return isBirthday(value) ? { ok: true, value } : { ok: false, value: null }
}

// The editor's starting point: the author's own latest record, or empty. The
// raw fields, never the displayText of aboutView: that turns some valid
// characters (an RLM) into U+FFFD, which a save would then write back.
const rawText = (value) => (typeof value === 'string' ? value : '')

export function draftFromRecord (record) {
  const draft = emptyAboutDraft()
  if (record === null || typeof record !== 'object') return draft
  return {
    about: rawText(record.about),
    city: rawText(record.city),
    work: rawText(record.work),
    studies: rawText(record.studies),
    interests: rawText(record.interests),
    birthday: birthdayToInput(record.birthday),
    theme: isThemeId(record.theme) ? record.theme : null
  }
}

const count = (s) => Array.from(s).length
// A multi-line field keeps its line breaks (LF only); a one-line field has none.
const clean = (value, multiline) => {
  const s = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (profileExtra.isInvisibleOnly(s)) return ''
  return multiline ? s : s.replace(/\s*\n\s*/g, ' ')
}

const FIELDS = [
  ['about', profileExtra.MAX_ABOUT, profileExtra.isAbout, true],
  ['city', profileExtra.MAX_CITY, profileExtra.isCity, false],
  ['work', profileExtra.MAX_WORK, profileExtra.isWork, false],
  ['studies', profileExtra.MAX_STUDIES, profileExtra.isStudies, false],
  ['interests', profileExtra.MAX_INTERESTS, profileExtra.isInterests, false]
]

// A draft to { ok, params, error }. params is what profile.about takes: all
// seven keys, null for an empty field. Every public text goes through the word
// check first, like a post. error is '' when ok.
export function aboutParams (draft) {
  const d = draft !== null && typeof draft === 'object' ? draft : {}
  const params = {}
  const texts = []
  for (const [key, max, valid, multiline] of FIELDS) {
    const text = clean(d[key], multiline)
    if (text === '') { params[key] = null; continue }
    if (count(text) > max) return { ok: false, params: null, error: 'Passa de ' + max + ' caracteres.' }
    if (!valid(text)) return { ok: false, params: null, error: TEXTS.badText }
    params[key] = text
    texts.push(text)
  }
  const refused = refusalOf(...texts)
  if (refused !== '') return { ok: false, params: null, error: refused }
  const birthday = birthdayFromInput(d.birthday)
  if (!birthday.ok) return { ok: false, params: null, error: TEXTS.badBirthday }
  params.birthday = birthday.value
  params.theme = isThemeId(d.theme) ? d.theme : null
  return { ok: true, params, error: '' }
}

const KEYS = ['about', 'city', 'work', 'studies', 'interests', 'birthday', 'theme']

// Does the author's record say what these params say?
export function aboutMatches (params, record) {
  if (params === null || typeof params !== 'object' || record === null || typeof record !== 'object') return false
  return KEYS.every((key) => (record[key] === undefined ? null : record[key]) === params[key])
}

// The mood draft to { ok, params, error, clears }. Both empty clears it.
export function moodParams (draft) {
  const d = draft !== null && typeof draft === 'object' ? draft : {}
  const emoji = typeof d.emoji === 'string' ? d.emoji : ''
  const text = clean(d.text, false)
  if (!profileExtra.isMoodEmoji(emoji) || (emoji !== '' && !isReaction(emoji))) return { ok: false, params: null, error: TEXTS.badText, clears: false }
  if (count(text) > profileExtra.MAX_MOOD_TEXT) return { ok: false, params: null, error: 'Passa de ' + profileExtra.MAX_MOOD_TEXT + ' caracteres.', clears: false }
  if (!profileExtra.isMoodText(text)) return { ok: false, params: null, error: TEXTS.badText, clears: false }
  const refused = refusalOf(text)
  if (refused !== '') return { ok: false, params: null, error: refused, clears: false }
  return { ok: true, params: { emoji, text }, error: '', clears: emoji === '' && text === '' }
}

export function moodMatches (params, record) {
  if (params === null || typeof params !== 'object' || record === null || typeof record !== 'object') return false
  return (record.emoji === undefined ? '' : record.emoji) === params.emoji && (record.text === undefined ? '' : record.text) === params.text
}

// A mood past its 24 hours starts the form empty. A live one gives its raw
// fields, for the same reason as draftFromRecord.
export function moodDraftFromRecord (record, now) {
  if (moodView(record, now) === null) return { emoji: '', text: '' }
  return { emoji: rawText(record.emoji), text: rawText(record.text) }
}

// ---- deleting -------------------------------------------------------------

export const DELETE_KINDS = Object.freeze(['about', 'mood'])

// The params of profile.extra.delete for a kind ('about' or 'mood').
export function deleteParams (kind) {
  return DELETE_KINDS.includes(kind) ? { ok: true, params: { kind } } : { ok: false, params: null }
}

// The delete action is offered only while the own profile holds a record of
// that kind (the editor reads it before it unlocks).
export function canDelete (held, kind) {
  return isObject(held) && DELETE_KINDS.includes(kind) && isObject(held[kind])
}

export function deleteAsk (kind) {
  return kind === 'mood' ? TEXTS.moodDeleteAsk : TEXTS.aboutDeleteAsk
}

export function deletedNote (kind) {
  return kind === 'mood' ? TEXTS.moodDeleted : TEXTS.aboutDeleted
}

// The node answers USAGE 'nada para apagar' when no live record is left (also
// on a repeat after a delete that worked). Nothing is left, so it is success.
export function isNothingToDelete (err) {
  return isObject(err) && err.code === 'USAGE' && err.message === 'nada para apagar'
}

// The held records without that kind (a deleted about also drops its theme:
// the theme lives in the about record).
export function withoutExtra (held, kind) {
  const h = isObject(held) ? held : {}
  const out = { about: h.about || null, mood: h.mood || null }
  if (DELETE_KINDS.includes(kind)) out[kind] = null
  return out
}

// The editor's form after a delete: the draft of that kind starts empty again.
export function draftAfterDelete (kind, aboutDraft, moodDraft) {
  return kind === 'about'
    ? { about: emptyAboutDraft(), mood: moodDraft }
    : { about: aboutDraft, mood: { emoji: '', text: '' } }
}

// After an uncertain delete, 'Conferir' re-reads the profile: held records
// with the given kinds dropped where the seeder says, for a complete index of
// the author, that it has none. Only for a check the person asked for: a
// normal read never drops, so a seeder that lags cannot undo a publish.
export function settledExtra (held, pointers, kinds) {
  const known = extraKnown(pointers)
  let out = withoutExtra(held, null)
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    if (known[kind] && !isSeq(pointers[kind])) out = withoutExtra(out, kind)
  }
  return out
}

// ---- reading someone's profile extras ------------------------------------

const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The diary.peek reads that fetch the two records the seeder pointed at (one
// batch: both are the author's own blocks). [] when there is nothing to read.
export function planExtraPeeks (pointers, author) {
  if (!isObject(pointers) || typeof author !== 'string') return []
  return peekBatches(author, [pointers.about, pointers.mood].filter(isSeq))
}

const TYPES = { about: 'profile-about', mood: 'mood' }

// { about, mood }, each { seq, record } or null, from the peeks of the plan.
// A record counts only when it came back under the pointer's seq from the
// author's own diary and has the right type; field checks are left to the
// views (aboutView, moodView), which reread every field.
export function readExtra (pointers, peeks, author) {
  const out = { about: null, mood: null }
  if (!isObject(pointers)) return out
  const list = peeks instanceof Map ? [...peeks.values()].flat() : Array.isArray(peeks) ? peeks : []
  for (const kind of ['about', 'mood']) {
    const seq = pointers[kind]
    if (!isSeq(seq)) continue
    for (const p of list) {
      if (!isObject(p) || p.key !== author) continue
      const hit = (Array.isArray(p.entries) ? p.entries : []).find((e) => isObject(e) && e.seq === seq && isObject(e.record) && e.record.type === TYPES[kind])
      if (hit !== undefined) { out[kind] = { seq, record: hit.record }; break }
    }
  }
  return out
}

// The status a read of the seeder's pointers reaches: 'ready' only when every
// kind is settled. A seq the seeder named but that did not verify (the peek
// put it in `missing`, or came back without it) settles nothing: the editor
// would otherwise start empty and overwrite the real record.
export function extraStatus (pointers, got) {
  const known = extraKnown(pointers)
  const p = isObject(pointers) ? pointers : {}
  const g = isObject(got) ? got : {}
  for (const kind of ['about', 'mood']) {
    if (!known[kind]) return 'unsure'
    if (isSeq(p[kind]) && !isObject(g[kind])) return 'unsure'
  }
  return 'ready'
}

// ---- reading the own profile extras ---------------------------------------

// The own profile reads its records from the member's own diary (log.read,
// newest page first), never from a seeder pointer: a seeder could name an
// older version, and the editor would start from it. log.read never lists a
// tombstoned block in `entries` (it goes to `invalid` as 'deleted'), so the
// newest entry of a type is the live one.
export const OWN_LOG_PAGES = 100

export function ownLogParams (before) {
  return isSeq(before) ? { limit: LOG_LIMIT_MAX, before } : { limit: LOG_LIMIT_MAX }
}

// The log.read pages read so far (newest first) to { held, settled, next }.
// held: the newest live record of each kind seen. settled: both were found,
// or the walk reached the start of the diary, so what is not held does not
// exist. next: the `before` of the next page, or null when there is none to
// read (settled, or a page that cannot be walked past). A page of another
// diary settles nothing.
export function ownExtraScan (pages, author) {
  const held = { about: null, mood: null }
  const list = Array.isArray(pages) ? pages : []
  let start = false
  let low = Infinity
  for (const page of list) {
    if (!isObject(page) || page.key !== author || !Array.isArray(page.entries)) return { held: { about: null, mood: null }, settled: false, next: null }
    for (const e of page.entries) {
      if (!isObject(e) || !isSeq(e.seq) || !isObject(e.record)) continue
      low = Math.min(low, e.seq)
      for (const kind of ['about', 'mood']) {
        if (e.record.type === TYPES[kind] && (held[kind] === null || e.seq > held[kind].seq)) held[kind] = { seq: e.seq, record: e.record }
      }
    }
    for (const e of Array.isArray(page.invalid) ? page.invalid : []) {
      if (isObject(e) && isSeq(e.seq)) low = Math.min(low, e.seq)
    }
    if (page.entriesTruncated === 0) start = true
  }
  const settled = start || (held.about !== null && held.mood !== null)
  return { held, settled, next: settled || low === Infinity ? null : low }
}

// One record of the own diary, read back after a write: { seq, record } when
// the page holds that seq live with the right type, else null.
export function ownRecordAt (page, author, kind, seq) {
  if (!isObject(page) || page.key !== author || !Array.isArray(page.entries) || !TYPES[kind]) return null
  const hit = page.entries.find((e) => isObject(e) && e.seq === seq && isObject(e.record) && e.record.type === TYPES[kind])
  return hit === undefined ? null : { seq, record: hit.record }
}

// What the seeder's answer settles. A null pointer means "no record" only
// when the index of that author is complete; while it is still indexing
// (complete false) it means "not known yet", and the screen keeps what it
// shows (or its loading look) instead of reading it as no Sobre mim, no mood
// or the default theme.
export function extraKnown (pointers) {
  const p = isObject(pointers) ? pointers : {}
  const done = p.complete === true
  return { about: isSeq(p.about) || done, mood: isSeq(p.mood) || done }
}

// Keep the newer of what is held and what was just read, per record. A seeder
// that lags must not undo what the person just published.
export function newerExtra (held, incoming) {
  const pick = (a, b) => (a !== null && a !== undefined && (b === null || b === undefined || a.seq > b.seq) ? a : (b || null))
  const h = isObject(held) ? held : {}
  const i = isObject(incoming) ? incoming : {}
  return { about: pick(h.about, i.about), mood: pick(h.mood, i.mood) }
}

// What a profile shows: theme (an id, or null for the usual sunset band), the
// about card (null when it has nothing to show) and the mood while it lives.
// A profile with no extra record gives null for all three.
export function extraView (held, now) {
  const h = isObject(held) ? held : {}
  const aboutRecord = isObject(h.about) ? h.about.record : null
  const view = aboutRecord === null ? null : aboutView(aboutRecord)
  const mood = isObject(h.mood) ? moodView(h.mood.record, now) : null
  return {
    theme: aboutRecord !== null && isThemeId(aboutRecord.theme) ? aboutRecord.theme : null,
    about: view === null || view.empty ? null : view,
    mood
  }
}

// 'some em 5 h' / 'some em 40 min' / 'some em instantes'.
export function moodRemaining (mood, now) {
  if (!isObject(mood) || !Number.isFinite(mood.expiresAt) || !Number.isFinite(now)) return ''
  const left = Math.min(mood.expiresAt - now, MOOD_TTL_MS)
  if (left <= 60 * 1000) return 'some em instantes'
  if (left < 60 * 60 * 1000) return 'some em ' + Math.ceil(left / 60000) + ' min'
  return 'some em ' + Math.ceil(left / 3600000) + ' h'
}

export function moodLabel (mood) {
  if (!isObject(mood)) return ''
  return [mood.emoji, mood.text].filter((s) => typeof s === 'string' && s !== '').join(' ')
}

// ---- the band -------------------------------------------------------------

// The colors of the controls drawn on a themed band: a disc of the ink color
// with the band color as the icon, so the pair keeps the contrast of the
// palette (a test checks it). null without a theme: the sunset band keeps its
// white icons on the dark scrim.
export function bandTint (themeId, scheme) {
  if (!isThemeId(themeId)) return null
  const c = themeColors(themeId, scheme)
  return { disc: c.bandInk, icon: c.band }
}
