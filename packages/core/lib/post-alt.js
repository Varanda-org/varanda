'use strict'

const { PROTOCOL, MAX_ID, MAX_MESSAGE, utf8ByteLength } = require('@varanda/rpc')
const { validAltList } = require('./records')

function altRecordsOf (copied) {
  const out = new Map()
  const first = new Map()
  try {
    for (const entry of copied) {
      try {
        const { seq, record } = entry
        if (!Number.isSafeInteger(seq) || !record || record.type !== 'post-alt') continue
        const postSeq = record.seq
        if (!Number.isSafeInteger(postSeq) || postSeq < 1 || (postSeq !== seq - 1 && postSeq !== seq - 2)) continue
        const alt = record.alt
        if (!validAltList(alt) || (first.has(postSeq) && first.get(postSeq) <= seq)) continue
        out.set(postSeq, alt.slice())
        first.set(postSeq, seq)
      } catch {}
    }
  } catch {}
  return out
}

function postAltOf (post, alt) {
  try {
    if (!Array.isArray(alt) || !Array.isArray(post.media) || post.media.length !== alt.length) return null
    return alt.slice()
  } catch {
    return null
  }
}

function pickedAlt (postSeq, seq, record) {
  if (!record || record.type !== 'post-alt' || record.seq !== postSeq) return null
  const alt = record.alt
  return validAltList(alt) ? { seq, alt: alt.slice() } : null
}

function pickAlt (postSeq, recordAt) {
  if (!Number.isSafeInteger(postSeq) || postSeq < 1) return null
  for (const seq of [postSeq + 1, postSeq + 2]) {
    try {
      const picked = pickedAlt(postSeq, seq, recordAt(seq))
      if (picked !== null) return picked
    } catch {}
  }
  return null
}

async function pickAltAsync (postSeq, recordAt) {
  if (!Number.isSafeInteger(postSeq) || postSeq < 1) return null
  for (const seq of [postSeq + 1, postSeq + 2]) {
    try {
      const picked = pickedAlt(postSeq, seq, await recordAt(seq))
      if (picked !== null) return picked
    } catch {}
  }
  return null
}

function fitAlt (result, field, atOf) {
  try {
    return fitAltRows(result, field, atOf)
  } catch {
    return withoutAlt(result, field)
  }
}

// Rows, their order and the cursors never change: a failure drops only the
// descriptions, never a row.
function withoutAlt (result, field) {
  const rows = result !== null && typeof result === 'object' && Array.isArray(result[field]) ? result[field] : []
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const out = {}
    for (const key of Object.keys(row)) if (key !== 'alt') out[key] = row[key]
    return out
  })
}

function fitAltRows (result, field, atOf) {
  const rows = result[field]
  const bare = rows.map((row) => {
    const { alt, thumbs, ...rest } = row
    return rest
  })
  // Descriptions get their budget before thumbnails, which are fitted later.
  let used = utf8ByteLength(JSON.stringify({ v: PROTOCOL, id: MAX_ID, ok: true, result: { ...result, [field]: bare } }))
  const order = rows.map((row, i) => i).filter((i) => Array.isArray(rows[i].alt))
    .sort((a, b) => {
      const ta = Date.parse(atOf(rows[a]))
      const tb = Date.parse(atOf(rows[b]))
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta) || b - a
    })
  const out = rows.map((row) => {
    const { alt, ...rest } = row
    return rest
  })
  for (const i of order) {
    const cost = utf8ByteLength(',"alt":' + JSON.stringify(rows[i].alt))
    if (used + cost > MAX_MESSAGE) break
    used += cost
    out[i] = { ...out[i], alt: rows[i].alt }
  }
  return out
}

module.exports = { altRecordsOf, postAltOf, pickAlt, pickAltAsync, fitAlt }
