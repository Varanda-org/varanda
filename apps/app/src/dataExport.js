import rpc from '@varanda/rpc'

export const EXPORT_TEXTS = Object.freeze({
  title: 'Exportar meus dados',
  note: 'Gera um arquivo com o seu diário, o seu perfil, quem você segue e as suas preferências.',
  prepare: 'Preparar arquivo',
  cancel: 'Cancelar',
  save: 'Salvar arquivo',
  share: 'Compartilhar',
  reading: (done, total) => `Lendo… ${done} de ${total}`,
  ready: (records, bytes) => `Pronto: ${records} registros, ${Math.ceil(bytes / 1024)} KB.`,
  saved: 'Arquivo salvo.',
  failed: 'Não foi possível exportar agora.',
  cancelled: 'Exportação cancelada.'
})

export const EXPORT_HELP = Object.freeze({
  title: 'Sobre a exportação',
  paragraphs: Object.freeze([
    'O arquivo contém os registros do seu diário como foram assinados, o seu perfil, quem você segue, as listas de pessoas bloqueadas e silenciadas quando disponíveis e as preferências deste aparelho.',
    'Não inclui chaves secretas, mensagens privadas, grupos, Páginas nem os bytes de fotos e vídeos.',
    'O arquivo é JSON e pode ser aberto em qualquer editor de texto ou navegador.',
    'Ele lista quem você segue, bloqueou e silenciou. Mantenha o arquivo privado.'
  ])
})

const RESULT_KEYS = ['key', 'head', 'follows', 'entries', 'invalid', 'next']
const PARTS = ['head', 'follows', 'diary']
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isKey = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isKeys = (value) => Array.isArray(value) && value.every(isKey)
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

function unexpected () {
  throw new Error('resposta inesperada do nó')
}

function validHead (head) {
  if (!isObject(head)) return false
  const profile = head.profile
  return head.format === rpc.EXPORT_FORMAT && head.version === rpc.EXPORT_VERSION &&
    isKey(head.association) && isCount(head.length) && isCount(head.follows) &&
    typeof head.followsDigest === 'string' && /^[0-9a-f]{8}$/.test(head.followsDigest) &&
    (profile === null || (isObject(profile) && typeof profile.name === 'string' && typeof profile.bio === 'string')) &&
    (head.blocked === null || isKeys(head.blocked)) &&
    (head.muted === null || isKeys(head.muted))
}

function validResult (result) {
  return hasKeys(result, RESULT_KEYS) && isKey(result.key) &&
    (result.head === null || validHead(result.head)) && isKeys(result.follows) &&
    Array.isArray(result.entries) && result.entries.every((item) => isObject(item) && isCount(item.seq) && isObject(item.record)) &&
    Array.isArray(result.invalid) && result.invalid.every((item) => isObject(item) && isCount(item.seq) && typeof item.reason === 'string') &&
    (result.next === null || (hasKeys(result.next, ['part', 'offset', 'until']) &&
      PARTS.includes(result.next.part) && isCount(result.next.offset) && isCount(result.next.until)))
}

function checkNext (next, params, head) {
  if (next === null) return
  const part = params.part || 'head'
  const from = PARTS.indexOf(part)
  const to = PARTS.indexOf(next.part)
  if (next.until !== head.length || to < from || to === 0) unexpected()
  if (to === from ? next.offset <= params.offset : next.offset !== 0) unexpected()
}

export async function collectExport ({ request, prefs, now = Date.now, onProgress, cancelled }) {
  let params = {}
  let head
  let key
  const follows = new Set()
  const entries = []
  const invalid = []
  do {
    if (cancelled && cancelled()) return { ok: false, reason: 'cancelled' }
    const result = await request('export.read', params)
    if (cancelled && cancelled()) return { ok: false, reason: 'cancelled' }
    if (!validResult(result)) unexpected()
    if (!head) {
      if (!result.head) unexpected()
      head = result.head
      key = result.key
    } else if (result.key !== key || result.head !== null) unexpected()
    checkNext(result.next, params, head)
    for (const follow of result.follows) follows.add(follow)
    entries.push(...result.entries)
    invalid.push(...result.invalid)
    if (params.part === 'diary' && onProgress) onProgress({ done: entries.length + invalid.length, total: head.length })
    params = result.next
  } while (params !== null)
  // Offset paging over a list that changed between pages can skip or repeat
  // keys, even with the same count; the head's digest of the set tells.
  if (follows.size !== head.follows || rpc.followsDigest([...follows]) !== head.followsDigest) unexpected()

  const preferences = rpc.exportPreferences(prefs, head)
  const ms = now()
  const text = rpc.buildExport({ key, head, follows: [...follows], entries, invalid, preferences, exportedAt: new Date(ms).toISOString() })
  return { ok: true, name: rpc.exportFileName(key, ms), text, records: entries.length, bytes: rpc.utf8ByteLength(text) }
}
