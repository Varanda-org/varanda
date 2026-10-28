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
  defasado: 'a lista mudou, recarregue o painel e tente de novo',
  // api/stats for a moderator who is not a stats admin (api/me hides the
  // tab then, so this is a stale page or a revoked grant).
  'nao-autorizado': 'sem acesso às estatísticas'
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
  loading: 'carregando…',
  none: '—',
  statsNow: 'Agora',
  statsMembers: 'Membros vinculados',
  statsOf: ' de ',
  statsAdmitted: 'Diários no semeador',
  statsActiveDay: 'Ativos hoje (dia de Brasília)',
  statsActiveWeek: 'Ativos nos últimos 7 dias',
  statsConnections: 'Conexões abertas',
  statsTopicPosts: 'Publicações indexadas',
  statsStorage: 'Armazenamento',
  statsActiveNote: 'Ativos: diários cujo tamanho cresceu no dia (horário de Brasília), contados só na memória do semeador; zeram quando ele reinicia.',
  statsRestarted: 'O semeador reiniciou há menos de 7 dias: os ativos ainda estão parciais.',
  statsNoSeeder: 'O semeador não respondeu: só os números do serviço de conta.',
  statsWeeks: 'Cadastros por semana',
  statsWeekOf: 'semana de ',
  statsMonths: 'Cadastros por mês',
  statsTotalOpen: ' (total ',
  statsTotalClose: ')',
  statsDays: 'Últimos 30 dias',
  statsColDay: 'Dia',
  statsColMembers: 'Membros',
  statsColActiveDay: 'Ativos no dia',
  statsColActiveWeek: 'Ativos 7 dias',
  statsColAdmitted: 'Diários',
  statsNoHistory: 'Histórico indisponível (usage.json inválido): avise a operação.',
  statsHistoryStarts: 'O histórico diário começa hoje.',
  statsPrivacy: 'Só contagens: nenhuma chave, e-mail ou @nome.',
  statsRefresh: 'Atualizar'
}

const TABS = [
  { id: 'abertas', label: 'Abertas' },
  { id: 'pendentes', label: 'Pendentes' },
  { id: 'bloqueadas', label: 'Bloqueadas' },
  { id: 'historico', label: 'Histórico' }
]
// Shown only when api/me says `stats: true` (a stats admin): the tab list
// stays the four moderation tabs for everyone else.
const STATS_TAB = { id: 'estatisticas', label: 'Estatísticas' }

// Usage statistics (api/stats). Counts only; every field is re-validated
// here because the panel renders nothing it did not shape itself.
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const MONTH_RE = /^[0-9]{4}-[0-9]{2}$/
const SIGNUP_ROWS = 24
const HISTORY_ROWS = 400
const TABLE_DAYS = 30
const WEEK_SECONDS = 604800
const SEEDER_FIELDS = ['uptimeSeconds', 'admitted', 'activeDay', 'activeWeek', 'blocks', 'bytes', 'mediaBytes', 'topicPosts', 'connections', 'external']
const HISTORY_FIELDS = ['members', 'admitted', 'activeDay', 'activeWeek', 'blocks', 'bytes', 'mediaBytes', 'topicPosts', 'connections', 'external']
// Fixed pt-BR month abbreviations, not the locale API: the output is the same in
// every browser and under Node.
const MONTHS = ['jan.', 'fev.', 'mar.', 'abr.', 'maio', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.']
const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB']

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

// A count is a non-negative safe integer; anything else (a float, a string
// digit, a negative) is null and renders as a dash, never as a guess.
function countOf (v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null
}

function plainObject (v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
}

function rowsOf (v) {
  return Array.isArray(v) ? v : []
}

// A real calendar day: the shape alone would accept 2026-02-30 or
// 9999-99-99, so the date must round-trip through Date unchanged (the Z
// midnight is only a parsing anchor here, never shown).
function validDay (day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false
  const d = new Date(day + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day
}

// 'YYYY-MM' with a month 01..12.
function validMonth (month) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) return false
  const m = Number(month.slice(5, 7))
  return m >= 1 && m <= 12
}

