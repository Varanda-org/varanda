// Diário: the person's own profile header (sunset band, avatar, name, key,
// bio, follow count) over the own log (log.read, the newest page), newest
// first. Publications are PostRows; other blocks are short technical lines.
// Posts still in the outbox ('fila de saída', browser node) are listed above
// them; they are not PostRows (no reply, no publication date yet). A queued
// item this page session did not write waits for the person ('enviar').
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LOG_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { UNCERTAIN_MESSAGE } from '../outbox'
import { handleOf, relativeTime } from '../format'
import { ErrorText, Mono, SectionHeader, Soft, colors, errorText, useAction, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'
import { SunsetBand } from '../ui/SunsetBand'
import { fonts, type } from '../ui/theme'
import Perfil from './Perfil'

// See ARua.js: a 'preempted' stop never triggers a reload.
const RELOAD_REASONS = ['done', 'timeout', 'stopped']

const BAND = 96

// The newest 'profile' record of the page, or null.
function newestProfile (log) {
  let best = null
  for (const entry of log.entries) {
    const record = entry.record
    if (record && record.type === 'profile' && (best === null || entry.seq > best.seq)) {
      best = { seq: entry.seq, record }
    }
  }
  return best === null ? null : best.record
}

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
  return <Text style={styles.tech}>{children}</Text>
}

