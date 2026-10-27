// Seguindo: follow.add, follow.remove, follow.list (offset paging, 50 per
// page). Rows show the avatar and the name (or @nome) the member chose, read
// from the profiles cache; never a key. The list reloads when another device
// changes the follows (node.followsVersion). A "Seguindo" pill unfollows. Design:
// apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { UNNAMED, whoOf } from '../who'
import { Card, ErrorText, Field, Notice, SectionHeader, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ListFooter, Skeleton } from '../ui/States'
import { colors, type } from '../ui/theme'

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
        <Avatar name={who.avatarName} publicKey={followKey} size={44} />
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
        hitSlop={8}
        onPress={() => onReport({
          author: followKey,
          name: profile ? profile.name : null,
          username: profile ? profile.username : null,
          seq: null,
          text: null
        })}
      >
        <Text style={styles.handle}>denunciar</Text>
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

// `onFollowsChanged` (optional): called after a follow or unfollow that
// changed the list, so the shell refreshes A Rua, Diário and the follow count.
// `onOpenMember(followKey, { name, username })` (optional): a row's name opens
// the member's profile.
export default function Seguindo ({ active, onReport, onFollowsChanged, onOpenMember, scrollToTop }) {
  const node = useNode()
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
  }, [followsVersion, active, reload])

  // Pull-to-refresh re-reads the first page; the list never calls it twice.
  const refresh = async () => {
    setRefreshing(true)
    try {
      await reload(PAGE)
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
      if (!text.startsWith('@')) return setLocalError(node.hosted ? 'Digite um @nome ou cole a chave da pessoa.' : 'Cole a chave da pessoa (64 letras e números).')
      if (!node.hosted) return setLocalError('Nesta versão, siga pela chave da pessoa.')
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

  const changing = add.pending || remove.pending || rereading

  const header = (
    <View style={styles.header}>
      <Field
        placeholder={node.hosted ? '@nome ou chave' : 'chave da pessoa (64 letras e números)'}
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
          body={node.hosted ? 'Digite o @nome de alguém para ver as publicações dessa pessoa na Rua.' : 'Cole a chave de alguém para ver as publicações dessa pessoa na Rua.'}
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
          <View style={styles.note}><Soft>Quem você segue é público e aparece igual em todos os seus aparelhos.</Soft></View>
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
  note: { paddingHorizontal: 16, paddingBottom: 8 },
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