// api/stats -> the stats view model. Rows whose day/week/month key is not
// the exact date shape are dropped (the key is rendered as text, but a
// bad key means a bad row). Lists are capped so a broken server cannot
// make the page build thousands of nodes.
function statsOf (json) {
  const members = has(json, 'members') && plainObject(json.members) ? json.members : {}
  const max = Number.isSafeInteger(members.max) && members.max > 0 ? members.max : null
  let seeder = null
  if (has(json, 'seeder') && plainObject(json.seeder)) {
    seeder = { at: str(json.seeder.at) }
    for (const k of SEEDER_FIELDS) seeder[k] = countOf(json.seeder[k])
  }
  const signups = has(json, 'signups') && plainObject(json.signups) ? json.signups : {}
  const weeks = rowsOf(signups.weeks)
    .filter((w) => plainObject(w) && validDay(w.start))
    .map((w) => ({ start: w.start, count: countOf(w.count) }))
    .slice(-SIGNUP_ROWS)
  const months = rowsOf(signups.months)
    .filter((m) => plainObject(m) && validMonth(m.month))
    .map((m) => ({ month: m.month, count: countOf(m.count), total: countOf(m.total) }))
    .slice(-SIGNUP_ROWS)
  let history = null
  if (has(json, 'history') && Array.isArray(json.history)) {
    // Oldest first, as the server sends it: keep the newest rows.
    history = json.history
      .filter((r) => plainObject(r) && validDay(r.day))
      .map((r) => {
        const row = { day: r.day }
        for (const k of HISTORY_FIELDS) row[k] = countOf(r[k])
        return row
      })
      .slice(-HISTORY_ROWS)
    // Rows were sent but none was usable: that is a broken usage.json, not
    // a history that starts today.
    if (history.length === 0 && json.history.length > 0) history = null
  }
  return {
    at: has(json, 'at') ? str(json.at) : '',
    members: { total: countOf(members.total), max },
    seeder,
    signups: { weeks, months },
    history
  }
}

// 1234567 -> '1.234.567' (pt-BR grouping, built by hand, locale-free).
function formatCount (n) {
  if (countOf(n) === null) return TEXT.none
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// Base 1024, one decimal with a comma: 1536 -> '1,5 KB'.
function formatBytes (n) {
  if (countOf(n) === null) return TEXT.none
  if (n < 1024) return n + ' B'
  let v = n / 1024
  let i = 0
  // Step up while the rounded value would print as 1024,0 or more.
  while (i < BYTE_UNITS.length - 1 && Math.round(v * 10) / 10 >= 1024) {
    v /= 1024
    i++
  }
  return v.toFixed(1).replace('.', ',') + ' ' + BYTE_UNITS[i]
}

// '2026-10-26' -> '26/10/2026'; a dash for anything else.
function formatDay (day) {
  if (!validDay(day)) return TEXT.none
  return day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4)
}

