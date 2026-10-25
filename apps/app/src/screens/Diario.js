// Diário: the person's own profile header (sunset band, avatar, name and
// @nome from profile.read, bio, follow count, the public key behind 'mostrar
// chave') over the own log (log.read), newest first, paged backwards with
// infinite scroll and pull to refresh. Publications are PostRows; other valid
// records are one compact line each, invalid blocks a short line with the
// reason. Posts still in the outbox ('fila de saída', browser node) are
// listed above them; they are not PostRows (no reply, no publication date
// yet). A queued item this page session did not write waits for the person
// ('enviar'). The 'ver novidades' pill (web only) follows the own-synced line
// growing, i.e. another device published; the native node has no such
// signal, so on native only the pull, the tab and the refresh prop reload.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LOG_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { UNCERTAIN_MESSAGE } from '../outbox'
import { relativeTime } from '../format'
import { isLastLogPage, logRows, mergeOlderRows, oldestSeq } from '../paging'
import { atName, replyNameOf, whoOf } from '../who'
import { ErrorText, Mono, SectionHeader, Soft, colors, errorText, useAction, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { SunsetBand } from '../ui/SunsetBand'
import { fonts, type } from '../ui/theme'
import Perfil from './Perfil'

const BAND = 96

// The state line of an outbox item. `held`: queued, but not sent
// automatically (found in storage from an earlier visit).
function PendingState ({ item, held }) {
  if (item.state === 'sending') return <Soft>publicando…</Soft>
  if (held) return <Soft>guardado antes: confira o texto e toque em enviar</Soft>
  if (item.state === 'uncertain') return <ErrorText>{UNCERTAIN_MESSAGE}</ErrorText>
  if (item.state === 'failed') return <ErrorText>{displayText(item.lastError)}</ErrorText>
  if (item.attempts === 0) return <Soft>aguardando conexão</Soft>
  return <Soft>{'nova tentativa em breve · ' + displayText(item.lastError)}</Soft>
}

function TechRow ({ children }) {
  return <View style={styles.tech}><Soft>{children}</Soft></View>
}

export default function Diario ({ active, refresh, onSettings, onReply, onPublish, scrollToTop }) {
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
  const [showKey, setShowKey] = useState(false)
  const [editing, setEditing] = useState(false)
  const pull = useAction()
  const seqRef = useRef(0)
  const olderBusy = useRef(false)
  const lastRefresh = useRef(refresh)
  const dataRef = useRef(null)
  dataRef.current = data

  const { learn, resolve, invalidate, profileOf } = names
  const { request, ackFresh } = node
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
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    }
  }, [request, ackFresh, resolve, invalidate])

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
      // meanwhile (a reload from activation or a refresh bump) would leave a
      // gap between the two, so this page is dropped (that reload reset the
      // paging state).
      if (mine !== seqRef.current || dataRef.current !== current) return
      const base = dataRef.current
      setData({ info: base.info, rows: mergeOlderRows(base.rows, log), atEnd: isLastLogPage(log) })
      setLoadingMore(false)
      olderBusy.current = false
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
    } catch (err) {
      if (mine !== seqRef.current) return
      setOlderError(errorText(err))
      setLoadingMore(false)
      olderBusy.current = false
    }
  }, [request, resolve])

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
    loadNewest(refreshProfile)
  }, [active, loadNewest, refresh])

  const reload = () => pull.run(() => loadNewest(true))

  const info = data === null ? null : data.info
  const rows = data === null ? [] : data.rows
  const publicKey = info && typeof info.publicKey === 'string' ? info.publicKey : null
  const profile = publicKey ? profileOf(publicKey) : undefined
  const who = whoOf(profile || undefined)
  const bio = profile && profile.bio ? profile.bio : ''

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
        <SectionHeader>Fila de saída</SectionHeader>
        {heldIds.length > 0
          ? (
            <View style={styles.pendingAll}>
              <Pill label='enviar todos' onPress={() => outbox.release(held)} />
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
                ' · a data será a da publicação'}
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
                  <Pill label='descartar' onPress={() => outbox.discard(item.id)} />
                </View>
                )
              : null}
          </View>
        ))}
      </>
      )
    : null

  // Copy only where the clipboard exists; elsewhere the key stays selectable.
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard
  const copyKey = () => {
    try {
      navigator.clipboard.writeText(publicKey).catch(() => {})
    } catch {}
  }

  const header = info === null
    ? (
      <View>
        <View style={[styles.plainBand, { height: bandHeight }]} />
      </View>
      )
    : (
      <View>
        <SunsetBand height={bandHeight}>
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
            and the pill receive them. */}
        <View style={styles.headRow} pointerEvents='box-none'>
          <Avatar name={who.avatarName} publicKey={info.publicKey} size={88} ring />
          <Pill label='Editar perfil' onPress={() => setEditing(true)} />
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
          {info.memberCert === false
            ? (
              <Pressable accessibilityRole='button' onPress={() => onSettings('identidade')}>
                <Text style={styles.warn}>certificado de membro ausente · abrir Identidade</Text>
              </Pressable>
              )
            : null}
          <View style={styles.keyRow}>
            <Text style={styles.keyText}>chave pública</Text>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={showKey ? 'esconder chave' : 'mostrar chave'}
              onPress={() => setShowKey((v) => !v)}
              style={styles.keyToggle}
            >
              <Icon name={showKey ? 'olho_fechado' : 'olho'} size={16} color={colors.soft} />
              <Text style={styles.keyText}>{showKey ? 'esconder chave' : 'mostrar chave'}</Text>
            </Pressable>
          </View>
          {showKey
            ? (
              <View style={styles.keyBox}>
                <Mono>{displayText(info.publicKey)}</Mono>
                {canCopy ? <Pill label='copiar' onPress={copyKey} /> : null}
              </View>
              )
            : null}
        </View>
        {outboxList}
        <SectionHeader>Publicações</SectionHeader>
        <ErrorText>{loadError}</ErrorText>
      </View>
      )

  const footer = data !== null && rows.length > 0
    ? (
      <ListFooter
        loading={loadingMore}
        atEnd={data.atEnd}
        endText='Início do diário.'
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
    empty = (
      <EmptyState
        icon='lapis'
        title='Seu diário está vazio'
        body='Sua primeira publicação aparece aqui.'
        actionLabel='Publicar'
        onAction={onPublish}
      />
    )
  }

  const renderItem = ({ item: row }) => {
    const head = '#' + String(row.seq)
    if (row.invalid) {
      return <TechRow>{'bloco inválido (' + head + ': ' + displayText(row.invalid.reason) + ')'}</TechRow>
    }
    const record = row.entry.record || {}
    if (record.type === 'post') {
      const replyProfile = record.replyTo ? profileOf(record.replyTo.author) : undefined
      return (
        <PostRow
          author={info.publicKey}
          name={profile ? profile.name : null}
          username={profile ? profile.username : null}
          at={record.at}
          text={record.text}
          replyToName={record.replyTo ? replyNameOf(replyProfile) : null}
          now={now}
          onReply={() => onReply({
            ref: info.publicKey + ':' + row.seq,
            name: profile ? profile.name : null,
            username: profile ? profile.username : null,
            text: record.text
          })}
        />
      )
    }
    if (record.type === 'profile') return <TechRow>perfil atualizado</TechRow>
    if (record.type === 'member-cert') return <TechRow>certificado de membro</TechRow>
    if (record.type === 'username') return <TechRow>{'@nome registrado ' + displayText(atName(record.username) || '')}</TechRow>
    return <TechRow>registro desconhecido</TechRow>
  }

  // Rows re-render when a name is learned or the clock ticks.
  const extra = useMemo(() => ({ profileOf, now, profile }), [profileOf, now, profile])

  return (
    <View style={styles.list}>
      <RefreshableList
        data={rows}
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
          visible: Platform.OS === 'web' && !!(node.signals && node.signals.fresh && node.signals.fresh.own),
          onPress: reload
        }}
      />
      <Perfil
        open={editing}
        ownKey={info ? info.publicKey : null}
        current={{ name: (profile && profile.name) || '', bio }}
        onClose={() => setEditing(false)}
        onSaved={(values) => {
          if (info && info.publicKey) {
            learn(info.publicKey, { name: values.name, bio: values.bio })
            // The authoritative answer also replaces a cleared bio.
            invalidate([info.publicKey])
          }
          setEditing(false)
          pull.run(loadNewest)
        }}
      />
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
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  keyToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  keyBox: { gap: 8, alignItems: 'flex-start' },
  bio: { ...type.postText, color: colors.ink, marginTop: 8 },
  counts: { fontSize: 15, color: colors.soft, marginTop: 8 },
  countsNum: { color: colors.ink, fontWeight: '700' },
  warn: { fontSize: 14, lineHeight: 20, color: colors.warn, marginTop: 6 },
  pending: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pendingText: { ...type.postText, color: colors.ink },
  pendingActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  pendingAll: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8 },
  tech: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  }
})
