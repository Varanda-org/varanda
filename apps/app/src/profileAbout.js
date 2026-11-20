// View model of the profile-about and mood diary records. Pure. Both come from
// a peer, so every field is checked again here and shown through displayText.
import rpc from '@varanda/rpc'
import { isThemeId, DEFAULT_THEME } from './profileThemes.js'

const { displayText, isReaction, isBirthday, profileExtra } = rpc

export const MOOD_TTL_MS = 24 * 60 * 60 * 1000
export const MONTHS = Object.freeze([
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
])

export const FIELD_LABELS = Object.freeze({
  city: 'Cidade',
  work: 'Trabalho',
  studies: 'Estudos',
  interests: 'Interesses',
  birthday: 'Aniversário'
})

// The limits are in code points: cut before displayText so no surrogate pair
// is ever split.
function text (value, max, multiline = false) {
  if (typeof value !== 'string') return null
  const cut = Array.from(value.trim()).slice(0, max).join('')
  const clean = displayText(cut, { multiline }).trim()
  return clean === '' ? null : clean
}

// 'MM-DD' to 'd de mês' ('1º de janeiro' for day 1); null for anything that is not a real calendar day.
export function birthdayLabel (value) {
  if (typeof value !== 'string') return null
  if (!isBirthday(value)) return null
  const day = Number(value.slice(3))
  return `${day === 1 ? '1º' : day} de ${MONTHS[Number(value.slice(0, 2)) - 1]}`
}

export function aboutView (record) {
  const r = record !== null && typeof record === 'object' ? record : {}
  const about = text(r.about, profileExtra.MAX_ABOUT, true)
  const rows = []
  for (const [key, max] of [['city', profileExtra.MAX_CITY], ['work', profileExtra.MAX_WORK], ['studies', profileExtra.MAX_STUDIES], ['interests', profileExtra.MAX_INTERESTS]]) {
    const value = text(r[key], max)
    if (value !== null) rows.push({ key, label: FIELD_LABELS[key], value })
  }
  const birthday = birthdayLabel(r.birthday)
  if (birthday !== null) rows.push({ key: 'birthday', label: FIELD_LABELS.birthday, value: birthday })
  return {
    about,
    rows,
    theme: isThemeId(r.theme) ? r.theme : DEFAULT_THEME,
    empty: about === null && rows.length === 0
  }
}

// The mood is live for 24 hours by the reader's clock. Records carry `at` as a
// canonical ISO string. An 'at' in the future (a skewed or forged clock) never
// shows, or it would stay up for good. A mood may be an emoji, a text, or both.
export function moodView (record, now) {
  if (record === null || typeof record !== 'object' || !Number.isFinite(now)) return null
  const t = typeof record.at === 'string' ? Date.parse(record.at) : NaN
  if (!Number.isFinite(t) || t > now || now - t >= MOOD_TTL_MS) return null
  const emoji = record.emoji === '' || isReaction(record.emoji) ? text(record.emoji, 16) : null
  const moodText = text(record.text, profileExtra.MAX_MOOD_TEXT)
  if (emoji === null && moodText === null) return null
  return { emoji, text: moodText, at: t, expiresAt: t + MOOD_TTL_MS }
}
