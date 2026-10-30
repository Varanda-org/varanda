// Diário: the person's own profile header (sunset band, avatar, name and
// @nome from profile.read, bio, follow count) over the own log (log.read), newest first, paged backwards with
// infinite scroll and pull to refresh. On the hosted web, 'Compartilhar'
// under the profile data opens a sheet with the link (copiar link /
// compartilhar; the /m/<key> form is never printed). Only publications are
// listed (PostRows): technical records and invalid blocks are not shown. Posts still in the
// outbox ('Aguardando envio', browser node) are listed above them; they are
// not PostRows (no reply, no publication date yet). The public key is shown
// only in Ajustes > Avançado. A queued item this page session did not write waits for the person
// ('enviar'). The 'ver novidades' pill (web only) follows the own-synced line
// growing, i.e. another device published; the native node has no such
// signal, so on native only the pull, the tab and the refresh prop reload.
// Own posts carry the action bar (counts on the hosted web; liking and
// reposting the own posts is allowed), quotes show the quoted post, and the
// own reposts still on show the original under 'Você republicou' (only the
// newest repost record per target counts; likes are not listed). Originals,
// counts and the own state come from A Rua's useSocial.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LOG_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { UNCERTAIN_MESSAGE } from '../outbox'
import { deletePostRows } from '../deletion'
import { revokeDeletedMedia } from '../media/cache'
import { relativeTime } from '../format'
import { isLastLogPage, logRows, mergeOlderRows, oldestSeq } from '../paging'
import { buildProfileUrl } from '../profileLink'
import { installationOrigin } from '../installation'
import { whoOf } from '../who'
import { ErrorText, SectionHeader, Soft, colors, errorText, plainMessage, useAction, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { ShareProfile } from '../ui/ShareProfile'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { SunsetBand } from '../ui/SunsetBand'
import { HelpButton } from '../ui/Help'
import { HELP } from '../help'
import { fonts, type } from '../ui/theme'
import Perfil from './Perfil'
import { CountsNote, RepostPlaceholder, SocialToast, refOf, socialRowProps, useSocial } from './ARua'
import { DeletePrompt, useDelete } from './Conversa'

const BAND = 96
const MAX_EMPTY_PAGES = 5

// The state line of an outbox item. `held`: queued, but not sent
// automatically (found in storage from an earlier visit).
function PendingState ({ item, held }) {
  if (item.state === 'sending') return <Soft>enviando…</Soft>
  if (held) return <Soft>toque para enviar</Soft>
  if (item.state === 'uncertain') return <ErrorText>{UNCERTAIN_MESSAGE}</ErrorText>
  if (item.state === 'failed') return <ErrorText>{displayText(plainMessage(item.lastError))}</ErrorText>
  return <Soft>vai sair quando a conexão voltar</Soft>
}

// Only publications are listed: records the person never wrote by hand (profile,
// certificate, @nome, media, likes) and invalid blocks stay out of the timeline.
const isPostRow = (row) => !row.invalid && !!row.entry && !!row.entry.record && row.entry.record.type === 'post'
const isRepostRow = (row) => !row.invalid && !!row.entry && !!row.entry.record && row.entry.record.type === 'repost'

// The seqs of the repost records still on: the newest record per target, when
// it is `on`. Rows are loaded newest first, so a newer record of the same
// target is always already loaded.
function liveReposts (rows) {
  const latest = new Map()
  for (const row of rows) {
    if (!isRepostRow(row)) continue
    const ref = refOf(row.entry.record.to)
    if (ref === null) continue
    const known = latest.get(ref)
    if (!known || row.seq > known.seq) latest.set(ref, { seq: row.seq, on: row.entry.record.on === true })
  }
  const live = new Set()
  for (const v of latest.values()) if (v.on) live.add(v.seq)
  return live
}

// What a page of own rows needs: counts and own state of the own posts and
// the originals of the reposts; originals and quoted posts to resolve; the
// parents of own replies (useSocial reads only strangers' ones).
function rowNeeds (rows, publicKey) {
  const local = new Map()
  const shown = []
  const need = []
  const parents = new Set()
  for (const row of rows) {
    if (row.invalid || !row.entry || !row.entry.record) continue
    const record = row.entry.record
    if (record.type === 'post') {
      const ref = publicKey + ':' + row.seq
      shown.push(ref)
      local.set(ref, postOf(publicKey, row.seq, record))
      const q = refOf(record.quote)
      if (q !== null) need.push(q)
      const p = refOf(record.replyTo)
      if (p !== null) parents.add(p)
    } else if (record.type === 'repost' && record.on === true) {
      const ref = refOf(record.to)
      if (ref !== null) {
        shown.push(ref)
        need.push(ref)
      }
    }
  }
  for (const ref of local.keys()) parents.delete(ref)
  return { local, shown, need, parents: [...parents], authors: [publicKey] }
}

// A post item (the feed shape) of an own post record.
function postOf (author, seq, record) {
  return {
    kind: 'post',
    author,
    seq,
    at: record.at,
    text: record.text,
    replyTo: record.replyTo || null,
    quote: record.quote || null,
    media: Array.isArray(record.media) && record.media.length > 0 ? record.media : null,
    name: null,
    username: null
  }
}

export default function Diario ({ active, refresh, onSettings, onReply, onPublish, onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onQuote, onToast, ownKey, scrollToTop, onDeletedPost }) {
  const node = useNode()
  const names = useNames()
  const outbox = useOutbox()
  const insets = useSafeAreaInsets()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  // { info, rows, atEnd } from the loads, or null before the first answer.
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [olderError, setOlderError] = useState('')
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const pull = useAction()
  const seqRef = useRef(0)
  const olderBusy = useRef(false)
  const lastRefresh = useRef(refresh)
  const dataRef = useRef(null)
  dataRef.current = data

  const { learn, resolve, invalidate, profileOf } = names
  const { request, ackFresh } = node
  const ownPublicKey = typeof ownKey === 'string' ? ownKey : (data && typeof data.info.publicKey === 'string' ? data.info.publicKey : null)
  const social = useSocial({ ownKey: ownPublicKey, onToast })
  const { ingest } = social
  // Replaces the rows with the newest page (a refresh).
  const loadNewest = useCallback(async (refreshProfile = false) => {
    const mine = ++seqRef.current
    setLoadingMore(false)
    setOlderError('')
    olderBusy.current = false
    const knownKey = dataRef.current && dataRef.current.info.publicKey
    if (refreshProfile && typeof knownKey === 'string') invalidate([knownKey])
    try {
      // One read after the other: each read preempts a running sync.
      const info = await request('node.info', {})
      if (refreshProfile && mine === seqRef.current && typeof info.publicKey === 'string' && info.publicKey !== knownKey) {
        invalidate([info.publicKey])
      }
      const log = await request('log.read', { limit: LOG_LIMIT_MAX })
      if (mine !== seqRef.current) return
      const rows = logRows(log)
      setData({ info, rows, atEnd: isLastLogPage(log) })
      setLoadError('')
      setOlderError('')
      setLoadingMore(false)
      olderBusy.current = false
      ackFresh(['own'])
      if (typeof info.publicKey === 'string') resolve(info.publicKey)
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
      if (typeof info.publicKey === 'string') ingest({ ...rowNeeds(rows, info.publicKey), reset: true })
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    }
  }, [request, ackFresh, resolve, invalidate, ingest])

  // Appends the next older page; never while one is loading.
  const loadOlder = useCallback(async () => {
    const current = dataRef.current
    if (current === null || current.atEnd || olderBusy.current) return
    olderBusy.current = true
    const mine = seqRef.current
    setLoadingMore(true)
    setOlderError('')
    try {
      const log = await request('log.read', { limit: LOG_LIMIT_MAX, before: oldestSeq(current.rows) })
      // The cursor came from `current`: a newest page that replaced it
      // meanwhile would leave a gap between the two. A deletion also replaces
      // it, so a stale page must not restore the deleted content.
      if (mine !== seqRef.current || dataRef.current !== current) return
      const base = dataRef.current
      setData({ info: base.info, rows: mergeOlderRows(base.rows, log), atEnd: isLastLogPage(log) })
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
      if (typeof base.info.publicKey === 'string') ingest(rowNeeds(logRows(log), base.info.publicKey))
    } catch (err) {
      if (mine !== seqRef.current || dataRef.current !== current) return
      setOlderError(errorText(err))
    } finally {
      if (mine === seqRef.current) {
        setLoadingMore(false)
        olderBusy.current = false
      }
    }
  }, [request, resolve, ingest])

  // The own-diary growth signal at this render: an activation that is about
  // to acknowledge it re-reads the profile too, or a change made on another
  // device would be acknowledged without reaching the header and the editor.
  const ownGrew = !!(node.signals && node.signals.fresh && typeof node.signals.fresh.own === 'number')
  const ownGrewRef = useRef(ownGrew)
  ownGrewRef.current = ownGrew
  useEffect(() => {
    if (!active) return
    // A refresh bump while hidden is consumed on the next activation.
    const refreshProfile = refresh !== lastRefresh.current || ownGrewRef.current
    lastRefresh.current = refresh
    emptyPages.current = 0
    loadNewest(refreshProfile)
  }, [active, loadNewest, refresh])

  const reload = () => pull.run(() => loadNewest(true))

  // Pages with no publication (only technical records) while older pages
  // remain: load the next one by itself, at most MAX_EMPTY_PAGES in a row
  // per trigger; then the footer's 'mostrar mais' takes over.
  const emptyPages = useRef(0)
  // Publications: posts (quotes included) and the reposts still on.
  const shownRows = useMemo(() => {
    if (data === null) return []
    const live = liveReposts(data.rows)
    return data.rows.filter((row) => isPostRow(row) || (isRepostRow(row) && live.has(row.seq)))
  }, [data])
  const postCount = shownRows.length
  const dataAtEnd = data === null ? true : data.atEnd
  useEffect(() => {
    if (data === null) return
    if (postCount > 0 || dataAtEnd) {
      emptyPages.current = 0
      return
    }
    if (loadingMore || olderError || olderBusy.current || emptyPages.current >= MAX_EMPTY_PAGES) return
    emptyPages.current += 1
    loadOlder()
  }, [data, postCount, dataAtEnd, loadingMore, olderError, loadOlder])

  const info = data === null ? null : data.info
  const posts = shownRows
  const publicKey = info && typeof info.publicKey === 'string' ? info.publicKey : null
  const profile = publicKey ? profileOf(publicKey) : undefined
  const who = whoOf(profile || undefined)
  const bio = profile && profile.bio ? profile.bio : ''
  const profileUrl = node.hosted === true && publicKey ? buildProfileUrl({ origin: installationOrigin() || globalThis.location?.origin || null, username: profile ? profile.username : null, publicKey }) : null

  const bandHeight = insets.top + BAND

  // Only this identity's items for this association.
  const pending = info && node.config ? outbox.itemsFor(info.publicKey, node.config.association) : []
  // Queued items not approved in this page session (stored before it, or
  // changed in storage since they were approved): they wait for 'enviar',
  // which approves them exactly as shown here.
  const held = pending.filter((item) => item.state === 'queued' && !outbox.isAllowed(item))
  const heldIds = held.map((item) => item.id)
  // The post a queued reply answers, shown before it is approved: the stored
  // target can be changed by any script of this origin, so the person must
  // see which post 'enviar' approves (the approval covers the target too).
  const replyTargetText = (to) => {
    const sep = typeof to === 'string' ? to.indexOf(':') : -1
    if (sep < 0) return displayText(String(to))
    const author = to.slice(0, sep)
    return displayText(whoOf(profileOf(author) || undefined).title) + ' · #' + displayText(to.slice(sep + 1))
  }
  const outboxList = pending.length > 0
    ? (
      <>
        <SectionHeader>Aguardando envio</SectionHeader>
        {heldIds.length > 0
          ? (
            <View style={styles.pendingAll}>
              <Pill label='enviar tudo' onPress={() => outbox.release(held)} />
            </View>
            )
          : null}
        {pending.map((item) => (
          <View key={item.id} style={styles.pending}>
            <Text style={styles.pendingText}>{displayText(item.text, { multiline: true })}</Text>
            {item.kind === 'reply'
              ? <Soft>{'resposta a ' + replyTargetText(item.to)}</Soft>
              : null}
            <Soft>
              {'escrito ' + (relativeTime(item.writtenAt, now) ?? displayText(item.writtenAt)) +
                ' · a data será a do envio'}
            </Soft>
            <PendingState item={item} held={heldIds.includes(item.id)} />
            {item.state !== 'sending'
              ? (
                <View style={styles.pendingActions}>
                  {heldIds.includes(item.id)
                    ? <Pill label='enviar' onPress={() => outbox.release([item])} />
                    : null}
                  {item.state === 'uncertain' || item.state === 'failed'
                    ? <Pill label='tentar de novo' onPress={() => outbox.retry(item)} />
                    : null}
                  <Pill label='apagar' onPress={() => outbox.discard(item.id)} />
                </View>
                )
              : null}
          </View>
        ))}
      </>
      )
    : null

  const header = info === null
    ? (
      <View>
        <View style={[styles.plainBand, { height: bandHeight }]} />
      </View>
      )
    : (
      <View>
        <SunsetBand height={bandHeight}>
          <HelpButton doc={HELP.diario} color='#ffffff' style={styles.info} />
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='ajustes'
            hitSlop={8}
            onPress={() => onSettings('lista')}
            style={styles.gear}
          >
            <Icon name='engrenagem' size={20} color='#ffffff' />
          </Pressable>
        </SunsetBand>
        {/* The row rises into the band (marginTop -44) and is drawn after it,
            so its empty space would take the gear's touches: only the avatar
            takes touches. */}
        <View style={styles.headRow} pointerEvents='box-none'>
          <Avatar name={who.avatarName} publicKey={info.publicKey} size={88} picture={profile && profile.avatar} persist ring />
        </View>
        <View style={styles.data}>
          <Text style={styles.name}>{displayText(who.title)}</Text>
          {who.subtitle ? <Text style={styles.keyText}>{displayText(who.subtitle)}</Text> : null}
          {bio
            ? <Text style={styles.bio}>{displayText(bio, { multiline: true })}</Text>
            : null}
          <Text style={styles.counts}>
            <Text style={styles.countsNum}>{displayText(String(info.followCount))}</Text> seguindo
          </Text>
          <View style={styles.actions}>
            <View style={styles.action}><Pill label='Editar perfil' onPress={() => setEditing(true)} /></View>
            {profileUrl !== null ? <View style={styles.action}><Pill label='Compartilhar' accessibilityLabel='compartilhar perfil' onPress={() => setSharing(true)} /></View> : null}
          </View>
        </View>
        {outboxList}
        <SectionHeader>Publicações</SectionHeader>
        <CountsNote social={social} />
        <ErrorText>{loadError}</ErrorText>
      </View>
      )

  const footer = data !== null && posts.length > 0
    ? (
      <ListFooter
        loading={loadingMore}
        atEnd={data.atEnd}
        endText='Isso é tudo por enquanto.'
        error={olderError}
        onRetry={loadOlder}
      />
      )
    : null

  // Before the first answer, and for an empty log, under the header.
  let empty
  if (data === null) {
    empty = loadError
      ? <ErrorState message={loadError} onRetry={reload} pending={pull.pending} />
      : <Skeleton />
  } else {
    empty = !data.atEnd
      // Older pages remain and none shown so far held a publication: loading
      // (or its error and retry), never the empty state.
      ? <ListFooter loading={loadingMore} atEnd={false} error={olderError} onRetry={loadOlder} pending={loadingMore} />
      : (
        <EmptyState
          icon='lapis'
          title='Você ainda não publicou'
          body='Sua primeira publicação aparece aqui.'
          actionLabel='Publicar'
          onAction={onPublish}
        />
        )
  }

  const del = useDelete({
    request,
    onToast,
    recheck: () => loadNewest(false),
    // The slot stays (as the node reports it) so the paging cursor holds.
    onDeleted: async (t) => {
      social.deleteOriginal(t.ref)
      const cur = dataRef.current
      if (cur !== null) {
        dataRef.current = { ...cur, rows: deletePostRows(cur.rows, t.ref, cur.info.publicKey) }
        setData(dataRef.current)
      }
      if (typeof onDeletedPost === 'function') onDeletedPost()
      // The row is gone. The tombstone's ranges leave the image cache too,
      // so a photo still mounted (the header avatar, another tile) loses
      // its blob URL. A range a surviving post or profile shows stays.
      if (t !== null && typeof t === 'object' && Number.isSafeInteger(t.seq)) {
        await revokeDeletedMedia(request, [t.seq], LOG_LIMIT_MAX)
      }
    }
  })
  const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onReply, onQuote, onDelete: del.offered ? del.ask : undefined }
  // An own repost is the ORIGINAL post under 'Você republicou' (every action
  // targets the original); an own post (or quote) targets itself.
  const renderItem = ({ item: row }) => {
    const record = row.entry.record
    if (record.type === 'repost') {
      const ref = refOf(record.to)
      const repostedBy = { author: info.publicKey, name: 'Você', username: null }
      const post = social.original(ref)
      if (!post) return <RepostPlaceholder repostedBy={repostedBy} missing={post === null} transient={social.transient(ref)} onRetry={() => social.retry(ref)} />
      return <PostRow {...socialRowProps({ post, ref, repostedBy, social, profileOf, now, ownKey: info.publicKey, h: handlers })} />
    }
    const post = postOf(info.publicKey, row.seq, record)
    return <PostRow {...socialRowProps({ post, ref: info.publicKey + ':' + row.seq, social, profileOf, now, ownKey: info.publicKey, h: handlers })} />
  }

  // Rows re-render when a name is learned, the clock ticks or the originals,
  // counts or own state change.
  const extra = useMemo(() => ({ profileOf, now, profile, social: social.social, offered: del.offered }), [profileOf, now, profile, social.social, del.offered])

  return (
    <View style={styles.list}>
      <DeletePrompt del={del} />
      <RefreshableList
        data={posts}
        keyExtractor={(row) => (row.invalid ? 'i' : 'e') + row.seq}
        renderItem={renderItem}
        extraData={extra}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={reload}
        refreshing={pull.pending}
        onLoadMore={loadOlder}
        loadingMore={loadingMore}
        loadMoreError={!!olderError}
        atEnd={data === null ? true : data.atEnd}
        scrollToTopSignal={scrollToTop}
        newItems={{
          label: 'ver novidades',
          visible: !!(node.signals && node.signals.fresh && node.signals.fresh.own),
          onPress: reload
        }}
      />
      <Perfil
        open={editing}
        ownKey={info ? info.publicKey : null}
        current={{ name: (profile && profile.name) || '', bio, avatar: profile ? profile.avatar : undefined }}
        onClose={() => setEditing(false)}
        onSaved={(values) => {
          if (info && info.publicKey) {
            learn(info.publicKey, values)
            // The authoritative answer also replaces a cleared bio.
            invalidate([info.publicKey])
          }
          setEditing(false)
          pull.run(loadNewest)
        }}
      />
      {profileUrl !== null
        ? (
          <Sheet open={sharing} onClose={() => setSharing(false)} title='Compartilhar perfil'>
            <View style={styles.shareBody}>
              <ShareProfile url={profileUrl} />
            </View>
          </Sheet>
          )
        : null}
      <SocialToast text={social.toast} />
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  plainBand: { backgroundColor: colors.bg },
  gear: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.dim,
    alignItems: 'center',
    justifyContent: 'center'
  },
  info: {
    position: 'absolute',
    right: 58,
    bottom: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.dim,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headRow: {
    marginTop: -44,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between'
  },
  data: { paddingTop: 10, paddingHorizontal: 16, paddingBottom: 12, gap: 2 },
  name: { ...type.profileName, fontFamily: fonts.title, color: colors.ink },
  keyText: { ...type.postMeta, color: colors.soft },
  bio: { ...type.postText, color: colors.ink, marginTop: 8 },
  counts: { fontSize: 15, color: colors.soft, marginTop: 8 },
  countsNum: { color: colors.ink, fontWeight: '700' },
  // Pill sets no width, so the column has to stretch it.
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  action: { flex: 1, alignItems: 'stretch' },
  shareBody: { padding: 16, gap: 12 },
  pending: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pendingText: { ...type.postText, color: colors.ink },
  pendingActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  pendingAll: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8 }
})
