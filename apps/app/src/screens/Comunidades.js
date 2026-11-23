// Comunidades: browse and create, pushed over the Conversas tab from its
// Comunidades row (nav 'comunidades'). Minhas comunidades from community.list
// (rpc 5.62), Descobrir and the Nova comunidade sheet (also opened from the
// Conversas "+" sheet, hence the export). Descobrir lists public communities
// and public groups without a community, never a community's groups (the
// person reaches those inside the community): one search through
// /index/discover/search (private roots never appear there) answers in two
// lists, and while it is empty the community shelves come before the group
// shelves (../useGroupShelves.js). There is no paste field: a /c/ or /g/ link
// opens its screen (App.js). There is no "Novo grupo" here: a group is made
// inside a community or from the Conversas "+" sheet. Hosted node only: a node that is not hosted
// says Comunidades are unavailable, as Grupo does, and calls nothing.
// Props: onBack, onOpenGroup(group), onOpenCommunity(community); both take a
// hex64 root key. onOpenCommunity also opens a community just made.
// Minhas comunidades paints the stored 'comunidades' snapshot
// (../screenSnapshot.js) until community.list answers, only for the member
// acting as the member.

import { pictureProps } from '../groupImage'
import { imageAfterCreate, words as imageWords } from '../groupImageCreate'
import { pickImage } from '../media/attach'
import { openImage } from '../media/avatarEncode'
import { AVATAR_SIDE, MAX_AVATAR_BYTES, checkAvatarBytes } from '../media/avatar'
import { AvatarEditor } from '../ui/AvatarEditor'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { perfMarks, useNode } from '../node'
import { cacheGeneration } from '../localCaches'
import { buildScreenSnapshot } from '../screenSnapshot'
import { clearScreenSnapshot, loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'
import { fetchDiscoverSearch, fetchGroupImages } from '../indexClient'
import { queryPath } from '../search'
import { COMMUNITY_JOIN_LABELS, PAGE_EMPTY_TEXT, PUBLIC_LABEL, membersLabel, pageCommunities, pageErrorText, pageMode, pageRoleOf, roleLabel } from '../groups'
import { pagesOn } from '../pageGate'
import { actAs } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { liveBinding } from './ARua'
import { Btn, ErrorText, Field, Label, SectionHeader, Soft, UNCERTAIN, errorText, useBottomPad } from '../ui'
import { refusalOf } from '../wordCheck'
import { Avatar } from '../ui/Avatar'
import { Badge } from '../ui/Badge'
import { PressScale } from '../ui/PressScale'
import { RefreshableList } from '../ui/RefreshableList'
import { SearchField } from '../ui/SearchField'
import { GroupShelf } from '../ui/GroupShelf'
import { CommunityShelf } from '../ui/CommunityShelf'
import { useGroupShelves } from '../useGroupShelves'
import { GROUP_LIST_LIMIT, GROUP_LIST_PAGES } from '../groupShelves'
import { EmptyState, ErrorState, SkeletonRow } from '../ui/States'
import { space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { Choice, NAME_MAX, nameLength, useEscapeClose } from './NovoGrupo'
import { KeyboardForm } from './Perfil'
import { Sheet } from '../ui/Sheet'
import { TopBar } from '../ui/TopBar'

const { displayText } = rpc

// By capability, not platform: a phone without the installation lands here too,
// so the text points at where Comunidades do work. The same words as Grupo.
export const UNAVAILABLE_TITLE = 'Comunidades indisponíveis'
export const UNAVAILABLE_MESSAGE = 'Comunidades disponíveis no site da associação ou no app ligado à instalação.'
const SEARCH_DELAY_MS = 400
const LIST_DELAY_MS = 800
const HEX64 = /^[0-9a-f]{64}$/
export const SEARCH_LABEL = 'Buscar comunidades e grupos'
export const SEARCH_EMPTY_TEXT = 'Nenhuma comunidade ou grupo público encontrado.'
export const SEARCH_UNAVAILABLE_TEXT = 'A busca ainda não está disponível.'

// The binding of the group snapshots (../screenSnapshot.js): the unlocked,
// signed in member acting as the member, bound by A Rua's rule
// (liveBinding: null in the Vitrine). A page actor reads and writes none.
export function memberSnapshotBinding ({ node, acting, pageKey }) {
  if (pageKey !== null || acting === null || typeof acting !== 'object' || acting.kind !== 'me') return null
  const st = node && node.passkey ? node.passkey.status : null
  if (st === null || typeof st !== 'object' || st.unlocked !== true || st.signedOut === true || typeof st.publicKey !== 'string') return null
  const binding = liveBinding(st.publicKey, node.config)
  return binding === null ? null : { ...binding, acting }
}

// Whether `binding` still names the identity `now` names: a lock, sign-out,
// owner change or page actor since a read began means its answer is not
// stored.
export function sameSnapshotBinding (binding, now) {
  return binding !== null && now !== null && binding.origin === now.origin &&
    binding.association === now.association && binding.owner === now.owner
}

// What sameSnapshotBinding compares, as one string ('' for none): a stable
// effect dependency for a binding rebuilt on every render.
export function bindingKeyOf (binding) {
  return binding === null || binding === undefined ? '' : binding.origin + '|' + binding.association + '|' + binding.owner
}

// -> the stored rows of `kind` for `binding`, or null when there are none.
export function readGroupSnapshot (kind, binding) {
  if (binding === null) return null
  const snapshot = loadScreenSnapshot(kind, binding)
  return snapshot === null || snapshot.body.rows.length === 0 ? null : snapshot.body.rows
}

// Stores a complete live list. `gen` is cacheGeneration() read before the
// list was asked for: a purge since then discards the write. A list the
// rules refuse removes the old snapshot instead of leaving it stale.
export function saveGroupSnapshot (kind, binding, rows, gen) {
  if (binding === null) return
  const snapshot = buildScreenSnapshot(kind, { ...binding, rows })
  if (snapshot === null) clearScreenSnapshot(kind)
  else saveScreenSnapshot(kind, snapshot, gen)
}

// A held row's explicit null is also a node answer: an index hint cannot
// restore a removed image. Pending rows only carry placeholder nulls.
// Private catalogue rows never disclose their key here.
function indexImageKey (row) {
  if (!row || row.visibility === 'private') return null
  if (row.state !== 'pending' && (Object.hasOwn(row, 'image') || Object.hasOwn(row, 'imageAuthor'))) return null
  const key = row.group || row.community
  return typeof key === 'string' && HEX64.test(key) ? key : null
}

export function indexImageRow (row, images) {
  const key = indexImageKey(row)
  const hit = key && images.get(key)
  if (!hit || !hit.image || hit.image.mime !== 'image/jpeg') return row
  const candidate = { ...row, image: hit.image, imageAuthor: hit.author }
  return pictureProps(candidate).picture ? candidate : row
}

// A missing or failed node read must not turn every hit into an index request.
export function heldSearchRows (hits, nodeRows) {
  const held = nodeRows === null ? null : new Map(nodeRows.map((row) => [row.group, row]))
  return hits.map((hit) => {
    const row = held && held.get(hit.group)
    if (held && !row) return hit
    return { ...hit, image: row?.image ?? null, imageAuthor: row?.imageAuthor ?? null }
  })
}

async function readHeldSearchGroups (request, alive) {
  const rows = []
  let offset = 0
  for (let i = 0; i < GROUP_LIST_PAGES; i++) {
    const page = await request('group.list', { offset, limit: GROUP_LIST_LIMIT })
    if (!alive()) return null
    if (page === null || typeof page !== 'object' || !Array.isArray(page.groups) || !Number.isSafeInteger(page.total) || page.total < 0) return null
    for (const row of page.groups) {
      if (row === null || typeof row !== 'object' || typeof row.group !== 'string' || typeof row.role !== 'string') return null
    }
    rows.push(...page.groups)
    offset += page.groups.length
    if (page.groups.length === 0 || offset >= page.total) break
  }
  return rows
}

// Kept apart from the rows that feed snapshots. Every page goes through the
// index client's scheduler, including a full catalogue plus its header.
export function useIndexGroupImages (node, rows, page = rows, enabled = true) {
  const active = enabled && node.hosted === true && node.online === true
  const keys = [...new Set(rows.map(indexImageKey).filter(Boolean))].join(',')
  const [state, setState] = useState(null)
  useEffect(() => {
    let alive = true
    setState(null)
    if (!active || keys === '') return
    const wanted = keys.split(',')
    ;(async () => {
      const images = new Map()
      for (let offset = 0; offset < wanted.length; offset += 32) {
        if (!alive) return
        try {
          const batch = await fetchGroupImages(wanted.slice(offset, offset + 32))
          if (!alive) return
          for (const [key, image] of batch) images.set(key, image)
        } catch {}
      }
      if (alive) setState({ page, keys, images })
    })()
    return () => { alive = false }
  }, [active, keys, page])
  return active && state && state.page === page && state.keys === keys ? state.images : new Map()
}

function communityTitle (row) {
  if (row.state !== 'ready') return 'Comunidade ainda chegando'
  return typeof row.name === 'string' && row.name !== '' ? displayText(row.name) : 'Comunidade sem nome'
}

function communitySubtitle (row) {
  // A wrap breaks before the dot, never leaves it at a line end.
  return [roleLabel(row.role), COMMUNITY_JOIN_LABELS[row.join] || ''].filter(Boolean).join(' ·\u00a0')
}

function Row ({ title, subtitle, dot, hint, seed, avatarName, image, imageAuthor, onPress, metaLines = 1 }) {
  const styles = useStyles(makeStyles)
  return (
    <PressScale
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title + (subtitle ? ', ' + subtitle : '') + (dot ? ', novidades' : '')}
      accessibilityHint={hint}
      onPress={onPress}
    >
      <Avatar name={avatarName} publicKey={seed} {...pictureProps({ image, imageAuthor })} size={48} shape='square' />
      <View style={styles.texts}>
        <Text style={[styles.name, dot && styles.nameUnread]} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.meta} numberOfLines={metaLines}>{subtitle}</Text> : null}
      </View>
      {dot ? <Badge /> : null}
    </PressScale>
  )
}

