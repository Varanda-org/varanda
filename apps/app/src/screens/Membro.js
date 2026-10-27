// Membro: a member's profile, pushed above the tabs (App.js screen stack,
// entry { screen: 'membro', key: authorHex, params: { seed } } where the seed
// is { name, username } from the row tapped). The header (avatar, name,
// @nome, bio) comes from profile.read when the node holds the diary, else
// (hosted web) from a diary.peek of the seeder index's profile/username seq
// hints. Seguir/Seguindo uses follow.list / follow.add / follow.remove;
// 'denunciar a conta' opens the report sheet without a post (hosted web). On
// the hosted web the member's posts and reposts are paged from the index
// (/index/member, newest first) and every one is fetched and verified with
// diary.peek (src/thread.js assembleMember). Natively, or offline, only the
// header shows, with a note. No key is ever shown; every peer string goes
// through displayText (PostRow does it for the rows).

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchMember, invalidateMember, POSTS_MAX } from '../indexClient'
import { assembleMember, planPeeks } from '../thread'
import { whoOf } from '../who'
import { Soft, errorText, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { PostRow } from '../ui/PostRow'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { colors, type } from '../ui/theme'
import { isSeederDown, knownAuthors, learnPeeked, peekAll, planWithHints, postAt, refOf, rowProps, useEngagement, useFollowSet } from './Conversa'

const NOT_HOSTED_NOTE = 'Publicações completas disponíveis na versão web, com internet.'
const OFFLINE_NOTE = 'Sem internet: as publicações completas aparecem quando a conexão voltar.'

const str = (v) => (typeof v === 'string' && v !== '' ? v : null)

// The posts of `items` that are not peeked yet and must be shown: repost
// originals and quoted posts, as diary.peek params (with the index hints of
// the strangers among their authors, so their names are learned).
async function extraPlan (items, peeked, known, alive) {
  const refs = []
  for (const item of items) {
    const target = item.kind === 'repost' ? item.to : item.quote
    if (!target) continue
    const ref = refOf(target.author, target.seq)
    if (postAt(peeked, ref) === null) refs.push(ref)
  }
  return planWithHints(refs, known, alive)
}

// The post a row shows: the item itself, or a repost's original.
function shownPost (item, peeked) {
  return item.kind === 'repost' ? postAt(peeked, refOf(item.to.author, item.to.seq)) : item
}

const INITIAL_POSTS = {
  phase: 'loading', // 'loading' | 'ready' | 'error'
  error: '',
  items: [],
  unavailable: 0,
  before: null,
  atEnd: false,
  indexing: false,
  complete: true,
  loadingMore: false,
  moreError: '',
  refreshing: false
}

export default function Membro ({ entry, ownKey, onBack, onFollowsChanged, onReply, onQuote, onReport, onOpenThread, onOpenMember, onToast }) {
  const node = useNode()
  const names = useNames()
  const now = useNow(60000)
  const bottomPad = useBottomPad()
  const author = entry.key
  const seed = entry.params && entry.params.seed ? entry.params.seed : null
  const full = !!node.hosted && node.online !== false
  const { request } = node
  const { learnMany, resolveMany } = names
  const eng = useEngagement({ request, onToast })
  const { follows, load: loadFollows, mark } = useFollowSet(request)
  const [header, setHeader] = useState(() => ({
    name: seed ? str(seed.name) : null,
    username: seed ? str(seed.username) : null,
    bio: null,
    verified: false
  }))
  const headerRef = useRef(header)
  const [posts, setPosts] = useState(INITIAL_POSTS)
  const postsRef = useRef(posts)
  const peekedRef = useRef(new Map())
  const followsRef = useRef(Promise.resolve(new Set()))
  const genRef = useRef(0)
  const [following, setFollowing] = useState(false)

  const commitHeader = useCallback((h) => {
    headerRef.current = h
    setHeader(h)
  }, [])
  const commit = useCallback((patch) => {
    postsRef.current = { ...postsRef.current, ...patch }
    setPosts(postsRef.current)
  }, [])

  // The header from profile.read (the node holds the diary); false when the
  // node has no showable diary for this key or the read failed.
  const readProfile = useCallback(async () => {
    try {
      const r = await request('profile.read', { authors: [author] })
      const p = (r && Array.isArray(r.profiles) ? r.profiles : []).find((x) => x && typeof x.author === 'string' && x.author.toLowerCase() === author)
      if (!p) return false
      const h = { name: str(p.name), username: str(p.username), bio: str(p.bio), verified: true }
      commitHeader(h)
      learnMany([[author, { name: h.name, username: h.username, bio: h.bio }]])
      return true
    } catch {
      return false
    }
  }, [request, author, commitHeader, learnMany])

  // The header from a peek (verified profile/username fields only).
  const headerFromPeek = useCallback((peek) => {
    if (!peek) return
    const name = peek.profile && typeof peek.profile.name === 'string' ? str(peek.profile.name) : null
    const bio = peek.profile && typeof peek.profile.bio === 'string' ? str(peek.profile.bio) : null
    const username = str(peek.username)
    if (name === null && username === null && bio === null) return
    commitHeader({ name, username, bio, verified: true })
  }, [commitHeader])

  // One page of the member's index (`before` exclusive), peeked and
  // assembled; returns { items, unavailable, index } or throws.
  const readPage = useCallback(async (before, alive, withHeader) => {
    const res = await fetchMember(author, before)
    if (!alive()) return null
    if (!res.ok) {
      const err = new Error(res.reason === 'not-found' ? 'Este perfil não está disponível.' : 'Não foi possível carregar as publicações.')
      err.reason = res.reason
      throw err
    }
    const index = res.value
    const peeked = peekedRef.current
    const hints = { [author]: { profileSeq: index.profileSeq, usernameSeq: index.usernameSeq } }
    const refs = index.posts.map((seq) => refOf(author, seq))
    if (withHeader && refs.length === 0) {
      // No posts: peek only the profile/username blocks for the header.
      const seqs = [...new Set([index.profileSeq, index.usernameSeq].filter((s) => Number.isSafeInteger(s) && s >= 1))].sort((a, b) => a - b)
      if (seqs.length > 0) await peekAll(request, planPeeks({ refs: seqs.map((s) => refOf(author, s)), authors: hints }), peeked, alive)
    } else {
      await peekAll(request, planPeeks({ refs, authors: withHeader ? hints : undefined }), peeked, alive)
    }
    if (!alive()) return null
    // withHeader: profile.read did not answer in this load, so the newest
    // verified peek is applied.
    if (withHeader) headerFromPeek(peeked.get(author))
    const page = assembleMember({ author, index, peeked })
    const followSet = await followsRef.current
    if (!alive()) return null
    const known = () => knownAuthors({ ownKey, follows: followSet, hinted: hints, peeked })
    await peekAll(request, await extraPlan(page.items, peeked, known(), alive), peeked, alive)
    if (!alive()) return null
    // Quotes inside repost originals.
    const originals = page.items.filter((i) => i.kind === 'repost').map((i) => shownPost(i, peeked)).filter(Boolean)
    await peekAll(request, await extraPlan(originals, peeked, known(), alive), peeked, alive)
    if (!alive()) return null
    learnPeeked(learnMany, peeked)
    let unavailable = page.unavailable
    const items = page.items.filter((i) => {
      if (shownPost(i, peeked) !== null) return true
      unavailable++
      return false
    })
    return { items, unavailable, index }
  }, [author, request, headerFromPeek, learnMany, ownKey])

  const { readOwn, readCounts, reset } = eng
  const afterPage = useCallback((items, alive) => {
    const peeked = peekedRef.current
    const shown = items.map((i) => shownPost(i, peeked)).filter(Boolean)
    const refs = shown.map((p) => refOf(p.author, p.seq))
    resolveMany([...new Set(shown.map((p) => p.author).concat(shown.filter((p) => p.replyTo).map((p) => p.replyTo.author)))])
    readOwn(refs, alive).then(() => readCounts(refs, alive))
  }, [readOwn, readCounts, resolveMany])

  const load = useCallback(async (refreshing = false) => {
    const mine = ++genRef.current
    const alive = () => mine === genRef.current
    commit(refreshing ? { refreshing: true, error: '' } : { ...INITIAL_POSTS })
    // Every load verifies the header again (the fields stay shown meanwhile).
    commitHeader({ ...headerRef.current, verified: false })
    const held = await readProfile()
    if (!alive()) return
    followsRef.current = loadFollows()
    if (!full) {
      commit({ phase: 'ready', refreshing: false })
      return
    }
    try {
      // An explicit refresh reads the member index again instead of the
      // cached first page (paging never invalidates: its pages follow it).
      if (refreshing) {
        reset()
        invalidateMember(author)
      }
      peekedRef.current = new Map()
      const page = await readPage(null, alive, !held)
      if (!alive() || page === null) return
      const { items, unavailable, index } = page
      commit({
        phase: 'ready',
        error: '',
        refreshing: false,
        items,
        unavailable,
        before: index.posts.length > 0 ? index.posts[index.posts.length - 1] : null,
        atEnd: index.posts.length < POSTS_MAX,
        indexing: index.indexing,
        complete: index.complete,
        loadingMore: false,
        moreError: ''
      })
      afterPage(items, alive)
    } catch (err) {
      if (!alive()) return
      commit({ phase: 'error', refreshing: false, error: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : (err && err.reason ? err.message : errorText(err)) })
    }
  }, [commit, commitHeader, readProfile, loadFollows, full, reset, readPage, afterPage])

  const loadMore = useCallback(async () => {
    const current = postsRef.current
    if (current.phase !== 'ready' || current.loadingMore || current.refreshing || current.atEnd || current.before === null) return
    const mine = genRef.current
    const alive = () => mine === genRef.current
    commit({ loadingMore: true, moreError: '' })
    try {
      const page = await readPage(current.before, alive, false)
      if (!alive() || page === null) return
      const { items, unavailable, index } = page
      const seen = new Set(postsRef.current.items.map((i) => i.seq))
      const fresh = items.filter((i) => !seen.has(i.seq))
      commit({
        items: postsRef.current.items.concat(fresh),
        unavailable: postsRef.current.unavailable + unavailable,
        before: index.posts.length > 0 ? index.posts[index.posts.length - 1] : current.before,
        atEnd: index.posts.length < POSTS_MAX,
        indexing: index.indexing,
        complete: index.complete,
        loadingMore: false
      })
      afterPage(fresh, alive)
    } catch (err) {
      if (alive()) commit({ loadingMore: false, moreError: isSeederDown(err) ? 'Sem conexão com o servidor agora.' : (err && err.reason ? err.message : errorText(err)) })
    }
  }, [commit, readPage, afterPage])

  useEffect(() => {
    load(false)
    return () => { genRef.current += 1 }
  }, [load])

  const isFollowed = follows !== null && follows.has(author)
  const toggleFollow = async () => {
    if (following || follows === null) return
    const on = !isFollowed
    setFollowing(true)
    try {
      await request(on ? 'follow.add' : 'follow.remove', { key: author })
      mark(author, on)
      if (typeof onFollowsChanged === 'function') onFollowsChanged()
    } catch (err) {
      if (typeof onToast === 'function') onToast(errorText(err))
      // Uncertain or failed: read the list again before the next change.
      await loadFollows()
    } finally {
      setFollowing(false)
    }
  }

  const who = whoOf({ name: header.name, username: header.username })
  const own = typeof ownKey === 'string' && author === ownKey
  const canReport = full && !own && typeof onReport === 'function' && typeof ownKey === 'string'

  const head = (
    <View style={styles.head}>
      <Avatar name={who.avatarName} publicKey={author} size={88} />
      <Text style={styles.name} accessibilityRole='header'>{displayText(who.title)}</Text>
      {who.subtitle ? <Text style={styles.handle}>{displayText(who.subtitle)}</Text> : null}
      {header.bio ? <Text style={styles.bio}>{displayText(header.bio, { multiline: true })}</Text> : null}
      <View style={styles.actions}>
        {!own
          ? (
            <Pill
              label={isFollowed ? 'Seguindo' : 'Seguir'}
              filled={!isFollowed}
              pending={following}
              disabled={follows === null}
              accessibilityLabel={isFollowed ? 'deixar de seguir ' + displayText(who.title) : 'seguir ' + displayText(who.title)}
              onPress={toggleFollow}
            />
            )
          : null}
        {canReport
          ? (
            <Pill
              label='denunciar a conta'
              danger
              onPress={() => onReport({ author, name: header.name, username: header.username })}
            />
            )
          : null}
      </View>
    </View>
  )

  const top = <TopBar title={displayText(who.title)} onBack={onBack} />
  if (!full) {
    return (
      <View style={styles.flex}>
        {top}
        <OfflineNote />
        <View style={styles.flex}>
          {head}
          <View style={styles.note}><Soft>{node.hosted ? OFFLINE_NOTE : NOT_HOSTED_NOTE}</Soft></View>
        </View>
      </View>
    )
  }

  const { phase, error, items, unavailable, atEnd, indexing, complete, loadingMore, moreError, refreshing } = posts
  const notes = []
  if (phase === 'ready' && indexing) notes.push('Ainda montando a lista completa…')
  else if (phase === 'ready' && complete === false) notes.push('Algumas publicações podem faltar.')
  if (unavailable > 0) notes.push(unavailable === 1 ? '1 publicação indisponível' : String(unavailable) + ' publicações indisponíveis')

  const listHeader = (
    <View>
      {head}
      {notes.length > 0 ? <View style={styles.note}>{notes.map((n) => <Soft key={n}>{n}</Soft>)}</View> : null}
    </View>
  )

  let empty = null
  if (phase === 'loading') empty = <Skeleton />
  else if (phase === 'error') empty = <ErrorState message={displayText(error)} onRetry={() => load(false)} pending={refreshing} />
  else if (unavailable === 0) empty = <EmptyState icon='lapis' title='Nenhuma publicação ainda' />

  const handlers = { onOpenThread, onOpenMember, onReply, onQuote, onReport }
  const memberWho = { author, name: header.name, username: header.username }
  const renderItem = ({ item }) => {
    const peeked = peekedRef.current
    const post = shownPost(item, peeked)
    if (post === null) return null
    const extra = item.kind === 'repost' ? { repostedBy: memberWho } : {}
    // The member's own posts carry the header's identity.
    const shown = post.author === author ? { ...post, name: post.name || header.name, username: post.username || header.username } : post
    return <PostRow {...rowProps({ item: shown, names, peeked, now, ownKey, follows, eng, handlers, extra })} />
  }

  return (
    <View style={styles.flex}>
      {top}
      <OfflineNote />
      <View style={styles.flex}>
        <RefreshableList
          data={phase === 'ready' ? items : []}
          keyExtractor={(i) => i.kind + ':' + i.seq}
          renderItem={renderItem}
          extraData={{ eng, follows, now, header, profileOf: names.profileOf }}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={empty}
          ListFooterComponent={phase === 'ready'
            ? (
              <ListFooter
                loading={loadingMore}
                atEnd={atEnd && items.length > 0}
                endText='Isso é tudo por enquanto.'
                error={moreError}
                onRetry={loadMore}
                pending={loadingMore}
              />
              )
            : null}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onLoadMore={phase === 'ready' && !atEnd && !moreError ? loadMore : undefined}
          loadingMore={loadingMore}
          loadMoreError={!!moreError}
          atEnd={atEnd}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  head: { alignItems: 'center', gap: 6, paddingTop: 20, paddingBottom: 16, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.line },
  name: { ...type.profileName, color: colors.ink, textAlign: 'center', marginTop: 8 },
  handle: { ...type.postMeta, color: colors.soft },
  bio: { ...type.postText, color: colors.ink, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
  note: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 }
})
