/* global document, fetch, location, history, confirm */
// Moderation panel (plan B3, T27): a classic script served by mod-routes.js
// at /account/mod/app.js under `script-src 'self'` (no inline code, no
// <form>: the Caddy CSP sets form-action 'none'). Every value from the server
// is rendered with textContent through the small builders below: no HTML
// parsing sink and no string evaluation (panel.test.js greps for them).
// Report quotes and comments are untrusted text written by members. Nothing
// is kept in browser storage: the session is the HttpOnly
// `__Host-varanda-mod` cookie.
// Under Node (panel.test.js) the file only exports its helpers and
// createPanel, which takes the browser objects as injected dependencies.
'use strict'

const API = '/account/mod/api/'
const LOGIN_URL = '/account/mod/login'
const LOGOUT_URL = '/account/mod/logout'

// A local copy of packages/core/lib/report.js REASON_LABELS: this file runs
// in the browser without a bundler (panel.test.js checks they agree).
const REASON_LABELS = { spam: 'spam', assedio: 'assédio', ilegal: 'conteúdo ilegal', outro: 'outro' }

// The ?erro values mod-routes.js redirects to after the Google callback.
// Only these fixed strings are ever shown; the query value is never echoed.
const LOGIN_ERRORS = {
  'nao-autorizado': 'Esta conta Google não está na lista de moderação.',
  sessao: 'sessão expirada, entre de novo',
  cancelado: 'login cancelado',
  google: 'o Google recusou',
  indisponivel: 'o painel de moderação está desligado neste serviço',
  'sem-diario': 'Entre no painel com a conta Google vinculada ao seu diário.'
}

// { error: token } bodies of the account service.
const API_ERRORS = {
  'nao-encontrado': 'não encontrada: talvez outra pessoa já tenha decidido',
  'pedido-invalido': 'pedido inválido',
  lotado: 'a lista de bloqueio está cheia',
  indisponivel: 'serviço de moderação indisponível',
  limite: 'o serviço guardou o máximo de denúncias; avise a operação',
  'muitos-pedidos': 'muitos pedidos, espere um minuto e tente de novo',
  rede: 'sem conexão com o servidor',
  'ja-revertido': 'Essa decisão já foi desfeita por outra mais recente.',
  expirado: 'a sessão expirou, entre de novo',
  defasado: 'a lista mudou, recarregue o painel e tente de novo'
}

// The AI triage (apps/cli/lib/account/ai) explains every abstention, and an
// exact-match suggestion, with one of these tokens. Only these fixed
// Portuguese labels are ever shown; an unknown token falls back to the
// generic one and is never echoed.
const AI_REASONS = {
  frio: 'ainda há poucas decisões para comparar',
  'sem-exemplo': 'nenhum caso decidido parecido',
  margem: 'casos parecidos com decisões diferentes',
  divergente: 'os casos mais parecidos discordam entre si',
  conta: 'denúncia de conta, não de publicação',
  ilegal: 'conteúdo possivelmente ilegal pede uma pessoa',
  contexto: 'depende de contexto',
  midia: 'a publicação tem fotos, que a IA não vê',
  citacao: 'a publicação cita outra',
  recurso: 'há um pedido de revisão',
  truncado: 'a publicação foi cortada para a leitura',
  curto: 'texto curto demais para comparar',
  'sem-vetor': 'a publicação não pôde ser comparada',
  'teto-bloquear': 'limite de bloqueios automáticos atingido',
  'teto-descartar': 'limite de descartes automáticos atingido',
  'ja-bloqueado': 'a conta já está bloqueada',
  'ja-decidida': 'a denúncia já foi decidida',
  sombra: 'modo de observação: a IA só registra, não decide',
  erro: 'erro na triagem',
  timeout: 'a triagem demorou demais',
  ausente: 'a publicação não foi encontrada no semeador',
  recusado: 'o semeador recusou a leitura',
  certificado: 'a publicação não pôde ser conferida',
  config: 'a triagem não está configurada',
  'humano-revisou': 'esta conta tem uma mudança pendente ou uma pessoa já desfez um bloqueio dela',
  motivo: 'a IA não decide sozinha este motivo de denúncia',
  modelo: 'o modelo da IA mudou; a triagem está parada',
  'falha-ia': 'a IA falhou ao ler a publicação; nova tentativa mais tarde',
  lotado: 'a lista de bloqueio está cheia',
  exato: 'igual a um caso já decidido'
}
const AI_FALLBACK = 'sem precedente suficiente'
const VERIFIED_MAX = 1000

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const HEX64 = /^[0-9a-f]{64}$/
const NOTE_MAX = 280

