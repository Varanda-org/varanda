// A page's votes on polls and its RSVPs to events: the pure part. The page's
// choices come from its signed 'status' answer (`picked`, keyed
// 'author:seq'); a vote or an RSVP is the page action 'choice'. No I/O here.

const HEX64 = /^[0-9a-f]{64}$/
const PICK_MAX = 3

// 'author:seq' of a post, or null for a key or seq that is not one.
export function pickRef (author, seq) {
  const key = typeof author === 'string' ? author.toLowerCase() : ''
  if (!HEX64.test(key) || !Number.isSafeInteger(seq) || seq < 1) return null
  return key + ':' + seq
}

// The page key when the app acts as a page, else null (the member votes).
export function choicePage (acting) {
  return acting && acting.kind === 'page' && HEX64.test(String(acting.key)) ? acting.key : null
}

// The Map 'author:seq' -> picks of a 'status' answer: each target's distinct
// picks since its last withdrawal, newest first. Keys or picks that are not
// well formed are dropped, and a repeated pick keeps its newest place.
export function pickedFromStatus (data) {
  const out = new Map()
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data.picked : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const ref of Object.keys(raw)) {
    const i = ref.indexOf(':')
    const seq = Number(ref.slice(i + 1))
    if (i !== 64 || pickRef(ref.slice(0, i), seq) !== ref) continue
    const list = raw[ref]
    if (!Array.isArray(list)) continue
    const picks = []
    for (const pick of list) {
      if (Number.isSafeInteger(pick) && pick >= 0 && pick <= PICK_MAX && !picks.includes(pick)) picks.push(pick)
    }
    if (picks.length > 0) out.set(ref, picks)
  }
  return out
}

// The page's pick on `ref` for a poll or event of `count` options: the
// newest pick below `count`, or null for no vote. Readers (polls.js
// livePick) skip a pick the post does not have and keep the one before it,
// and the service cannot know a foreign post's count, so the app folds the
// same way.
export function pickedOf (picked, ref, count) {
  if (!(picked instanceof Map) || ref === null || !Number.isSafeInteger(count) || count < 1) return null
  const list = picked.get(ref)
  if (!Array.isArray(list)) return null
  for (const pick of list) if (pick < count) return pick
  return null
}

// A copy of `picked` with `pick` settled on `ref`: a pick goes first, as the
// service records it, and null withdraws (no history left).
export function withPick (picked, ref, pick) {
  const next = new Map(picked instanceof Map ? picked : [])
  const prior = Array.isArray(next.get(ref)) ? next.get(ref) : []
  if (pick === null) next.delete(ref)
  else next.set(ref, [pick, ...prior.filter((p) => p !== pick)])
  return next
}

// What a tap does after an unknown outcome: the same pick again resends the
// signed bytes of the attempt that was kept; any other tap drops it and
// starts anew. -> 'resend' | 'fresh'
export function tapAfterUncertain (pending, { page, ref, pick }) {
  return pending && pending.page === page && pending.ref === ref && pending.pick === pick &&
    typeof pending.retry === 'function'
    ? 'resend'
    : 'fresh'
}

export const PAGE_VOTE_UNCERTAIN = 'Não deu para confirmar o voto da Página. Toque de novo na mesma opção para reenviar.'
export const PAGE_RSVP_UNCERTAIN = 'Não deu para confirmar a resposta da Página. Toque de novo na mesma opção para reenviar.'

export const PAGE_VOTE_NOTICE = 'O voto da Página fica público no diário dela: quem vê o diário da Página pode ver em quem ela votou.'
export const PAGE_RSVP_NOTICE = 'A resposta da Página fica pública no diário dela: quem vê o diário da Página pode ver se ela vai.'
export const PAGE_PICK_UNREAD = 'Não deu para ler o voto da Página agora. Tente de novo mais tarde.'

// The notice a card shows: the person's text, or the Page's while acting as
// a Page. null stays null (no notice once a pick exists).
export function choiceNotice (page, notice, pageText) {
  if (notice === null) return null
  return page !== null ? pageText : notice
}

// The spoken mark of the own pick on an option or answer.
export function ownMark (page, person) {
  return page !== null ? ', voto da Página' : person
}

// The page refusals a definite (not uncertain) failure names to the person.
const KNOWN_REFUSALS = ['termos-pendentes', 'encerrada', 'pausada', 'sem-permissao', 'limite', 'movida']

// The pt-BR text of a definite page refusal (pageError carries it), else the
// card's generic text. An uncertain failure never gets here.
export function refusalText (err, fallback) {
  if (err && err.uncertain !== true && KNOWN_REFUSALS.includes(err.code) && typeof err.message === 'string' && err.message !== '') return err.message
  return fallback
}
