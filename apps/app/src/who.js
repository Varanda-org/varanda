// One display identity rule, never a fallback to key-derived characters.
// Callers render the returned names through displayText as plain text.
//
// Anti-impersonation: the bold title only ever comes from the free-form
// display name (with any leading at-sign removed, look-alikes included) or,
// without one, the verified username written as a name (no '@'); the
// '@nome' only ever appears as the subtitle and only from a verified
// username record. A display name such as '@alice' can therefore never pass
// for the member whose verified @nome is alice.

export const UNNAMED = 'sem nome'

// A leading run of at-signs ('@', FULLWIDTH and SMALL COMMERCIAL AT),
// whitespace and invisible characters is dropped from a display name, and a
// name with nothing visible left counts as no name. "Invisible" is Unicode's
// complete Default_Ignorable_Code_Point set (DerivedCoreProperties): soft
// hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers,
// Khmer and Mongolian invisibles, zero-width spaces and joiners, direction
// marks and embeddings, word joiner and invisible operators, variation
// selectors, BOM, the reserved FFF0-FFF8, shorthand format controls, musical
// formatting controls, and the tag and supplementary variation selector
// plane block E0000-E0FFF. Code-point ranges rather than \p{...}, which not
// every JavaScript engine the app runs on is known to support.
const AT_SIGNS = [0x40, 0xff20, 0xfe6b]
const INVISIBLE = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

function invisible (cp) {
  return /\s/.test(String.fromCodePoint(cp)) || INVISIBLE.some(([from, to]) => cp >= from && cp <= to)
}

// The display name without its leading at-signs and invisibles, or '' when
// nothing visible remains.
function displayName (s) {
  const chars = Array.from(s)
  let i = 0
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0)
    if (!AT_SIGNS.includes(cp) && !invisible(cp)) break
    i++
  }
  const rest = chars.slice(i)
  if (!rest.some((ch) => !invisible(ch.codePointAt(0)))) return ''
  return rest.join('').trim()
}

export function isValidUsername (username) {
  return typeof username === 'string' && /^[a-z][a-z0-9_]{2,19}$/.test(username) && !/^[0-9a-f]{6}$/.test(username)
}

export function atName (username) {
  return isValidUsername(username) ? '@' + username : null
}

export function whoOf (profile) {
  const name = typeof profile?.name === 'string' ? displayName(profile.name) : ''
  const username = isValidUsername(profile?.username) ? profile.username : null
  return {
    title: name || username || UNNAMED,
    subtitle: atName(username),
    avatarName: name || username || null,
    known: profile !== undefined
  }
}

// The name in a reply mark: '…' while the profile is not looked up yet, so
// "respondendo a sem nome" never flashes before the answer.
export const PENDING_NAME = '…'
export function replyNameOf (profile) {
  return profile === undefined ? PENDING_NAME : whoOf(profile).title
}
