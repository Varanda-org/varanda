'use strict'

// The pure rules of the rich profile (docs/protocol.md, `profile-about` and
// `mood`): field limits, the frozen theme ids, the birthday form and the text
// checks. Core folds records with them, the node validates methods with them
// and the app shows them, so every side agrees. Zero dependencies, no Node
// built-ins. The checks never throw.

const L = require('./limits')
const { isCardForbiddenChar } = require('./link-card')
const { isReaction } = require('./reaction')

// A consensus rule: a reader that predates a new id shows no theme, so ids are
// only ever appended in a protocol change, never renamed or reused.
const THEME_IDS = Object.freeze(['varanda', 'floresta', 'mar', 'por-do-sol', 'ipe', 'flor', 'lavanda', 'terra'])

const BIRTHDAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/
// 02-29 is allowed: a birthday has no year.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isBirthday (v) {
  if (typeof v !== 'string' || !BIRTHDAY.test(v)) return false
  return Number(v.slice(3)) <= DAYS_IN_MONTH[Number(v.slice(0, 2)) - 1]
}

function isThemeId (v) {
  return typeof v === 'string' && THEME_IDS.includes(v)
}

// Code points of a well-formed string with no forbidden character (LF only
// when allowLf), or -1.
function scan (s, allowLf) {
  if (typeof s !== 'string') return -1
  let n = 0
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (!(d >= 0xdc00 && d <= 0xdfff)) return -1
      cp = 0x10000 + ((cp - 0xd800) << 10) + (d - 0xdc00)
      i++
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      return -1
    }
    if (isCardForbiddenChar(cp, allowLf)) return -1
    n++
  }
  return n
}

// Whitespace plus the characters that draw nothing: zero-width and soft
// hyphen, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the blank
// Braille pattern (U+2800), the interlinear annotation marks (U+FFF9 to
// U+FFFB) and the tag block (U+E0000 to U+E007F, as its surrogate pairs: no
// `u` flag, so every JS engine the app runs on takes it).
const INVISIBLE_ONLY = /^(?:[\s\u200b-\u200d\u2060\u00ad\u115f\u1160\u3164\uffa0\u2800\ufff9-\ufffb]|\udb40[\udc00-\udc7f])*$/

// True for a string made only of whitespace and invisible characters ('' too).
function isInvisibleOnly (v) {
  return typeof v === 'string' && INVISIBLE_ONLY.test(v)
}

// A non-empty text of at most `max` code points that shows something (not only
// whitespace or invisible characters); an empty field is null, never ''.
function isFieldText (v, max, allowLf) {
  const n = scan(v, allowLf)
  return n >= 1 && n <= max && !isInvisibleOnly(v)
}

const isAbout = (v) => isFieldText(v, L.MAX_ABOUT, true)
const isCity = (v) => isFieldText(v, L.MAX_CITY, false)
const isWork = (v) => isFieldText(v, L.MAX_WORK, false)
const isStudies = (v) => isFieldText(v, L.MAX_STUDIES, false)
const isInterests = (v) => isFieldText(v, L.MAX_INTERESTS, false)

// Mood text: 0..MAX_MOOD_TEXT code points on one line; a non-empty text
// must show something, as a field text must.
function isMoodText (v) {
  const n = scan(v, false)
  return n === 0 || (n >= 1 && n <= L.MAX_MOOD_TEXT && !isInvisibleOnly(v))
}

// Mood emoji: '' (none) or exactly one emoji.
function isMoodEmoji (v) {
  return v === '' || isReaction(v)
}

const nullable = (check) => (v) => v === null || check(v)

module.exports = {
  THEME_IDS,
  MAX_ABOUT: L.MAX_ABOUT,
  MAX_CITY: L.MAX_CITY,
  MAX_WORK: L.MAX_WORK,
  MAX_STUDIES: L.MAX_STUDIES,
  MAX_INTERESTS: L.MAX_INTERESTS,
  MAX_MOOD_TEXT: L.MAX_MOOD_TEXT,
  isBirthday,
  isThemeId,
  isAbout,
  isCity,
  isWork,
  isStudies,
  isInterests,
  isMoodText,
  isMoodEmoji,
  isInvisibleOnly,
  nullable
}
