// Cadeiras: the tab of the "Cadeiras de Praia" (docs/app.md). Minhas cadeiras
// from group.list, a search of public groups through the index
// (/index/group-search; private groups never appear there), "Entrar por link"
// (a /g/<hex> link or a bare key, then group.join) and the Nova cadeira sheet.
// Hosted web only: elsewhere the tab shows the "só na versão web" note, like
// Avisos, and calls nothing. App.js draws the top bar.
// Props: onOpenGroup(group), onOpenCommunity(community); both take a hex64
// root key. onOpenCommunity opens a community just made in Nova comunidade.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { fetchGroupSearch } from '../indexClient'
import { queryPath } from '../search'
import { PRIVATE_LABEL, PUBLIC_LABEL, joinLabel, membersLabel, parseJoinLink, reconcile, roleLabel } from '../groups'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, colors, errorText, useAction, useBottomPad } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { NAME_MAX, NovaCadeira, nameLength, useEscapeClose } from './NovaCadeira'
import { Sheet } from '../ui/Sheet'

const { displayText } = rpc

export const WEB_ONLY_MESSAGE = 'Cadeiras de Praia só na versão web'
const PAGE = rpc.GROUP_LIMIT_MAX
const SEARCH_DELAY_MS = 400
const LIST_DELAY_MS = 800
const HEX64 = /^[0-9a-f]{64}$/

// A link, or a bare key pasted as it is.
function keyOfInput (text) {
  const fromLink = parseJoinLink(text)
  if (fromLink) return fromLink
  const t = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return HEX64.test(t) ? t : null
}

function groupTitle (row) {
  if (row.role === 'pending') return roleLabel('pending')
  return typeof row.name === 'string' && row.name !== '' ? displayText(row.name) : PRIVATE_LABEL
}

