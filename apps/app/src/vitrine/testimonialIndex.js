import { fixtures, testimonialHash } from './fixtures.js'

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// The seeder's testimonial index (packages/core/lib/engagement-index.js),
// over { author, seq, record } entries and the tombstoned 'author:seq' refs:
// the owner's newest show per writer while its writer block is live, and
// the newest live block per writer never shown, even by a removed show.
export function testimonialPointers (entries, deleted, owner) {
  const live = (e) => !deleted.has(`${e.author}:${e.seq}`)
  const blocks = new Map()
  for (const e of entries) {
    if (e.record.type === 'testimonial' && e.record.to === owner && e.author !== owner && live(e)) blocks.set(`${e.author}:${e.seq}`, e)
  }
  const everShown = new Set()
  const newestShow = new Map()
  for (const e of entries) {
    if (e.author !== owner || e.record.type !== 'testimonial-show') continue
    everShown.add(`${e.record.from}:${e.record.seq}`)
    const prev = newestShow.get(e.record.from)
    if (!prev || e.seq > prev.seq) newestShow.set(e.record.from, e)
  }
  const shown = [...newestShow.values()]
    .filter((e) => live(e) && e.record.from !== owner && blocks.get(`${e.record.from}:${e.record.seq}`)?.record.hash === testimonialHash(e.record.from, e.record.nonce, e.record.text))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 64)
    .map((e) => ({ seq: e.seq, from: e.record.from, wseq: e.record.seq }))
  const newestBlock = new Map()
  for (const e of blocks.values()) {
    const prev = newestBlock.get(e.author)
    if (!prev || e.seq > prev.seq) newestBlock.set(e.author, e)
  }
  const pending = [...newestBlock.values()]
    .filter((e) => !everShown.has(`${e.author}:${e.seq}`))
    .sort((a, b) => Date.parse(b.record.at) - Date.parse(a.record.at) || compare(a.author, b.author))
    .slice(0, 64)
    .map((e) => ({ from: e.author, seq: e.seq }))
  return { shown, pending }
}

// A live Vitrine request registers its diaries here, so the route follows
// what the lab writes; without one, the route reads the fixtures.
let source = () => ({ entries: fixtures.diaryRecords, deleted: new Set() })
export function useTestimonialSource (next) {
  source = next
}
export const testimonialSource = () => source()
