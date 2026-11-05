// Pure helpers for deleting own posts and profile versions (docs/rpc.md 5.33,
// 5.34). No imports: the app tests load it directly.

const KEY_RE = /^[0-9a-f]{64}$/

// Only the author's own post, or the post of the page the person acts as
// (`page`, a hex64 key or null): a repost wrapper never makes another
// author's original deletable.
export function canDelete (post, own, page = null) {
  if (post === null || typeof post !== 'object') return false
  const mine = typeof own === 'string' && own !== '' && post.author === own
  const pages = typeof page === 'string' && KEY_RE.test(page) && post.author === page
  return (mine || pages) && Number.isInteger(post.seq) && post.seq >= 1
}

// The ref of a deletable own (or acting page's) post, or null.
export function deleteRef (post, own, page = null) {
  return canDelete(post, own, page) ? post.author + ':' + post.seq : null
}

// True when `ref` ('<author>:<seq>') is a post of the page being acted as.
export function isPageRef (ref, page) {
  return typeof ref === 'string' && typeof page === 'string' && KEY_RE.test(page) && ref.startsWith(page + ':')
}

// Keep the slots for pagination, but discard the post and every repost of it.
export function deletePostRows (rows, ref, author) {
  return rows.map((row) => {
    const record = row.entry && row.entry.record
    const to = record && record.type === 'repost' && record.to
    const target = to && typeof to.author === 'string' ? to.author.toLowerCase() + ':' + to.seq : null
    if (author + ':' + row.seq !== ref && target !== ref) return row
    return { seq: row.seq, invalid: { seq: row.seq, reason: 'deleted' } }
  })
}

function sameProfile (a, b) {
  return a.name === b.name && a.bio === b.bio && a.at === b.at
}

const isProfile = (entry) => entry !== null && typeof entry === 'object' &&
  Number.isInteger(entry.seq) && entry.record !== null && typeof entry.record === 'object' &&
  entry.record.type === 'profile'

// Own profile versions, newest first, from log.read entries (any order). A
// version is a plain profile at seq n immediately followed by the same profile
// with an avatar at n+1 (the compatibility pair, docs/protocol.md), or one
// profile record alone. `seq` is the first block: the node deletes the pair.
export function profileVersions (entries) {
  const profiles = (Array.isArray(entries) ? entries : []).filter(isProfile).sort((a, b) => a.seq - b.seq)
  const versions = []
  for (let i = 0; i < profiles.length; i++) {
    const first = profiles[i]
    const next = profiles[i + 1]
    const paired = next !== undefined && next.seq === first.seq + 1 &&
      first.record.avatar === undefined && next.record.avatar !== undefined &&
      sameProfile(first.record, next.record)
    const last = paired ? next : first
    versions.push({
      seq: first.seq,
      seqs: paired ? [first.seq, next.seq] : [first.seq],
      name: last.record.name,
      bio: last.record.bio,
      at: last.record.at,
      avatar: last.record.avatar !== undefined
    })
    if (paired) i++
  }
  return versions.reverse()
}
