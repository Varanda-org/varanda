// Comunidades: the tab (docs/app.md). Minhas comunidades from community.list
// (rpc 5.62), a search of public groups through the index (/index/group-search;
// private groups never appear there) whose rows name the community of each
// group when the index knows it, "Entrar por link" (a /c/ or /g/ link or a
// bare key: it opens the community or the group, where the person joins) and
// the Nova comunidade sheet. Groups live inside a community: there is no
// "Novo grupo" here. Hosted web only: elsewhere the tab shows the "só na
// versão web" note, like Avisos, and calls nothing. App.js draws the top bar.
// Props: onOpenGroup(group), onOpenCommunity(community); both take a hex64
// root key. onOpenCommunity also opens a community just made.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { fetchCommunity, fetchGroup, fetchGroupSearch } from '../indexClient'
import { queryPath } from '../search'
import { COMMUNITY_JOIN_LABELS, PUBLIC_LABEL, membersLabel, parseCommunityJoinLink, parseJoinLink, roleLabel } from '../groups'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, colors, errorText, useAction, useBottomPad } from '../ui'
import { Icon } from '../ui/Icon'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { Choice, NAME_MAX, nameLength, useEscapeClose } from './NovoGrupo'
import { Sheet } from '../ui/Sheet'

const { displayText } = rpc

export const WEB_ONLY_MESSAGE = 'Comunidades só na versão web'
const SEARCH_DELAY_MS = 400
const LIST_DELAY_MS = 800
const HEX64 = /^[0-9a-f]{64}$/
// How many search rows get their community name looked up (one index call each).
const NAMED_HITS = 8

// A /c/ link, a /g/ link or a bare key: { kind, key } or null. A bare key is
// taken as a group, like before; the group screen finds its community.
export function parseEntry (text) {
  const community = parseCommunityJoinLink(text)
  if (community) return { kind: 'community', key: community }
  const group = parseJoinLink(text)
  if (group) return { kind: 'group', key: group }
  const t = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return HEX64.test(t) ? { kind: 'group', key: t } : null
}

function communityTitle (row) {
  if (row.state !== 'ready') return 'Comunidade ainda chegando'
  return typeof row.name === 'string' && row.name !== '' ? displayText(row.name) : 'Comunidade sem nome'
}

function communitySubtitle (row) {
  return [roleLabel(row.role), COMMUNITY_JOIN_LABELS[row.join] || ''].filter(Boolean).join(' · ')
}

function Row ({ title, subtitle, dot, hint, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title + (subtitle ? ', ' + subtitle : '') + (dot ? ', novidades' : '')}
      accessibilityHint={hint}
      onPress={onPress}
    >
      <View style={styles.icon}><Icon name='cadeira' size={24} color={colors.ink} /></View>
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.meta} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {dot ? <View style={styles.dot} /> : null}
    </Pressable>
  )
}

