// Comunidade: one community (community.info, docs/rpc.md 5.59). Its header
// (name, join label, members, role), an invite card with one Entrar or Pedir
// entrada button for someone who is not a member (also from the seeder
// index; a link is never consent, only the tap joins), Sair da comunidade for
// a member (Concluir saída for a creator whose leave was interrupted), and
// the groups it holds (Geral first; each opens its group). The creator and
// admins also see Novo grupo, Pedidos and Membros; the creator also has
// Ajustes (rename, Entrada, Administradores by @nome among the members).
// Compartilhar is for everyone. The link is shared, never shown as text. A
// mutation that comes back uncertain is never resent: the screen re-reads and
// only then lets the person try again.
// Props: community (hex64 root key), afterGroup (a group to open once the
// person joined, from a /g/ link), onBack(), onOpenGroup(group),
// onOpenMember(diary). The screen runs wherever the node is hosted (site and
// installed app with an installation), like the Comunidades tab.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc, { isKey } from '@varanda/rpc'
import { useNode } from '../node'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { classifyFollowInput, PARTIAL_KEY_TEXT } from '../followInput'
import { communityLink } from '../groupLink'
import { INVITE_NOTE, INVITE_NO_DM, INVITE_SENT, INVITE_UNSURE, inviteText } from '../inviteMessage'
import { installationOrigin } from '../installation'
import { canShare, copyText, shareUrl } from '../share'
import { shareNav } from '../shareNav'
import { fetchCommunity } from '../indexClient'
import { useMemberSearch } from '../useMemberSearch'
import { whoOf } from '../who'
import { shortKey } from '../format'
import { COMMUNITY_JOIN_LABELS, GENERAL_LABEL, PRIVATE_LABEL, can, membersLabel, reconcile, roleLabel, visibilityLabel } from '../groups'
import { UNSURE_SEND } from '../dm'
import { Body, Btn, Card, ErrorText, Field, SectionHeader, Soft, Title, UNCERTAIN, colors, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { shouldOpenQueued } from '../groupRedirect'
import { NAME_MAX, NovoGrupo, nameLength } from './NovoGrupo'
import { WEB_ONLY_MESSAGE } from './Comunidades'

const { displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const PAGE = 100
const NOT_FOUND = '@nome não encontrado.'
const NOT_MEMBER = 'Essa pessoa ainda não é membro da comunidade.'
const JOIN_OPEN_TEXT = 'Entre para conversar nos grupos desta comunidade.'
const JOIN_APPROVAL_TEXT = 'Peça entrada: um administrador aprova antes de você participar.'
const JOIN_PUBLIC_TEXT = 'Participar é público: sua entrada fica registrada no seu diário.'
const JOIN_PENDING_TEXT = 'Enviado. Aguardando a comunidade chegar a este aparelho.'
const JOIN_OFFLINE_TEXT = 'Sem internet: conecte-se para entrar.'
const LEAVE_TEXT = 'Sair da comunidade encerra sua participação em todos os grupos dela.'
// The root loses its powers after the creator's first confirmed leave, even if they return.
const CREATOR_LEAVE_TEXT = LEAVE_TEXT + ' Você criou esta comunidade: depois de sair, não poderá mais nomear administradores nem criar grupos, mesmo que volte. Ao voltar, ainda poderá mudar o nome e a entrada, tirar grupos da lista e tirar o cargo de administradores.'
// community.info `repair`: the creator, back after its root's powers ended, takes a group off the list.
const DROP_GROUP_TEXT = 'Tirar este grupo da lista da comunidade? Ele deixa de aparecer aqui e ninguém mais escreve nele.'
// community.info `dropped`: with `repair`, the creator puts a group it took off back.
const UNDROP_GROUP_TEXT = 'Devolver este grupo à lista da comunidade?'
const DROPPED_LABEL = 'Grupo tirado da lista'
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

// Native has no document origin. The hosted site never stores an installation.
function origin () {
  return installationOrigin() || globalThis.location?.origin || ''
}

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

function GroupRow ({ title, detail, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title}
      accessibilityHint='abre o grupo'
      onPress={onPress}
    >
      <View style={styles.icon}><Icon name='cadeira' size={24} color={colors.ink} /></View>
      <View style={styles.hitText}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={styles.handle} numberOfLines={1}>{detail}</Text> : null}
      </View>
    </Pressable>
  )
}