const IDLE_SEARCH = { status: 'idle', groups: [], communities: [], nodeRows: null, moreGroups: false, moreCommunities: false, indexing: false, partial: false, unavailable: false, error: '' }

// One discover search: public communities and public groups without a
// community, never a community's groups. An older seeder answers 404.
function useGroupSearch (node, text) {
  const [state, setState] = useState(IDLE_SEARCH)
  const [attempt, setAttempt] = useState(0)
  const gen = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const path = queryPath(text)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    const mine = ++gen.current
    if (path === null) {
      setState(IDLE_SEARCH)
      return
    }
    setState((s) => ({ ...s, status: 'loading', nodeRows: null, error: '' }))
    const timer = setTimeout(async () => {
      const res = await fetchDiscoverSearch(path)
      if (mine !== gen.current) return
      if (!res || !res.ok) {
        const unavailable = !!res && res.reason === 'not-found'
        const error = unavailable ? SEARCH_UNAVAILABLE_TEXT : 'Não foi possível buscar agora.'
        setState({ ...IDLE_SEARCH, status: 'error', unavailable, error })
        return
      }
      const v = res.value
      setState({ status: 'done', groups: v.groups, communities: v.communities, nodeRows: null, moreGroups: v.moreGroups === true, moreCommunities: v.moreCommunities === true, indexing: v.indexing === true, partial: v.complete === false, unavailable: false, error: '' })
      if (v.groups.length === 0) return
      let nodeRows = null
      try {
        nodeRows = await readHeldSearchGroups(requestRef.current, () => mine === gen.current)
      } catch {}
      if (mine !== gen.current) return
      setState((s) => ({ ...s, nodeRows }))
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      gen.current++
    }
  }, [path, attempt])
  return { ...state, rows: heldSearchRows(state.groups, state.nodeRows), path, retry }
}

