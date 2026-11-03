// Mensagem: one private conversation, pushed above the tabs (nav.js screen
// 'mensagem', keyed by the peer's diary key). Props: { peer, isTop, onBack,
// onOpenMember(peer), onReport({ dm, id, text, author }) }.
// Oldest message on top, the composer at the bottom, scrolled to the end on
// open and on new messages. The header names the peer from the profile
// cache, never the raw key. Whether the conversation is a request or blocked
// comes from dm.thread itself (docs/rpc.md 5.78), never from a dm.list page;
// until the first answer neither the composer nor the request actions show.
// dm.seen runs only while this screen is the top of the stack and the app is
// visible; it is a local mark, nothing is told to the peer. After every
// dm.set, dm.seen and dm.pull attempt (success or failure) node.bumpDm makes
// the thread, the list and the tab dot read again: dm.changed is only a
// hint. Rows are keyed by sender and id (an id is unique only per sender).
// A send answered uncertain is never resent by itself: it stays held until
// the person taps "Tentar de novo", sends the same text again (both re-put
// the same bytes), discards it, or confirms sending a different text. No
// read, delivered or typing state anywhere; an own message shows only
// LABELS.sent.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_TEXT } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { whoOf } from '../who'
import { countChars } from '../format'
import { LABELS } from '../dm'
import { mergeMessages, newestOf, refreshThread, sendPlan, threadRows } from '../dm-screen'
import { Btn, ErrorText, Soft, colors, errorText, useAction, useNow } from '../ui'
import { DmMessageRow } from '../ui/DmMessageRow'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { EmptyState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'

const UNSURE_SEND = 'não deu para confirmar o envio'
const BLOCKED_SEND = 'você bloqueou esta pessoa'

export function Mensagem ({ peer, isTop = true, onBack, onOpenMember, onReport }) {
  const node = useNode()
  const now = useNow(60000)
  const { request } = node
  const hosted = node.hosted === true
  const status = node.passkey && node.passkey.status ? node.passkey.status : null
  const unlocked = !!(status && status.unlocked === true)
  const ownKey = status ? status.publicKey : null
  const names = useNames()
  const { resolveMany } = names
  useEffect(() => {
    resolveMany([peer])
  }, [peer, resolveMany])
  const nameText = whoOf(names.profileOf(peer)).title

  const [raw, setRaw] = useState([])
  const [next, setNext] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lookup, setLookup] = useState(undefined)
  const [folder, setFolder] = useState(null)
  const [newest, setNewest] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [askNew, setAskNew] = useState(false)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [hold, setHold] = useState(null)
  const [menu, setMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const post = useAction()
  const act = useAction()
  const lastErr = useRef(null)
  const genRef = useRef(0)
  const rawRef = useRef(raw)
  rawRef.current = raw
  const nextRef = useRef(next)
  nextRef.current = next
  // True once an older page is held: a newer read then keeps its cursor.
  const olderRef = useRef(false)
  const listRef = useRef(null)
  const bumpDm = node.bumpDm
  const reread = useCallback(() => { if (typeof bumpDm === 'function') bumpDm() }, [bumpDm])

  const readThread = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const r = await request('dm.thread', { peer })
      if (gen !== genRef.current) return
      const page = Array.isArray(r.messages) ? r.messages : []
      const held = refreshThread(rawRef.current, page)
      if (!held.keepOlder) olderRef.current = false
      rawRef.current = held.messages
      setRaw(held.messages)
      setNewest(newestOf(page))
      if (!olderRef.current) setNext(r.next || null)
      setFolder(r.folder === 'request' ? 'request' : 'inbox')
      setBlocked(r.blocked === true)
      setLoadError('')
    } catch (err) {
      if (gen === genRef.current) setLoadError(errorText(err))
    }
    if (gen === genRef.current) setLoaded(true)
  }, [request, peer])

  const ready = hosted && unlocked

  useEffect(() => {
    if (!ready) return
    readThread()
  }, [ready, readThread, node.dmVersion])

  // Read on mount, on pull to refresh and when the screen comes back while
  // the last answer was a miss (so one miss never leaves the composer off for
  // good), never on every dmVersion bump: a read may be a diary.peek.
  const lookupGen = useRef(0)
  const lookupRef = useRef(lookup)
  lookupRef.current = lookup
  const readLookup = useCallback(() => {
    const gen = ++lookupGen.current
    request('dm.lookup', { member: peer }).then((r) => {
      if (gen === lookupGen.current) setLookup(r && typeof r.box === 'string' ? r.box : null)
    }).catch(() => {})
  }, [request, peer])
  useEffect(() => () => { lookupGen.current++ }, [])
  useEffect(() => {
    if (ready) readLookup()
  }, [ready, readLookup])

  const visible = node.visible !== false
  useEffect(() => {
    if (ready && isTop && visible && lookupRef.current === null) readLookup()
  }, [ready, isTop, visible, readLookup])
  useEffect(() => {
    if (!ready || !loaded || !visible || !isTop || newest === '') return
    // Local mark only; a lost answer may still have marked it, so read again.
    request('dm.seen', { peer }).catch(() => {}).then(reread)
  }, [ready, loaded, visible, isTop, request, peer, reread, newest])

  // The newest line sits at the bottom: show it on open and when a newer one
  // arrives; an older page loaded above leaves the position alone.
  const shownNewest = useRef('')
  useEffect(() => {
    if (!loaded || newest === '' || newest === shownNewest.current) return
    const first = shownNewest.current === ''
    shownNewest.current = newest
    const t = setTimeout(() => {
      const list = listRef.current
      if (list && typeof list.scrollToEnd === 'function') list.scrollToEnd({ animated: !first })
    }, 50)
    return () => clearTimeout(t)
  }, [loaded, newest])

  const decide = async (state) => {
    const r = await act.run(() => request('dm.set', { peer, state }))
    reread()
    if (!r.ok) return
    setMenu(false)
    if (state === 'blocked') setBlocked(true)
    if (state === 'unblocked') setBlocked(false)
    if (state === 'deleted') onBack()
  }

  const send = async (text, quoteId) => {
    setAskNew(false)
    lastErr.current = null
    const r = await post.run(async () => {
      try {
        return await request('dm.send', { to: peer, text, ...(quoteId ? { replyTo: quoteId } : {}) })
      } catch (err) {
        lastErr.current = err
        throw err
      }
    })
    const err = lastErr.current
    if (r.ok) {
      setDraft('')
      setReplyTo(null)
      setHold(null)
    } else if (r.uncertain || (err && err.message === UNSURE_SEND)) {
      setHold({ text, quoteId })
    } else if (err && err.message === BLOCKED_SEND) {
      setBlocked(true)
    }
    reread()
  }

  const onSend = () => {
    const quoteId = replyTo ? replyTo.id : null
    const plan = sendPlan(hold, draft, quoteId)
    if (plan === 'confirm') setAskNew(true)
    else if (plan === 'retry') send(hold.text, hold.quoteId)
    else send(draft, quoteId)
  }

  const refreshAll = async () => {
    setRefreshing(true)
    try { await request('dm.pull', {}) } catch {}
    reread()
    readLookup()
    setRefreshing(false)
  }

  // Lands only while its cursor is still the one shown, so a page that
  // started before another one can neither duplicate nor reorder rows.
  const loadOlder = async () => {
    const cursor = nextRef.current
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await request('dm.thread', { peer, before: cursor })
      if (cursor === nextRef.current) {
        olderRef.current = true
        const merged = mergeMessages(Array.isArray(r.messages) ? r.messages : [], rawRef.current)
        rawRef.current = merged
        setRaw(merged)
        setNext(r.next || null)
      }
    } catch (err) {
      setLoadError(errorText(err))
    }
    setLoadingMore(false)
  }

  const open = onOpenMember ? () => onOpenMember(peer) : undefined
  const topRight = (
    <View style={styles.headerRight}>
      {open ? <Pill label='perfil' onPress={open} /> : null}
      <Pill label='mais' onPress={() => setMenu(true)} accessibilityLabel='opções da conversa' />
    </View>
  )

  if (!hosted || !unlocked) {
    return (
      <View style={styles.root}>
        <TopBar title='Mensagem' onBack={onBack} />
        <EmptyState icon='conversas' title='Mensagens bloqueadas' body='Desbloqueie com a passkey para ler suas mensagens.' />
      </View>
    )
  }

  const rows = threadRows(raw)

  let blockNote = null
  if (blocked) blockNote = LABELS.blockedSend
  else if (peer === ownKey) blockNote = LABELS.selfSend
  else if (lookup === null) blockNote = LABELS.noBox

  const left = MAX_TEXT - countChars(draft)
  const canSend = blockNote === null && node.online !== false && draft.trim() !== '' && left >= 0

  let composer
  if (folder === null) {
    composer = (
      <View style={styles.composer}>
        {loadError ? <ErrorText>{loadError}</ErrorText> : <Skeleton rows={1} />}
      </View>
    )
  } else if (blocked) {
    composer = (
      <View style={styles.composer}>
        <Soft>{LABELS.blockedSend}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.inline}>
          <Pill label={LABELS.unblock} onPress={() => decide('unblocked')} pending={act.pending} />
        </View>
      </View>
    )
  } else if (folder === 'request') {
    composer = (
      <View style={styles.composer}>
        <Soft>{LABELS.requestNote}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <View style={styles.inline}>
          <Pill label={LABELS.accept} filled onPress={() => decide('accepted')} pending={act.pending} />
          <Pill label={LABELS.decline} onPress={() => decide('declined')} pending={act.pending} />
          <Pill label={LABELS.block} danger onPress={() => decide('blocked')} pending={act.pending} />
        </View>
      </View>
    )
  } else {
    composer = (
      <View style={styles.composer}>
        {blockNote ? <Soft>{blockNote}</Soft> : null}
        {replyTo
          ? (
            <View style={styles.replying}>
              <Text style={styles.replyText} numberOfLines={2}>{replyTo.text}</Text>
              <Pill label='limpar' onPress={() => setReplyTo(null)} />
            </View>
            )
          : null}
        {hold
          ? (
            <View style={styles.inline}>
              <Soft>{LABELS.uncertain}</Soft>
              <Pill label='Tentar de novo' onPress={() => send(hold.text, hold.quoteId)} pending={post.pending} />
              <Pill label='descartar' onPress={() => { setHold(null); setAskNew(false) }} />
            </View>
            )
          : <ErrorText>{post.error}</ErrorText>}
        {hold && askNew
          ? (
            <View style={styles.inline}>
              <Soft>A mensagem anterior pode já ter chegado. Enviar este novo texto também?</Soft>
              <Pill label='Enviar o novo' filled onPress={() => send(draft, replyTo ? replyTo.id : null)} pending={post.pending} />
              <Pill label='cancelar' onPress={() => setAskNew(false)} />
            </View>
            )
          : null}
        <View style={styles.composeRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={(t) => { setDraft(t); setAskNew(false) }}
            multiline
            maxLength={MAX_TEXT * 2}
            editable={blockNote === null}
            placeholder='Escreva uma mensagem'
            placeholderTextColor={colors.placeholder}
            accessibilityLabel='mensagem'
          />
          <Btn label='Enviar' onPress={onSend} pending={post.pending} disabled={!canSend} />
        </View>
        {left < 50 ? <Soft>{left} caracteres restantes</Soft> : null}
      </View>
    )
  }

  let empty = null
  if (!loaded) empty = <Skeleton />
  else if (loadError) empty = <View style={styles.pad}><ErrorText>{loadError}</ErrorText></View>
  else empty = <EmptyState icon='conversas' title='Nenhuma mensagem' body='Escreva a primeira.' />

  return (
    <View style={styles.root}>
      <TopBar title={nameText} onBack={onBack} right={topRight} />
      <OfflineNote />
      <RefreshableList
        data={rows}
        listRef={listRef}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => (
          <DmMessageRow
            item={item}
            now={now}
            onReply={() => setReplyTo({ id: item.id, text: item.deleted ? LABELS.deletedQuote : item.text })}
            onReport={typeof onReport === 'function' && !item.mine && !item.deleted ? () => onReport({ dm: true, id: item.id, text: item.rawText, author: item.from }) : undefined}
          />
        )}
        extraData={{ now }}
        ListHeaderComponent={next ? <View style={styles.pad}><Pill label='mensagens anteriores' onPress={loadOlder} pending={loadingMore} /></View> : null}
        ListEmptyComponent={empty}
        onRefresh={refreshAll}
        refreshing={refreshing}
        keepVisiblePosition
      />
      {composer}
      <Sheet open={menu} onClose={() => setMenu(false)} title='Conversa'>
        <View style={styles.sheet}>
          <ErrorText>{act.error}</ErrorText>
          {blocked
            ? <Btn label={LABELS.unblock} onPress={() => decide('unblocked')} pending={act.pending} secondary />
            : <Btn label={LABELS.block} onPress={() => decide('blocked')} pending={act.pending} secondary />}
          {confirmDelete
            ? (
              <View style={styles.sheet}>
                <Soft>Apagar esta conversa só neste aparelho? A outra pessoa continua com a cópia dela.</Soft>
                <Btn label='Apagar' danger onPress={() => decide('deleted')} pending={act.pending} />
                <Btn label='Cancelar' secondary onPress={() => setConfirmDelete(false)} />
              </View>
              )
            : <Btn label={LABELS.delete} danger onPress={() => setConfirmDelete(true)} />}
        </View>
      </Sheet>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pad: { padding: 12, alignItems: 'center', gap: 6 },
  sheet: { padding: 16, gap: 12 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  replying: { flexDirection: 'row', alignItems: 'center', gap: 8, borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 8 },
  replyText: { flex: 1, fontSize: 13, color: colors.soft },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6
  },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.bg
  }
})
