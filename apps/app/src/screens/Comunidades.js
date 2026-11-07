// Comunidades: browse and create, pushed over the Conversas tab from its
// Comunidades row (nav 'comunidades'). Minhas comunidades from community.list
// (rpc 5.62), a search of public groups through the index (/index/group-search;
// private groups never appear there) whose rows name the community of each
// group when the index knows it, and the Nova comunidade sheet (also opened
// from the Conversas "+" sheet, hence the export). There is no paste field: a
// /c/ or /g/ link opens its screen (App.js). Groups live inside a community:
// there is no "Novo grupo" here. Hosted node only: a node that is not hosted
// shows the "só na versão web" note, like Avisos, and calls nothing.
// Props: onBack, onOpenGroup(group), onOpenCommunity(community); both take a
// hex64 root key. onOpenCommunity also opens a community just made.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { fetchCommunity, fetchGroup, fetchGroupSearch } from '../indexClient'
import { queryPath } from '../search'
import { COMMUNITY_JOIN_LABELS, PAGE_EMPTY_TEXT, PUBLIC_LABEL, membersLabel, pageCommunities, pageErrorText, pageMode, pageRoleOf, roleLabel } from '../groups'
import { pagesOn } from '../pageGate'
import { actAs } from '../pages'
import { memberKeyOf, useActing } from './Conversa'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { Choice, NAME_MAX, nameLength, useEscapeClose } from './NovoGrupo'
import { KeyboardForm } from './Perfil'
import { Sheet } from '../ui/Sheet'
import { TopBar } from '../ui/TopBar'

const { displayText } = rpc

export const WEB_ONLY_MESSAGE = 'Comunidades só na versão web'
const SEARCH_DELAY_MS = 400
const LIST_DELAY_MS = 800
const HEX64 = /^[0-9a-f]{64}$/
// How many search rows get their community name looked up (one index call each).
const NAMED_HITS = 8

function communityTitle (row) {
  if (row.state !== 'ready') return 'Comunidade ainda chegando'
  return typeof row.name === 'string' && row.name !== '' ? displayText(row.name) : 'Comunidade sem nome'
}

function communitySubtitle (row) {
  // A wrap breaks before the dot, never leaves it at a line end.
  return [roleLabel(row.role), COMMUNITY_JOIN_LABELS[row.join] || ''].filter(Boolean).join(' ·\u00a0')
}

function Row ({ title, subtitle, dot, hint, seed, avatarName, onPress, metaLines = 1 }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title + (subtitle ? ', ' + subtitle : '') + (dot ? ', novidades' : '')}
      accessibilityHint={hint}
      onPress={onPress}
    >
      <Avatar name={avatarName} publicKey={seed} size={44} shape='square' />
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.meta} numberOfLines={metaLines}>{subtitle}</Text> : null}
      </View>
      {dot ? <View style={styles.dot} /> : null}
    </Pressable>
  )
}