// The search answer as headed lists, Comunidades first: a community hit
// opens Comunidade, a group hit opens Grupo. Empty lists are left out.
export function searchSections ({ communities, rows, moreCommunities, moreGroups }) {
  const out = []
  if (communities.length > 0) {
    out.push({
      id: 'communities',
      title: 'Comunidades',
      more: moreCommunities === true,
      hits: communities.map((c) => ({ key: 'c' + c.community, open: 'community', id: c.community, name: c.name, count: c.members, hint: 'abre a comunidade', row: c }))
    })
  }
  if (rows.length > 0) {
    out.push({
      id: 'groups',
      title: 'Grupos',
      more: moreGroups === true,
      hits: rows.map((g) => ({ key: 'g' + g.group, open: 'group', id: g.group, name: g.name, count: g.writerCount, hint: 'abre o grupo', row: g }))
    })
  }
  return out
}

// Nova comunidade: community.create (rpc 5.57) makes the community and its
// Geral group. An uncertain create is never resent: the list is re-read and
// the person is told to check it; only closing the sheet lifts the lock.
export function NovaComunidade ({ visible, onClose, onCreated, onUncertain }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const [name, setName] = useState('')
  const [join, setJoin] = useState('open')
  const [uncertain, setUncertain] = useState(false)
  const [hasPhoto, setHasPhoto] = useState(false)
  const [createError, setCreateError] = useState('')
  const [editor, setEditor] = useState(null)
  const [photoError, setPhotoError] = useState('')
  const [pending, setPending] = useState(false)
  const sessionRef = useRef(null)
  const release = (session) => {
    if (!session) return
    try { session.handle?.release() } catch {}
    session.handle = null
    session.picked = null
  }
  const close = () => {
    if (sessionRef.current?.busy) return
    if (sessionRef.current) sessionRef.current.open = false
    release(sessionRef.current)
    setEditor(null)
    setHasPhoto(false)
    onClose()
  }
  useEscapeClose(visible, close)

  useEffect(() => {
    if (!visible) return
    const session = { open: true, busy: false, done: false, handle: null, picked: null }
    sessionRef.current = session
    setName('')
    setJoin('open')
    setUncertain(false)
    setHasPhoto(false)
    setEditor(null)
    setPhotoError('')
    setPending(false)
    setCreateError('')
    return () => { session.open = false; release(session) }
  }, [visible])

  const trimmed = name.trim()
  const tooLong = nameLength(trimmed) > NAME_MAX
  const offline = node.online === false
  const refused = refusalOf(trimmed)
  const canPick = node.hosted === true && typeof node.media?.upload === 'function'
  const ready = trimmed.length > 0 && !tooLong && refused === '' && !offline && !uncertain && !pending && editor === null

  const cancelPhoto = () => {
    const session = sessionRef.current
    if (!session?.open || session.busy) return
    release(session)
    setHasPhoto(false)
    setEditor(null)
    setPhotoError('')
  }
  const choosePhoto = async () => {
    const session = sessionRef.current
    if (!session?.open || !canPick || offline || session.busy || session.done || session.handle) return
    session.busy = true
    setPending(true)
    setPhotoError('')
    try {
      const file = await pickImage()
      if (!file || !session.open) return
      const handle = await openImage(file)
      if (!session.open) {
        handle.release()
        return
      }
      session.handle = handle
      setEditor(handle)
    } catch (err) {
      if (session.open) setPhotoError(errorText(err))
    } finally {
      session.busy = false
      if (session.open) setPending(false)
    }
  }
  const savePhoto = async (rect) => {
    const session = sessionRef.current
    if (!session?.open || session.busy || !session.handle) return
    session.busy = true
    setPending(true)
    setPhotoError('')
    try {
      const encoded = await session.handle.encode(rect, MAX_AVATAR_BYTES, { format: 'jpeg' })
      if (!session.open) return
      if (!encoded || encoded.mime !== 'image/jpeg' || !checkAvatarBytes(encoded.bytes, { mime: encoded.mime, width: AVATAR_SIDE, height: AVATAR_SIDE })) throw new Error('Não foi possível preparar a foto.')
      release(session)
      session.picked = { bytes: encoded.bytes, mime: encoded.mime }
      setHasPhoto(true)
      setEditor(null)
    } catch (err) {
      if (session.open) setPhotoError(errorText(err))
    } finally {
      session.busy = false
      if (session.open) setPending(false)
    }
  }

  const create = async () => {
    const session = sessionRef.current
    if (!ready || !session?.open || session.busy || session.done || session.handle) return
    session.busy = true
    setPending(true)
    try {
      setCreateError('')
      const value = await node.request('community.create', { name: trimmed, join })
      if (!session.open) return
      if (value && typeof value.community === 'string' && HEX64.test(value.community)) {
        session.done = true
        const result = await imageAfterCreate({
          key: value.community,
          kind: 'community',
          picked: canPick ? session.picked : null,
          upload: (params) => node.media.upload(params),
          setImage: (method, params) => {
            if (!session.open) throw new Error('A criação foi fechada.')
            return node.request(method, params)
          }
        })
        release(session)
        if (!session.open) return
        setHasPhoto(false)
        const note = result === 'failed' || result === 'uncertain' ? imageWords.communityFailed : ''
        if (typeof onCreated === 'function') onCreated(value.community, note)
      }
    } catch (err) {
      if (!session.open) return
      setCreateError(errorText(err))
      if (err?.uncertain === true) {
        release(session)
        setHasPhoto(false)
        session.done = true
        setUncertain(true)
        if (typeof onUncertain === 'function') onUncertain()
      }
    } finally {
      session.busy = false
      if (session.open) setPending(false)
    }
  }

  const fields = editor !== null
    ? <AvatarEditor source={editor} pending={pending} error={photoError} onCancel={cancelPhoto} onConfirm={savePhoto} />
    : (
      <>
        <Field
          label='Nome'
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX * 2}
          placeholder='Nome da comunidade'
        />
        {tooLong ? <ErrorText>{'O nome pode ter até ' + NAME_MAX + ' caracteres.'}</ErrorText> : null}
        <ErrorText>{refused}</ErrorText>
        <Choice
          label='Entrada'
          value={join}
          onChange={setJoin}
          options={[{ value: 'open', label: 'Aberta' }, { value: 'approval', label: 'Com aprovação' }]}
        />
        <Soft>Até 32 grupos, já com o grupo Geral.</Soft>
        {canPick
          ? (
            <View style={styles.sheet}>
              <Label>{imageWords.communityLabel}</Label>
              <Soft>{imageWords.communityPublic}</Soft>
              {hasPhoto ? <Soft>Foto escolhida.</Soft> : null}
              <Btn label={hasPhoto ? 'Trocar foto' : 'Escolher foto'} onPress={choosePhoto} disabled={offline || pending || uncertain} secondary />
              {hasPhoto ? <Btn label='Tirar foto' onPress={cancelPhoto} disabled={pending || uncertain} secondary /> : null}
              <ErrorText>{photoError}</ErrorText>
            </View>
            )
          : null}
        {offline ? <Soft>Sem internet: conecte-se para criar a comunidade.</Soft> : null}
        {uncertain
          ? <ErrorText>{UNCERTAIN + '. Confira em Minhas comunidades antes de criar de novo.'}</ErrorText>
          : <ErrorText>{createError}</ErrorText>}
        <Btn label='Criar comunidade' onPress={create} disabled={!ready} pending={pending} />
      </>
      )

  return (
    <Sheet open={!!visible} onClose={close} dismissable={!pending} title='Nova comunidade'>
      {/* The crop editor is taller than a small phone's sheet. */}
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheet}>
        {fields}
      </ScrollView>
    </Sheet>
  )
}

