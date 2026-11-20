// What the Avisos list draws from the loaded notices: the filter chips, the
// day headers between rows and who gets the Seguir de volta pill. Only the
// drawing: seen marking, settle and the badge keep the full loaded list.
// Pure: no React, no react-native and no Node built-ins.

import { noticeKind } from './notices.js'
import { dayHeading } from './format.js'

export const NOTICE_FILTERS = Object.freeze([
  Object.freeze({ id: 'todas', label: 'Todas' }),
  Object.freeze({ id: 'mencoes', label: 'Menções' }),
  Object.freeze({ id: 'seguidores', label: 'Seguidores' })
])

export const FOLLOW_BACK_LABEL = 'Seguir de volta'
export const FILTER_EMPTY_TITLE = 'Nada neste filtro'
export const FILTER_EMPTY_TEXT = 'Os avisos deste tipo aparecem aqui. Toque em Todas para ver os outros.'

// noticeKind reads a row without a known kind (an older node) as a follow,
// so Seguidores keeps those rows too. Likes and reposts stay under Todas.
const MENTION_KINDS = new Set(['mention', 'reply', 'quote'])

// A new array of the same row objects, in the same order. An unknown filter
// id is Todas.
export function filterNotices (items, id) {
  const list = Array.isArray(items) ? items : []
  if (id === 'mencoes') return list.filter((item) => MENTION_KINDS.has(noticeKind(item)))
  if (id === 'seguidores') return list.filter((item) => noticeKind(item) === 'follow')
  return list.slice()
}

function dayKeyOf (at) {
  const d = new Date(String(at))
  if (Number.isNaN(d.getTime())) return null
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

function capitalized (text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// A header is known by identity, never by a field: a notice from the pages
// service is not checked and could carry any field. A header row has a key
// of its own ('d:' and the local day), so it never takes a notice's id.
const HEADERS = new WeakSet()

export function isDayHeader (row) {
  return row !== null && typeof row === 'object' && HEADERS.has(row)
}

// The same row objects (never copied, merged or re-keyed), newest first as
// given, with a header row before the first row of each local calendar day.
// A row whose time does not parse stays under the header above it.
export function withDayHeaders (items, now = Date.now()) {
  const out = []
  let last = null
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const key = item ? dayKeyOf(item.at) : null
    if (key !== null && key !== last) {
      const title = dayHeading(item.at, now)
      // A day that comes back after another one (rows out of order) keeps
      // its first header, so the list never holds two rows with one key.
      if (title !== null && !seen.has(key)) {
        seen.add(key)
        const header = Object.freeze({ key: 'd:' + key, title: capitalized(title) })
        HEADERS.add(header)
        out.push(header)
      }
      last = key
    }
    out.push(item)
  }
  return out
}

const KEY64 = /^[0-9a-f]{64}$/

// The pill only follows a person as the person: never while a page is
// acting (follow.add would act as the person, and page notices belong to
// the page), never before the follow set is read, never for someone already
// followed or for the own key, and only on a follow notice: kind 'follow',
// or none from an older node. An unknown kind still lists under Seguidores
// but gets no pill.
export function showsFollowBack (item, { pageActing, follows, ownKey }) {
  if (pageActing !== false) return false
  if (!(follows instanceof Set)) return false
  if (!item || (item.kind !== 'follow' && item.kind !== undefined)) return false
  const key = typeof item.key === 'string' ? item.key.toLowerCase() : ''
  if (!KEY64.test(key)) return false
  if (typeof ownKey === 'string' && key === ownKey.toLowerCase()) return false
  return !follows.has(key)
}
