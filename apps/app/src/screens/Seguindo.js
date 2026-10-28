// Seguindo: follow.add, follow.remove, follow.list (offset paging, 50 per
// page). Rows show the avatar and the name (or @nome) the member chose, read
// from the profiles cache; never a key. The list reloads when another device
// changes the follows (node.followsVersion). A "Seguindo" pill unfollows. Design:
// apps/site/artwork/app-design.md.
//
// On the hosted web a "Buscar" field above the exact follow field finds
// people by display name or @nome (useMemberSearch): the seeder's search
// answer only says where to look, and a row appears only once diary.peek
// confirms that person (name from the peeked profile, @nome only from the
// verified username). Each row opens the profile and has Seguir/Seguindo,
// read from the full follow set (useFollowSet). The own key never has a row.
// Native and loopback keep the exact follow field only and send no search.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { pickAvatar } from '../media/avatar'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { UNNAMED, whoOf } from '../who'
import { HELP, SHORT } from '../help'
import { Card, ErrorText, Field, Notice, SectionHeader, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { HelpLink } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ListFooter, Skeleton } from '../ui/States'
import { colors, type } from '../ui/theme'
import { queryPath } from '../search'
import { useMemberSearch } from '../useMemberSearch'
import { useFollowSet } from './Conversa'

const PAGE = 50

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
      <Pill
        label='Seguindo'
        onPress={() => onRemove(followKey)}
        pending={pending}
        disabled={disabled}
        accessibilityLabel={who.known ? 'deixar de seguir ' + title : 'deixar de seguir'}
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

