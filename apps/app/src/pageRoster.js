// The people of a page, from a page.read answer. Keys only: the caller
// resolves names (useNames) and never shows a raw key as a label.

// Same values as records.js (MAX_PAGE_ADMINS) and the page.read / page.feed
// bounds of rpc methods.js; duplicated because the app imports no core module.
export const MAX_ADMINS = 16
export const MAX_OWNED = 8
export const MAX_FEED_KEYS = 64

const KEY_RE = /^[0-9a-f]{64}$/
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v)
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const nowIso = () => new Date().toISOString()

// rows: [{ key, role }] with the owner first, then the admins as given.
// sections: 'Dono' (the owner) and 'Administradores' (admins, owner excluded).
export function rosterRows (read) {
  if (!isObject(read)) return { owner: null, admins: [], rows: [], sections: [] }
  const owner = isKey(read.owner) ? read.owner : null
  const seen = new Set(owner === null ? [] : [owner])
  const admins = []
  for (const key of Array.isArray(read.admins) ? read.admins : []) {
    if (!isKey(key) || seen.has(key)) continue
    seen.add(key)
    admins.push(key)
    if (admins.length >= MAX_ADMINS) break
  }
  const rows = []
  if (owner !== null) rows.push({ key: owner, role: 'owner' })
  for (const key of admins) rows.push({ key, role: 'admin' })
  const sections = []
  if (owner !== null) sections.push({ title: 'Dono', keys: [owner] })
  if (admins.length > 0) sections.push({ title: 'Administradores', keys: admins })
  return { owner, admins, rows, sections }
}

// A pending admin invite for this member, from the owner-side `status` read
// ({ invites: [{ member, gen, expiresAt }] }); expired ones do not count.
export function hasInvite (read, member, now = Date.now()) {
  if (!isObject(read) || !isKey(member)) return false
  return (Array.isArray(read.invites) ? read.invites : [])
    .some((i) => isObject(i) && i.member === member && Date.parse(i.expiresAt) > now)
}

// An ownership offer ({ to, exp }) addressed to this member and not expired.
export function hasOffer (read, member, now = Date.now()) {
  if (!isObject(read) || !isKey(member) || !isObject(read.offer)) return false
  const { to, exp } = read.offer
  return to === member && Date.parse(exp) > now
}

// Op builders. Each takes the nonce the service minted for the action
// (record.nonce must equal it) and answers the op page.sign expects; the node
// fills in actor, association and signature. `read` is a page.read answer:
// `gen` and `seq` are those of the roster in force.

export function inviteOp (read, member, { nonce, at = nowIso() }) {
  const r = rosterRows(read)
  const admins = [...new Set([...r.admins, member])].sort()
  return {
    member,
    gen: read.gen + 1,
    rosterSignature: '',
    roster: { owner: r.owner, admins, prev: read.seq, at, nonce }
  }
}

export function acceptOp ({ gen, rosterSignature }, { nonce, at = nowIso() }) {
  return { gen, rosterSignature, at, nonce }
}

export function removeOp (read, admin, { nonce, at = nowIso() }) {
  const r = rosterRows(read)
  return {
    gen: read.gen + 1,
    owner: r.owner,
    admins: r.admins.filter((k) => k !== admin).sort(),
    prev: read.seq,
    at,
    nonce
  }
}

export function offerOp (read, to, { exp, nonce, at = nowIso() }) {
  return { to, exp, gen: read.gen, at, nonce }
}

// The owner's signed cancel: an offer naming no one, appended on the diary so
// readers stop showing the old offer (the service then forgets it).
export function cancelOfferOp (read, { nonce, at = nowIso() }) {
  return { to: null, exp: null, gen: read.gen, at, nonce }
}

// The old owner stays on as an admin.
export function transferAcceptOp (read, member, { nonce, at = nowIso() }) {
  const r = rosterRows(read)
  const admins = [...r.admins.filter((k) => k !== member), r.owner].sort()
  return { gen: read.gen + 1, owner: member, admins, prev: read.seq, at, nonce }
}

export function closeOp (read, { nonce, at = nowIso() }) {
  return { gen: read.gen + 1, at, nonce }
}

// gen is K1's final gen (the roster is carried over unchanged) and fromSeq the
// last seq of K1, which the signed `status` read reports as `length`.
export function moveOp (read, to, { fromSeq, nonce, at = nowIso() }) {
  const r = rosterRows(read)
  return { to, gen: read.gen, fromSeq, owner: r.owner, admins: r.admins, at, nonce }
}
