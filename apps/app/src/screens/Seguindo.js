// Seguindo: a stack screen opened from 'N seguindo' on the Diário. It lists
// who the own account follows: follow.list (offset paging, 50 per page). Rows
// show the avatar and the name (or @nome) the member chose, read from the
// profiles cache; never a key. The list reloads when another device changes
// the follows (node.followsVersion). A "Seguindo" pill asks for a
// confirmation before it unfollows. Design: apps/site/artwork/app-design.md.
//
// The field on top only FILTERS the people already on the list (filterPeople
// over the loaded keys, by the cached name and @nome): it never searches the
// account service and never follows, so a 64-hex string is just text. Finding
// and following other accounts is the Busca tab's job. A key whose profile is
// not known yet is hidden while the filter has text and shows once the
// profile resolves. While the filter shows fewer than one page of rows and
// the list has more, the next page is read.
//
// Only the own list is served here (entry.key === ownKey, or no entry): any
// other key shows 'Disponível em breve.' and makes no request.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { UNNAMED, whoOf } from '../who'
import { HELP, SHORT } from '../help'
import { HelpButton } from '../ui/Help'
import { FILTER_EMPTY, FILTER_HINT, FILTER_LABEL, FILTER_PLACEHOLDER, filterPeople } from '../peopleFilter'
import { Card, ErrorText, Field, Notice, SectionHeader, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { FollowPill } from '../ui/FollowPill'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ListFooter, Skeleton } from '../ui/States'
import { OfflineNote } from '../ui/OfflineNote'
import { TopBar } from '../ui/TopBar'
import { colors, type } from '../ui/theme'

const PAGE = 50
// Pages in a row that add no filtered row before the filter stops paging.
const DRY_MAX = 3

// One followed diary. The avatar and name column open the member's profile
// (`onOpen(followKey, profile)`, optional); 'denunciar' opens the report sheet
// for the whole account (the list never holds the own key: follow.add refuses
// it). `profile` is undefined while it is being looked up.
function FollowRow ({ followKey, profile, onOpen, onRemove, onReport, pending, disabled }) {
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function'
    ? () => onOpen(followKey, { name: profile ? profile.name : null, username: profile ? profile.username : null })
    : undefined
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.open, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={who.known ? 'ver o perfil de ' + title : 'ver o perfil'}
        disabled={!open}
        onPress={open}
      >
        <Avatar name={who.avatarName} publicKey={followKey} size={44} picture={(profile || {}).avatar} persist />
        <View style={styles.who}>
          {who.known
            ? (
              <>
                <Text style={styles.name} numberOfLines={1}>{title}</Text>
                {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
              </>
              )
            : <View style={styles.skeleton} accessible={false} />}
        </View>
      </Pressable>
      <FollowPill
        following
        title={who.known ? title : 'esta pessoa'}
        pending={pending}
        disabled={disabled}
        onFollow={() => {}}
        onUnfollow={() => onRemove(followKey)}
      />
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={who.known ? 'denunciar ' + title : 'denunciar'}
        hitSlop={13}
        onPress={() => onReport({
          author: followKey,
          name: profile ? profile.name : null,
          username: profile ? profile.username : null,
          seq: null,
          text: null
        })}
      >
        <Icon name='bandeira' size={18} color={colors.soft} />
      </Pressable>
    </View>
  )
}

// One key of the legacy-follows card: a checkbox (on by default), the name or
// @nome the profile cache knows, or 'Alguém sem nome' with a short key
// fragment so an unknown (possibly planted) entry stands out.
function LegacyRow ({ followKey, profile, checked, onToggle, disabled }) {
  const who = whoOf(profile)
  const named = profile != null && (who.title !== UNNAMED)
  const title = named ? displayText(who.title) : 'Alguém sem nome'
  const detail = named ? (who.subtitle ? displayText(who.subtitle) : null) : displayText(followKey.slice(0, 8))
  return (
    <Pressable
      style={styles.legacyRow}
      accessibilityRole='checkbox'
      accessibilityLabel={'publicar que você segue ' + title + (named ? '' : ' ' + detail)}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Icon name='check' size={14} color='#ffffff' /> : null}
      </View>
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={styles.handle} numberOfLines={1}>{detail}</Text> : null}
      </View>
    </Pressable>
  )
}