// '2026-10' -> 'out. 2026'; a dash for anything else.
function formatMonth (month) {
  if (!validMonth(month)) return TEXT.none
  const i = Number(month.slice(5, 7)) - 1
  return MONTHS[i] + ' ' + month.slice(0, 4)
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
    // Only an explicit `stats: true` opens the Estatísticas tab.
    stats: has(me, 'stats') && me.stats === true,
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
  // The api/stats answer, fetched lazily on the first visit to the tab and
  // kept apart from state: load() (and so every mutation) never refetches it.
  let statsData = null
  // True only while a GET api/stats is in flight. It is NOT the global busy:
  // a slow read must never disable Sair or a decision. statsLast is that
  // GET's promise (settled() waits for it); session changes only on
  // toLogin, so an answer from a previous login is dropped.
  let statsLoading = false
  // The last stats failure, shown only inside the Estatísticas view: a
  // background read must never paint over another tab or replace a
  // decision's error line.
  let statsError = ''
  let statsLast = Promise.resolve()
  let session = 0
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
    // <meter> bounds and reading. `amount` is the value attribute: the
    // `value` prop above sets the property, which is for textareas.
    if (p.min !== undefined) node.setAttribute('min', String(p.min))
    if (p.max !== undefined) node.setAttribute('max', String(p.max))
    if (p.amount !== undefined) node.setAttribute('value', String(p.amount))
    if (p.label !== undefined) node.setAttribute('aria-label', p.label)
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
      // The stats GET runs beside this queue and may have gone to the login
      // view (a 401) while this step was in flight: then a later failure of
      // this step must not paint over the login screen.
      const mine = session
      try {
        await fn()
      } catch (err) {
        if (mine !== session) return
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
    session++
    statsData = null
    statsLoading = false
    statsError = ''
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
      const mine = session
      try {
        await call('POST', url, body)
        // Logged out meanwhile (a 401 on the stats GET): do not reload the
        // queue behind the login screen.
        if (mine !== session) return
        if (onSent) onSent()
        notice = done
        await load()
      } finally {
        busy = false
        if (state) render()
      }
    })
  }

  // The stats GET. It runs beside the run() queue, not in it: call() has no
  // timeout, and a slow read must not hold a decision POST behind it. It
  // mirrors run()'s handling: a 401 goes to login, anything else shows the
  // fixed API_ERRORS line (a 403 is 'sem acesso às estatísticas'), but in
  // statsError, never the shared error. A click while one is in flight
  // returns the same promise: one request at a time.
  function loadStats () {
    if (statsLoading) return statsLast
    const mine = session
    statsLoading = true
    statsError = ''
    renderIfStats()
    statsLast = (async () => {
      try {
        const json = await call('GET', API + 'stats')
        if (mine === session) statsData = statsOf(json)
      } catch (err) {
        if (mine !== session) return
        if (err instanceof LoginRequired) {
          toLogin('')
          return
        }
        statsError = err && typeof err.message === 'string' ? err.message : 'erro'
      } finally {
        if (mine === session) {
          statsLoading = false
          renderIfStats()
        }
      }
    })()
    return statsLast
  }

  // Only the Estatísticas view shows stats: on any other tab the answer is
  // just stored, so a remount never steals the caret from a note being typed.
  function renderIfStats () {
    if (state && tab === STATS_TAB.id) render()
  }

  function selectTab (id) {
    tab = id
    notice = ''
    error = ''
    render()
    if (id === STATS_TAB.id && statsData === null) loadStats()
  }

  function render () {
    if (!state) return
    // A tab id left over from a session that had stats access falls back.
    if (tab === STATS_TAB.id && !state.stats) tab = 'abertas'
    const tabs = [...TABS, ...(state.stats ? [STATS_TAB] : [])]
    mount(
      h('div', { className: 'header' },
        h('h1', { text: TEXT.title }),
        h('p', { className: 'email', text: state.email }),
        button(TEXT.logout, logout, { disabled: busy })
      ),
      h('nav', { className: 'tabs' }, ...tabs.map((t) => button(t.label, () => selectTab(t.id), { pressed: tab === t.id }))),
      notice ? h('p', { className: 'notice', text: notice }) : null,
      error ? h('p', { className: 'error', text: error }) : null,
      tab === 'abertas'
        ? renderOpen()
        : tab === 'pendentes'
          ? renderPending()
          : tab === 'bloqueadas'
            ? renderBlocked()
            : tab === STATS_TAB.id ? renderStats() : renderHistory()
    )
  }

  function figure (label, text) {
    return [h('dt', { text: label }), h('dd', { text })]
  }

  // One labelled <meter> row per signup bucket; the peak bucket fills it.
  function bars (rows, labelOf, textOf) {
    const peak = Math.max(1, ...rows.map((r) => r.count ?? 0))
    return rows.map((r) => {
      const label = labelOf(r)
      return h('div', { className: 'bar' },
        h('span', { text: label }),
        h('meter', { min: 0, max: peak, amount: r.count ?? 0, label }),
        h('span', { text: textOf(r) })
      )
    })
  }

  function renderStats () {
    const refresh = button(TEXT.statsRefresh, loadStats, { disabled: statsLoading })
    const failed = statsError ? h('p', { className: 'error', text: statsError }) : null
    if (statsData === null) {
      // A failed first GET: say why and offer the retry instead of a
      // 'carregando…' that would never end.
      return statsLoading ? h('p', { className: 'meta', text: TEXT.loading }) : h('div', { className: 'stats' }, failed, refresh)
    }
    const { members, seeder, signups, history } = statsData
    const s = seeder || {}
    const storage = countOf(s.bytes) !== null && countOf(s.mediaBytes) !== null
      ? formatBytes(s.bytes + s.mediaBytes)
      : TEXT.none
    const figures = h('dl', { className: 'figures' },
      ...figure(TEXT.statsMembers, formatCount(members.total) + (members.max !== null ? TEXT.statsOf + formatCount(members.max) : '')),
      ...figure(TEXT.statsAdmitted, formatCount(s.admitted)),
      ...figure(TEXT.statsActiveDay, formatCount(s.activeDay)),
      ...figure(TEXT.statsActiveWeek, formatCount(s.activeWeek)),
      ...figure(TEXT.statsConnections, formatCount(s.connections)),
      ...figure(TEXT.statsTopicPosts, formatCount(s.topicPosts)),
      ...figure(TEXT.statsStorage, storage)
    )
    let days
    if (history === null) {
      days = h('p', { className: 'banner', text: TEXT.statsNoHistory })
    } else if (history.length === 0) {
      days = h('p', { className: 'meta', text: TEXT.statsHistoryStarts })
    } else {
      const head = [TEXT.statsColDay, TEXT.statsColMembers, TEXT.statsColActiveDay, TEXT.statsColActiveWeek, TEXT.statsColAdmitted]
      const rows = history.slice(-TABLE_DAYS).reverse().map((r) => h('tr', null,
        h('td', { text: formatDay(r.day) }),
        h('td', { text: formatCount(r.members) }),
        h('td', { text: formatCount(r.activeDay) }),
        h('td', { text: formatCount(r.activeWeek) }),
        h('td', { text: formatCount(r.admitted) })
      ))
      days = h('table', { className: 'days' },
        h('thead', null, h('tr', null, ...head.map((t) => h('th', { text: t })))),
        h('tbody', null, ...rows)
      )
    }
    return h('div', { className: 'stats' },
      h('h2', { text: TEXT.statsNow }),
      figures,
      h('p', { className: 'meta', text: TEXT.statsActiveNote }),
      seeder !== null && countOf(seeder.uptimeSeconds) !== null && seeder.uptimeSeconds < WEEK_SECONDS
        ? h('p', { className: 'meta', text: TEXT.statsRestarted })
        : null,
      seeder === null ? h('p', { className: 'meta', text: TEXT.statsNoSeeder }) : null,
      h('h2', { text: TEXT.statsWeeks }),
      ...bars(signups.weeks, (w) => TEXT.statsWeekOf + formatDay(w.start).slice(0, 5), (w) => formatCount(w.count)),
      h('h2', { text: TEXT.statsMonths }),
      ...bars(signups.months, (m) => formatMonth(m.month), (m) => formatCount(m.count) + TEXT.statsTotalOpen + formatCount(m.total) + TEXT.statsTotalClose),
      h('h2', { text: TEXT.statsDays }),
      days,
      h('p', { className: 'meta', text: TEXT.statsPrivacy }),
      // A failed refresh keeps the last good numbers above and says so here.
      failed,
      refresh
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
    // Both queues: the run() chain and the stats GET beside it.
    settled: async () => {
      await last
      await statsLast
      await last
    },
    get state () { return state }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { reasonLabel, aiReasonLabel, formatSimilarity, aiLine, formatDate, buildState, nextAction, shortKey, who, statsOf, formatCount, formatBytes, formatDay, formatMonth, createPanel, REASON_LABELS, LOGIN_ERRORS, AI_REASONS, TEXT }
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