export function Comunidades ({ onBack, onOpenGroup, onOpenCommunity }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true
  const acting = useActing()
  const asPage = pageMode({ acting, on: pagesOn({ hosted, accountOrigin: node.accountOrigin }) })
  const pageKey = asPage.key
  const bottomPad = useBottomPad()
  const snapshotBinding = memberSnapshotBinding({ node, acting, pageKey })
  const bindingRef = useRef(snapshotBinding)
  bindingRef.current = snapshotBinding
  // Stored rows keep loaded false: community.list still runs and replaces
  // them. Nothing unread is stored; the dots come from live versions.
  const [list, setList] = useState(() => {
    const rows = hosted ? readGroupSnapshot('comunidades', snapshotBinding) : null
    return { rows: rows === null ? [] : rows, loaded: false, loading: false, error: '', seeded: rows !== null, seedBinding: snapshotBinding }
  })
  // Stored rows read for another installation, association or owner never
  // stay, even with the same key: that store was already wiped.
  const bindingKey = bindingKeyOf(snapshotBinding)
  useEffect(() => {
    setList((l) => (l.seeded === true && !sameSnapshotBinding(l.seedBinding, bindingRef.current) ? { ...l, rows: [], seeded: false, seedBinding: null } : l))
  }, [bindingKey])
  const liveMarked = useRef(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdNotice, setCreatedNotice] = useState(null)
  const search = useGroupSearch(node, hosted ? query : '')
  const searchImages = useIndexGroupImages(node, search.rows, search.groups, search.status === 'done')
  // Community hits carry no image and have no held-row reconciliation: their
  // own page, so a group answer arriving later does not ask for them again.
  const searchCommunityImages = useIndexGroupImages(node, search.communities, search.communities, search.status === 'done')
  const communityImages = useIndexGroupImages(node, list.rows, list.rows, list.loaded)
  // The person's own diary, left out of the followed shelf's count.
  const ownKey = snapshotBinding !== null ? snapshotBinding.owner : null
  const versions = node.groupVersions
  const { shelves, communityShelves, reload: reloadShelves } = useGroupShelves({ enabled: hosted, request: node.request, pageKey, bindingKey, ownKey, groupVersions: versions })
  // The version of each community when the person last opened it (or when
  // the list first showed it), for this session only.
  const seenRef = useRef(new Map())
  const loadGen = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const nodeRef = useRef(node)
  nodeRef.current = node

  const load = useCallback(async () => {
    const mine = ++loadGen.current
    setList((l) => ({ ...l, loading: true, error: '' }))
    try {
      if (pageKey !== null) {
        // The page's own communities come from its signed status read.
        const member = await memberKeyOf(requestRef.current, nodeRef.current)
        const status = await actAs(nodeRef.current, { member, action: 'status', page: pageKey })
        if (mine !== loadGen.current) return
        const rows = pageCommunities(status).map((c) => ({ ...c, state: 'ready', role: pageRoleOf(c) === 'requested' ? 'requested' : (typeof c.role === 'string' ? c.role : 'member') }))
        setList({ rows, loaded: true, loading: false, error: '' })
        return
      }
      const gen = cacheGeneration()
      const binding = bindingRef.current
      const res = await requestRef.current('community.list', {})
      if (mine !== loadGen.current) return
      const all = Array.isArray(res && res.communities) ? res.communities : []
      const rows = all.filter((c) => c && typeof c.community === 'string' && HEX64.test(c.community))
      setList({ rows, loaded: true, loading: false, error: '' })
      if (!liveMarked.current) {
        liveMarked.current = true
        perfMarks().mark('rows-live:comunidades')
      }
      if (sameSnapshotBinding(binding, bindingRef.current)) saveGroupSnapshot('comunidades', binding, rows, gen)
    } catch (err) {
      if (mine !== loadGen.current) return
      setList((l) => ({ ...l, loading: false, error: pageKey !== null ? pageErrorText(err) : errorText(err) }))
    }
  }, [pageKey])

  const seeded = list.seeded === true
  useEffect(() => {
    if (seeded) perfMarks().mark('rows-snapshot:comunidades')
  }, [seeded])

  useEffect(() => {
    if (hosted) load()
  }, [hosted, load])

  // Roles and counts move with groups.changed: re-read the list, coalesced so
  // a burst of events costs one read.
  const firstVersions = useRef(versions)
  useEffect(() => {
    if (!hosted || versions === firstVersions.current) return
    const timer = setTimeout(load, LIST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hosted, versions, load])

  const getVersion = node.getGroupVersion
  useEffect(() => {
    for (const c of list.rows) {
      if (!seenRef.current.has(c.community)) seenRef.current.set(c.community, getVersion(c.community))
    }
  }, [list.rows, getVersion])

  // The list keeps taps while the search keyboard is up, so opening a
  // screen from it closes the keyboard first: otherwise it covers the next
  // screen and what is typed goes to the hidden search field.
  const openCommunity = useCallback((community) => {
    Keyboard.dismiss()
    seenRef.current.set(community, getVersion(community))
    if (typeof onOpenCommunity === 'function') onOpenCommunity(community)
  }, [getVersion, onOpenCommunity])

  const openGroup = useCallback((group) => {
    Keyboard.dismiss()
    if (typeof onOpenGroup === 'function') onOpenGroup(group)
  }, [onOpenGroup])

  // The icon set has no plus glyph ('mais' is the overflow dots), so the + is text.
  const plus = hosted && pageKey === null
    ? (
      <PressScale accessibilityRole='button' accessibilityLabel='Nova comunidade' onPress={() => { setCreatedNotice(null); setCreating(true) }} style={styles.plus}>
        <Text style={styles.plusText} maxFontSizeMultiplier={1.5}>+</Text>
      </PressScale>
      )
    : null
  const bar = <TopBar title='Comunidades' onBack={onBack} right={plus} />
  if (!hosted) {
    return (
      <View style={styles.root}>
        {bar}
        <EmptyState icon='cadeira' title={UNAVAILABLE_TITLE} body={UNAVAILABLE_MESSAGE} />
      </View>
    )
  }

  const sections = search.status === 'done' ? searchSections(search) : []
  const hits = sections.map((section) => (
    <View key={section.id}>
      <SectionHeader>{section.title}</SectionHeader>
      {section.hits.map((hit) => {
        const h = indexImageRow(hit.row, hit.open === 'community' ? searchCommunityImages : searchImages)
        return (
          <Row
            key={hit.key}
            title={typeof hit.name === 'string' && hit.name !== '' ? displayText(hit.name) : (hit.open === 'group' ? PUBLIC_LABEL : 'Comunidade sem nome')}
            subtitle={membersLabel(hit.count)}
            hint={hit.hint}
            seed={hit.id}
            image={h.image}
            imageAuthor={h.imageAuthor}
            avatarName={typeof hit.name === 'string' ? hit.name : null}
            onPress={() => (hit.open === 'community' ? openCommunity : openGroup)(hit.id)}
          />
        )
      })}
      {section.more ? <View style={styles.block}><Soft>Há mais resultados: refine a busca.</Soft></View> : null}
    </View>
  ))

  // Search first, like other apps: a field under a long list ends up under
  // the keyboard. Then the person's own communities.
  const mineSection = (
    <View>
      <SectionHeader>Minhas comunidades</SectionHeader>
      {list.error && list.rows.length > 0 ? <ErrorState message={list.error} onRetry={load} pending={list.loading} /> : null}
    </View>
  )

  let searchState = null
  if (search.status === 'loading') {
    searchState = <View><Soft>Buscando…</Soft>{[0, 1, 2].map((key) => <SkeletonRow key={key} />)}</View>
  } else if (search.status === 'error') {
    searchState = (
      <View>
        <ErrorText>{search.error}</ErrorText>
        {!search.unavailable ? <Btn label='Tentar de novo' onPress={() => search.retry()} /> : <Btn label='Limpar busca' onPress={() => setQuery('')} />}
      </View>
    )
  } else if (search.status === 'done') {
    if (sections.length === 0) {
      if (search.indexing) searchState = <EmptyState icon='gente' title='A busca ainda está sendo atualizada; tente de novo depois.' actionLabel='Tentar de novo' onAction={() => search.retry()} secondaryLabel='Limpar busca' onSecondary={() => setQuery('')} />
      else if (search.partial) searchState = <EmptyState icon='gente' title='Alguns resultados podem faltar' actionLabel='Limpar busca' onAction={() => setQuery('')} secondaryLabel='Tentar de novo' onSecondary={() => search.retry()} />
      else searchState = <EmptyState icon='gente' title={SEARCH_EMPTY_TEXT} actionLabel='Limpar busca' onAction={() => setQuery('')} />
    } else if (search.indexing) {
      searchState = <Soft>A busca ainda está sendo atualizada; tente de novo depois.</Soft>
    } else if (search.partial) {
      searchState = <Soft>Alguns resultados podem faltar</Soft>
    }
  }

  const discover = (
    <View>
      <SectionHeader>Descobrir</SectionHeader>
      <View style={styles.block}>
        <SearchField
          label={SEARCH_LABEL}
          value={query}
          onChangeText={setQuery}
          placeholder='Nome da comunidade ou do grupo'
        />
        {searchState}
      </View>
      {hits.length > 0 ? <View>{hits}</View> : null}
      {query.trim() === '' ? communityShelves.map((s) => <CommunityShelf key={s.id} title={s.title} orderText={s.orderText} note={s.note} items={s.items} onOpen={openCommunity} />) : null}
      {query.trim() === '' ? shelves.map((s) => <GroupShelf key={s.id} title={s.title} orderText={s.orderText} note={s.note} items={s.items} onOpen={openGroup} />) : null}
    </View>
  )

  const header = (
    <View>
      {discover}
      {mineSection}
    </View>
  )

  let empty
  if (list.error) {
    empty = <ErrorState message={list.error} onRetry={load} pending={list.loading} />
  } else if (!list.loaded) {
    empty = <View>{[0, 1, 2].map((key) => <SkeletonRow key={key} />)}</View>
  } else {
    empty = <EmptyState icon='cadeira' title='Nenhuma comunidade ainda' body={pageKey !== null ? PAGE_EMPTY_TEXT : 'Crie uma comunidade, busque uma comunidade ou um grupo público, ou abra o link de convite que alguém mandou.'} actionLabel={pageKey === null ? 'Nova comunidade' : 'Voltar'} onAction={pageKey === null ? () => { setCreatedNotice(null); setCreating(true) } : onBack} secondaryLabel={pageKey === null ? 'Voltar' : undefined} onSecondary={onBack} />
  }

  const refresh = () => {
    load()
    reloadShelves()
  }

  const renderItem = ({ item }) => {
    item = indexImageRow(item, communityImages)
    const seen = seenRef.current.has(item.community) ? seenRef.current.get(item.community) : getVersion(item.community)
    return (
      <Row
        title={communityTitle(item)}
        subtitle={communitySubtitle(item)}
        metaLines={3}
        dot={getVersion(item.community) !== seen}
        hint='abre a comunidade'
        seed={item.community}
        image={item.image}
        imageAuthor={item.imageAuthor}
        avatarName={item.state === 'ready' && typeof item.name === 'string' ? item.name : null}
        onPress={() => openCommunity(item.community)}
      />
    )
  }

  return (
    <View style={styles.root}>
      {bar}
      {createdNotice
        ? <View style={styles.block}><Soft>{createdNotice.note}</Soft><Btn label='Abrir comunidade' onPress={() => { setCreatedNotice(null); openCommunity(createdNotice.community) }} secondary /></View>
        : null}
      {/* The search sits under the list: with the keyboard open (Android
          draws edge to edge) the list must shrink so a result scrolls into
          view above it. */}
      <KeyboardForm>
        <RefreshableList
          perfId='comunidades'
          data={list.rows}
          keyExtractor={(c) => c.community}
          renderItem={renderItem}
          extraData={{ versions, getVersion, communityImages }}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={refresh}
          refreshing={list.loading && list.loaded}
          atEnd
        />
      </KeyboardForm>
      <NovaComunidade
        visible={creating}
        onClose={() => { setCreating(false); load() }}
        onUncertain={load}
        onCreated={(community, note) => {
          setCreating(false)
          load()
          setCreatedNotice(note ? { community, note } : null)
          if (!note) openCommunity(community)
        }}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  block: { paddingHorizontal: space.lg, paddingVertical: 10, gap: space.sm },
  sheet: { padding: 16, gap: 12 },
  plus: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 28, lineHeight: 32, fontWeight: '400', color: colors.ink },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 72,
    paddingVertical: 10,
    paddingHorizontal: space.lg
  },
  pressed: { backgroundColor: colors.line },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...type.postName, fontSize: 16, fontWeight: '600', lineHeight: 21, color: colors.ink },
  nameUnread: { fontWeight: '700' },
  meta: { ...type.postMeta, fontSize: 14, lineHeight: 19, color: colors.soft }
})