const TEXT = {
  title: 'Moderação',
  login: 'Entrar com Google',
  logout: 'Sair',
  quoteLabel: 'Texto enviado por quem denunciou, não conferido.',
  verifiedLabel: 'Publicação lida no semeador',
  verifiedMedia: 'A publicação tem fotos; a IA não vê imagens.',
  verifiedQuote: 'A publicação cita outra; confira no app.',
  aiSuggest: 'Sugestão da IA:',
  aiAbstain: 'A IA não sugeriu nada:',
  byAi: 'pedido pela IA',
  commentLabel: 'Comentário de quem denunciou',
  noteLabel: 'motivo da decisão (opcional)',
  blockWarning: 'O bloqueio vale para a conta inteira, incluindo suas publicações.',
  waiting: 'aguardando assinatura do operador',
  decided: 'Decisão registrada. Ela vale quando a operação assinar e publicar.',
  discarded: 'Denúncia descartada.',
  noOpen: 'Nenhuma denúncia aberta.',
  moreOpen: 'Há mais denúncias depois destas.',
  moreDecided: 'Há mais decisões antes destas.',
  showMore: 'mostrar mais',
  beyondLimit: 'Há decisões mais antigas que o painel não mostra.',
  noDecided: 'Nenhuma decisão ainda.',
  pendingBanner: 'As decisões só valem depois que a associação rodar `varanda mod apply` e publicar a lista.',
  noPending: 'Nenhuma mudança pendente.',
  claimed: 'enviada para assinatura',
  cancelClaimed: 'a operação vai desfazer esta decisão na próxima assinatura',
  publishedTitle: 'última lista confirmada pela operação',
  notPublished: 'A lista publicada ainda não foi confirmada neste painel. A operação precisa rodar mod apply.',
  noBlocked: 'Nenhuma conta bloqueada na lista confirmada.',
  loading: 'carregando…'
}

const TABS = [
  { id: 'abertas', label: 'Abertas' },
  { id: 'pendentes', label: 'Pendentes' },
  { id: 'bloqueadas', label: 'Bloqueadas' },
  { id: 'historico', label: 'Histórico' }
]

function has (obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
}

function str (v) {
  return typeof v === 'string' ? v : ''
}

function reasonLabel (reason) {
  return has(REASON_LABELS, reason) ? REASON_LABELS[reason] : 'motivo desconhecido'
}

// Local time, pt-BR; '' for anything that is not a parseable date string.
function formatDate (iso) {
  if (typeof iso !== 'string') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function shortKey (hex) {
  return typeof hex === 'string' && HEX64.test(hex) ? hex.slice(0, 8) + '…' : '?'
}

// '@nome' when the member linked a username (B1), else the short key.
function who (member, username) {
  return typeof username === 'string' && username !== '' ? '@' + username : shortKey(member)
}

function aiReasonLabel (motivo) {
  return has(AI_REASONS, motivo) ? AI_REASONS[motivo] : AI_FALLBACK
}

// A cosine similarity as '0,93': a comma and two decimals, never a
// percentage (it is not a probability). '' for anything out of [-1, 1].
function formatSimilarity (v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 1) return ''
  return v.toFixed(2).replace('.', ',')
}

// report.ia -> { sugestao, semelhanca, motivo } or null. Anything that is
// not the documented shape is ignored (an old server sends no field at all).
function aiOf (ia) {
  if (ia === null || typeof ia !== 'object' || Array.isArray(ia)) return null
  return {
    sugestao: ia.sugestao === 'bloquear' || ia.sugestao === 'descartar' ? ia.sugestao : null,
    semelhanca: formatSimilarity(ia.semelhanca),
    motivo: typeof ia.motivo === 'string' ? ia.motivo : '',
    sombra: ia.modo === 'sombra'
  }
}

