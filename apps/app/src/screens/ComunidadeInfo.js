// Informações da comunidade (community.info, docs/rpc.md 5.59), opened from
// the community's top bar: its picture, name and meta line, then the actions
// that apply today (Compartilhar for everyone; Sair da comunidade, Desistir do
// pedido or Concluir saída; Convidar by @nome when the role may), and rows
// that open the management panels: Membros and Pedidos for the creator and
// admins, Quem pode convidar, and the creator's Ajustes (rename, Entrada,
// Administradores by @nome among the members). Joining stays on the list
// screen. A second device without its writer here has no Sair (it would
// change nothing), and controls this device cannot sign for give way to one
// note. A mutation that comes back uncertain is never resent: the screen
// re-reads and only then lets the person try again.
// Props: community (hex64 root key), onBack(), onOpenMember(diary).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc, { isKey } from '@varanda/rpc'
import { useNode } from '../node'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { classifyFollowInput, PARTIAL_KEY_TEXT } from '../followInput'
import { communityLink } from '../groupLink'
import { inviteText } from '../inviteMessage'
import { origin, shareCommunity } from '../communityShare'
import { useMemberSearch } from '../useMemberSearch'
import { whoOf } from '../who'
import { shortKey } from '../format'
import {
  COMMUNITY_JOIN_LABELS, DEVICE_ROOT_TEXT, DEVICE_STAFF_TEXT,
  authorityHere, can, deviceStaffNote, membersLabel, rootAdminHere, roleLabel, writerOnDevice
} from '../groups'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { InviteByName } from '../ui/InviteByName'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { NAME_MAX, nameLength } from './NovoGrupo'
import { WEB_ONLY_MESSAGE } from './Comunidades'

const { displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const PAGE = 100
const NOT_FOUND = '@nome não encontrado.'
const NOT_MEMBER = 'Essa pessoa ainda não é membro da comunidade.'
const LEAVE_TEXT = 'Sair da comunidade encerra sua participação em todos os grupos dela.'
// The root loses its powers after the creator's first confirmed leave, even if they return.
const CREATOR_LEAVE_TEXT = LEAVE_TEXT + ' Você criou esta comunidade: depois de sair, não poderá mais nomear administradores nem criar grupos, mesmo que volte. Ao voltar, ainda poderá mudar o nome e a entrada, tirar grupos da lista e tirar o cargo de administradores.'
const WITHDRAW_TEXT = 'Desistir do pedido retira seu pedido de entrada nesta comunidade.'
const FINISH_LEAVE_TEXT = 'Sua saída desta comunidade foi interrompida antes de terminar. Concluir a saída grava o que falta.'
const GROUPS_WAIT = 'aguarde a sincronização dos grupos da comunidade para sair'
const FORCE_LEAVE_TEXT = 'Alguns grupos desta comunidade ainda não chegaram a este aparelho. Sair mesmo assim? Nesses grupos, o que você fez como criador antes deixa de valer.'
const ROOT_WAIT = 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair'
const ROOT_FORCE_LEAVE_TEXT = 'Este aparelho ainda não baixou tudo desta comunidade. Sair mesmo assim? O que ainda não chegou aqui não vai contar.'
// The creator's leave waits for the community's own data, its other devices
// and the group roots its diary bound; the person may leave anyway.
const DEVICES_WAIT = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'
const DEVICES_FORCE_LEAVE_TEXT = 'Outro aparelho seu ainda não terminou de sincronizar esta comunidade. Sair mesmo assim? O que ele fez e ainda não chegou aqui pode deixar de valer.'
// Each wait of the creator's leave, by its name in community.leave's force.
const LEAVE_WAITS = { root: [ROOT_WAIT, ROOT_FORCE_LEAVE_TEXT], devices: [DEVICES_WAIT, DEVICES_FORCE_LEAVE_TEXT], groups: [GROUPS_WAIT, FORCE_LEAVE_TEXT] }
const leaveWaitOf = (err) => {
  if (!err || err.code !== 'USAGE' || err.uncertain === true) return null
  return Object.keys(LEAVE_WAITS).find((name) => LEAVE_WAITS[name][0] === err.message) || null
}

function adminsLabel (n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return n === 1 ? '1 administrador' : n + ' administradores'
}

function personName (row) {
  const n = typeof row.name === 'string' ? displayText(row.name).trim() : ''
  if (n) return n
  const u = typeof row.username === 'string' ? displayText(row.username).trim() : ''
  return u ? '@' + u : shortKey(row.member || '')
}

// A row that opens or closes one panel in place.
function PanelRow ({ label, open, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
    >
      <Text style={styles.name} numberOfLines={1}>{label}</Text>
      <View style={open ? styles.chevronOpen : null}><Icon name='seta' size={20} color={colors.soft} /></View>
    </Pressable>
  )
}

export function ComunidadeInfo ({ community, onBack, onOpenMember }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const hosted = node.hosted === true
  const bottomPad = useBottomPad()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [ownKey, setOwnKey] = useState(null)
  const [adminInput, setAdminInput] = useState('')
  const [adminNote, setAdminNote] = useState('')
  // Who the typed key or @nome resolved to, shown before the grant.
  const [candidate, setCandidate] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [localError, setLocalError] = useState('')
  const [shareNote, setShareNote] = useState('')
  const [granting, setGranting] = useState(null)
  const [adminUncertain, setAdminUncertain] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [check, setCheck] = useState(null)
  const [inviting, setInviting] = useState(false)
  // 'policy' or 'settings': the open panel that needs no list.
  const [section, setSection] = useState(null)
  const [panel, setPanel] = useState(null)
  const [people, setPeople] = useState({ rows: [], total: 0, loading: false, error: '' })
  const [nameDraft, setNameDraft] = useState('')
  const admin = useAction()
  const act = useAction()
  const resolveGen = useRef(0)
  const peopleGen = useRef(0)
  const gen = useRef(0)
  const panelRef = useRef(null)
  const loadPeopleRef = useRef(null)
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

  const search = useMemberSearch({ request: node.request, hosted, online: node.online !== false, ownKey })

  useEffect(() => {
    if (!hosted) return
    load()
    requestRef.current('node.info', {}).then((i) => {
      setOwnKey(i && typeof i.publicKey === 'string' ? i.publicKey : null)
    }).catch(() => {})
  }, [hosted, load])

  // groups.changed also names communities: a pending or incomplete answer
  // fills in when the data arrives.
  const version = node.getGroupVersion(community)
  const lastVersion = useRef(version)
  useEffect(() => {
    if (!hosted || version === lastVersion.current) return
    lastVersion.current = version
    load()
    if (panelRef.current) loadPeopleRef.current(panelRef.current)
  }, [hosted, version, load])

  const role = info && typeof info.role === 'string' ? info.role : null
  const isMember = role === 'creator' || role === 'admin' || role === 'member'
  const staff = isMember && (role === 'creator' || role === 'admin')
  const owner = role === 'creator'
  const rootOk = rootAdminHere(info)
  const authOk = authorityHere(info)
  const staffNote = deviceStaffNote(info, { owner, staff })

  const loadPeople = useCallback(async (kind, offset = 0) => {
    const mine = ++peopleGen.current
    setPeople((p) => ({ ...p, loading: true, error: '' }))
    try {
      const res = await requestRef.current(kind === 'members' ? 'community.members' : 'community.requests', { community, offset, limit: PAGE })
      if (mine !== peopleGen.current) return
      const rows = Array.isArray(res && (kind === 'members' ? res.members : res.requests)) ? (kind === 'members' ? res.members : res.requests) : []
      setPeople((p) => ({ rows: offset === 0 ? rows : p.rows.concat(rows), total: Number.isSafeInteger(res && res.total) ? res.total : rows.length, loading: false, error: '' }))
    } catch (err) {
      if (mine === peopleGen.current) setPeople((p) => ({ ...p, loading: false, error: errorText(err) }))
    }
  }, [community])

  panelRef.current = panel
  loadPeopleRef.current = loadPeople

  const openPanel = (kind) => {
    setConfirm(null)
    if (panel === kind) {
      setPanel(null)
      return
    }
    setPanel(kind)
    setPeople({ rows: [], total: 0, loading: true, error: '' })
    loadPeople(kind)
  }

  const openSection = (kind) => setSection((s) => (s === kind ? null : kind))

  // Whether `member` is a live member of the community: pages through
  // community.members, so a large community is not misjudged.
  const isCommunityMember = async (member) => {
    for (let offset = 0; ; offset += PAGE) {
      const res = await requestRef.current('community.members', { community, offset, limit: PAGE })
      const rows = Array.isArray(res && res.members) ? res.members : []
      if (rows.some((r) => r && r.member === member && r.banned !== true)) return true
      const total = Number.isSafeInteger(res && res.total) ? res.total : 0
      if (rows.length === 0 || offset + rows.length >= total) return false
    }
  }

  // `onGroupsWait`, when given, replaces the error of a creator leave that
  // waits (nothing was written) with a second confirmation, given the wait's
  // name in community.leave's force.
  const mutate = async (method, params, after, onGroupsWait) => {
    setCheck(null)
    setConfirm(null)
    let waited = null
    const res = await act.run(async () => {
      try {
        return await requestRef.current(method, params)
      } catch (err) {
        const wait = onGroupsWait ? leaveWaitOf(err) : null
        // A wait already accepted is an error, never a second prompt.
        if (wait === null || (Array.isArray(params.force) && params.force.includes(wait))) throw err
        waited = wait
        return null
      }
    })
    if (waited !== null) {
      onGroupsWait(waited)
      return res
    }
    if (res.ok) {
      if (after) after()
      load()
      if (panel) loadPeople(panel)
      return res
    }
    if (res.uncertain) {
      // The change may or may not have landed: re-read and let the person decide.
      setCheck(true)
      load()
      if (panel) loadPeople(panel)
    }
    return res
  }

  // Each "Sair mesmo assim" skips only the wait it answered: the next one
  // asks again, and a wait already accepted never prompts twice.
  // A member who left loses the invite form and the open panels with the role.
  const leaveWith = (accepted) => mutate('community.leave', accepted.length > 0 ? { community, force: accepted } : { community }, () => { setInviting(false); setSection(null); setPanel(null) }, (wait) => setConfirm({
    text: LEAVE_WAITS[wait][1],
    label: 'Sair mesmo assim',
    run: () => leaveWith([...accepted, wait])
  }))
  const leave = () => leaveWith([])
  const rename = () => mutate('community.meta', { community, name: nameDraft.trim() }, () => setNameDraft(''))
  const setInvitePolicy = (members) => mutate('community.invitePolicy', { community, members })
  const setJoinMode = (mode) => mutate('community.meta', { community, join: mode })

  if (!hosted) {
    return (
      <View style={styles.root}>
        <TopBar title='Informações' onBack={onBack} />
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
      </View>
    )
  }

  const offline = node.online === false
  const pending = info !== null && info.state === 'pending'
  const title = info && typeof info.name === 'string' && info.name !== '' ? displayText(info.name) : 'Comunidade'

  const cls = classifyFollowInput(adminInput)
  const searchable = cls.kind === 'name' || cls.kind === 'handle'
  const hits = search.hits.filter((h) => h.author !== ownKey)
  const newName = nameDraft.trim()
  const nameOk = newName !== '' && nameLength(newName) <= NAME_MAX && (!info || newName !== info.name)

  const typeAdmin = (t) => {
    setAdminInput(t)
    setAdminUncertain(false)
    setAdminNote('')
    setCandidate(null)
    setLocalError('')
    resolveGen.current++
    setResolving(false)
    admin.clearError()
    const c = classifyFollowInput(t)
    search.setQuery(c.kind === 'name' || c.kind === 'handle' ? t : '')
  }

  // A key or @nome becomes a candidate first; the grant waits for a tap.
  const findPerson = async () => {
    setLocalError('')
    setAdminNote('')
    if (cls.kind === 'key') return setCandidate({ member: cls.key, label: shortKey(cls.key) })
    if (cls.kind !== 'handle') return
    const name = isUsername(cls.handle)
    if (name === null) return setLocalError('@nome inválido')
    const mine = ++resolveGen.current
    setResolving(true)
    try {
      const found = await lookupUsername(name)
      if (mine !== resolveGen.current) return
      // Same-origin data, not a signature check: only a consistent answer.
      if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) {
        setLocalError(NOT_FOUND)
      } else {
        setCandidate({ member: found.member, label: '@' + displayText(name) })
      }
    } catch (err) {
      if (mine === resolveGen.current) setLocalError(errorText(err))
    } finally {
      if (mine === resolveGen.current) setResolving(false)
    }
  }

  // Only a member can be made admin: anyone else is refused here and nothing
  // is sent.
  const grant = async (member, label) => {
    if (!HEX64.test(member) || offline || adminUncertain) return
    setAdminNote('')
    setLocalError('')
    setGranting(member)
    try {
      let member0
      try {
        member0 = await isCommunityMember(member)
      } catch (err) {
        setLocalError(errorText(err))
        return
      }
      if (!member0) {
        setLocalError(NOT_MEMBER)
        return
      }
      const res = await admin.run(() => node.request('community.admin', { community, member, on: true }))
      if (res.ok) {
        setAdminInput('')
        setCandidate(null)
        search.clear()
        setAdminNote(label + ' agora é administrador.')
        load()
        return
      }
      if (res.uncertain) {
        // The count alone cannot tell whether this grant landed: re-read and
        // leave a new attempt to the person.
        setAdminUncertain(true)
        load()
      }
    } finally {
      setGranting(null)
    }
  }

  const share = async () => {
    setShareNote('')
    setShareNote(await shareCommunity({ community, title }))
  }

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
  if (info === null && loadError) {
    body = <ErrorState message={loadError} onRetry={load} pending={loading} />
  } else if (info === null) {
    body = <Skeleton />
  } else {
    // A pending answer knows only the key: its zero counts and 'pending' role
    // are placeholders, not meta. Compartilhar still works from the key.
    const header = pending ? '' : [COMMUNITY_JOIN_LABELS[info.join] || '', membersLabel(info.members), adminsLabel(info.admins), roleLabel(role)].filter(Boolean).join(' · ')
    const canInvite = node.hosted && can('invite', role, { memberInvite: info.memberInvite === true })
    body = (
      <View>
        <View style={styles.head}>
          <Avatar name={title} publicKey={community} size={96} />
          <Text style={styles.title} accessibilityRole='header'>{pending ? 'Comunidade ainda chegando' : title}</Text>
          {header ? <Soft>{header}</Soft> : null}
        </View>
        <View style={styles.block}>
          <View style={styles.inline}>
            <Btn label='Compartilhar' onPress={share} secondary />
            {(isMember || role === 'requested') && writerOnDevice(info)
              ? <Btn label={isMember ? 'Sair da comunidade' : 'Desistir do pedido'} danger secondary pending={act.pending} onPress={() => setConfirm({ text: isMember ? (owner ? CREATOR_LEAVE_TEXT : LEAVE_TEXT) : WITHDRAW_TEXT, label: isMember ? 'Sair' : 'Desistir', run: leave })} />
              : null}
            {info.leavePending === true
              ? <Btn label='Concluir saída' danger secondary pending={act.pending} onPress={() => setConfirm({ text: FINISH_LEAVE_TEXT, label: 'Concluir saída', run: () => mutate('community.leave', { community }) })} />
              : null}
            {canInvite ? <Btn label='Convidar' onPress={() => setInviting((v) => !v)} secondary /> : null}
          </View>
          <ErrorText>{act.error}</ErrorText>
          {role === 'requested' ? <Soft>Pedido enviado: aguardando aprovação de um administrador.</Soft> : null}
          {shareNote ? <Soft>{shareNote}</Soft> : null}
          {pending ? <Soft>Aguardando a sincronização desta comunidade.</Soft> : null}
          {loadError ? <ErrorText>{loadError}</ErrorText> : null}
        </View>
        {checkBox}
        {confirmBox}
        {canInvite && inviting
          ? (
            <View>
              <SectionHeader>Convidar</SectionHeader>
              <InviteByName
                request={node.request}
                hosted={hosted}
                online={!offline}
                ownKey={ownKey}
                isMember={(m) => isCommunityMember(m)}
                makeText={() => {
                  const base = origin()
                  const path = communityLink(community)
                  return base === '' || path === null ? null : inviteText({ communityName: typeof info.name === 'string' ? info.name : '', link: base + path })
                }}
              />
            </View>
            )
          : null}
        {staffNote ? <View style={styles.block}><Soft>{staffNote === 'root' ? DEVICE_ROOT_TEXT : DEVICE_STAFF_TEXT}</Soft></View> : null}
        {staff && authOk
          ? (
            <View>
              <SectionHeader>Administração</SectionHeader>
              <PanelRow label='Membros' open={panel === 'members'} onPress={() => openPanel('members')} />
              <PanelRow label='Pedidos' open={panel === 'requests'} onPress={() => openPanel('requests')} />
              {panel ? <ErrorText>{people.error}</ErrorText> : null}
              {panel === 'requests' && !people.loading && people.rows.length === 0 ? <View style={styles.block}><Soft>Nenhum pedido agora.</Soft></View> : null}
              {panel === 'requests'
                ? people.rows.map((r) => (
                  <View key={r.member} style={styles.hit}>
                    <Text style={[styles.name, styles.hitText]} numberOfLines={1}>{personName(r)}</Text>
                    <Pill label='aprovar' filled onPress={() => mutate('community.admit', { community, member: r.member, on: true })} pending={act.pending} />
                    <Pill label='recusar' onPress={() => mutate('community.admit', { community, member: r.member, on: false })} pending={act.pending} />
                  </View>
                ))
                : null}
              {panel === 'members'
                ? people.rows.map((m) => (
                  <View key={m.member} style={styles.hit}>
                    <Pressable
                      style={styles.hitText}
                      accessibilityRole='link'
                      accessibilityLabel={personName(m) + ', ver perfil'}
                      disabled={typeof onOpenMember !== 'function'}
                      onPress={() => onOpenMember(m.member)}
                    >
                      <Text style={styles.name} numberOfLines={1}>{personName(m)}</Text>
                      <Text style={styles.handle}>{m.banned ? 'banido' : (m.member === info.creator ? 'criador' : (m.admin ? 'administrador' : ''))}</Text>
                    </Pressable>
                    {m.member !== info.creator && m.member !== ownKey && !m.admin
                      ? (m.banned
                          ? <Pill label='desbanir' onPress={() => mutate('community.ban', { community, member: m.member, on: false })} pending={act.pending} />
                          : <Pill label='banir' danger pending={act.pending} onPress={() => setConfirm({ text: 'Banir ' + personName(m) + ' desta comunidade?', label: 'Banir', run: () => mutate('community.ban', { community, member: m.member, on: true }) })} />)
                      : null}
                  </View>
                ))
                : null}
              {panel && people.rows.length < people.total
                ? <View style={styles.block}><Pill label={panel === 'members' ? 'mais membros' : 'mais pedidos'} onPress={() => loadPeople(panel, people.rows.length)} pending={people.loading} /></View>
                : null}
            </View>
            )
          : null}
        {can('invitePolicy', role) && (owner ? rootOk : authOk)
          ? (
            <View>
              <PanelRow label='Quem pode convidar' open={section === 'policy'} onPress={() => openSection('policy')} />
              {section === 'policy'
                ? (
                  <View style={styles.block}>
                    <View style={styles.inline}>
                      <Pill label='Só administradores' filled={info.memberInvite !== true} onPress={() => setInvitePolicy(false)} disabled={offline || info.memberInvite !== true} />
                      <Pill label='Membros podem convidar' filled={info.memberInvite === true} onPress={() => setInvitePolicy(true)} disabled={offline || info.memberInvite === true} />
                    </View>
                    <Soft>Um convite só avisa a pessoa. Quem recebe escolhe se entra.</Soft>
                  </View>
                  )
                : null}
            </View>
            )
          : null}
        {owner && rootOk
          ? (
            <View>
              <PanelRow label='Ajustes' open={section === 'settings'} onPress={() => openSection('settings')} />
              {section === 'settings'
                ? (
                  <View>
                    <View style={styles.block}>
                      <Field label='Novo nome' value={nameDraft} onChangeText={setNameDraft} maxLength={NAME_MAX * 2} placeholder={typeof info.name === 'string' ? displayText(info.name) : ''} />
                      <Btn label='Renomear' onPress={rename} disabled={!nameOk || offline} pending={act.pending} />
                      <View style={styles.inline}>
                        <Pill label='Aberta' filled={info.join === 'open'} onPress={() => setJoinMode('open')} disabled={offline || info.join === 'open'} />
                        <Pill label='Com aprovação' filled={info.join === 'approval'} onPress={() => setJoinMode('approval')} disabled={offline || info.join === 'approval'} />
                      </View>
                    </View>
                    <View style={styles.block}>
                      <Field
                        label='Administradores'
                        placeholder='nome, @nome ou código'
                        value={adminInput}
                        onChangeText={typeAdmin}
                        maxLength={80}
                        mono
                      />
                      <Soft>Administradores da comunidade podem admitir, banir e ocultar nos grupos dela. A pessoa precisa ser membro.</Soft>
                      {cls.kind === 'partial-key' ? <Soft>{PARTIAL_KEY_TEXT}</Soft> : null}
                      {cls.kind === 'key' || cls.kind === 'handle'
                        ? <Btn label={cls.kind === 'key' ? 'Conferir pessoa' : 'Procurar @nome'} onPress={findPerson} pending={resolving} disabled={offline || adminUncertain} secondary />
                        : null}
                      {candidate
                        ? (
                          <View style={styles.inline}>
                            <Text style={styles.name} numberOfLines={1}>{candidate.label}</Text>
                            <Btn label='Tornar administrador' onPress={() => grant(candidate.member, candidate.label)} pending={granting === candidate.member} disabled={offline || adminUncertain} />
                          </View>
                          )
                        : null}
                      {localError ? <ErrorText>{localError}</ErrorText> : null}
                      {searchable && (offline || search.phase === 'offline') ? <Soft>A busca precisa de internet.</Soft> : null}
                      {searchable && search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
                      {searchable && search.phase === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
                      {search.phase === 'loading' && hits.length === 0 ? <Skeleton rows={2} /> : null}
                      {hits.map((hit) => {
                        const who = whoOf({ name: hit.name, username: hit.username })
                        const label = displayText(who.title)
                        return (
                          <View key={hit.author} style={styles.hit}>
                            <Pressable
                              style={({ pressed }) => [styles.hitWho, pressed && styles.pressed]}
                              accessibilityRole='link'
                              accessibilityLabel={'ver o perfil de ' + label}
                              disabled={typeof onOpenMember !== 'function'}
                              onPress={() => onOpenMember(hit.author, { name: hit.name, username: hit.username })}
                            >
                              <Avatar name={who.avatarName} publicKey={hit.author} size={44} />
                              <View style={styles.hitText}>
                                <Text style={styles.name} numberOfLines={1}>{label}</Text>
                                {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
                              </View>
                            </Pressable>
                            <Pill label='Tornar administrador' onPress={() => grant(hit.author, label)} pending={granting === hit.author} disabled={offline || adminUncertain || admin.pending} />
                          </View>
                        )
                      })}
                      {search.phase === 'ready' && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
                      {adminUncertain ? <ErrorText>{UNCERTAIN}</ErrorText> : <ErrorText>{admin.error}</ErrorText>}
                      {adminNote ? <Soft>{adminNote}</Soft> : null}
                    </View>
                  </View>
                  )
                : null}
            </View>
            )
          : null}
        {staff && offline ? <View style={styles.block}><Soft>Sem internet: conecte-se para alterar a comunidade.</Soft></View> : null}
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <TopBar title='Informações' onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        keyboardShouldPersistTaps='handled'
        refreshControl={<RefreshControl refreshing={loading && info !== null} onRefresh={() => { load(); if (panel) loadPeople(panel) }} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.card} />}
      >
        {body}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: { alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 },
  title: { ...type.barTitle, color: colors.ink, textAlign: 'center' },
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  pressed: { opacity: 0.6 },
  name: { ...type.postName, color: colors.ink, flex: 1 },
  handle: { ...type.postMeta, color: colors.soft },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  hitWho: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  hitText: { flex: 1 }
})
