import { isBackfillRef } from './coverBackfill.js'
import { validDescriptor } from './media/fetch.js'
import { needsCover } from './media/shareCover.js'
import { actingPageStopped, pagesRun } from './pageSecrets.js'
import { COVER_NOT_BUILT, claimCover, releaseCover, sendCover } from './postShare.js'

const key = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function candidates (posts, author, kind) {
  if (!key(author) || !Array.isArray(posts) || posts.length > 8) return []
  let previous = 0
  const out = []
  for (const row of posts) {
    if (!row || !Number.isSafeInteger(row.seq) || row.seq <= previous ||
      !validDescriptor(row.image) || !needsCover({ media: [row.image] })) return []
    previous = row.seq
    out.push({ ref: author + ':' + row.seq, author, seq: row.seq, kind, image: row.image })
  }
  return out
}

async function ownCandidates (listOwn, identity) {
  try {
    const answer = await listOwn()
    return answer && typeof answer.more === 'boolean' ? candidates(answer.posts, identity, 'own') : []
  } catch {
    return []
  }
}

async function pageCandidates (listPages, page) {
  try {
    const rows = await listPages(page)
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) => row && row.status ? candidates(row.status.uncovered, row.page, 'page') : [])
  } catch {
    return []
  }
}

// Use the signed list directly: pagesList also maintains conversation keys.
// Recheck the status roster because membership can change after that list.
export async function listBackfillPages ({ list, status, identity, alive }, only = null) {
  const out = []
  if (!alive()) return out
  const data = await list()
  const roles = pagesRun(data)
  if (!alive() || roles === null) return out
  for (const page of roles.run) {
    if ((only !== null && page !== only) || actingPageStopped(data, page)) continue
    if (!alive()) break
    try {
      const answer = await status(page)
      if (!alive()) break
      if (!answer || answer.closed === true || answer.movedTo ||
        !(answer.owner === identity || (Array.isArray(answer.admins) && answer.admins.includes(identity)))) continue
      out.push({ page, status: answer })
    } catch {}
  }
  return out
}

export async function runBackfillPass ({ planner, identity, listOwn, listPages, readPost, buildDeps, alive }) {
  if (!alive()) return
  const pass = planner.beginPass()
  if (pass === null) return
  const own = await ownCandidates(listOwn, identity)
  if (!alive()) return
  const pages = await pageCandidates(listPages, null)
  const all = [...own, ...pages]
  while (alive()) {
    const candidate = await pass.nextStep(all)
    if (!candidate || !isBackfillRef(candidate.ref) || !alive()) return
    try {
      await pass.claim(candidate.ref)
    } catch {
      return
    }
    let outcome = 'failed'
    const held = alive() && claimCover(candidate.ref)
    let uncertain = false
    try {
      if (held) {
        const post = await readPost(candidate)
        if (post && alive()) {
          const deps = await buildDeps(candidate)
          if (alive()) {
            const result = await sendCover({
              post,
              fetchStill: (image) => {
                if (!alive()) throw new Error('Passagem encerrada.')
                return deps.fetchStill(image)
              },
              encodeThumbnail: (...args) => {
                if (!alive()) throw new Error('Passagem encerrada.')
                return deps.encodeThumbnail(...args)
              },
              upload: async (built) => {
                if (!alive()) throw new Error('Passagem encerrada.')
                const current = candidate.kind === 'own'
                  ? await ownCandidates(listOwn, identity)
                  : await pageCandidates(listPages, candidate.author)
                if (!alive() || !current.some((row) => row.ref === candidate.ref)) throw new Error('Capa indisponível.')
                try {
                  return await deps.upload(built)
                } catch (err) {
                  uncertain = err?.uncertain === true
                  throw err
                }
              },
              setCover: async (image) => {
                if (!alive()) throw new Error('Passagem encerrada.')
                try {
                  return await deps.setCover(image)
                } catch (err) {
                  uncertain = true
                  throw err
                }
              }
            })
            outcome = result.state === 'on' || result.state === 'skipped'
              ? 'done'
              : result.state === 'off' ? (result.message === COVER_NOT_BUILT ? 'no-decode' : 'failed') : 'uncertain'
          }
        }
      }
    } catch {
      outcome = 'failed'
    } finally {
      if (held) releaseCover(candidate.ref)
    }
    if (uncertain) outcome = 'uncertain'
    try {
      await pass.settle(candidate.ref, outcome)
    } catch {
      return
    }
    if (outcome === 'uncertain') return
  }
}