// The one fixed line an open card shows for report.ia.
function aiLine (ai) {
  if (ai.sugestao === null) return TEXT.aiAbstain + ' ' + aiReasonLabel(ai.motivo)
  return TEXT.aiSuggest + ' ' + ai.sugestao +
    (ai.semelhanca !== '' ? ' (semelhança ' + ai.semelhanca + ')' : '') +
    (ai.motivo === 'exato' ? ' · ' + AI_REASONS.exato : '') +
    (ai.sombra || ai.motivo === 'sombra' ? ' · ' + AI_REASONS.sombra : '')
}

// report.publicacao: the post text the server read from the seeder for the
// AI. Used only when it is a plain object with a string texto of at most
// VERIFIED_MAX code points and two boolean flags; anything else -> null.
function verifiedOf (p) {
  if (p === null || typeof p !== 'object' || Object.getPrototypeOf(p) !== Object.prototype) return null
  if (typeof p.texto !== 'string' || Array.from(p.texto).length > VERIFIED_MAX) return null
  if (typeof p.midia !== 'boolean' || typeof p.citacao !== 'boolean') return null
  return { texto: p.texto, midia: p.midia, citacao: p.citacao }
}

// report.actor: who decided. A decided report from an older server has no
// field: it was a person.
function actorOf (r) {
  if (r.actor === 'ia' || r.actor === 'pessoa') return r.actor
  return str(r.status) !== 'aberta' ? 'pessoa' : null
}

// HTTP status -> what the panel does next.
function nextAction (status) {
  if (status === 401) return 'login'
  if (status >= 200 && status < 300) return 'ok'
  return 'error'
}

function person (p) {
  return { member: has(p, 'member') ? str(p.member) : '', username: has(p, 'username') ? str(p.username) : '' }
}

