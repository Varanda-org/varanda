// Comunidade: one community (community.info, docs/rpc.md 5.59) as a list of
// its groups, Geral first, each with its newest message, the time and the
// unread count, opening the group on a tap. Someone who is not a member gets
// an invite card with one Entrar or Pedir entrada button (also from the
// seeder index; a link is never consent, only the tap joins). The creator
// also sees Novo grupo and, on repair, Tirar da lista and Devolver à lista.
// The top bar (or its ⋯) opens Informações da comunidade, where sharing,
// leaving, inviting and the management panels live. A mutation that comes
// back uncertain is never resent: the screen re-reads and only then lets the
// person try again.
// Props: community (hex64 root key), afterGroup (a group to open once the
// person joined, from a /g/ link), isTop (this screen is the visible one),
// seenTick (bumped when a group was marked seen), onBack(),
// onOpenGroup(group), onOpenInfo(community). The screen runs wherever the
// node is hosted (site and installed app with an installation), like the
// Comunidades tab.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { shareCommunity } from '../communityShare'
import { fetchCommunity } from '../indexClient'
import { relativeTime } from '../format'
import { COMMUNITY_JOIN_LABELS, GENERAL_LABEL, PRIVATE_LABEL, can, lastLine, membersLabel, reconcile, roleLabel, unreadLabel, visibilityLabel } from '../groups'
import { Body, Btn, Card, ErrorText, SectionHeader, Soft, Title, UNCERTAIN, colors, errorText, useAction, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { shouldOpenQueued } from '../groupRedirect'
import { NovoGrupo } from './NovoGrupo'
import { WEB_ONLY_MESSAGE } from './Comunidades'

const { displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const JOIN_OPEN_TEXT = 'Entre para conversar nos grupos desta comunidade.'
const JOIN_APPROVAL_TEXT = 'Peça entrada: um administrador aprova antes de você participar.'
const JOIN_PUBLIC_TEXT = 'Participar é público: sua entrada fica registrada no seu diário.'
const JOIN_PENDING_TEXT = 'Enviado. Aguardando a comunidade chegar a este aparelho.'
const JOIN_OFFLINE_TEXT = 'Sem internet: conecte-se para entrar.'
// community.info `repair`: the creator, back after its root's powers ended, takes a group off the list.
const DROP_GROUP_TEXT = 'Tirar este grupo da lista da comunidade? Ele deixa de aparecer aqui e ninguém mais escreve nele.'
// community.info `dropped`: with `repair`, the creator puts a group it took off back.
const UNDROP_GROUP_TEXT = 'Devolver este grupo à lista da comunidade?'
const DROPPED_LABEL = 'Grupo tirado da lista'
const INFO_LABEL = 'informações da comunidade'

const inside = (role) => role === 'creator' || role === 'admin' || role === 'member' || role === 'requested'

function adminsLabel (n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return n === 1 ? '1 administrador' : n + ' administradores'
}

// The invite card of someone outside the community: one button, and only the
// tap joins.
function JoinCard ({ title, header, join, showJoin, onJoin, pending, offline, error, note }) {
  const approval = join === 'approval'
  return (
    <View style={styles.block}>
      <Card>
        <Title>{title}</Title>
        {header ? <Soft>{header}</Soft> : null}
        <Body>{approval ? JOIN_APPROVAL_TEXT : JOIN_OPEN_TEXT}</Body>
        {showJoin ? <Btn label={approval ? 'Pedir entrada' : 'Entrar'} onPress={onJoin} pending={pending} disabled={offline} /> : null}
        <Soft>{JOIN_PUBLIC_TEXT}</Soft>
        {offline && showJoin ? <Soft>{JOIN_OFFLINE_TEXT}</Soft> : null}
        <ErrorText>{error}</ErrorText>
        {note ? <Soft>{note}</Soft> : null}
      </Card>
    </View>
  )
}

function GroupRow ({ title, detail, time, unread, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={unread ? title + ', ' + unread + ' não lidas' : title}
      accessibilityHint='abre o grupo'
      onPress={onPress}
    >
      <View style={styles.icon}><Icon name='cadeira' size={24} color={colors.ink} /></View>
      <View style={styles.hitText}>
        <View style={styles.line}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
        {detail || unread
          ? (
            <View style={styles.line}>
              <Text style={[styles.handle, styles.grow]} numberOfLines={1}>{detail}</Text>
              {unread ? <View style={styles.badge}><Text style={styles.badgeText}>{unread}</Text></View> : null}
            </View>
            )
          : null}
      </View>
    </Pressable>
  )
}

export function Comunidade ({ community, afterGroup, isTop, seenTick, onBack, onOpenGroup, onOpenInfo }) {
  const node = useNode()
  const hosted = node.hosted === true
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shareNote, setShareNote] = useState('')
  const [joinNote, setJoinNote] = useState('')
  // The seeder index's view, for someone whose node holds nothing of this
  // community yet: { status, name, groups, partial, join, members, error }.
  const [idx, setIdx] = useState({ status: 'idle', name: '', groups: [], partial: false, join: null, members: null, error: '' })
  const idxGen = useRef(0)
  const [confirm, setConfirm] = useState(null)
  const [check, setCheck] = useState(null)
  const [newGroup, setNewGroup] = useState(false)
  const [droppedNames, setDroppedNames] = useState({})
  const act = useAction()
  const join = useAction()
  const gen = useRef(0)
  const queued = useRef(afterGroup || null)
  // The role the first answer showed: a queued group opens only after a join.
  const firstRole = useRef(null)
  const requestRef = useRef(node.request)
  requestRef.current = node.request

  const load = useCallback(async () => {
    const mine = ++gen.current
    setLoading(true)
    setLoadError('')
    try {
      const res = await requestRef.current('community.info', { community })
      if (mine !== gen.current) return
      setInfo(res && typeof res === 'object' ? res : null)
    } catch (err) {
      if (mine !== gen.current) return
      setLoadError(errorText(err))
    } finally {
      if (mine === gen.current) setLoading(false)
    }
  }, [community])

  const needIndex = hosted && ((info !== null && info.state === 'pending') || (info === null && loadError !== ''))
  const loadIndex = useCallback(async () => {
    const mine = ++idxGen.current
    setIdx((s) => ({ ...s, status: 'loading', error: '' }))
    const res = await fetchCommunity(community)
    if (mine !== idxGen.current) return
    if (!res || !res.ok) {
      setIdx({ status: 'error', name: '', groups: [], partial: false, join: null, members: null, error: res && res.reason === 'not-found' ? 'O servidor ainda não conhece esta comunidade.' : 'Não foi possível consultar o índice agora.' })
      return
    }
    const v = res.value
    setIdx({ status: 'done', name: v.name, groups: v.groups, partial: v.indexing === true || v.complete === false, join: v.join, members: v.members, error: '' })
  }, [community])
  useEffect(() => {
    if (!needIndex) {
      idxGen.current++
      return
    }
    loadIndex()
  }, [needIndex, loadIndex])

  useEffect(() => {
    if (!hosted) return
    load()
  }, [hosted, load])

  // groups.changed also names communities: a pending or incomplete answer
  // fills in when the data arrives.
  const version = node.getGroupVersion(community)
  const lastVersion = useRef(version)
  useEffect(() => {
    if (!hosted || version === lastVersion.current) return
    lastVersion.current = version
    load()
  }, [hosted, version, load])

  const groups = info && Array.isArray(info.groups) ? info.groups : []
  const ordered = groups.filter((g) => g.general === true).concat(groups.filter((g) => g.general !== true))

  // A new post emits groups.changed for its group only, not the community:
  // the newest line and the unread count need a re-read. The list may change
  // in the same render and its answer may predate the post, so any change of
  // the pairs re-reads (the gen counter drops a stale answer).
  const groupVersions = ordered.map((g) => g.group + ':' + node.getGroupVersion(g.group)).join(',')
  const lastGroupVersions = useRef(groupVersions)
  useEffect(() => {
    if (lastGroupVersions.current === groupVersions) return
    lastGroupVersions.current = groupVersions
    if (hosted) load()
  }, [hosted, groupVersions, load])

  // group.seen emits nothing: coming back from a group re-reads the counts,
  // and so does the mark landing after the person already came back.
  const wasTop = useRef(isTop)
  useEffect(() => {
    const was = wasTop.current
    wasTop.current = isTop
    if (hosted && was === false && isTop === true) load()
  }, [hosted, isTop, load])
  const lastSeen = useRef(seenTick)
  useEffect(() => {
    if (seenTick === lastSeen.current) return
    lastSeen.current = seenTick
    if (hosted) load()
  }, [hosted, seenTick, load])

  const role = info && typeof info.role === 'string' ? info.role : null
  const isMember = role === 'creator' || role === 'admin' || role === 'member'
  const staff = isMember && (role === 'creator' || role === 'admin')
  const canCreate = isMember && can('create', role)
  const dropped = info && info.repair === true && Array.isArray(info.dropped) ? info.dropped.filter((g) => typeof g === 'string' && HEX64.test(g)) : []
  const droppedKey = dropped.join(',')

  // A join note from earlier in this visit would sit next to the card's
  // Entrar after leaving on the info screen.
  const lastRole = useRef(role)
  useEffect(() => {
    if (inside(lastRole.current) && role !== null && !inside(role)) setJoinNote('')
    if (role !== null) lastRole.current = role
  }, [role])

  // community.info rows no longer name a dropped group: group.info does
  // when its root is held here.
  useEffect(() => {
    if (droppedKey === '') return
    let live = true
    for (const g of droppedKey.split(',')) {
      requestRef.current('group.info', { group: g }).then((r) => {
        if (live && r && typeof r.name === 'string' && r.name !== '') setDroppedNames((m) => ({ ...m, [g]: r.name }))
      }).catch(() => {})
    }
    return () => { live = false }
  }, [droppedKey])

  // After a /g/ link: the queued group opens once, and only when this screen
  // saw the person outside and then inside the community.
  useEffect(() => {
    if (role !== null && firstRole.current === null) firstRole.current = role
    if (queued.current === null || typeof onOpenGroup !== 'function') return
    if (!shouldOpenQueued({ queued: queued.current, firstRole: firstRole.current, role })) return
    const group = queued.current
    queued.current = null
    onOpenGroup(group)
  }, [role, onOpenGroup])

  const mutate = async (method, params) => {
    setCheck(null)
    setConfirm(null)
    const res = await act.run(() => requestRef.current(method, params))
    if (res.ok) {
      load()
      return res
    }
    if (res.uncertain) {
      // The change may or may not have landed: re-read and let the person decide.
      setCheck(true)
      load()
    }
    return res
  }

  const doJoin = async () => {
    setJoinNote('')
    setCheck(null)
    const res = await join.run(() => requestRef.current('community.join', { community }))
    if (res.ok) {
      const v = res.value || {}
      if (v.group) setJoinNote('Você entrou no Geral.')
      else if (v.state === 'requested') setJoinNote('Pedido enviado: aguardando aprovação.')
      else if (v.state === 'pending') setJoinNote(JOIN_PENDING_TEXT)
      load()
      return
    }
    if (res.uncertain) {
      try {
        const view = await requestRef.current('community.info', { community })
        setInfo(view)
        if (reconcile({ action: 'community-join' }, { role: view && view.role }) !== 'landed') setCheck(true)
      } catch {
        setCheck(true)
      }
    }
  }

  if (!hosted) {
    return (
      <View style={styles.root}>
        <TopBar title='Comunidade' onBack={onBack} />
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
      </View>
    )
  }

  const offline = node.online === false
  const pending = info !== null && info.state === 'pending'
  const title = info && typeof info.name === 'string' && info.name !== ''
    ? displayText(info.name)
    : (idx.status === 'done' && needIndex && idx.name !== '' ? displayText(idx.name) : 'Comunidade')

  const share = async () => {
    setShareNote('')
    setShareNote(await shareCommunity({ community, title }))
  }

  const openGroup = (g) => { if (typeof onOpenGroup === 'function') onOpenGroup(g) }
  const canInfo = info !== null && typeof onOpenInfo === 'function'
  const openInfo = () => onOpenInfo(community)

  const confirmBox = confirm
    ? (
      <View style={styles.block}>
        <Soft>{confirm.text}</Soft>
        <View style={styles.inline}>
          <Btn label={confirm.label} danger onPress={() => confirm.run()} pending={act.pending} />
          <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} />
        </View>
      </View>
      )
    : null

  const checkBox = check
    ? (
      <View style={styles.block}>
        <ErrorText>{UNCERTAIN}</ErrorText>
        <Pill label='conferir' onPress={() => { setCheck(null); load() }} />
      </View>
      )
    : null

  let body
  const fromIndex = needIndex && idx.status === 'done'
  if (fromIndex) {
    body = (
      <View>
        <JoinCard
          title={title}
          header={[COMMUNITY_JOIN_LABELS[idx.join] || '', membersLabel(idx.members)].filter(Boolean).join(' · ')}
          join={idx.join}
          showJoin={joinNote === ''}
          onJoin={doJoin}
          pending={join.pending}
          offline={offline}
          error={join.error}
          note={joinNote}
        />
        {checkBox}
        <View style={styles.block}>
          {idx.partial ? <Soft>O índice ainda está sendo atualizado; a lista pode estar incompleta.</Soft> : null}
          <View style={styles.inline}>
            <Btn label='Compartilhar' onPress={share} secondary />
          </View>
          {shareNote ? <Soft>{shareNote}</Soft> : null}
        </View>
        <SectionHeader>Grupos</SectionHeader>
        {idx.groups.length === 0
          ? <View style={styles.block}><Soft>Nenhum grupo ainda.</Soft></View>
          : idx.groups.map((g) => (
            <GroupRow
              key={g.group}
              title={typeof g.name === 'string' ? displayText(g.name) : PRIVATE_LABEL}
              detail={membersLabel(g.writerCount) || 'grupo privado'}
              onPress={() => openGroup(g.group)}
            />
          ))}
      </View>
    )
  } else if (info === null && loadError && idx.status === 'loading') {
    body = <Skeleton />
  } else if (info === null && loadError) {
    body = <ErrorState message={idx.status === 'error' ? idx.error : loadError} onRetry={() => { load(); loadIndex() }} pending={loading} />
  } else if (info === null) {
    body = <Skeleton />
  } else {
    const joinable = !isMember && role !== 'banned' && role !== 'requested' && !pending && info.leavePending !== true
    body = (
      <View>
        {joinable
          ? (
            <JoinCard
              title={title}
              header={[COMMUNITY_JOIN_LABELS[info.join] || '', membersLabel(info.members), adminsLabel(info.admins)].filter(Boolean).join(' · ')}
              join={info.join}
              showJoin={joinNote === ''}
              onJoin={doJoin}
              pending={join.pending}
              offline={offline}
              error={join.error}
              note={joinNote}
            />
            )
          : null}
        <View style={styles.block}>
          {joinable ? null : <ErrorText>{join.error}</ErrorText>}
          <ErrorText>{act.error}</ErrorText>
          {joinNote && !joinable ? <Soft>{joinNote}</Soft> : null}
          {role === 'requested' ? <Soft>Pedido enviado: aguardando aprovação de um administrador.</Soft> : null}
          {pending ? <Soft>Aguardando a sincronização desta comunidade.</Soft> : null}
          {!pending && info.incomplete === true ? <Soft>Alguns grupos ainda não chegaram a este aparelho; a lista pode estar incompleta.</Soft> : null}
          {loadError ? <ErrorText>{loadError}</ErrorText> : null}
        </View>
        {checkBox}
        {confirmBox}
        <SectionHeader>Grupos</SectionHeader>
        {ordered.length === 0
          ? <View style={styles.block}><Soft>Nenhum grupo ainda.</Soft></View>
          : ordered.map((g) => {
            const name = typeof g.name === 'string' && g.name !== '' ? displayText(g.name) : (g.general === true ? GENERAL_LABEL : PRIVATE_LABEL)
            const last = g.last && typeof g.last === 'object' ? g.last : null
            const line = lastLine(last)
            const detail = line !== '' ? line : [g.general === true ? 'grupo principal' : '', visibilityLabel(g.visibility), g.role ? roleLabel(g.role) : 'Entrar'].filter(Boolean).join(' · ')
            const time = last !== null && typeof last.at === 'string' ? relativeTime(last.at, now) : ''
            const unread = unreadLabel(g.unread)
            if (info.repair !== true || g.general === true) return <GroupRow key={g.group} title={name} detail={detail} time={time} unread={unread} onPress={() => openGroup(g.group)} />
            return (
              <View key={g.group}>
                <GroupRow title={name} detail={detail} time={time} unread={unread} onPress={() => openGroup(g.group)} />
                <View style={[styles.block, styles.inline]}>
                  <Pill label='Tirar da lista' danger pending={act.pending} disabled={offline} onPress={() => setConfirm({ text: DROP_GROUP_TEXT, label: 'Tirar da lista', run: () => mutate('community.removeGroup', { community, group: g.group }) })} />
                </View>
              </View>
            )
          })}
        {dropped.length > 0
          ? (
            <View>
              <SectionHeader>Tirados da lista</SectionHeader>
              {dropped.map((g) => (
                <View key={g}>
                  <GroupRow title={typeof droppedNames[g] === 'string' ? displayText(droppedNames[g]) : DROPPED_LABEL} onPress={() => openGroup(g)} />
                  <View style={[styles.block, styles.inline]}>
                    <Pill label='Devolver à lista' pending={act.pending} disabled={offline} onPress={() => setConfirm({ text: UNDROP_GROUP_TEXT, label: 'Devolver à lista', run: () => mutate('community.removeGroup', { community, group: g, undo: true }) })} />
                  </View>
                </View>
              ))}
            </View>
            )
          : null}
        {canCreate
          ? (
            <View style={styles.block}>
              <Btn label='Novo grupo' onPress={() => setNewGroup(true)} disabled={offline} />
            </View>
            )
          : null}
        {staff && offline ? <View style={styles.block}><Soft>Sem internet: conecte-se para alterar a comunidade.</Soft></View> : null}
      </View>
    )
  }

  const subtitle = pending
    ? 'Aguardando a sincronização'
    : (info !== null && Number.isSafeInteger(info.members) ? membersLabel(info.members) : '') || 'Comunidade'

  return (
    <View style={styles.root}>
      <TopBar
        title={pending ? 'Comunidade ainda chegando' : title}
        subtitle={subtitle}
        onBack={onBack}
        leading={<Avatar name={title} publicKey={community} size={36} />}
        onTitlePress={canInfo ? openInfo : undefined}
        titleLabel={INFO_LABEL}
        right={canInfo
          ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={INFO_LABEL}
              hitSlop={10}
              onPress={openInfo}
              style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
            >
              <Text style={styles.gearText}>⋯</Text>
            </Pressable>
            )
          : null}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        keyboardShouldPersistTaps='handled'
        refreshControl={<RefreshControl refreshing={loading && info !== null} onRefresh={load} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {body}
      </ScrollView>
      <NovoGrupo
        community={community}
        visible={newGroup}
        onClose={() => { setNewGroup(false); load() }}
        onCreated={(group) => {
          setNewGroup(false)
          load()
          if (typeof group === 'string') openGroup(group)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pressed: { opacity: 0.6 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { ...type.postName, color: colors.ink, flex: 1 },
  handle: { ...type.postMeta, color: colors.soft },
  time: { fontSize: 12, color: colors.soft },
  grow: { flex: 1 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 12, fontWeight: '600', color: colors.accentInk },
  gear: { paddingHorizontal: 6 },
  gearText: { fontSize: 22, color: colors.ink },
  hitText: { flex: 1 }
})