function useGroupSearch (text) {
  const [state, setState] = useState({ status: 'idle', groups: [], more: false, indexing: false, partial: false, unavailable: false, error: '' })
  const [attempt, setAttempt] = useState(0)
  const gen = useRef(0)
  const path = queryPath(text)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    const mine = ++gen.current
    if (path === null) {
      setState({ status: 'idle', groups: [], more: false, indexing: false, partial: false, unavailable: false, error: '' })
      return
    }
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    const timer = setTimeout(async () => {
      const res = await fetchGroupSearch(path)
      if (mine !== gen.current) return
      if (!res || !res.ok) {
        const unavailable = !!res && res.reason === 'not-found'
        const error = unavailable ? 'A busca ainda não está disponível.' : 'Não foi possível buscar agora.'
        setState({ status: 'error', groups: [], more: false, indexing: false, partial: false, unavailable, error })
        return
      }
      const v = res.value
      setState({ status: 'done', groups: v.groups, more: v.more === true, indexing: v.indexing === true, partial: v.complete === false, unavailable: false, error: '' })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [path, attempt])
  return { ...state, path, retry }
}

// The community name of each search row: /index/group/<G> names the
// community, /index/community/<C> its name. One group at a time, the first
// rows only; a failure leaves the row without a community name.
function useCommunityNames (groups) {
  const [names, setNames] = useState({})
  const gen = useRef(0)
  const key = groups.slice(0, NAMED_HITS).map((g) => g.group).join(',')
  useEffect(() => {
    const mine = ++gen.current
    const wanted = key === '' ? [] : key.split(',')
    ;(async () => {
      for (const group of wanted) {
        const g = await fetchGroup(group)
        if (mine !== gen.current) return
        if (!g || !g.ok || typeof g.value.community !== 'string') continue
        const c = await fetchCommunity(g.value.community)
        if (mine !== gen.current) return
        if (!c || !c.ok || typeof c.value.name !== 'string' || c.value.name === '') continue
        setNames((prev) => (prev[group] === c.value.name ? prev : { ...prev, [group]: c.value.name }))
      }
    })()
    return () => { gen.current++ }
  }, [key])
  return names
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
  const action = useAction()
  const clearRef = useRef(action.clearError)
  clearRef.current = action.clearError
  useEscapeClose(visible, onClose)

  useEffect(() => {
    if (!visible) return
    setName('')
    setJoin('open')
    setUncertain(false)
    clearRef.current()
  }, [visible])

  const trimmed = name.trim()
  const tooLong = nameLength(trimmed) > NAME_MAX
  const offline = node.online === false
  const ready = trimmed.length > 0 && !tooLong && !offline && !uncertain

  const create = async () => {
    if (!ready) return
    const res = await action.run(() => node.request('community.create', { name: trimmed, join }))
    if (res.ok && res.value && typeof res.value.community === 'string') {
      if (typeof onCreated === 'function') onCreated(res.value.community)
      return
    }
    if (res.uncertain) {
      setUncertain(true)
      if (typeof onUncertain === 'function') onUncertain()
    }
  }

  return (
    <Sheet open={!!visible} onClose={onClose} title='Nova comunidade'>
      <View style={styles.sheet}>
        <Field
          label='Nome'
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX * 2}
          placeholder='Nome da comunidade'
        />
        {tooLong ? <ErrorText>{'O nome pode ter até ' + NAME_MAX + ' caracteres.'}</ErrorText> : null}
        <Choice
          label='Entrada'
          value={join}
          onChange={setJoin}
          options={[{ value: 'open', label: 'Aberta' }, { value: 'approval', label: 'Com aprovação' }]}
        />
        <Soft>Uma comunidade reúne até 32 grupos sob a mesma moderação e já nasce com o grupo Geral.</Soft>
        {offline ? <Soft>Sem internet: conecte-se para criar a comunidade.</Soft> : null}
        {uncertain
          ? <ErrorText>{UNCERTAIN + '. Confira em Minhas comunidades antes de criar de novo.'}</ErrorText>
          : <ErrorText>{action.error}</ErrorText>}
        <Btn label='Criar comunidade' onPress={create} disabled={!ready} pending={action.pending} />
      </View>
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
  const [list, setList] = useState({ rows: [], loaded: false, loading: false, error: '' })
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const search = useGroupSearch(hosted ? query : '')
  const communityNames = useCommunityNames(search.groups)
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
      const res = await requestRef.current('community.list', {})
      if (mine !== loadGen.current) return
      const rows = Array.isArray(res && res.communities) ? res.communities : []
      setList({ rows: rows.filter((c) => c && typeof c.community === 'string' && HEX64.test(c.community)), loaded: true, loading: false, error: '' })
    } catch (err) {
      if (mine !== loadGen.current) return
      setList((l) => ({ ...l, loading: false, error: pageKey !== null ? pageErrorText(err) : errorText(err) }))
    }
  }, [pageKey])

  useEffect(() => {
    if (hosted) load()
  }, [hosted, load])

  // Roles and counts move with groups.changed: re-read the list, coalesced so
  // a burst of events costs one read.
  const versions = node.groupVersions
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

  const bar = <TopBar title='Comunidades' onBack={onBack} />
  if (!hosted) {
    return (
      <View style={styles.root}>
        {bar}
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
      </View>
    )
  }

  const hits = search.groups.map((h) => {
    const community = typeof communityNames[h.group] === 'string' ? displayText(communityNames[h.group]) : ''
    return (
      <Row
        key={'s' + h.group}
        title={typeof h.name === 'string' && h.name !== '' ? displayText(h.name) : PUBLIC_LABEL}
        subtitle={[community ? 'na comunidade ' + community : '', membersLabel(h.writerCount)].filter(Boolean).join(' ·\u00a0')}
        hint='abre o grupo'
        // The community name and the count both matter: up to three lines.
        metaLines={3}
        seed={h.group}
        avatarName={typeof h.name === 'string' ? h.name : null}
        onPress={() => openGroup(h.group)}
      />
    )
  })

  // Search first, like other apps: a field under a long list ends up under
  // the keyboard. Then the person's own communities.
  const createButton = pageKey === null
    ? (
      <View style={styles.block}>
        <Btn label='Nova comunidade' onPress={() => setCreating(true)} />
      </View>
      )
    : null
  const mineSection = (
    <View>
      <SectionHeader>Minhas comunidades</SectionHeader>
      {list.error && list.rows.length > 0 ? <ErrorState message={list.error} onRetry={load} pending={list.loading} /> : null}
    </View>
  )

  const discover = (
    <View>
      <SectionHeader>Descobrir</SectionHeader>
      <View style={styles.block}>
        <Field
          label='Buscar grupos públicos'
          value={query}
          onChangeText={setQuery}
          placeholder='Nome do grupo'
          returnKeyType='search'
          plain
        />
        <Soft>O resultado abre um grupo da comunidade</Soft>
        {search.status === 'loading' ? <Soft>Buscando…</Soft> : null}
        {search.status === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
        {search.status === 'error' && !search.unavailable ? <Btn label='Tentar de novo' onPress={() => search.retry()} /> : null}
        {search.status === 'done' && search.groups.length === 0 ? <Soft>Nenhum grupo público encontrado.</Soft> : null}
        {search.status === 'done' && search.partial ? <Soft>Alguns grupos podem faltar</Soft> : null}
        {search.status === 'done' && search.indexing ? <Soft>A busca ainda está sendo atualizada; tente de novo depois.</Soft> : null}
      </View>
      {hits.length > 0 ? <View>{hits}</View> : null}
      {search.status === 'done' && search.more ? <View style={styles.block}><Soft>Há mais resultados: refine a busca.</Soft></View> : null}
    </View>
  )

  const header = (
    <View>
      {createButton}
      {discover}
      {mineSection}
    </View>
  )

  let empty
  if (list.error) {
    empty = <ErrorState message={list.error} onRetry={load} pending={list.loading} />
  } else if (!list.loaded) {
    empty = <Skeleton />
  } else {
    empty = <EmptyState icon='cadeira' title='Nenhuma comunidade ainda' body={pageKey !== null ? PAGE_EMPTY_TEXT : 'Crie uma comunidade, busque um grupo público ou abra o link de convite que alguém da comunidade mandou.'} />
  }

  const renderItem = ({ item }) => {
    const seen = seenRef.current.has(item.community) ? seenRef.current.get(item.community) : getVersion(item.community)
    return (
      <Row
        title={communityTitle(item)}
        subtitle={communitySubtitle(item)}
        metaLines={3}
        dot={getVersion(item.community) !== seen}
        hint='abre a comunidade'
        seed={item.community}
        avatarName={item.state === 'ready' && typeof item.name === 'string' ? item.name : null}
        onPress={() => openCommunity(item.community)}
      />
    )
  }

  return (
    <View style={styles.root}>
      {bar}
      {/* The search sits under the list: with the keyboard open (Android
          draws edge to edge) the list must shrink so a result scrolls into
          view above it. */}
      <KeyboardForm>
        <RefreshableList
          data={list.rows}
          keyExtractor={(c) => c.community}
          renderItem={renderItem}
          extraData={{ versions, getVersion }}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={load}
          refreshing={list.loading && list.loaded}
          atEnd
        />
      </KeyboardForm>
      <NovaComunidade
        visible={creating}
        onClose={() => { setCreating(false); load() }}
        onUncertain={load}
        onCreated={(community) => {
          setCreating(false)
          load()
          openCommunity(community)
        }}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  sheet: { padding: 16, gap: 12 },
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
  texts: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  meta: { ...type.postMeta, color: colors.soft },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }
})