function GroupRow ({ title, subtitle, dot, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title + (subtitle ? ', ' + subtitle : '') + (dot ? ', novidades' : '')}
      accessibilityHint='abre a cadeira'
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

// Nova comunidade: community.create (rpc 5.57). An uncertain create is never
// resent and editing the name does not unlock it: there is no local list of
// communities to check, so only closing the sheet lifts the lock.
function NovaComunidade ({ visible, onClose, onCreated }) {
  const node = useNode()
  const [name, setName] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const action = useAction()
  const clearRef = useRef(action.clearError)
  clearRef.current = action.clearError
  useEscapeClose(visible, onClose)

  useEffect(() => {
    if (!visible) return
    setName('')
    setUncertain(false)
    clearRef.current()
  }, [visible])

  const trimmed = name.trim()
  const tooLong = nameLength(trimmed) > NAME_MAX
  const offline = node.online === false
  const ready = trimmed.length > 0 && !tooLong && !offline && !uncertain

  const create = async () => {
    if (!ready) return
    const res = await action.run(() => node.request('community.create', { name: trimmed }))
    if (res.ok && res.value && typeof res.value.community === 'string') {
      if (typeof onCreated === 'function') onCreated(res.value.community)
      return
    }
    if (res.uncertain) setUncertain(true)
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
        <Soft>Uma comunidade reúne até 32 cadeiras sob a mesma moderação. Depois de criar, vincule as cadeiras na tela da comunidade.</Soft>
        {offline ? <Soft>Sem internet: conecte-se para criar a comunidade.</Soft> : null}
        {uncertain
          ? <ErrorText>{UNCERTAIN + '. Talvez ela já tenha sido criada. Espere um pouco e abra a aba Cadeiras de novo antes de tentar outra vez, para não ficar com duas.'}</ErrorText>
          : <ErrorText>{action.error}</ErrorText>}
        <Btn label='Criar comunidade' onPress={create} disabled={!ready} pending={action.pending} />
      </View>
    </Sheet>
  )
}

export function Cadeiras ({ onOpenGroup, onOpenCommunity }) {
  const node = useNode()
  const hosted = node.hosted === true
  const bottomPad = useBottomPad()
  const [list, setList] = useState({ groups: [], total: 0, loaded: false, loading: false, more: false, error: '' })
  const [query, setQuery] = useState('')
  const [link, setLink] = useState('')
  const [joinNote, setJoinNote] = useState('')
  // An uncertain join: { group, verdict } until it is reconciled.
  const [joinCheck, setJoinCheck] = useState(null)
  const [creating, setCreating] = useState(false)
  const [creatingCommunity, setCreatingCommunity] = useState(false)
  const join = useAction()
  const search = useGroupSearch(hosted ? query : '')
  // The version of each group when the person last opened it (or when the
  // list first showed it), for this session only.
  const seenRef = useRef(new Map())
  const loadGen = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request

  const loadFirst = useCallback(async () => {
    const mine = ++loadGen.current
    setList((l) => ({ ...l, loading: true, error: '' }))
    try {
      const res = await requestRef.current('group.list', { offset: 0, limit: PAGE })
      if (mine !== loadGen.current) return
      const groups = Array.isArray(res && res.groups) ? res.groups : []
      const total = Number.isSafeInteger(res && res.total) ? res.total : groups.length
      setList({ groups, total, loaded: true, loading: false, more: false, error: '' })
    } catch (err) {
      if (mine !== loadGen.current) return
      setList((l) => ({ ...l, loading: false, error: errorText(err) }))
    }
  }, [])

  const loadMore = useCallback(async () => {
    const mine = loadGen.current
    setList((l) => ({ ...l, more: true, error: '' }))
    try {
      const res = await requestRef.current('group.list', { offset: list.groups.length, limit: PAGE })
      if (mine !== loadGen.current) return
      const page = Array.isArray(res && res.groups) ? res.groups : []
      setList((l) => {
        const have = new Set(l.groups.map((g) => g.group))
        const groups = l.groups.concat(page.filter((g) => g && !have.has(g.group)))
        const total = Number.isSafeInteger(res && res.total) ? res.total : l.total
        return { ...l, groups, total, more: false }
      })
    } catch (err) {
      if (mine !== loadGen.current) return
      setList((l) => ({ ...l, more: false, error: errorText(err) }))
    }
  }, [list.groups.length])

  useEffect(() => {
    if (hosted) loadFirst()
  }, [hosted, loadFirst])

  // Roles and member counts move with groups.changed: re-read the local list,
  // coalesced so a burst of events costs one read.
  const versions = node.groupVersions
  const firstVersions = useRef(versions)
  useEffect(() => {
    if (!hosted || versions === firstVersions.current) return
    const timer = setTimeout(loadFirst, LIST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hosted, versions, loadFirst])

  const getVersion = node.getGroupVersion
  useEffect(() => {
    for (const g of list.groups) {
      if (g && typeof g.group === 'string' && !seenRef.current.has(g.group)) seenRef.current.set(g.group, getVersion(g.group))
    }
  }, [list.groups, getVersion])

  const open = useCallback((group) => {
    seenRef.current.set(group, getVersion(group))
    if (typeof onOpenGroup === 'function') onOpenGroup(group)
  }, [getVersion, onOpenGroup])

  const linkKey = keyOfInput(link)
  const offline = node.online === false

  const recheckJoin = async (group) => {
    try {
      const info = await node.request('group.info', { group })
      const verdict = reconcile({ action: 'join' }, { state: info && info.state })
      setJoinCheck({ group, verdict })
      if (verdict === 'landed') {
        setJoinCheck(null)
        setLink('')
        loadFirst()
        open(group)
      }
    } catch {
      setJoinCheck({ group, verdict: 'unknown' })
    }
  }

  const doJoin = async () => {
    const group = linkKey
    if (!group || offline) return
    setJoinNote('')
    setJoinCheck(null)
    const res = await join.run(() => node.request('group.join', { group }))
    if (res.ok) {
      const state = res.value && res.value.state
      setLink('')
      loadFirst()
      if (state === 'requested') setJoinNote('Pedido enviado: aguardando aprovação.')
      open(group)
      return
    }
    if (res.uncertain) await recheckJoin(group)
  }

  if (!hosted) {
    return <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
  }

  let joinStatus = null
  if (joinCheck && joinCheck.verdict === 'not-landed') {
    joinStatus = (
      <View style={styles.inline}>
        <ErrorText>A entrada não foi registrada.</ErrorText>
        <Pill label='tentar de novo' onPress={doJoin} pending={join.pending} disabled={offline} />
      </View>
    )
  } else if (joinCheck && joinCheck.verdict === 'unknown') {
    joinStatus = (
      <View style={styles.inline}>
        <ErrorText>{UNCERTAIN}</ErrorText>
        <Pill label='conferir' onPress={() => recheckJoin(joinCheck.group)} />
      </View>
    )
  } else if (join.error) {
    joinStatus = <ErrorText>{join.error}</ErrorText>
  }

  const hits = search.groups.map((h) => (
    <GroupRow
      key={'s' + h.group}
      title={typeof h.name === 'string' && h.name !== '' ? displayText(h.name) : PUBLIC_LABEL}
      subtitle={membersLabel(h.writerCount)}
      onPress={() => open(h.group)}
    />
  ))

  const header = (
    <View>
      <View style={styles.block}>
        <Field
          label='Buscar cadeiras públicas'
          value={query}
          onChangeText={setQuery}
          placeholder='Nome da cadeira'
          returnKeyType='search'
        />
        {search.status === 'loading' ? <Soft>Buscando…</Soft> : null}
        {search.status === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
        {search.status === 'done' && search.groups.length === 0 ? <Soft>Nenhuma cadeira pública encontrada.</Soft> : null}
        {search.status === 'done' && search.indexing ? <Soft>A busca ainda está sendo atualizada; tente de novo depois.</Soft> : null}
      </View>
      {hits.length > 0 ? <View>{hits}</View> : null}
      {search.status === 'done' && search.more ? <View style={styles.block}><Soft>Há mais resultados: refine a busca.</Soft></View> : null}
      <View style={styles.block}>
        <Field
          label='Entrar por link'
          value={link}
          onChangeText={(t) => { setLink(t); setJoinCheck(null); join.clearError() }}
          placeholder='/g/…'
          mono
          onSubmitEditing={doJoin}
          returnKeyType='go'
        />
        {link.trim() !== '' && !linkKey ? <Soft>Cole um link de cadeira (/g/…).</Soft> : null}
        {offline ? <Soft>Sem internet: conecte-se para entrar.</Soft> : null}
        {joinStatus}
        {joinNote ? <Soft>{joinNote}</Soft> : null}
        <View style={styles.actions}>
          <Btn label='Entrar' onPress={doJoin} disabled={!linkKey || offline || joinCheck !== null} pending={join.pending} secondary />
          <Btn label='Nova cadeira' onPress={() => setCreating(true)} />
          <Btn label='Nova comunidade' onPress={() => setCreatingCommunity(true)} secondary />
        </View>
      </View>
      <SectionHeader>Minhas cadeiras</SectionHeader>
      {list.error && list.groups.length > 0 ? <ErrorState message={list.error} onRetry={loadFirst} pending={list.loading} /> : null}
    </View>
  )

  let empty
  if (list.error) {
    empty = <ErrorState message={list.error} onRetry={loadFirst} pending={list.loading} />
  } else if (!list.loaded) {
    empty = <Skeleton />
  } else {
    empty = <EmptyState icon='cadeira' title='Nenhuma cadeira ainda' body='Crie uma cadeira, busque uma pública ou entre por um link.' />
  }

  const renderItem = ({ item }) => {
    const seen = seenRef.current.has(item.group) ? seenRef.current.get(item.group) : getVersion(item.group)
    const parts = [roleLabel(item.role), joinLabel(item.join), item.role === 'pending' ? '' : membersLabel(item.members)].filter(Boolean)
    return (
      <GroupRow
        title={groupTitle(item)}
        subtitle={parts.join(' · ')}
        dot={getVersion(item.group) !== seen}
        onPress={() => open(item.group)}
      />
    )
  }

  const hasMore = list.loaded && list.groups.length < list.total
  return (
    <View style={styles.root}>
      <RefreshableList
        data={list.groups}
        keyExtractor={(g) => g.group}
        renderItem={renderItem}
        extraData={{ versions, getVersion }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={list.groups.length > 0 ? <ListFooter loading={list.more} atEnd={false} /> : null}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={loadFirst}
        refreshing={list.loading && list.loaded}
        onLoadMore={hasMore && !list.more && !list.loading ? loadMore : undefined}
        loadingMore={list.more}
        atEnd={!hasMore}
      />
      <NovaCadeira
        visible={creating}
        onClose={() => setCreating(false)}
        onCreated={(group) => {
          setCreating(false)
          loadFirst()
          open(group)
        }}
      />
      <NovaComunidade
        visible={creatingCommunity}
        onClose={() => setCreatingCommunity(false)}
        onCreated={(community) => {
          setCreatingCommunity(false)
          if (typeof onOpenCommunity === 'function') onOpenCommunity(community)
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
  texts: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  meta: { ...type.postMeta, color: colors.dim },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }
})