function reportRow (r) {
  if (!has(r, 'id') || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
  const reported = person(r.reported)
  return {
    id: r.id,
    at: str(r.at),
    kind: r.kind === 'account' ? 'account' : 'post',
    seq: Number.isInteger(r.seq) ? r.seq : null,
    quote: str(r.quote),
    reason: str(r.reason),
    text: str(r.text),
    reporter: person(r.reporter),
    reported: { ...reported, linked: has(r.reported, 'linked') ? r.reported.linked !== false : true },
    status: str(r.status),
    decidedAt: str(r.decidedAt),
    note: str(r.note),
    actor: actorOf(r),
    ai: has(r, 'ia') ? aiOf(r.ia) : null,
    verified: has(r, 'publicacao') ? verifiedOf(r.publicacao) : null
  }
}

function reportList (json) {
  const rows = has(json, 'reports') && Array.isArray(json.reports) ? json.reports : []
  return {
    reports: rows.map(reportRow).filter((r) => r !== null),
    truncated: has(json, 'truncated') && json.truncated === true,
    beyondLimit: has(json, 'alemDoLimite') && json.alemDoLimite === true
  }
}

function publishedOf (p) {
  if (!has(p, 'seq') || !Number.isInteger(p.seq)) return null
  return { seq: p.seq, at: str(p.at) }
}

// The answers of api/me, api/reports (aberta and decidida) and api/blocked
// -> one view model. Pending changes are an ordered intent log (plan D6):
// a member's net state is the published membership after its pending
// changes in order.
function buildState ({ me, open, decided, blocked } = {}) {
  const blockedRows = has(blocked, 'blocked') && Array.isArray(blocked.blocked) ? blocked.blocked : []
  const pendingRows = has(blocked, 'pending') && Array.isArray(blocked.pending) ? blocked.pending : []
  const published = publishedOf(has(blocked, 'published') ? blocked.published : null) ||
    publishedOf(has(me, 'published') ? me.published : null)
  const list = []
  for (const b of blockedRows) {
    if (!has(b, 'member') || !HEX64.test(str(b.member))) continue
    list.push({ member: b.member, username: str(b.username) })
  }
  const pending = []
  for (const c of pendingRows) {
    if (!has(c, 'id') || !ID_RE.test(str(c.id))) continue
    if (c.op !== 'block' && c.op !== 'unblock') continue
    if (!HEX64.test(str(c.member))) continue
    pending.push({
      id: c.id,
      op: c.op,
      member: c.member,
      username: str(c.username),
      at: str(c.at),
      claimed: has(c, 'claimedAt') && typeof c.claimedAt === 'string' && c.claimedAt !== '',
      byAi: has(c, 'byAi') && c.byAi === true
    })
  }
  const listed = new Set(list.map((b) => b.member))
  // member -> { listed, blocked (net), changes } for members with pending changes
  const net = new Map()
  for (const c of pending) {
    if (!net.has(c.member)) net.set(c.member, { member: c.member, username: c.username, listed: listed.has(c.member), blocked: listed.has(c.member), changes: [] })
    const n = net.get(c.member)
    n.blocked = c.op === 'block'
    n.changes.push(c)
  }
  return {
    email: has(me, 'email') ? str(me.email) : '',
    published,
    open: reportList(open),
    decided: reportList(decided),
    blocked: list,
    pending,
    net
  }
}

function createPanel (env) {
  const doc = env.document
  let state = null
  let tab = 'abertas'
  let notice = ''
  let error = ''
  let loginError = ''
  let busy = false
  // Decision notes typed but not yet sent, by report id: a render must never
  // lose them (a failed POST keeps the note for the retry).
  const drafts = new Map()
  let gen = 0
  let last = Promise.resolve()

  function root () {
    return doc.getElementById('app')
  }

  // h('p', { className, text, ... }, child, ...): text always goes through
  // textContent; attributes are fixed names chosen here, never from data.
  function h (tag, props, ...children) {
    const node = doc.createElement(tag)
    const p = props || {}
    if (p.className) node.className = p.className
    if (p.text !== undefined) node.textContent = p.text
    if (p.type) node.setAttribute('type', p.type)
    if (p.dir) node.setAttribute('dir', p.dir)
    if (p.pressed !== undefined) node.setAttribute('aria-pressed', p.pressed ? 'true' : 'false')
    if (p.maxLength) node.setAttribute('maxlength', String(p.maxLength))
    if (p.value !== undefined) node.value = p.value
    if (p.onInput) node.addEventListener('input', p.onInput)
    if (p.disabled) node.disabled = true
    if (p.onClick) node.addEventListener('click', p.onClick)
    for (const c of children) if (c) node.appendChild(c)
    return node
  }

  function button (text, onClick, extra) {
    return h('button', { type: 'button', text, onClick, ...(extra || {}) })
  }

  function untrusted (tag, text) {
    return h(tag, { className: 'untrusted', dir: 'auto', text })
  }

  // The post as the seeder holds it (amendment 1), next to the reporter's
  // unverified quote; nothing when the server did not read it.
  function verifiedBlock (v) {
    if (v === null) return null
    return h('div', { className: 'verified' },
      h('p', { className: 'label', text: TEXT.verifiedLabel }),
      untrusted('blockquote', v.texto),
      v.midia ? h('p', { className: 'ai', text: TEXT.verifiedMedia }) : null,
      v.citacao ? h('p', { className: 'ai', text: TEXT.verifiedQuote }) : null
    )
  }

  function mount (...nodes) {
    const main = root()
    main.replaceChildren()
    for (const n of nodes) if (n) main.appendChild(n)
  }

  class LoginRequired extends Error {}

  function apiError (token) {
    const err = new Error(has(API_ERRORS, token) ? API_ERRORS[token] : 'erro no servidor')
    err.token = typeof token === 'string' ? token : ''
    return err
  }

  async function call (method, url, body) {
    const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }
    if (method === 'POST') {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body || {})
    }
    let res
    try {
      res = await env.fetch(url, opts)
    } catch {
      throw apiError('rede')
    }
    const action = nextAction(res.status)
    if (action === 'login') throw new LoginRequired()
    let json = null
    try {
      json = await res.json()
    } catch {}
    // A 429 is the per-session window (mod-routes.js), whatever its token.
    if (action === 'error') throw apiError(res.status === 429 ? 'muitos-pedidos' : has(json, 'error') ? json.error : '')
    return json
  }

  // Every async step goes through here: a 401 anywhere drops the state and
  // shows the login view; other errors are shown as a fixed message.
  function run (fn) {
    const p = last.then(async () => {
      try {
        await fn()
      } catch (err) {
        if (err instanceof LoginRequired) {
          toLogin('')
          return
        }
        error = err && typeof err.message === 'string' ? err.message : 'erro'
        if (state) render()
        else renderMessage(error)
      }
    })
    last = p
    return p
  }

  function toLogin (erro) {
    gen++
    state = null
    notice = ''
    error = ''
    busy = false
    loginError = has(LOGIN_ERRORS, erro) ? LOGIN_ERRORS[erro] : ''
    renderLogin()
  }

  function renderLogin () {
    mount(
      h('h1', { text: TEXT.title }),
      loginError ? h('p', { className: 'error', text: loginError }) : null,
      button(TEXT.login, () => env.location.assign(LOGIN_URL), { className: 'primary' })
    )
  }

  function renderMessage (text) {
    mount(h('h1', { text: TEXT.title }), h('p', { className: 'error', text }))
  }

  async function load () {
    const mine = ++gen
    const me = await call('GET', API + 'me')
    const [open, decided, blocked] = await Promise.all([
      call('GET', API + 'reports?estado=aberta'),
      call('GET', API + 'reports?estado=decidida'),
      call('GET', API + 'blocked')
    ])
    if (mine !== gen) return
    state = buildState({ me, open, decided, blocked })
    const openIds = new Set(state.open.reports.map((r) => r.id))
    for (const id of drafts.keys()) if (!openIds.has(id)) drafts.delete(id)
    render()
  }

  // A mutation: confirm, POST, then refetch everything (the server is the
  // only source of truth; decisions by other moderators show up too).
  function mutate (question, url, body, done, onSent) {
    if (busy) return last
    if (question && !env.confirm(question)) return last
    busy = true
    notice = ''
    error = ''
    render()
    return run(async () => {
      try {
        await call('POST', url, body)
        if (onSent) onSent()
        notice = done
        await load()
      } finally {
        busy = false
        if (state) render()
      }
    })
  }

  function render () {
    if (!state) return
    mount(
      h('div', { className: 'header' },
        h('h1', { text: TEXT.title }),
        h('p', { className: 'email', text: state.email }),
        button(TEXT.logout, logout, { disabled: busy })
      ),
      h('nav', { className: 'tabs' }, ...TABS.map((t) => button(t.label, () => { tab = t.id; notice = ''; error = ''; render() }, { pressed: tab === t.id }))),
      notice ? h('p', { className: 'notice', text: notice }) : null,
      error ? h('p', { className: 'error', text: error }) : null,
      tab === 'abertas'
        ? renderOpen()
        : tab === 'pendentes'
          ? renderPending()
          : tab === 'bloqueadas' ? renderBlocked() : renderHistory()
    )
  }

  function waitingBlock (member) {
    const n = state.net.get(member)
    return n !== undefined && n.blocked && n.changes[n.changes.length - 1].op === 'block'
  }

  function renderOpen () {
    const { reports, truncated } = state.open
    if (reports.length === 0) return h('p', { text: TEXT.noOpen })
    const cards = reports.map((r) => {
      const note = h('textarea', {
        maxLength: NOTE_MAX,
        value: drafts.has(r.id) ? drafts.get(r.id) : '',
        onInput: () => { drafts.set(r.id, str(note.value).slice(0, NOTE_MAX)) }
      })
      const waiting = waitingBlock(r.reported.member)
      const target = who(r.reported.member, r.reported.username) + (r.reported.linked ? '' : ' (sem conta vinculada)')
      const decide = (decision) => {
        drafts.set(r.id, str(note.value).slice(0, NOTE_MAX))
        return mutate(
          decision === 'bloquear'
            ? 'Bloquear ' + target + '? ' + TEXT.blockWarning
            : 'Descartar esta denúncia?',
          API + 'reports/' + encodeURIComponent(r.id) + '/decide',
          { decision, note: str(note.value).slice(0, NOTE_MAX) },
          decision === 'bloquear' ? TEXT.decided : TEXT.discarded,
          () => { drafts.delete(r.id) }
        )
      }
      return h('div', { className: 'card' },
        h('h2', { text: reasonLabel(r.reason) }),
        h('p', { className: 'meta', text: formatDate(r.at) + ' · ' + (r.kind === 'account' ? 'conta' : 'publicação' + (r.seq !== null ? ' nº ' + r.seq : '')) }),
        h('p', { text: 'denunciada: ' + target }),
        r.ai !== null ? h('p', { className: 'ai', text: aiLine(r.ai) }) : null,
        verifiedBlock(r.verified),
        r.quote !== '' ? h('p', { className: 'label', text: TEXT.quoteLabel }) : null,
        r.quote !== '' ? untrusted('blockquote', r.quote) : null,
        r.text !== '' ? h('p', { className: 'label', text: TEXT.commentLabel }) : null,
        r.text !== '' ? untrusted('p', r.text) : null,
        h('p', { className: 'meta', text: 'denunciada por: ' + who(r.reporter.member, r.reporter.username) }),
        h('label', { text: TEXT.noteLabel }, note),
        h('p', { className: 'warning', text: TEXT.blockWarning }),
        waiting ? h('p', { className: 'waiting', text: TEXT.waiting }) : null,
        button('Bloquear', () => decide('bloquear'), { className: 'danger', disabled: busy || waiting }),
        button('Descartar', () => decide('descartar'), { disabled: busy })
      )
    })
    return h('div', { className: 'list' }, ...cards, truncated ? h('p', { className: 'meta', text: TEXT.moreOpen }) : null)
  }

  function renderPending () {
    const banner = h('p', { className: 'banner', text: TEXT.pendingBanner })
    if (state.net.size === 0) return h('div', null, banner, h('p', { text: TEXT.noPending }))
    const cards = []
    for (const n of state.net.values()) {
      const effect = n.blocked === n.listed
        ? 'efeito: nenhum (volta ao estado da lista publicada)'
        : n.blocked ? 'efeito: fica bloqueada' : 'efeito: fica desbloqueada'
      const changes = n.changes.map((c) => h('div', { className: 'change' },
        h('p', { text: (c.op === 'block' ? 'bloquear' : 'desbloquear') + ' · ' + formatDate(c.at) }),
        c.byAi ? h('p', { className: 'ai', text: TEXT.byAi }) : null,
        c.claimed ? h('p', { className: 'waiting', text: TEXT.claimed }) : null,
        button('cancelar', () => mutate(
          c.claimed ? 'Cancelar? ' + TEXT.cancelClaimed + '.' : 'Cancelar esta mudança?',
          API + 'pending/' + encodeURIComponent(c.id) + '/cancel',
          {},
          c.claimed ? 'Cancelamento registrado: ' + TEXT.cancelClaimed + '.' : 'Mudança cancelada.'
        ), { disabled: busy })
      ))
      cards.push(h('div', { className: 'card' },
        h('h2', { text: who(n.member, n.username) }),
        h('p', { text: effect }),
        ...changes
      ))
    }
    return h('div', null, banner, h('div', { className: 'list' }, ...cards))
  }

  function renderBlocked () {
    const head = state.published === null
      ? h('p', { className: 'banner', text: TEXT.notPublished })
      : h('p', { className: 'banner', text: TEXT.publishedTitle + ': nº ' + state.published.seq + (state.published.at ? ' · ' + formatDate(state.published.at) : '') })
    if (state.blocked.length === 0) return h('div', null, head, h('p', { text: TEXT.noBlocked }))
    const cards = state.blocked.map((b) => {
      const n = state.net.get(b.member)
      const leaving = n !== undefined && !n.blocked
      const name = who(b.member, b.username)
      return h('div', { className: 'card' },
        h('h2', { text: name }),
        leaving ? h('p', { className: 'waiting', text: 'desbloqueio ' + TEXT.waiting }) : null,
        button('Desbloquear', () => mutate(
          'Desbloquear ' + name + '?',
          API + 'unblock',
          { member: b.member },
          TEXT.decided
        ), { disabled: busy || leaving })
      )
    })
    return h('div', null, head, h('div', { className: 'list' }, ...cards))
  }

  function renderHistory () {
    const { reports, truncated, beyondLimit } = state.decided
    if (reports.length === 0) return h('p', { text: TEXT.noDecided })
    const cards = reports.map((r) => h('div', { className: 'card' },
      h('h2', { text: r.status === 'descartar' ? 'descartada' : r.status === 'bloquear' ? 'bloquear' : '?' }),
      h('p', { className: 'meta', text: reasonLabel(r.reason) + ' · ' + formatDate(r.decidedAt) + ' · ' + (r.kind === 'account' ? 'conta' : 'publicação') + (r.actor === 'ia' ? ' · pela IA' : ' · por uma pessoa') }),
      h('p', { text: 'denunciada: ' + who(r.reported.member, r.reported.username) }),
      verifiedBlock(r.verified),
      r.note !== '' ? h('p', { className: 'label', text: 'motivo da decisão' }) : null,
      r.note !== '' ? untrusted('p', r.note) : null
    ))
    return h('div', { className: 'list' }, ...cards,
      truncated ? h('p', { className: 'meta', text: TEXT.moreDecided }) : null,
      truncated ? button(TEXT.showMore, showMoreDecided, { disabled: busy }) : null,
      beyondLimit ? h('p', { className: 'meta', text: TEXT.beyondLimit }) : null)
  }

  // The next page of the history, appended to what is shown; the other
  // lists are not read again.
  function showMoreDecided () {
    if (busy) return last
    const mine = gen
    const shown = state.decided.reports
    const cursor = shown[shown.length - 1].id
    busy = true
    error = ''
    render()
    return run(async () => {
      try {
        const page = reportList(await call('GET', API + 'reports?estado=decidida&antes=' + encodeURIComponent(cursor)))
        if (mine !== gen) return
        const seen = new Set(shown.map((r) => r.id))
        state.decided = { ...page, reports: [...shown, ...page.reports.filter((r) => !seen.has(r.id))] }
      } finally {
        busy = false
        if (state) render()
      }
    })
  }

  function logout () {
    if (busy) return last
    return run(async () => {
      try {
        await call('POST', LOGOUT_URL, {})
      } catch (err) {
        if (!(err instanceof LoginRequired)) throw err
      }
      toLogin('')
    })
  }

  function start () {
    const search = str(env.location.search)
    const m = /(?:^|[?&])erro=([a-z-]{1,32})(?:&|$)/.exec(search)
    if (search !== '') env.history.replaceState(null, '', str(env.location.pathname) || '/account/mod/')
    const erro = m ? m[1] : ''
    mount(h('h1', { text: TEXT.title }), h('p', { className: 'meta', text: TEXT.loading }))
    // A page restored from the back/forward cache shows an old queue.
    if (env.onPageShow) env.onPageShow((ev) => { if (ev && ev.persisted && state) run(load) })
    return run(async () => {
      try {
        await load()
      } catch (err) {
        if (err instanceof LoginRequired) {
          toLogin(erro)
          return
        }
        throw err
      }
    })
  }

  return {
    start,
    settled: () => last,
    get state () { return state }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { reasonLabel, aiReasonLabel, formatSimilarity, aiLine, formatDate, buildState, nextAction, shortKey, who, createPanel, REASON_LABELS, LOGIN_ERRORS, AI_REASONS, TEXT }
} else {
  createPanel({
    document,
    fetch: (url, opts) => fetch(url, opts),
    location,
    history,
    confirm: (text) => confirm(text),
    onPageShow: (fn) => globalThis.addEventListener('pageshow', fn)
  }).start()
}
