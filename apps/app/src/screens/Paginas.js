// Páginas: the pages the member owns or administers, the invites to be an
// administrator and the offers to take a page over, plus 'Nova página'. The
// list is the signed 'list' read of the account service (pages.js); accepting
// signs the record through the node (page.sign) and is never resent: an
// uncertain answer only shows the 'incerto' sentence and the list is read
// again. The service has no decline route, so 'Recusar' hides the row on this
// screen until it is opened again; the invite or offer simply runs out.
//
// Props: { active, onBack, onNewPage(), onOpenPage(key, row), onChanged() }.
// Product UI is gated on pagesOn. A closed or moved page is a greyed row with
// no action: there is nothing left to run on that key.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { UNNAMED, whoOf } from '../who'
import { fetchMember } from '../indexClient'
import { planPeeks } from '../thread'
import { learnPeeked, peekAll, refOf } from './Conversa'
import { actAs } from '../pages'
import { acceptOp, transferAcceptOp } from '../pageRoster'
import { pagesCore, pagesOn } from '../pageGate'
import { ACTOR_NOTE, coreActor } from '../pageCore'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { ErrorText, Page, SectionHeader, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { EmptyState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { fonts, type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const EMPTY_LIST = Object.freeze({ owned: [], admin: [], invites: [], offers: [] })
const SOON = 'Disponível em breve.'
const LOCKED = 'Desbloqueie a conta para ver suas páginas.'
const INVITE_TEXT = 'convidou você para administrar'
const OFFER_TEXT = 'quer passar a página para você'

const NEUTRAL = 'página'
const TRY_AGAIN = 'Tente de novo em instantes'
const KINDS = Object.freeze({ owned: 'sua página', admin: 'você administra', invite: 'convite', offer: 'oferta' })
const KEY_RE = /^[0-9a-f]{64}$/

const MAX_PEEKS = 3

// The key the page screens act as: the passkey's on the hosted node; on a
// core node its delegate, registered and past the Terms (pageCore.js) on the
// first use. `retry` asks again after a failure.
export function usePageMember (node) {
  const passkey = node.passkey
  const core = pagesCore({ hosted: node.hosted, accountOrigin: node.accountOrigin })
  const unlocked = !!passkey && !!passkey.status && passkey.status.unlocked === true
  const own = unlocked && typeof passkey.status.publicKey === 'string' ? passkey.status.publicKey : null
  const [state, setState] = useState({ id: null, actor: null, error: '' })
  const [tick, setTick] = useState(0)
  const id = core ? node.accountOrigin + '|' + String(node.epoch) + '|' + tick : null
  const nodeRef = useRef(node)
  nodeRef.current = node
  useEffect(() => {
    if (id === null) return undefined
    let alive = true
    coreActor(nodeRef.current).then(
      (r) => { if (alive) setState({ id, actor: r.actor, error: '' }) },
      (err) => { if (alive) setState({ id, actor: null, error: errorText(err) }) }
    )
    return () => { alive = false }
  }, [id])
  if (!core) return { core: false, member: own, actor: null, error: '', retry: null }
  const mine = state.id === id
  return {
    core: true,
    member: mine ? state.actor : null,
    actor: mine ? state.actor : null,
    error: mine ? state.error : '',
    pending: !mine,
    retry: () => setTick((n) => n + 1)
  }
}

// The delegate key, copyable: invites to administer a page name it.
export function ActorKey ({ actor }) {
  const styles = useStyles(makeStyles)
  const [note, setNote] = useState('')
  if (typeof actor !== 'string' || !KEY_RE.test(actor)) return null
  const copy = async () => setNote((await copyText(shareNav(), actor)) ? 'chave copiada' : 'não foi possível copiar: selecione a chave acima')
  return (
    <View style={styles.actor}>
      <Text style={styles.key} selectable>{actor}</Text>
      <Soft>{'Chave da sua conta nas páginas: ' + ACTOR_NOTE + '.'}</Soft>
      <Pill label='Copiar chave' onPress={copy} />
      {note ? <Soft>{note}</Soft> : null}
    </View>
  )
}

const rows = (v) => (Array.isArray(v) ? v : [])
const isMoved = (p) => p.moved === true || (p.movedTo !== undefined && p.movedTo !== null && p.movedTo !== false)
const endedNote = (p) => (p.closed === true ? 'encerrada' : isMoved(p) ? 'mudou de chave' : null)

// An unnamed page is never 'sem nome' (rows would look alike) and never a
// key: a neutral label plus what the row is. A page is not the own key and
// this screen knows no follows (invites and offers come from any page), so
// its photo is never kept on disk.
function PageRow ({ pageKey, profile, kind, note, ended = false, onOpen, children }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const who = whoOf(profile)
  const unnamed = who.title === UNNAMED
  const title = unnamed ? NEUTRAL : displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const line = [unnamed ? kind : null, note].filter(Boolean).join(' · ')
  return (
    <View style={[styles.row, ended && styles.ended]}>
      <Pressable
        style={({ pressed }) => [styles.open, pressed && onOpen && styles.pressed]}
        accessibilityRole={onOpen ? 'link' : undefined}
        accessibilityLabel={onOpen ? 'abrir ' + title : undefined}
        disabled={!onOpen}
        onPress={onOpen}
      >
        <Avatar name={who.avatarName} publicKey={pageKey} size={44} picture={(profile || {}).avatar} persist={false} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
          {line ? <Text style={styles.note}>{line}</Text> : null}
        </View>
        {onOpen ? <Icon name='seta' size={20} color={colors.soft} /> : null}
      </Pressable>
      {children}
    </View>
  )
}

export default function Paginas ({ active = true, onBack, onNewPage, onOpenPage, onChanged }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const { profileOf, resolveMany, learnMany } = names
  const who = usePageMember(node)
  const member = who.member
  const retryMember = who.retry
  const hosted = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })
  const [list, setList] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [dismissed, setDismissed] = useState(() => new Set())
  // The row whose button is running: only that row shows 'Aceitar…'.
  const [busy, setBusy] = useState(null)
  const act = useAction()
  const seqRef = useRef(0)
  // Keys whose peek succeeded, keys being peeked, and tries per key: a
  // failed or cancelled peek is tried again, at most MAX_PEEKS times.
  const peekedRef = useRef(new Set())
  const peekingRef = useRef(new Set())
  const triesRef = useRef(new Map())

  const load = useCallback(async () => {
    if (!hosted || member === null) return
    const seq = ++seqRef.current
    setLoadError('')
    try {
      const data = await actAs(node, { member, action: 'list', page: '', op: {} })
      if (seq !== seqRef.current) return
      const next = {
        owned: rows(data.owned),
        admin: rows(data.admin),
        invites: rows(data.invites),
        offers: rows(data.offers)
      }
      setList(next)
      resolveMany([...next.owned, ...next.admin, ...next.invites, ...next.offers].map((r) => r.page))
    } catch (err) {
      if (seq === seqRef.current) setLoadError(errorText(err))
    }
  }, [hosted, member, node, resolveMany])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  useEffect(() => () => { seqRef.current += 1 }, [])

  // Keys the names cache could not name (a page this device does not hold)
  // are peeked once, the way Membro opens a diary it does not hold; the
  // verified name and @nome go into the names cache.
  useEffect(() => {
    if (list === null) return undefined
    const missing = []
    for (const r of [...list.owned, ...list.admin, ...list.invites, ...list.offers]) {
      const key = r.page
      if (typeof key !== 'string' || !KEY_RE.test(key) || peekedRef.current.has(key) || peekingRef.current.has(key) || missing.includes(key)) continue
      if ((triesRef.current.get(key) || 0) >= MAX_PEEKS) continue
      const p = profileOf(key)
      if (p === undefined) continue // the cache is still asking
      if (whoOf(p).title === UNNAMED) missing.push(key)
    }
    if (missing.length === 0) return undefined
    let alive = true
    const peek = async () => {
      for (const key of missing.slice(0, 8)) {
        if (!alive) return
        peekingRef.current.add(key)
        try {
          const res = await fetchMember(key)
          if (!alive) continue
          triesRef.current.set(key, (triesRef.current.get(key) || 0) + 1)
          if (!res.ok) continue
          const { profileSeq, usernameSeq } = res.value
          const seqs = [...new Set([profileSeq, usernameSeq].filter((n) => Number.isSafeInteger(n) && n >= 1))]
          // Nothing to peek is an answer too: asking again would say the same.
          if (seqs.length === 0) { peekedRef.current.add(key); continue }
          const peeked = new Map()
          await peekAll(node.request, planPeeks({ refs: seqs.map((n) => refOf(key, n)), authors: { [key]: { profileSeq, usernameSeq } } }), peeked, () => alive)
          if (!alive) continue
          learnPeeked(learnMany, peeked)
          if (peeked.has(key)) peekedRef.current.add(key)
        } catch {
        } finally {
          peekingRef.current.delete(key)
        }
      }
    }
    peek()
    return () => { alive = false }
  }, [list, profileOf, learnMany, node])

  const dismiss = (id) => setDismissed((prev) => new Set(prev).add(id))

  // Success, failure or an uncertain answer: the list is read again.
  const accept = async (id, run) => {
    setBusy(id)
    try {
      const r = await act.run(run)
      if (r.ok && typeof onChanged === 'function') onChanged()
      await load()
    } finally {
      setBusy(null)
    }
  }

  const acceptInvite = (inv) => accept('i:' + inv.page, () => actAs(node, {
    member,
    action: 'accept',
    page: inv.page,
    op: ({ nonce }) => acceptOp(inv, { nonce })
  }))

  const acceptOffer = (offer) => accept('o:' + offer.page, async () => {
    const read = await node.request('page.read', { key: offer.page })
    if (!read || read.complete !== true) throw new Error(TRY_AGAIN)
    return actAs(node, {
      member,
      action: 'transfer-accept',
      page: offer.page,
      op: ({ nonce }) => transferAcceptOp(read, member, { nonce })
    })
  })

  const data = list || EMPTY_LIST
  const invites = data.invites.filter((r) => !dismissed.has('i:' + r.page))
  const offers = data.offers.filter((r) => !dismissed.has('o:' + r.page))
  const empty = list !== null && data.owned.length === 0 && data.admin.length === 0 && invites.length === 0 && offers.length === 0

  let body
  if (!hosted) body = <Soft>{SOON}</Soft>
  else if (who.core && member === null) {
    body = who.error
      ? <><ErrorText>{who.error}</ErrorText><Pill label='Tentar de novo' onPress={retryMember} /></>
      : <Skeleton rows={2} />
  } else if (member === null) body = <Soft>{LOCKED}</Soft>
  else if (list === null) body = loadError ? <ErrorText>{loadError}</ErrorText> : <Skeleton rows={2} />
  else {
    body = (
      <>
        {who.core ? <ActorKey actor={who.actor} /> : null}
        <ErrorText>{loadError}</ErrorText>
        <ErrorText>{act.error}</ErrorText>
        {invites.length > 0
          ? (
            <>
              <SectionHeader>Convites</SectionHeader>
              {invites.map((inv) => (
                <PageRow key={'i' + inv.page} pageKey={inv.page} profile={profileOf(inv.page)} kind={KINDS.invite} note={INVITE_TEXT}>
                  <View style={styles.actions}>
                    <Pill label='Aceitar' filled onPress={() => acceptInvite(inv)} pending={busy === 'i:' + inv.page} disabled={busy !== null} />
                    <Pill label='Recusar' onPress={() => dismiss('i:' + inv.page)} disabled={busy !== null} />
                  </View>
                </PageRow>
              ))}
            </>
            )
          : null}
        {offers.length > 0
          ? (
            <>
              <SectionHeader>Ofertas de transferência</SectionHeader>
              {offers.map((offer) => (
                <PageRow key={'o' + offer.page} pageKey={offer.page} profile={profileOf(offer.page)} kind={KINDS.offer} note={OFFER_TEXT}>
                  <View style={styles.actions}>
                    <Pill label='Aceitar' filled onPress={() => acceptOffer(offer)} pending={busy === 'o:' + offer.page} disabled={busy !== null} />
                    <Pill label='Recusar' onPress={() => dismiss('o:' + offer.page)} disabled={busy !== null} />
                  </View>
                </PageRow>
              ))}
            </>
            )
          : null}
        {data.owned.length > 0
          ? (
            <>
              <SectionHeader>Suas páginas</SectionHeader>
              {data.owned.map((p) => (
                <PageRow key={'p' + p.page} pageKey={p.page} profile={profileOf(p.page)} kind={KINDS.owned} note={endedNote(p)} ended={endedNote(p) !== null} onOpen={endedNote(p) === null && typeof onOpenPage === 'function' ? () => onOpenPage(p.page, p) : undefined} />
              ))}
            </>
            )
          : null}
        {data.admin.length > 0
          ? (
            <>
              <SectionHeader>Páginas que você administra</SectionHeader>
              {data.admin.map((p) => (
                <PageRow key={'a' + p.page} pageKey={p.page} profile={profileOf(p.page)} kind={KINDS.admin} note={endedNote(p)} ended={endedNote(p) !== null} onOpen={endedNote(p) === null && typeof onOpenPage === 'function' ? () => onOpenPage(p.page, p) : undefined} />
              ))}
            </>
            )
          : null}
        {empty ? <EmptyState icon='user' title='Nenhuma página ainda' body='Crie uma página para o seu negócio ou projeto.' /> : null}
      </>
    )
  }

  return (
    <View style={styles.flex}>
      <TopBar title='Páginas' onBack={onBack} right={hosted && member !== null && list !== null ? { icon: 'plus', label: 'Nova página', onPress: onNewPage } : undefined} />
      <Page>{body}</Page>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  row: { gap: 10, paddingVertical: 8 },
  open: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.6 },
  ended: { opacity: 0.5 },
  who: { flex: 1 },
  name: { ...type.postName, color: colors.ink },
  handle: { fontSize: 14, color: colors.soft },
  note: { fontSize: 14, color: colors.soft },
  actions: { flexDirection: 'row', gap: 8, paddingLeft: 56 },
  actor: { gap: 6, paddingVertical: 8 },
  key: { fontFamily: fonts.mono, fontSize: 13, color: colors.ink }
})
