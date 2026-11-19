// A Page's web share of its own post (account service actions 'post-share',
// 'post-cover' and 'post-unshare', docs/rpc.md 5.84; the page `status`
// answers `shared` and, from a current service, `covered`).
// Pure ES module: the caller passes `share({ seq })`, so tests run it without
// a node. Nothing here retries: one call sends one request.
import { UNCERTAIN_MESSAGE, claimCover, coverAnswerState, coverErrorState, releaseCover, sendCover } from './postShare.js'
import { webShareRef } from './postShareCompose.js'

const KEY = /^[0-9a-f]{64}$/i

const FAILED = 'Não deu para publicar na web.'
const UNPUBLISH_FAILED = 'Não deu para tirar da web.'
const READ_FAILED = 'Não deu para ver se esta publicação está na web.'

// The page action's op for a post of the page.
export function pageShareOp (seq) {
  return { seq }
}

// The page action's op for a cover of a post of the page.
export function pageCoverOp (seq, image) {
  return { seq, image }
}

// Whether the status answer lists `seq` in `covered`: true or false, or null
// when an older service sent no `covered` (unknown, so no repair is offered).
export function coveredState (status, seq) {
  const list = status !== null && typeof status === 'object' ? status.covered : undefined
  if (!Array.isArray(list)) return null
  return list.includes(seq)
}

// The refs `<pageKey>:<seq>` of a status answer's `shared` list, a Set.
// Anything but a list of positive integers reads as none.
export function sharedRefs (page, status) {
  const out = new Set()
  if (typeof page !== 'string' || !KEY.test(page)) return out
  const list = status !== null && typeof status === 'object' ? status.shared : null
  if (!Array.isArray(list)) return out
  for (const seq of list) {
    const ref = webShareRef(page, seq)
    if (ref !== null) out.add(ref)
  }
  return out
}

// The same { state, shareSeq, message } shape as postShare.js.
export function shareAnswerState (answer, action) {
  const publish = action === 'publish'
  if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
    if (publish && Number.isSafeInteger(answer.shareSeq) && answer.shareSeq >= 1 && typeof answer.created === 'boolean') {
      return { state: 'on', shareSeq: answer.shareSeq, message: '' }
    }
    if (!publish && answer.ok === true && typeof answer.changed === 'boolean') {
      return { state: 'off', shareSeq: null, message: '' }
    }
  }
  return { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE }
}

export function shareErrorState (err, action) {
  const fallback = action === 'publish' ? FAILED : action === 'read' ? READ_FAILED : UNPUBLISH_FAILED
  if (err === null || typeof err !== 'object' || err.uncertain === true) {
    return { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE }
  }
  const message = typeof err.message === 'string' && err.message !== '' ? err.message : fallback
  return { state: 'error', shareSeq: null, message }
}

// One 'post-cover' request through `write(op)`. Never rejects. Any refusal,
// an older service's 'pedido-invalido' or unknown action included, is 'off':
// the page keeps the seeder's own preview.
export async function coverAsPage (write, seq, image) {
  if (typeof write !== 'function' || !Number.isSafeInteger(seq) || seq < 1) return coverErrorState({})
  try {
    return coverAnswerState(await write(pageCoverOp(seq, image)))
  } catch (err) {
    return coverErrorState(err)
  }
}

// Never rejects. -> { ref, result } like postShareCompose.shareNew: a page
// post that went out is never failed by its share, nor by its cover.
// `cover` (optional) is sendCover's input with `write(op)` the 'post-cover'
// action and `upload` the page media upload.
export async function shareNewAsPage (share, page, seq, cover = null) {
  const ref = webShareRef(page, seq)
  if (ref === null || typeof share !== 'function') return { ref: null, result: null }
  let result
  try {
    result = shareAnswerState(await share(pageShareOp(seq)), 'publish')
  } catch (err) {
    result = shareErrorState(err, 'publish')
  }
  if (result.state === 'on' && cover !== null && typeof cover === 'object' && claimCover(ref)) {
    const { write, ...rest } = cover
    try {
      await sendCover({ ...rest, setCover: (image) => coverAsPage(write, seq, image) })
    } finally {
      releaseCover(ref)
    }
  }
  return { ref, result }
}

// The seq of a `<pageKey>:<seq>` ref of this page, or null.
export function pageSeqOf (page, ref) {
  if (typeof page !== 'string' || !KEY.test(page) || typeof ref !== 'string') return null
  const at = ref.indexOf(':')
  if (at !== 64 || ref.slice(0, 64).toLowerCase() !== page.toLowerCase()) return null
  const seq = Number(ref.slice(65))
  return webShareRef(page, seq) === ref.toLowerCase() ? seq : null
}

// What PostShareSheet's page mode runs instead of the person's post.shared /
// post.share / post.unshare. `status()`, `share(seq)` and `unshare(seq)` are
// the account service calls; each op resolves to { state, shareSeq, message }
// and never rejects, one request per call. read adds `cover` (coveredState).
// `ops.page` names the page, so the sheet can upload a cover as the page.
export function pageShareOps ({ page, status, share, unshare }) {
  const wrong = { state: 'error', shareSeq: null, message: 'Não encontramos esta publicação. Ela pode ter sido apagada.' }
  // The sheet calls each op unbound (ops[action](target)), so none uses this.
  const ops = {
    page: typeof page === 'string' && KEY.test(page) ? page.toLowerCase() : null,
    async read (ref) {
      const seq = pageSeqOf(page, ref)
      if (seq === null) return wrong
      try {
        const answer = await status()
        if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.shared)) {
          return { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE }
        }
        return sharedRefs(page, answer).has(ref.toLowerCase())
          ? { state: 'on', shareSeq: null, message: '', cover: coveredState(answer, seq) }
          : { state: 'off', shareSeq: null, message: '', cover: false }
      } catch (err) {
        return shareErrorState(err, 'read')
      }
    },
    async publish (ref) {
      const seq = pageSeqOf(page, ref)
      if (seq === null) return wrong
      try {
        return shareAnswerState(await share(seq), 'publish')
      } catch (err) {
        return shareErrorState(err, 'publish')
      }
    },
    async unpublish (ref) {
      const seq = pageSeqOf(page, ref)
      if (seq === null) return wrong
      try {
        const raw = await unshare(seq)
        const answer = shareAnswerState(raw, 'unpublish')
        if (answer.state !== 'off' || raw.changed !== true) return answer
        // More than MAX_UNSHARE live shares leave older ones live: the state
        // comes from one fresh read, never from a repeated unshare.
        const after = await ops.read(ref)
        return after.state === 'on' || after.state === 'off' ? after : { state: 'uncertain', shareSeq: null, message: READ_FAILED }
      } catch (err) {
        return shareErrorState(err, 'unpublish')
      }
    }
  }
  return ops
}

// The acting Page's key when `target` is a ref of that Page's own post, else
// null: the sheet then works in page mode. `acting` is { kind, key }.
export function sharePageOf (target, acting) {
  if (typeof target !== 'string' || acting === null || typeof acting !== 'object') return null
  if (acting.kind !== 'page' || typeof acting.key !== 'string' || !KEY.test(acting.key)) return null
  return pageSeqOf(acting.key, target) === null ? null : acting.key.toLowerCase()
}
