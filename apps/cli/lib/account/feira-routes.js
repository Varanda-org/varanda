'use strict'

// The Feira entry (mounted by ./server.js): someone who opens a shared
// listing link and is not a member yet signs up with a one-hour code charged
// to the listing's owner, instead of a member's weekly invite.
//
//   - GET /account/feira/policy answers exactly { enabled }, even when off.
//     On only with VARANDA_FEIRA_INVITES_PER_WEEK, VARANDA_INVITES_PER_WEEK
//     and VARANDA_TRIAGE_TOKEN set (../commands/account.js refuses to start
//     with the first and not the other two).
//   - POST /account/feira/start { author, seq } -> { code }. 404 while off.
//     In this order: the exact body; the quota owner, who is the author when
//     the author is a linked member, else the current owner of the open page
//     `author` (./pages-store.js), else 404 'nao-encontrado' with NO seeder
//     read, so junk refs cost nothing on the seeder; then the listing check
//     on the local seeder (./feira-read.js, GET /feira-listing, which has
//     its own budget there, never the report triage's): block <seq> of
//     diary <author> must be the root of a live listing, else the same 404.
//     Its status is not read: a sold listing still opens the door. Last, the
//     code. Nothing here is limited per owner key, which anyone could spend
//     to lock an owner's listings: the per-address limit is at the edge
//     (deploy/seeder/Caddyfile, zone feira-entrada), and the global bucket
//     of the unsigned routes applies. The code comes from the Feira store
//     (feira-invites.json, ./invites-store.js capOn 'use'): it lives one
//     hour and the owner's weekly cap applies when it is used at sign-up,
//     through the same check/consume the member invites go through
//     (./invites-pair.js); its paid age sessions have their own ceilings
//     (./age-routes.js).
//
// Logs carry { event: 'feira', reason } only: never a code, a key or a seq.

const HEX64_RE = /^[0-9a-f]{64}$/

function createFeiraRoutes ({ enabled = false, invites = null, reader = null, store, pagesStore = null, log = () => {}, now = Date.now, http }) {
  const { send, readJsonBody, checkPost, refuse, fromStore } = http
  const on = enabled === true && invites !== null && reader !== null && typeof reader.readListing === 'function'
  const notFound = () => refuse('nao-encontrado')

  function readRef (body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw refuse('pedido-invalido')
    const keys = Object.keys(body)
    if (keys.length !== 2 || !Object.hasOwn(body, 'author') || !Object.hasOwn(body, 'seq')) throw refuse('pedido-invalido')
    const { author, seq } = body
    if (typeof author !== 'string' || !HEX64_RE.test(author)) throw refuse('pedido-invalido')
    if (!Number.isSafeInteger(seq) || seq < 1) throw refuse('pedido-invalido')
    return { author, seq }
  }

  function linked (key) {
    try {
      return store.status(key).linked === true
    } catch (err) {
      throw fromStore(err)
    }
  }

  // The member whose weekly Feira quota pays for this code, or null.
  function ownerOf (author) {
    if (linked(author)) return author
    if (pagesStore === null) return null
    let row
    try {
      row = pagesStore.get(author)
    } catch (err) {
      throw fromStore(err)
    }
    if (row === null || row.closed !== null || typeof row.owner !== 'string' || !HEX64_RE.test(row.owner)) return null
    return linked(row.owner) ? row.owner : null
  }

  async function start (res, body) {
    const { author, seq } = readRef(body)
    if (!invites.available()) throw refuse('indisponivel')
    const owner = ownerOf(author)
    if (owner === null) throw notFound()
    const listing = await reader.readListing(author, seq)
    if (listing === null || typeof listing !== 'object') {
      if (listing === 'timeout' || listing === 'recusado' || listing === 'config') log({ event: 'feira', reason: 'leitura-falhou' })
      throw notFound()
    }
    let result
    try {
      result = await invites.issue(owner)
    } catch (err) {
      log({ event: 'feira', reason: 'emissao-falhou' })
      throw fromStore(err)
    }
    log({ event: 'feira', reason: 'codigo' })
    send(res, 200, { code: result.code })
  }

  function owns (pathname) {
    return pathname === '/account/feira' || pathname.startsWith('/account/feira/')
  }

  async function handle (req, res, url) {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/account/feira/policy') return send(res, 200, { enabled: on })
    if (!on) throw notFound()
    if (req.method === 'POST' && pathname === '/account/feira/start') {
      checkPost(req)
      return start(res, await readJsonBody(req))
    }
    throw notFound()
  }

  return { owns, handle, enabled: () => on }
}

module.exports = {
  createFeiraRoutes
}