const NO_LINK = 'Não foi possível montar o link.'
const INVITE_SELF = 'Você já está aqui.'
const INVITE_MEMBER = 'Essa pessoa já é membro.'

// Invite by @nome through a private message (Conversas). Exported for the
// group settings, which sends its own link text through makeText. The send
// starts only from a tap: an uncertain answer keeps the same { to, text } for
// one more tap on Tentar de novo (the node re-puts the same drop, so there is
// no duplicate) and is never resent on its own.
export function InviteByName ({ request, hosted, online, ownKey, isMember, makeText }) {
  const [input, setInput] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [localError, setLocalError] = useState('')
  const [result, setResult] = useState('')
  const [held, setHeld] = useState(null)
  const send = useAction()
  const sendErr = useRef(null)
  const resolveGen = useRef(0)
  const search = useMemberSearch({ request, hosted, online, ownKey })
  const offline = !online
  const cls = classifyFollowInput(input)
  const searchable = cls.kind === 'name' || cls.kind === 'handle'
  const hits = search.hits.filter((h) => h.author !== ownKey)

  const typeInput = (t) => {
    setInput(t)
    setCandidate(null)
    setLocalError('')
    setResult('')
    setHeld(null)
    send.clearError()
    resolveGen.current++
    setResolving(false)
    const c = classifyFollowInput(t)
    search.setQuery(c.kind === 'name' || c.kind === 'handle' ? t : '')
  }

  const find = async () => {
    setLocalError('')
    setResult('')
    if (cls.kind === 'key') return setCandidate({ member: cls.key, label: shortKey(cls.key) })
    if (cls.kind !== 'handle') return
    const name = isUsername(cls.handle)
    if (name === null) return setLocalError('@nome inválido')
    const mine = ++resolveGen.current
    setResolving(true)
    try {
      const found = await lookupUsername(name)
      if (mine !== resolveGen.current) return
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

  // The one place dm.send runs, always from a tap.
  const deliver = async (to, text, checkBox) => {
    sendErr.current = null
    setHeld(null)
    setResult('')
    // A lookup still running must not bring the candidate back after the send.
    resolveGen.current++
    setResolving(false)
    const r = await send.run(async () => {
      try {
        if (checkBox) {
          // Whoever may invite does not always see the member list, so the
          // check is asked of the node; a failed check does not block the send.
          let inside = false
          if (typeof isMember === 'function') {
            try { inside = (await isMember(to)) === true } catch { inside = false }
          }
          if (inside) return 'member'
          const found = await request('dm.lookup', { member: to })
          if (!found || typeof found.box !== 'string') return 'nodm'
        }
        await request('dm.send', { to, text })
        return 'sent'
      } catch (err) {
        sendErr.current = err
        throw err
      }
    })
    const err = sendErr.current
    if (r.ok && r.value === 'nodm') return setResult(INVITE_NO_DM)
    if (r.ok && r.value === 'member') return setLocalError(INVITE_MEMBER)
    if (r.ok) {
      resolveGen.current++
      setResolving(false)
      setResult(INVITE_SENT)
      setInput('')
      setCandidate(null)
      search.clear()
      return
    }
    if (r.uncertain || (err && err.message === UNSURE_SEND)) {
      setHeld({ to, text })
      setResult(INVITE_UNSURE)
    }
  }

  const invite = (member) => {
    if (offline || send.pending) return
    setLocalError('')
    if (typeof ownKey === 'string' && member === ownKey) return setLocalError(INVITE_SELF)
    let text = null
    try { text = makeText() } catch { text = null }
    if (typeof text !== 'string' || text === '') return setLocalError(NO_LINK)
    deliver(member, text, true)
  }

  return (
    <View style={styles.block}>
      <Soft>{INVITE_NOTE}</Soft>
      <Field label='Convidar por @nome' placeholder='nome, @nome ou código' value={input} onChangeText={typeInput} maxLength={80} mono />
      {cls.kind === 'partial-key' ? <Soft>{PARTIAL_KEY_TEXT}</Soft> : null}
      {cls.kind === 'key' || cls.kind === 'handle'
        ? <Btn label={cls.kind === 'key' ? 'Conferir pessoa' : 'Procurar @nome'} onPress={find} pending={resolving} disabled={offline} secondary />
        : null}
      {candidate
        ? (
          <View style={styles.inline}>
            <Text style={styles.name} numberOfLines={1}>{candidate.label}</Text>
            <Btn label='Convidar' onPress={() => invite(candidate.member)} pending={send.pending} disabled={offline} />
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
            <View style={styles.hitWho}>
              <Avatar name={who.avatarName} publicKey={hit.author} size={44} />
              <View style={styles.hitText}>
                <Text style={styles.name} numberOfLines={1}>{label}</Text>
                {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
              </View>
            </View>
            <Pill label='Convidar' onPress={() => invite(hit.author)} pending={send.pending} disabled={offline || send.pending} />
          </View>
        )
      })}
      {search.phase === 'ready' && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
      {held ? <Btn label='Tentar de novo' onPress={() => deliver(held.to, held.text, false)} pending={send.pending} disabled={offline} secondary /> : null}
      {held ? null : <ErrorText>{send.error}</ErrorText>}
      {result ? <Soft>{result}</Soft> : null}
    </View>
  )
}

function personName (row) {
  const n = typeof row.name === 'string' ? displayText(row.name).trim() : ''
  if (n) return n
  const u = typeof row.username === 'string' ? displayText(row.username).trim() : ''
  return u ? '@' + u : shortKey(row.member || '')
}

export function Comunidade ({ community, afterGroup, onBack, onOpenGroup, onOpenMember }) {
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
  const [joinNote, setJoinNote] = useState('')
  // The seeder index's view, for someone whose node holds nothing of this
  // community yet: { status, name, groups, partial, join, members, error }.
  const [idx, setIdx] = useState({ status: 'idle', name: '', groups: [], partial: false, join: null, members: null, error: '' })
  const idxGen = useRef(0)
  const [granting, setGranting] = useState(null)
  const [adminUncertain, setAdminUncertain] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [check, setCheck] = useState(null)
  const [newGroup, setNewGroup] = useState(false)
  const [panel, setPanel] = useState(null)
  const [people, setPeople] = useState({ rows: [], total: 0, loading: false, error: '' })
  const [nameDraft, setNameDraft] = useState('')
  const [droppedNames, setDroppedNames] = useState({})
  const admin = useAction()
  const act = useAction()
  const join = useAction()
  const resolveGen = useRef(0)
  const peopleGen = useRef(0)
  const gen = useRef(0)
  const queued = useRef(afterGroup || null)
  // The role the first answer showed: a queued group opens only after a join.
  const firstRole = useRef(null)
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
  const canCreate = isMember && can('create', role)
  const owner = role === 'creator'
  const dropped = info && info.repair === true && Array.isArray(info.dropped) ? info.dropped.filter((g) => typeof g === 'string' && HEX64.test(g)) : []
  const droppedKey = dropped.join(',')

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

  // Each "Sair mesmo assim" skips only the wait it answered: the next one
  // asks again, and a wait already accepted never prompts twice.
  // A join note from earlier in this visit would sit next to the card's Entrar after leaving.
  const leaveWith = (accepted) => mutate('community.leave', accepted.length > 0 ? { community, force: accepted } : { community }, () => setJoinNote(''), (wait) => setConfirm({
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
  const groups = info && Array.isArray(info.groups) ? info.groups : []
  const ordered = groups.filter((g) => g.general === true).concat(groups.filter((g) => g.general !== true))

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

  // The system share sheet when there is one, else a copy. The link is never
  // shown as text.
  const shareCommunity = async () => {
    const path = communityLink(community)
    if (path === null) return
    const base = origin()
    // An empty origin would hand the share sheet a relative path.
    if (base === '') {
      setShareNote('Não foi possível copiar o link.')
      return
    }
    const url = base + path
    const nav = shareNav()
    setShareNote('')
    if (canShare(nav) && (await shareUrl(nav, { url, title: title === 'Comunidade' ? 'Varanda' : title })) !== 'failed') return
    setShareNote((await copyText(nav, url)) ? 'Link copiado.' : 'Não foi possível copiar o link.')
  }

  const openGroup = (g) => { if (typeof onOpenGroup === 'function') onOpenGroup(g) }

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
            <Btn label='Compartilhar' onPress={shareCommunity} secondary />
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
    const header = [COMMUNITY_JOIN_LABELS[info.join] || '', membersLabel(info.members), adminsLabel(info.admins), roleLabel(role)].filter(Boolean).join(' · ')
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
          {header && !joinable ? <Soft>{header}</Soft> : null}
          <View style={styles.inline}>
            {isMember || role === 'requested'
              ? <Btn label={isMember ? 'Sair da comunidade' : 'Desistir do pedido'} danger secondary pending={act.pending} onPress={() => setConfirm({ text: isMember ? (owner ? CREATOR_LEAVE_TEXT : LEAVE_TEXT) : WITHDRAW_TEXT, label: isMember ? 'Sair' : 'Desistir', run: leave })} />
              : null}
            {info.leavePending === true
              ? <Btn label='Concluir saída' danger secondary pending={act.pending} onPress={() => setConfirm({ text: FINISH_LEAVE_TEXT, label: 'Concluir saída', run: () => mutate('community.leave', { community }) })} />
              : null}
            <Btn label='Compartilhar' onPress={shareCommunity} secondary />
          </View>
          {joinable ? null : <ErrorText>{join.error}</ErrorText>}
          <ErrorText>{act.error}</ErrorText>
          {joinNote && !joinable ? <Soft>{joinNote}</Soft> : null}
          {role === 'requested' ? <Soft>Pedido enviado: aguardando aprovação de um administrador.</Soft> : null}
          {shareNote ? <Soft>{shareNote}</Soft> : null}
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
            const detail = [g.general === true ? 'grupo principal' : '', visibilityLabel(g.visibility), g.role ? roleLabel(g.role) : 'Entrar'].filter(Boolean).join(' · ')
            if (info.repair !== true || g.general === true) return <GroupRow key={g.group} title={name} detail={detail} onPress={() => openGroup(g.group)} />
            return (
              <View key={g.group}>
                <GroupRow title={name} detail={detail} onPress={() => openGroup(g.group)} />
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
        {staff
          ? (
            <View>
              <SectionHeader>Administração</SectionHeader>
              <View style={[styles.block, styles.inline]}>
                <Pill label='Pedidos' filled={panel === 'requests'} onPress={() => openPanel('requests')} />
                <Pill label='Membros' filled={panel === 'members'} onPress={() => openPanel('members')} />
              </View>
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
        {node.hosted && can('invite', role, { memberInvite: info.memberInvite === true })
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
        {can('invitePolicy', role)
          ? (
            <View>
              <SectionHeader>Quem pode convidar</SectionHeader>
              <View style={styles.block}>
                <View style={styles.inline}>
                  <Pill label='Só administradores' filled={info.memberInvite !== true} onPress={() => setInvitePolicy(false)} disabled={offline || info.memberInvite !== true} />
                  <Pill label='Membros podem convidar' filled={info.memberInvite === true} onPress={() => setInvitePolicy(true)} disabled={offline || info.memberInvite === true} />
                </View>
                <Soft>Um convite só avisa a pessoa. Quem recebe escolhe se entra.</Soft>
              </View>
            </View>
            )
          : null}
        {owner
          ? (
            <View>
              <SectionHeader>Ajustes</SectionHeader>
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
        {staff && offline ? <View style={styles.block}><Soft>Sem internet: conecte-se para alterar a comunidade.</Soft></View> : null}
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <TopBar title={title} subtitle='Comunidade' onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        keyboardShouldPersistTaps='handled'
        refreshControl={<RefreshControl refreshing={loading && info !== null} onRefresh={() => { load(); if (panel) loadPeople(panel) }} tintColor={colors.accent} colors={[colors.accent]} />}
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
  name: { ...type.postName, color: colors.ink, flex: 1 },
  handle: { ...type.postMeta, color: colors.soft },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  hitWho: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  hitText: { flex: 1 }
})