// One confirmed search result, styled like FollowRow: the name and the
// verified @nome from the peek (`hit`), never a key, and no 'denunciar'. The
// avatar and name open the profile; the pill follows ('Seguir') or unfollows
// ('Seguindo'), disabled while the follow set is unknown (`following` null).
function SearchRow ({ hit, avatar, following, onOpen, onFollow, onUnfollow, pending, disabled }) {
  const profile = { name: hit.name, username: hit.username }
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(hit.author, profile) : undefined
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.open, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={'ver o perfil de ' + title}
        disabled={!open}
        onPress={open}
      >
        <Avatar name={who.avatarName} publicKey={hit.author} size={44} picture={avatar} persist={following === true} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </Pressable>
      {following === true
        ? (
          <Pill
            label='Seguindo'
            onPress={() => onUnfollow(hit)}
            pending={pending}
            disabled={disabled}
            accessibilityLabel={'deixar de seguir ' + title}
          />
          )
        : (
          <Pill
            label='Seguir'
            filled
            onPress={() => onFollow(hit)}
            pending={pending}
            disabled={disabled || following === null}
            accessibilityLabel={'seguir ' + title}
          />
          )}
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

// `onFollowsChanged` (optional): called after a follow or unfollow that
// changed the list, so the shell refreshes A Rua, Diário and the follow count.
// `onOpenMember(followKey, { name, username })` (optional): a row's name opens
// the member's profile. `ownKey`: the own public key, never a search row.
export default function Seguindo ({ active, ownKey, followsTick, onReport, onFollowsChanged, onOpenMember, scrollToTop }) {
  const node = useNode()
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const names = useNames()
  const bottomPad = useBottomPad()
  const [keys, setKeys] = useState([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [localError, setLocalError] = useState('')
  // True while follow.list is re-read after a change: no new change until then.
  const [rereading, setRereading] = useState(false)
  // The key being removed: only its row shows "Seguindo…".
  const [removing, setRemoving] = useState(null)
  const [done, setDone] = useNotice()
  const add = useAction()
  const remove = useAction()
  const follow = useAction()
  // The key a search row is following: only its pill shows "Seguir…".
  const [following, setFollowing] = useState(null)
  const search = useMemberSearch({ request: node.request, hosted: node.hosted === true, online: node.online !== false, ownKey: own })
  const { setQuery: setSearchQuery, flush: handleSearch, retry: handleRetry } = search
  const { follows, load: loadFollows, mark: markFollow } = useFollowSet(node.request)
  const searching = search.phase !== 'idle'
  // The full follow set is read when search first becomes active and again
  // at every new search (a failed or stale read never sticks).
  const followsAsked = useRef(false)
  const loading = search.phase === 'loading'
  useEffect(() => {
    if (!searching) return
    if (followsAsked.current && !loading) return
    followsAsked.current = true
    loadFollows()
  }, [searching, loading, loadFollows])
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
    const mine = ++seqRef.current
    reloadingRef.current = true
    setLoadingMore(false)
    setMoreError('')
    try {
      const r = await node.request('follow.list', { offset: 0, limit: Math.min(FOLLOW_LIMIT_MAX, Math.max(PAGE, want)) })
      if (mine !== seqRef.current) return
      setKeys(r.follows)
      setTotal(r.total)
      setLoaded(true)
      setLoadError('')
      resolveMany(r.follows)
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    } finally {
      if (mine === seqRef.current) reloadingRef.current = false
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

  useEffect(() => { if (active) reload(PAGE) }, [active, reload])

  // A follow changed elsewhere (another device, synced): read the list again.
  const followsVersion = typeof node.followsVersion === 'number' ? node.followsVersion : 0
  const seenVersion = useRef(followsVersion)
  useEffect(() => {
    if (seenVersion.current === followsVersion) return
    seenVersion.current = followsVersion
    if (active) reload(PAGE)
    if (followsAsked.current) loadFollows()
  }, [followsVersion, active, reload, loadFollows])

  // A follow changed in this app (another screen, the profile, the exact
  // field): the search pills read the follow set again once search was used.
  const seenTick = useRef(followsTick)
  useEffect(() => {
    if (seenTick.current === followsTick) return
    seenTick.current = followsTick
    if (followsAsked.current) loadFollows()
  }, [followsTick, loadFollows])

  // Pull-to-refresh re-reads the first page; the list never calls it twice.
  // It also re-reads the follow set and re-runs a valid search query.
  const refresh = async () => {
    setRefreshing(true)
    try {
      if (node.hosted === true && queryPath(search.query) !== null) search.retry()
      await Promise.all([reload(PAGE), followsAsked.current ? loadFollows() : null])
    } finally {
      setRefreshing(false)
    }
  }

  // A 64-hex key, or '@nome' on a hosted page: the account service names the
  // key, and the follow is still that key (follows stay keys).
  const doAdd = async () => {
    setDone('')
    const text = input.trim()
    const key = text.toLowerCase()
    let name = null
    if (!isKey(key)) {
      if (!text.startsWith('@')) return setLocalError(node.hosted ? 'Digite um @nome ou cole o código da pessoa.' : 'Cole o código da pessoa (64 letras e números).')
      if (!node.hosted) return setLocalError('Nesta versão, siga pelo código da pessoa.')
      name = isUsername(text)
      if (name === null) return setLocalError('@nome inválido')
    }
    setLocalError('')
    const r = await add.run(async () => {
      let target = key
      if (name !== null) {
        const found = await lookupUsername(name)
        // Same-origin data, not a signature check: only a consistent answer.
        if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) throw new Error('@nome não encontrado')
        target = found.member
      }
      const res = await node.request('follow.add', { key: target })
      return { target, changed: res.changed }
    })
    if (r.ok) {
      setInput('')
      names.resolve(r.value.target)
      // Names the person once the profile is known; never by key.
      const profile = profileOf(r.value.target)
      const named = profile && (profile.name || profile.username) ? ' ' + displayText(whoOf(profile).title) : ''
      setDone(r.value.changed ? 'Agora você segue' + (named || ' esta pessoa') + '.' : 'Você já segue esta pessoa.')
      if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
    }
    await reread()
  }

  const doRemove = async (key) => {
    setDone('')
    setRemoving(key)
    try {
      const r = await remove.run(() => node.request('follow.remove', { key }))
      if (r.ok) setDone(r.value.changed ? 'Você deixou de seguir.' : 'Você já não seguia esta pessoa.')
      if (r.ok && r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      if (r.ok && followsAsked.current) markFollow(key.toLowerCase(), false)
      // Success, failure or an uncertain answer: the search pills read the
      // follow set again, like the list below.
      if (followsAsked.current) loadFollows()
      await reread()
    } finally {
      setRemoving(null)
    }
  }

  // Seguir on a search row: the verified name and @nome come from the peek.
  // One attempt; never retried automatically.
  const doFollowHit = async (hit) => {
    setDone('')
    setFollowing(hit.author)
    try {
      const r = await follow.run(() => node.request('follow.add', { key: hit.author }))
      if (r.ok) {
        markFollow(hit.author, true)
        names.learnMany([[hit.author, { name: hit.name, username: hit.username }]])
        const title = displayText(whoOf({ name: hit.name, username: hit.username }).title)
        setDone(r.value.changed ? 'Agora você segue ' + title + '.' : 'Você já segue esta pessoa.')
        if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      }
      // Success, failure or an uncertain answer: read the follow set again.
      loadFollows()
      await reread()
    } finally {
      setFollowing(null)
    }
  }

  // Older pages only after the first read landed (an end reach on the empty
  // list must not ask offset 0 a second time), one at a time; a key already
  // shown is never appended twice.
  const doMore = async () => {
    if (!loaded || loadingMore || reloadingRef.current) return
    const mine = seqRef.current
    setLoadingMore(true)
    setMoreError('')
    try {
      const r = await node.request('follow.list', { offset: keys.length, limit: PAGE })
      if (mine !== seqRef.current) return
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
      if (mine !== seqRef.current) return
      setMoreError(errorText(err))
      setLoadingMore(false)
    }
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
    const keys = legacy.filter((k) => picked[k])
    const r = await publish.run(() => legacyApi.confirm(keys))
    if (r.ok) {
      setDone('Pronto: quem você segue agora aparece em todos os seus aparelhos.')
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
      await reread()
    }
  }

  const changing = add.pending || remove.pending || follow.pending || rereading

  // The search block (hosted only): field, state lines, confirmed rows.
  const hits = search.hits.filter((h) => h.author !== own)
  const offline = node.online === false
  const ready = search.phase === 'ready'
  const listed = ready || search.phase === 'loading'
  const searchBlock = node.hosted === true
    ? (
      <>
        <Field
          label='Buscar'
          placeholder='nome ou @nome'
          value={search.query}
          onChangeText={setSearchQuery}
          maxLength={80}
          editable={!offline}
        />
        <View style={styles.addRow}>
          <Pill label='Buscar' onPress={handleSearch} disabled={offline || search.query.trim() === ''} />
        </View>
        {offline || search.phase === 'offline' ? <Soft>A busca precisa de internet.</Soft> : null}
        {search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
        {search.phase === 'error'
          ? (
            <>
              <ErrorText>{search.error}</ErrorText>
              <View style={styles.addRow}><Pill label='tentar de novo' onPress={handleRetry} /></View>
            </>
            )
          : null}
        {search.phase === 'loading' && hits.length === 0 ? <View style={styles.bleed}><Skeleton rows={2} /></View> : null}
        {hits.length > 0
          ? (
            <View style={styles.bleed}>
              {hits.map((hit) => (
                <SearchRow
                  key={hit.author}
                  hit={hit}
                  avatar={pickAvatar(names.profileOf(hit.author), hit)}
                  following={follows === null ? null : follows.has(hit.author)}
                  onOpen={onOpenMember}
                  onFollow={doFollowHit}
                  onUnfollow={(h) => doRemove(h.author)}
                  pending={following === hit.author || removing === hit.author}
                  disabled={changing}
                />
              ))}
            </View>
            )
          : null}
        {ready && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
        {ready && hits.length === 0 && search.unchecked > 0
          ? (
            <>
              <Soft>Não deu para conferir todo mundo agora.</Soft>
              <View style={styles.addRow}><Pill label='tentar de novo' onPress={handleRetry} /></View>
            </>
            )
          : null}
        {ready && hits.length > 0 && search.unchecked > 0 ? <Soft>Algumas pessoas não puderam ser conferidas agora.</Soft> : null}
        {listed && search.complete === false ? <Soft>Ainda montando a lista; alguém pode faltar.</Soft> : null}
        {listed && search.more ? <Soft>Há mais gente com esse nome. Tente um nome mais específico.</Soft> : null}
        <ErrorText>{follow.error}</ErrorText>
      </>
      )
    : null

  const header = (
    <View style={styles.header}>
      {searchBlock}
      <Field
        placeholder={node.hosted ? '@nome ou código' : 'código da pessoa (64 letras e números)'}
        value={input}
        onChangeText={setInput}
        mono
        multiline
        lines={2}
      />
      <View style={styles.addRow}>
        <Pill label='Seguir' filled onPress={doAdd} pending={add.pending} disabled={input.trim() === '' || changing} />
      </View>
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
      <ErrorText>{localError || add.error}</ErrorText>
      <Notice>{done}</Notice>
      <ErrorText>{loadError || remove.error}</ErrorText>
    </View>
  )

  // Nothing to page before the first read: the list stays "at the end".
  const atEnd = !loaded || keys.length >= total
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
          body={node.hosted ? 'Busque alguém pelo nome ou @nome para ver as publicações dessa pessoa na Rua.' : 'Cole o código de alguém para ver as publicações dessa pessoa na Rua.'}
        />
        )
      : null

  return (
    <RefreshableList
      scrollToTopSignal={scrollToTop}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      data={keys}
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
            <HelpLink doc={HELP.seguindo} />
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
  )
}

const styles = StyleSheet.create({
  legacyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  note: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  bleed: { marginHorizontal: -16 },
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