// `entry` ({ key }, optional): whose list; only the own one is served.
// `onBack`: the top bar's 'voltar'. `onFollowsChanged` (optional): called after
// an unfollow that changed the list, so the shell refreshes A Rua, Diário and
// the follow count. `onOpenMember(followKey, { name, username })` (optional):
// a row's name opens the member's profile. `onToast(text)` (optional): shows a
// confirmation; without it the screen shows its own notice. `followsTick`: a
// follow changed elsewhere in this app, so the list is read again. `isTop`
// (default true): false while another screen is stacked above this one, which
// stops the filter's automatic paging.
export default function Seguindo ({ active = true, isTop = true, entry, ownKey, onBack, onReport, onFollowsChanged, onOpenMember, onToast, followsTick, scrollToTop }) {
  const node = useNode()
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const mine = !entry || typeof entry.key !== 'string' || entry.key.toLowerCase() === own
  const names = useNames()
  const bottomPad = useBottomPad()
  const [keys, setKeys] = useState([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [text, setText] = useState('')
  // True while follow.list is re-read after a change: no new change until then.
  const [rereading, setRereading] = useState(false)
  // The key being removed: only its row shows "Seguindo…".
  const [removing, setRemoving] = useState(null)
  const [done, setDone] = useNotice()
  const remove = useAction()
  const notify = (msg) => {
    if (typeof onToast === 'function') onToast(msg)
    else setDone(msg)
  }
  // Paging state, set together with the new items (one render per page).
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // One sequence for every list read: a reload supersedes an older page in
  // flight (its offset came from the list being replaced, so applying it
  // would skip entries), no older page starts while a reload runs, and only
  // the latest reload is applied.
  const seqRef = useRef(0)
  const reloadingRef = useRef(false)

  // Reads from the start; keeps at least as many entries as were shown.
  const { profileOf, resolveMany } = names
  const reload = useCallback(async (want) => {
    const seq = ++seqRef.current
    reloadingRef.current = true
    setLoadingMore(false)
    setMoreError('')
    try {
      const r = await node.request('follow.list', { offset: 0, limit: Math.min(FOLLOW_LIMIT_MAX, Math.max(PAGE, want)) })
      if (seq !== seqRef.current) return
      setKeys(r.follows)
      setTotal(r.total)
      setLoaded(true)
      setLoadError('')
      resolveMany(r.follows)
    } catch (err) {
      if (seq === seqRef.current) setLoadError(errorText(err))
    } finally {
      if (seq === seqRef.current) reloadingRef.current = false
    }
  }, [node.request, resolveMany])

  // After any follow change (success or failure, uncertain included) the list
  // is re-read before the person can act again; the error text stays.
  const reread = async () => {
    setRereading(true)
    try {
      await reload(keys.length)
    } finally {
      setRereading(false)
    }
  }

  useEffect(() => { if (active && mine) reload(PAGE) }, [active, mine, reload])

  // Later re-reads ask for as many rows as are loaded (reload keeps at least
  // PAGE), the same width reread() uses, so whichever lands last is complete
  // and paging past the first page is not undone.
  const loadedLen = useRef(0)
  loadedLen.current = keys.length

  // A follow changed elsewhere (another device, synced): read the list again.
  const followsVersion = typeof node.followsVersion === 'number' ? node.followsVersion : 0
  const seenVersion = useRef(followsVersion)
  useEffect(() => {
    if (seenVersion.current === followsVersion) return
    seenVersion.current = followsVersion
    if (active && mine) reload(loadedLen.current)
  }, [followsVersion, active, mine, reload])

  // A follow changed in this app (the profile, the Busca): read the list again.
  const seenTick = useRef(followsTick)
  useEffect(() => {
    if (seenTick.current === followsTick) return
    seenTick.current = followsTick
    if (active && mine) reload(loadedLen.current)
  }, [followsTick, active, mine, reload])

  // Pull-to-refresh re-reads the first page; the list never calls it twice.
  const refresh = async () => {
    setRefreshing(true)
    try {
      await reload(PAGE)
    } finally {
      setRefreshing(false)
    }
  }

  const doRemove = async (key) => {
    setDone('')
    setRemoving(key)
    try {
      const r = await remove.run(() => node.request('follow.remove', { key }))
      if (r.ok) notify(r.value.changed ? 'Você deixou de seguir.' : 'Você já não seguia esta pessoa.')
      if (r.ok && r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      // Success, failure or an uncertain answer: the list is read again.
      await reread()
    } finally {
      setRemoving(null)
    }
  }

  // Older pages only after the first read landed (an end reach on the empty
  // list must not ask offset 0 a second time), one at a time; a key already
  // shown is never appended twice.
  const doMore = async () => {
    if (!loaded || loadingMore || reloadingRef.current) return
    const seq = seqRef.current
    setLoadingMore(true)
    setMoreError('')
    try {
      const r = await node.request('follow.list', { offset: keys.length, limit: PAGE })
      if (seq !== seqRef.current) return
      // Offsets drift if the list changed underneath (a follow added
      // elsewhere sorts before the loaded rows): a page with nothing new while
      // entries are missing re-reads from the start instead of stalling.
      const shown = new Set(keys)
      if (r.follows.length > 0 && r.follows.every((k) => shown.has(k)) && keys.length < r.total) {
        setLoadingMore(false)
        return reload(keys.length + PAGE)
      }
      setKeys((prev) => {
        const seen = new Set(prev)
        return prev.concat(r.follows.filter((k) => !seen.has(k)))
      })
      setTotal(r.total)
      setLoadingMore(false)
      resolveMany(r.follows)
    } catch (err) {
      if (seq !== seqRef.current) return
      setMoreError(errorText(err))
      setLoadingMore(false)
    }
  }

  // Nothing to page before the first read: the list stays "at the end".
  const atEnd = !loaded || keys.length >= total

  // The filter narrows the loaded keys. profileOf changes identity whenever
  // the profiles cache does, so a key hidden for its unknown profile returns
  // as soon as it resolves.
  const filtering = text.trim() !== ''
  const shownKeys = useMemo(() => filterPeople(keys, profileOf, text), [keys, profileOf, text])

  // A key whose profile is not known yet is not a non-match: nothing is
  // decided (no paging, no 'nobody here') until every loaded name resolved.
  const unresolved = useMemo(() => keys.reduce((n, k) => n + (profileOf(k) === undefined ? 1 : 0), 0), [keys, profileOf])

  // A filter that leaves less than a page of rows reads on, so a match deeper
  // in the list is found without scrolling. Every follow.list interrupts the
  // node's sync, so it is bounded: only while this screen is on top, and it
  // stops after DRY_MAX pages in a row that add no visible row (the person
  // then asks for more with 'carregar mais'). A page counts once its names
  // are known. A new filter text starts the count over.
  const [dry, setDry] = useState(0)
  const pageRef = useRef({ len: 0, shown: 0 })
  useEffect(() => {
    pageRef.current = { len: keys.length, shown: shownKeys.length }
    setDry(0)
  }, [text])
  useEffect(() => {
    if (!filtering || unresolved > 0) return
    const last = pageRef.current
    if (keys.length === last.len) return
    pageRef.current = { len: keys.length, shown: shownKeys.length }
    setDry((d) => shownKeys.length > last.shown ? 0 : d + 1)
  }, [keys.length, unresolved, shownKeys.length, filtering])
  const paused = filtering && dry >= DRY_MAX
  useEffect(() => {
    if (!isTop || !active || !filtering || !loaded || atEnd || loadingMore || moreError !== '' || unresolved > 0 || paused) return
    if (shownKeys.length < PAGE) doMore()
  }, [isTop, active, filtering, loaded, atEnd, loadingMore, moreError, unresolved, paused, shownKeys.length])
  const moreByHand = () => {
    setDry(0)
    doMore()
  }

  // Follows stored on this device before the update: published only after the
  // person confirms the exact list once. The provider loads the keys.
  const legacyApi = node.legacyFollows || null
  const [picked, setPicked] = useState({})
  const [legacyHidden, setLegacyHidden] = useState(false)
  const publish = useAction()
  // The provider loads the keys once per unlock (node.legacyFollows.keys).
  const legacy = legacyApi !== null && Array.isArray(legacyApi.keys) ? legacyApi.keys.filter(isKey) : null
  const legacyTag = legacy === null ? '' : legacy.join(',')
  useEffect(() => {
    if (legacy === null) return setPicked({})
    setPicked(Object.fromEntries(legacy.map((k) => [k, true])))
    if (legacy.length > 0) resolveMany(legacy)
  }, [legacyTag, resolveMany])

  const doPublishLegacy = async () => {
    setDone('')
    const confirmed = legacy.filter((k) => picked[k])
    const r = await publish.run(() => legacyApi.confirm(confirmed))
    if (r.ok) {
      notify('Pronto: quem você segue agora aparece em todos os seus aparelhos.')
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
      await reread()
    }
  }

  const changing = remove.pending || rereading

  if (!mine) {
    return (
      <View style={styles.screen}>
        <TopBar title='Seguindo' onBack={onBack} />
        <OfflineNote />
        <EmptyState icon='gente' title='Seguindo' body='Disponível em breve.' />
      </View>
    )
  }

  const header = (
    <View style={styles.header}>
      <Field
        label={FILTER_LABEL}
        placeholder={FILTER_PLACEHOLDER}
        value={text}
        onChangeText={setText}
        maxLength={80}
        returnKeyType='search'
      />
      <Soft>{FILTER_HINT}</Soft>
      {legacyApi !== null && !legacyHidden && legacy !== null && legacy.length > 0
        ? (
          <Card>
            <Text style={styles.name}>Pessoas que você seguia neste aparelho</Text>
            <Soft>Para aparecerem em todos os seus aparelhos, elas precisam ficar públicas no seu perfil. Confira a lista:</Soft>
            {legacy.map((k) => (
              <LegacyRow
                key={k}
                followKey={k}
                profile={profileOf(k)}
                checked={picked[k] === true}
                disabled={publish.pending}
                onToggle={() => setPicked((p) => ({ ...p, [k]: !p[k] }))}
              />
            ))}
            <ErrorText>{publish.error}</ErrorText>
            <View style={styles.addRow}>
              <Pill label='Agora não' onPress={() => setLegacyHidden(true)} disabled={publish.pending} />
              <Pill label='Publicar selecionados' filled onPress={doPublishLegacy} pending={publish.pending} />
            </View>
          </Card>
          )
        : null}
      <Notice>{done}</Notice>
      <ErrorText>{loadError || remove.error}</ErrorText>
    </View>
  )

  const footer = loaded
    ? <ListFooter loading={loadingMore} atEnd={atEnd && keys.length > 0} error={moreError} onRetry={doMore} pending={loadingMore} />
    : null

  const empty = !loaded
    ? (loadError ? null : <Skeleton rows={3} />)
    : total === 0
      ? (
        <EmptyState
          icon='gente'
          title='Você ainda não segue ninguém'
          body='Encontre pessoas na Busca para ver as publicações delas na Rua.'
        />
        )
      : filtering && shownKeys.length === 0
        ? (unresolved > 0
            ? <View style={styles.note}><Soft>Carregando nomes…</Soft></View>
            : atEnd
              ? <View style={styles.note}><Soft>{FILTER_EMPTY}</Soft></View>
              : paused
                ? (
                  <View style={styles.note}>
                    <Soft>Ninguém com esse nome entre os já carregados.</Soft>
                    <Pill label='carregar mais' onPress={moreByHand} pending={loadingMore} />
                  </View>
                  )
                : <View style={styles.note}><Soft>Procurando…</Soft></View>)
        : null

  return (
    <View style={styles.screen}>
      <TopBar title='Seguindo' onBack={onBack} right={<HelpButton doc={HELP.seguindo} />} />
      <OfflineNote />
      <RefreshableList
        scrollToTopSignal={scrollToTop}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        data={shownKeys}
        extraData={[profileOf, removing, changing]}
        keyExtractor={(key) => key}
        onRefresh={refresh}
        refreshing={refreshing}
        onLoadMore={doMore}
        loadingMore={loadingMore}
        loadMoreError={moreError !== ''}
        atEnd={atEnd}
        ListHeaderComponent={
          <>
            {header}
            <SectionHeader right={loaded ? <Soft>{String(total) + (total === 1 ? ' pessoa' : ' pessoas')}</Soft> : null}>
              Seguindo
            </SectionHeader>
            <View style={styles.note}>
              <Soft>{SHORT.followsPublic}</Soft>
            </View>
          </>
        }
        ListEmptyComponent={empty}
        renderItem={({ item }) => (
          <FollowRow
            followKey={item}
            profile={profileOf(item)}
            onOpen={onOpenMember}
            onRemove={doRemove}
            onReport={onReport}
            pending={removing === item}
            disabled={changing}
          />
        )}
        ListFooterComponent={footer}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  legacyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  note: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  header: { paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  addRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  open: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft },
  skeleton: { height: 14, width: '55%', borderRadius: 7, backgroundColor: colors.line }
})