function useGroupSearch (text) {
  const [state, setState] = useState({ status: 'idle', groups: [], more: false, indexing: false, error: '' })
  const gen = useRef(0)
  const path = queryPath(text)
  useEffect(() => {
    const mine = ++gen.current
    if (path === null) {
      setState({ status: 'idle', groups: [], more: false, indexing: false, error: '' })
      return
    }
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    const timer = setTimeout(async () => {
      const res = await fetchGroupSearch(path)
      if (mine !== gen.current) return
      if (!res || !res.ok) {
        const error = res && res.reason === 'not-found' ? 'A busca ainda não está disponível.' : 'Não foi possível buscar agora.'
        setState({ status: 'error', groups: [], more: false, indexing: false, error })
        return
      }
      const v = res.value
      setState({ status: 'done', groups: v.groups, more: v.more === true, indexing: v.indexing === true || v.complete === false, error: '' })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [path])
  return { ...state, path }
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
function NovaComunidade ({ visible, onClose, onCreated, onUncertain }) {
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

export function Comunidades ({ onOpenGroup, onOpenCommunity }) {
  const node = useNode()
  const hosted = node.hosted === true
  const bottomPad = useBottomPad()
  const [list, setList] = useState({ rows: [], loaded: false, loading: false, error: '' })
  const [query, setQuery] = useState('')
  const [link, setLink] = useState('')
  const [creating, setCreating] = useState(false)
  const search = useGroupSearch(hosted ? query : '')
  const communityNames = useCommunityNames(search.groups)
  // The version of each community when the person last opened it (or when
  // the list first showed it), for this session only.
  const seenRef = useRef(new Map())
  const loadGen = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request

  const load = useCallback(async () => {
    const mine = ++loadGen.current
    setList((l) => ({ ...l, loading: true, error: '' }))
    try {
      const res = await requestRef.current('community.list', {})
      if (mine !== loadGen.current) return
      const rows = Array.isArray(res && res.communities) ? res.communities : []
      setList({ rows: rows.filter((c) => c && typeof c.community === 'string' && HEX64.test(c.community)), loaded: true, loading: false, error: '' })
    } catch (err) {
      if (mine !== loadGen.current) return
      setList((l) => ({ ...l, loading: false, error: errorText(err) }))
    }
  }, [])

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

  const openCommunity = useCallback((community) => {
    seenRef.current.set(community, getVersion(community))
    if (typeof onOpenCommunity === 'function') onOpenCommunity(community)
  }, [getVersion, onOpenCommunity])

  const openGroup = useCallback((group) => {
    if (typeof onOpenGroup === 'function') onOpenGroup(group)
  }, [onOpenGroup])

  const entry = parseEntry(link)

  const go = () => {
    if (!entry) return
    setLink('')
    if (entry.kind === 'community') openCommunity(entry.key)
    else openGroup(entry.key)
  }

  if (!hosted) {
    return <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
  }

  const hits = search.groups.map((h) => {
    const community = typeof communityNames[h.group] === 'string' ? displayText(communityNames[h.group]) : ''
    return (
      <Row
        key={'s' + h.group}
        title={typeof h.name === 'string' && h.name !== '' ? displayText(h.name) : PUBLIC_LABEL}
        subtitle={[community ? 'na comunidade ' + community : '', membersLabel(h.writerCount)].filter(Boolean).join(' · ')}
        hint='abre o grupo'
        onPress={() => openGroup(h.group)}
      />
    )
  })

  const header = (
    <View>
      <View style={styles.block}>
        <Field
          label='Buscar grupos públicos'
          value={query}
          onChangeText={setQuery}
          placeholder='Nome do grupo'
          returnKeyType='search'
        />
        {search.status === 'loading' ? <Soft>Buscando…</Soft> : null}
        {search.status === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
        {search.status === 'done' && search.groups.length === 0 ? <Soft>Nenhum grupo público encontrado.</Soft> : null}
        {search.status === 'done' && search.indexing ? <Soft>A busca ainda está sendo atualizada; tente de novo depois.</Soft> : null}
      </View>
      {hits.length > 0 ? <View>{hits}</View> : null}
      {search.status === 'done' && search.more ? <View style={styles.block}><Soft>Há mais resultados: refine a busca.</Soft></View> : null}
      <View style={styles.block}>
        <Field
          label='Entrar por link'
          value={link}
          onChangeText={setLink}
          placeholder='/c/… ou /g/…'
          mono
          onSubmitEditing={go}
          returnKeyType='go'
        />
        {link.trim() !== '' && !entry ? <Soft>Cole um link de comunidade (/c/…) ou de grupo (/g/…).</Soft> : null}
        <View style={styles.actions}>
          <Btn label='Entrar' onPress={go} disabled={!entry} secondary />
          <Btn label='Nova comunidade' onPress={() => setCreating(true)} />
        </View>
      </View>
      <SectionHeader>Minhas comunidades</SectionHeader>
      {list.error && list.rows.length > 0 ? <ErrorState message={list.error} onRetry={load} pending={list.loading} /> : null}
    </View>
  )

  let empty
  if (list.error) {
    empty = <ErrorState message={list.error} onRetry={load} pending={list.loading} />
  } else if (!list.loaded) {
    empty = <Skeleton />
  } else {
    empty = <EmptyState icon='cadeira' title='Nenhuma comunidade ainda' body='Crie uma comunidade, busque um grupo público ou entre por um link.' />
  }

  const renderItem = ({ item }) => {
    const seen = seenRef.current.has(item.community) ? seenRef.current.get(item.community) : getVersion(item.community)
    return (
      <Row
        title={communityTitle(item)}
        subtitle={communitySubtitle(item)}
        dot={getVersion(item.community) !== seen}
        hint='abre a comunidade'
        onPress={() => openCommunity(item.community)}
      />
    )
  }

  return (
    <View style={styles.root}>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  sheet: { padding: 16, gap: 12 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
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
  texts: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  meta: { ...type.postMeta, color: colors.dim },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }
})
