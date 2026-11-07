'use strict'

const { designAt } = require('@varanda/rpc')
const { CODE_RE, inviteId } = require('./invites-store')

// The page messenger crawlers (WhatsApp, Telegram, iMessage) read for a
// signup invite link preview, mounted by ./server.js:
//
//   GET or HEAD /account/og/convite/<code>[?c=N]
//
// Crawlers never see the #fragment, so the card's design travels in the
// public query ?c=N (packages/rpc/lib/invite-card.js buildInviteCardUrl);
// the card's name and message never reach this service. The page always
// answers 200: a malformed, unknown, used or expired code gets the same
// generic page, so a probe learns nothing beyond what the live invite's
// inviter already put in a link they shared. Only a live invite with a
// design names its inviter's username.
//
// Every absolute URL starts at the configured origin, never the Host
// header. Logs carry { event: 'og', reason } counts only: never the code,
// the inviter's key or the username.

const PREFIX = '/account/og/convite/'
const QUERY_RE = /^\?c=(0|[1-9][0-9]{0,2})$/
const GENERIC_TITLE = 'Você recebeu um convite pra Varanda'
const DESCRIPTION = 'Um cartão de convite te espera na Varanda. Abra o link para ver.'
const IMAGE_ALT = 'Cartão de convite da Varanda'
const CSP = "default-src 'none'; img-src https:; base-uri 'none'; form-action 'none'"

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

function personalTitle (username) {
  return '@' + username + ' te mandou um convite pra Varanda'
}

// The page for one preview; every interpolated value is escaped.
function ogPage ({ title, image, url }) {
  const meta = (attr, key, value) => '<meta ' + attr + '="' + key + '" content="' + escapeHtml(value) + '">'
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(title) + '</title>' +
    meta('name', 'robots', 'noindex') +
    meta('name', 'description', DESCRIPTION) +
    meta('property', 'og:title', title) +
    meta('property', 'og:description', DESCRIPTION) +
    meta('property', 'og:image', image) +
    meta('property', 'og:image:width', '1200') +
    meta('property', 'og:image:height', '630') +
    meta('property', 'og:image:alt', IMAGE_ALT) +
    meta('property', 'og:url', url) +
    meta('property', 'og:type', 'website') +
    meta('property', 'og:site_name', 'Varanda') +
    meta('name', 'twitter:card', 'summary_large_image') +
    '</head><body><p><a href="' + escapeHtml(url) + '">Abrir o convite</a></p></body></html>\n'
}

// `limits.lookup` is the service's global lookup window; `invites` is the
// openInvitesStore or null (open sign-up); `store.status(member)` answers
// { linked, username }.
function createOgRoutes ({ origin, store, invites = null, limits, log = () => {}, http }) {
  const { RouteError, refuse } = http
  const over = () => new RouteError('pedido-invalido', 429)

  function inviterName (code) {
    if (invites === null) return null
    let inviter
    try {
      inviter = invites.inviterOf(inviteId(code))
    } catch {
      return null
    }
    if (inviter === null) return null
    let st
    try {
      st = store.status(inviter)
    } catch {
      return null
    }
    return st && st.linked === true && typeof st.username === 'string' ? st.username : null
  }

  function preview (req, res, url) {
    if (!limits.lookup()) throw over()
    const code = url.pathname.slice(PREFIX.length)
    const valid = CODE_RE.test(code)
    const q = valid ? QUERY_RE.exec(url.search) : null
    const index = q === null ? null : q[1]
    const design = index === null ? null : designAt(Number(index))
    const username = valid && design !== null ? inviterName(code) : null
    const personal = design !== null && username !== null
    const link = valid ? origin + '/convite/' + code + (design !== null ? '?c=' + index : '') : origin + '/'
    const body = ogPage({
      title: personal ? personalTitle(username) : GENERIC_TITLE,
      image: origin + (design !== null ? '/og/convite-' + design + '.png' : '/og/convite.png'),
      url: link
    })
    log({ event: 'og', reason: personal ? 'pessoal' : 'generico' })
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer'
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  }

  function owns (pathname) {
    return pathname.startsWith(PREFIX)
  }

  async function handle (req, res, url) {
    if (req.method === 'GET' || req.method === 'HEAD') return preview(req, res, url)
    throw refuse('nao-encontrado')
  }

  return { owns, handle }
}

module.exports = {
  GENERIC_TITLE,
  DESCRIPTION,
  IMAGE_ALT,
  CSP,
  escapeHtml,
  personalTitle,
  ogPage,
  createOgRoutes
}