export default function Diario ({ active, refresh, onSettings, onReply }) {
  const node = useNode()
  const names = useNames()
  const outbox = useOutbox()
  const insets = useSafeAreaInsets()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  // { info, log } from one load, or null before the first answer.
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [editing, setEditing] = useState(false)
  // The profile last saved from this screen ({ name, bio }), shown until a
  // reload carries it: reopening the editor before that reload lands (or
  // after it failed) must not start from the older profile.
  const [saved, setSaved] = useState(null)
  const pull = useAction()
  const seqRef = useRef(0)

  const { learn, resolve } = names
  const load = useCallback(async () => {
    const mine = ++seqRef.current
    try {
      // One read after the other: each read preempts a running sync.
      const info = await node.request('node.info', {})
      const log = await node.request('log.read', { limit: LOG_LIMIT_MAX })
      if (mine !== seqRef.current) return
      setData({ info, log })
      setLoadError('')
      const profile = newestProfile(log)
      // Without a profile in this page the name stays whatever is known: an
      // older profile may exist beyond the page.
      if (profile && info.publicKey) learn(info.publicKey, profile.name)
      for (const entry of log.entries) {
        const record = entry.record
        if (record && record.type === 'post' && record.replyTo) resolve(record.replyTo.author)
      }
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    }
  }, [node.request, learn, resolve])

  useEffect(() => { if (active) load() }, [active, load, refresh])

  // Reload after a sync run that ended on its own or was stopped.
  const stopped = node.sync.stopped
  const prevStoppedRef = useRef(stopped)
  useEffect(() => {
    if (stopped === prevStoppedRef.current) return
    prevStoppedRef.current = stopped
    if (active && stopped && RELOAD_REASONS.includes(stopped.reason)) load()
  }, [stopped, active, load])

  const reload = () => pull.run(load)

  const info = data === null ? null : data.info
  const log = data === null ? null : data.log
  const loaded = log === null ? null : newestProfile(log)
  const carried = loaded !== null && saved !== null && loaded.name === saved.name && (loaded.bio || '') === saved.bio
  const profile = saved !== null && !carried ? saved : loaded
  // Once a reload carries the saved profile, the loaded records rule again
  // (a later change made elsewhere must show).
  useEffect(() => { if (carried) setSaved(null) }, [carried])
  const knownName = profile
    ? profile.name
    : (info && info.publicKey ? names.nameOf(info.publicKey) : undefined)
  const hasName = typeof knownName === 'string' && knownName !== ''

  // Entries and invalid blocks, newest first, in one list by seq.
  const rows = log === null
    ? []
    : log.entries.map((e) => ({ seq: e.seq, entry: e }))
      .concat(log.invalid.map((i) => ({ seq: i.seq, invalid: i })))
      .sort((a, b) => b.seq - a.seq)

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
    return displayText(names.nameOf(author) || handleOf(author)) + ' · #' + displayText(to.slice(sep + 1))
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

  const header = info === null
    ? (
      <View>
        <View style={[styles.plainBand, { height: bandHeight }]} />
        {loadError ? null : <View style={styles.pad}><Soft>carregando…</Soft></View>}
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
          <Avatar name={hasName ? knownName : null} publicKey={info.publicKey} size={88} ring />
          <Pill label='Editar perfil' onPress={() => setEditing(true)} />
        </View>
        <View style={styles.data}>
          <Text style={styles.name}>
            {hasName ? displayText(knownName) : displayText(handleOf(info.publicKey))}
          </Text>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='mostrar a chave inteira'
            onPress={() => setShowKey((v) => !v)}
            style={styles.keyWrap}
          >
            <Text style={styles.keyText}>{displayText(handleOf(info.publicKey))}</Text>
          </Pressable>
          {showKey ? <Mono>{displayText(info.publicKey)}</Mono> : null}
          {profile && profile.bio
            ? <Text style={styles.bio}>{displayText(profile.bio, { multiline: true })}</Text>
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
          {!profile && log.entriesTruncated > 0
            ? <Soft>Nenhum perfil nos últimos blocos; um perfil mais antigo pode existir.</Soft>
            : null}
        </View>
        {outboxList}
        <SectionHeader right={Platform.OS === 'web' ? <Pill label='atualizar' onPress={reload} pending={pull.pending} /> : null}>
          Publicações
        </SectionHeader>
      </View>
      )

  const footer = (
    <View style={styles.footer}>
      {log !== null && rows.length === 0 ? <Soft>O diário ainda está vazio.</Soft> : null}
      {log !== null && log.entriesTruncated > 0
        ? <Soft>{String(log.entriesTruncated) + ' blocos mais antigos não aparecem: nesta versão só a página mais recente pode ser lida.'}</Soft>
        : null}
      <ErrorText>{loadError}</ErrorText>
      {/* The web has no pull to refresh: a failed load still offers a retry. */}
      {loadError && Platform.OS === 'web' && info === null
        ? <Pill label='tentar de novo' onPress={reload} pending={pull.pending} />
        : null}
    </View>
  )

  const renderItem = ({ item: row }) => {
    const head = '#' + String(row.seq)
    if (row.invalid) {
      return <TechRow>{'bloco inválido (' + head + ': ' + displayText(row.invalid.reason) + ')'}</TechRow>
    }
    const record = row.entry.record || {}
    if (record.type === 'post') {
      return (
        <PostRow
          author={info.publicKey}
          name={hasName ? knownName : null}
          at={record.at}
          text={record.text}
          replyToName={record.replyTo ? (names.nameOf(record.replyTo.author) || handleOf(record.replyTo.author)) : null}
          now={now}
          onReply={() => onReply({
            ref: info.publicKey + ':' + row.seq,
            name: hasName ? knownName : handleOf(info.publicKey),
            text: record.text
          })}
        />
      )
    }
    if (record.type === 'profile') {
      return <TechRow>{head + ' · perfil · ' + displayText(record.name) + ' · ' + (relativeTime(record.at, now) ?? displayText(record.at))}</TechRow>
    }
    if (record.type === 'member-cert') return <TechRow>{head + ' · certificado de membro'}</TechRow>
    return <TechRow>{head + ' · registro desconhecido'}</TechRow>
  }

  // Rows re-render when a name is learned or the clock ticks.
  const extra = useMemo(() => ({ nameOf: names.nameOf, now, knownName }), [names.nameOf, now, knownName])

  return (
    <View style={styles.list}>
      <FlatList
        style={styles.list}
        data={info === null ? [] : rows}
        keyExtractor={(row) => (row.invalid ? 'i' : 'e') + row.seq}
        renderItem={renderItem}
        extraData={extra}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        keyboardShouldPersistTaps='handled'
        refreshControl={Platform.OS === 'web'
          ? undefined
          : <RefreshControl refreshing={pull.pending} onRefresh={reload} tintColor={colors.accent} colors={[colors.accent]} />}
      />
      <Perfil
        open={editing}
        current={{ name: (profile && profile.name) || '', bio: (profile && profile.bio) || '' }}
        onClose={() => setEditing(false)}
        onSaved={(values) => {
          setSaved(values)
          if (info && info.publicKey) learn(info.publicKey, values.name)
          setEditing(false)
          reload()
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  plainBand: { backgroundColor: colors.bg },
  pad: { padding: 16 },
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
  keyWrap: { alignSelf: 'flex-start' },
  keyText: { ...type.postMeta, color: colors.soft },
  bio: { ...type.postText, color: colors.ink, marginTop: 8 },
  counts: { fontSize: 15, color: colors.soft, marginTop: 8 },
  countsNum: { color: colors.ink, fontWeight: '700' },
  warn: { fontSize: 14, lineHeight: 20, color: colors.warn, marginTop: 6 },
  footer: { padding: 16, gap: 8 },
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
    ...type.replyMark,
    color: colors.soft,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  }
})
