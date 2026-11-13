import rpc from '@varanda/rpc'
import { bubbleShape, withDayMarks } from './dm-screen.js'
import { HIDDEN_LABEL, mergePages, rowsOf } from './groups.js'
import { whoOf } from './who.js'

const { displayText } = rpc

// group.read supplies newest first. Keep rowsOf's text escaping and reply
// references while adapting the writer identity to the shared bubble rules.
export function groupRows (items, ownKey, now = Date.now()) {
  const byRef = new Map(mergePages([items]).map((item) => [item.writer + ':' + item.seq, item]))
  const rows = withDayMarks(rowsOf(items).map((row) => {
    const mine = typeof ownKey === 'string' && row.diary === ownKey
    // A run is one person (diary), not one device core: two devices of the
    // same member within the time limit read as one run, as in WhatsApp.
    const reactions = !row.hidden && byRef.get(row.id)?.reactions
    const summary = Array.isArray(reactions) ? { reactions: reactions.filter((r) => r && typeof r === 'object').map(({ emoji, count, mine }) => ({ emoji, count, mine })) } : {}
    return { ...row, ...summary, key: row.id, from: row.diary || row.writer, mine, side: mine ? 'mine' : 'theirs' }
  }), now)
  return rows.map((row, i) => {
    const shape = bubbleShape(rows, i)
    return { ...row, shape, showName: shape === 'first' || shape === 'single' }
  })
}

// byRef contains only loaded group.read items, keyed by writer:seq. A reply
// never triggers a fetch, and hidden targets reveal neither text nor name.
export function replyPreview (item, byRef) {
  const ref = item && item.replyTo
  const key = typeof ref === 'string'
    ? ref
    : ref && typeof ref.writer === 'string' && Number.isSafeInteger(ref.seq)
      ? ref.writer + ':' + ref.seq
      : null
  const target = key && byRef ? byRef.get(key) : null
  if (!target) return null
  if (target.hidden === true) return { name: '', text: HIDDEN_LABEL }
  return {
    name: displayText(whoOf(target).title),
    text: typeof target.text === 'string' ? target.text : ''
  }
}
