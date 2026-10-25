// Seguindo: follow.add, follow.remove, follow.list (offset paging, 50 per
// page). Rows show the avatar and the name (or @nome) the member chose, read
// from the profiles cache; never a key. A "Seguindo" pill unfollows. Design:
// apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { whoOf } from '../who'
import { ErrorText, Field, Notice, SectionHeader, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ListFooter, Skeleton } from '../ui/States'
import { colors, type } from '../ui/theme'

const PAGE = 50

// One followed diary. The name column is not pressable yet; 'denunciar' opens
// the report sheet for the whole account (the list never holds the own key:
// follow.add refuses it). `profile` is undefined while it is being looked up.
function FollowRow ({ followKey, profile, onRemove, onReport, pending, disabled }) {
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  return (
    <View style={styles.row}>
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

// `onFollowsChanged` (optional): called after a follow or unfollow that
// changed the list, so the shell refreshes A Rua, Diário and the follow count.
export default function Seguindo ({ active, onReport, onFollowsChanged, scrollToTop }) {
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
      if (!text.startsWith('@')) return setLocalError('chave inválida (64 dígitos hexadecimais) ou @nome')
      if (!node.hosted) return setLocalError('siga pela chave nesta versão')
      name = isUsername(text)
      if (name === null) return setLocalError('nome inválido')
    }
    setLocalError('')
    const r = await add.run(async () => {
      let target = key
      if (name !== null) {
        const found = await lookupUsername(name)
        // Same-origin data, not a signature check: only a consistent answer.
        if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) throw new Error('nome não encontrado')
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
      setDone(r.value.changed ? 'seguindo' + named : 'você já seguia esta chave')
      if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
    }
    await reread()
  }

  const doRemove = async (key) => {
    setDone('')
    setRemoving(key)
    try {
      const r = await remove.run(() => node.request('follow.remove', { key }))
      if (r.ok) setDone(r.value.changed ? 'deixou de seguir' : 'esta chave não estava na lista')
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

  const changing = add.pending || remove.pending || rereading

  const header = (
    <View style={styles.header}>
      <Field
        placeholder={node.hosted ? 'chave pública ou @nome' : 'chave pública (64 dígitos hexadecimais)'}
        value={input}
        onChangeText={setInput}
        mono
        multiline
        lines={2}
      />
      <View style={styles.addRow}>
        <Pill label='Seguir' filled onPress={doAdd} pending={add.pending} disabled={input.trim() === '' || changing} />
      </View>
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
          body='Cole a chave pública de alguém (ou um @nome, na versão web) para ver as publicações dessa pessoa na Rua.'
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
          <SectionHeader right={loaded ? <Soft>{String(total) + (total === 1 ? ' diário' : ' diários')}</Soft> : null}>
            Seguindo
          </SectionHeader>
        </>
      }
      ListEmptyComponent={empty}
      renderItem={({ item }) => (
        <FollowRow
          followKey={item}
          profile={profileOf(item)}
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
  header: { paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  addRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft },
  skeleton: { height: 14, width: '55%', borderRadius: 7, backgroundColor: colors.line }
})
