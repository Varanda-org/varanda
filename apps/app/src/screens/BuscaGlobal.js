// Busca: the global search tab, with two categories under one field.
//
// Contas (moved from Seguindo): the field takes a name, an @nome or a 64-hex
// code (classifyFollowInput). A name or @nome searches (useMemberSearch); an
// @nome also gets a "Seguir @nome" pill and a code a "Seguir" pill that
// follows by key with no search. Nodes that are not hosted keep the code
// field only and send no search. The own key is never listed or followed.
//
// Publicações (moved from the Espiadinha): a word search over the seeder's
// topic index, sent on submit only (the seeder rate-limits /index requests),
// listed by Busca.js. Hosted nodes only.
//
// Trust model: the seeder only says where to look. Every account is confirmed
// with diary.peek (name from the peeked profile, @nome only from the verified
// username) and every post is read and verified the same way before it is
// shown, as in Busca.js. An @nome follow checks the account service's answer
// for consistency before following the key.
//
// Each category keeps its own draft and results while the other is shown:
// both panes stay mounted and only the selected one is visible.

import { useContext, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { pickAvatar } from '../media/avatar'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { whoOf } from '../who'
import { HELP, SHORT } from '../help'
import { PARTIAL_KEY_TEXT } from '../followInput'
import { SEARCH_CLEAR, SEARCH_INPUT_MAX, SEARCH_INVALID, SEARCH_TRUNCATED } from '../topics'
import {
  BUSCA_EMPTY, BUSCA_EMPTY_CODE, BUSCA_LABEL, BUSCA_NOT_HOSTED, BUSCA_NOT_HOSTED_TITLE, BUSCA_PLACEHOLDER, CATEGORIES, CATEGORY_LABEL,
  CODE_FIELD_LABEL, buscaNotice, debouncePlan, plan, staleGuard
} from '../buscaGlobal'
import { ErrorText, Notice, Soft, useAction, useBottomPad } from '../ui'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { MemberRow } from '../ui/MemberRow'
import { Pill } from '../ui/Pill'
import { ScreenVisible } from '../ui/screenVisible'
import { EmptyState, SkeletonRow } from '../ui/States'
import { layout, radius, space, type, webInputReset } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { useMemberSearch } from '../useMemberSearch'
import Busca from './Busca'
import { useFollowSet } from './Conversa'

const NO_DRAFTS = Object.freeze({ contas: '', publicacoes: '' })

// The rounded field of the Conversas search: lupa, system font, clear X.
function SearchField ({ label, placeholder, value, onChangeText, maxLength, onSubmitEditing, inputRef }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  // Both panes: a keyboard that rewrites the query before the typing pause
  // ends would search for words nobody typed.
  const raw = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false }
  const [focused, setFocused] = useState(false)
  return (
    <View style={[styles.search, focused && styles.searchFocused]}>
      <Icon name='lupa' size={20} color={colors.soft} />
      <TextInput
        ref={inputRef}
        style={[styles.input, webInputReset]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label}
        maxLength={maxLength}
        returnKeyType='search'
        onSubmitEditing={onSubmitEditing}
        {...raw}
      />
      {value !== ''
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={SEARCH_CLEAR} hitSlop={space.md} onPress={() => onChangeText('')} style={styles.clear}>
            <Icon name='fechar' size={18} color={colors.soft} />
          </Pressable>
          )
        : null}
    </View>
  )
}

// `paneRequest` (number): every change, and the mount, shows Contas.
// `onFollowsChanged` (optional): called after a follow or unfollow that
// changed the follows, so the shell refreshes A Rua, Diário and the count.
// `refresh`: the shell's bump after a follow or a sent post.
export default function BuscaGlobal ({ active, ownKey, scrollToTop, paneRequest, onOpenMember, onFollowsChanged, onToast, onReply, onReport, onQuote, onOpenThread, onOpenMention, onOpenEngagers, refresh }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true
  const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const names = useNames()
  const bottomPad = useBottomPad()
  const inputRef = useRef(null)
  const [category, setCategory] = useState('contas')
  const visible = useContext(ScreenVisible)
  const [drafts, setDrafts] = useState(NO_DRAFTS)
  const draft = drafts[category]
  const setDraft = (text) => setDrafts((d) => ({ ...d, [category]: text }))
  // Read after an await: the field stays editable while a follow runs.
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts

  useEffect(() => { setCategory('contas') }, [paneRequest])

  // A reselect scrolls only the category on screen: each one gets its own
  // signal, so a hidden list never moves.
  const [tops, setTops] = useState({ contas: 0, publicacoes: 0 })
  const shownRef = useRef({ active, category })
  shownRef.current = { active, category }
  const lastTop = useRef(scrollToTop)
  useEffect(() => {
    if (lastTop.current === scrollToTop) return
    lastTop.current = scrollToTop
    const { active: on, category: cat } = shownRef.current
    if (on) setTops((t) => ({ ...t, [cat]: t[cat] + 1 }))
  }, [scrollToTop])

  // The full follow set: the Contas pills, and which authors' avatars may be
  // kept (own and followed only, as persistOf in ARua.js).
  const { follows, load: loadFollows, mark: markFollow } = useFollowSet(node.request)
  const followsAsked = useRef(false)
  const followsRef = useRef(follows)
  followsRef.current = follows
  // markFollow on a set not loaded yet would replace it with one key.
  const markKnown = (key, on) => { if (followsRef.current !== null) markFollow(key, on) }

  // Contas.
  const [localError, setLocalError] = useState('')
  const [removing, setRemoving] = useState(null)
  const [following, setFollowing] = useState(null)
  const [done, setDone] = useNotice()
  const add = useAction()
  const remove = useAction()
  const follow = useAction()
  const search = useMemberSearch({ request: node.request, hosted, online: node.online !== false, ownKey: own })
  const { setQuery: setSearchQuery, flush: handleSearch, retry: handleRetry } = search
  const searching = search.phase !== 'idle'
  const loading = search.phase === 'loading'
  // Read when search first becomes active and again at every new search (a
  // failed or stale read never sticks).
  useEffect(() => {
    if (!searching) return
    if (followsAsked.current && !loading) return
    followsAsked.current = true
    loadFollows()
  }, [searching, loading, loadFollows])
  // The code and @nome pills wait for the follow set: asked at the first input.
  const typed = drafts.contas.trim() !== ''
  useEffect(() => {
    if (!typed || followsAsked.current) return
    followsAsked.current = true
    loadFollows()
  }, [typed, loadFollows])
  const followsReady = follows !== null

  // A follow changed elsewhere (another device, or another screen of this
  // app): the pills read the follow set again once it was used.
  const followsVersion = typeof node.followsVersion === 'number' ? node.followsVersion : 0
  const seen = useRef({ followsVersion, refresh })
  useEffect(() => {
    const prev = seen.current
    seen.current = { followsVersion, refresh }
    if (prev.followsVersion === followsVersion && prev.refresh === refresh) return
    if (followsAsked.current) loadFollows()
  }, [followsVersion, refresh, loadFollows])

  // A 64-hex key, or '@nome' on a hosted node: the account service names the
  // key, and the follow is still that key (follows stay keys).
  const doAdd = async () => {
    setDone('')
    const started = drafts.contas
    const text = started.trim()
    const key = text.toLowerCase()
    let name = null
    if (!isKey(key)) {
      if (!text.startsWith('@')) return setLocalError(hosted ? 'Digite um @nome ou cole o código da pessoa.' : CODE_FIELD_LABEL)
      if (!hosted) return setLocalError('Nesta versão, siga pelo código da pessoa.')
      name = isUsername(text)
      if (name === null) return setLocalError('@nome inválido')
    }
    if (own !== null && key === own) return setLocalError('Esse é o seu código.')
    setLocalError('')
    const r = await add.run(async () => {
      let target = key
      if (name !== null) {
        const found = await lookupUsername(name)
        // Same-origin data, not a signature check: only a consistent answer.
        if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) throw new Error('@nome não encontrado')
        target = found.member.toLowerCase()
        if (target === own) throw new Error('Esse é o seu @nome.')
      }
      const res = await node.request('follow.add', { key: target })
      return { target, changed: res.changed }
    })
    if (r.ok) {
      if (draftsRef.current.contas === started) {
        setDrafts((d) => ({ ...d, contas: '' }))
        search.clear()
      }
      names.resolve(r.value.target)
      markKnown(r.value.target, true)
      // Names the person once the profile is known; never by key.
      const profile = names.profileOf(r.value.target)
      const named = profile && (profile.name || profile.username) ? ' ' + displayText(whoOf(profile).title) : ''
      setDone(r.value.changed ? 'Agora você segue' + (named || ' esta pessoa') + '.' : 'Você já segue esta pessoa.')
      if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
    }
    if (followsAsked.current) loadFollows()
  }

  const doRemove = async (key) => {
    setDone('')
    setRemoving(key)
    try {
      const r = await remove.run(() => node.request('follow.remove', { key }))
      if (r.ok) setDone(r.value.changed ? 'Você deixou de seguir.' : 'Você já não seguia esta pessoa.')
      if (r.ok && r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      if (r.ok) markKnown(key.toLowerCase(), false)
      // Success, failure or an uncertain answer: read the follow set again.
      loadFollows()
    } finally {
      setRemoving(null)
    }
  }

  // Seguir on a search row: the verified name and @nome come from the peek.
  // One attempt; never retried automatically.
  const doFollowHit = async (hit) => {
    if (hit.author === own) return
    setDone('')
    setFollowing(hit.author)
    try {
      const r = await follow.run(() => node.request('follow.add', { key: hit.author }))
      if (r.ok) {
        markKnown(hit.author, true)
        names.learnMany([[hit.author, { name: hit.name, username: hit.username }]])
        const title = displayText(whoOf({ name: hit.name, username: hit.username }).title)
        setDone(r.value.changed ? 'Agora você segue ' + title + '.' : 'Você já segue esta pessoa.')
        if (r.value.changed && typeof onFollowsChanged === 'function') onFollowsChanged()
      }
      loadFollows()
    } finally {
      setFollowing(null)
    }
  }

  const changing = add.pending || remove.pending || follow.pending
  const cls = plan('contas', drafts.contas)
  const handle = cls.kind === 'handle' ? isUsername(cls.value) : null
  const hits = search.hits.filter((h) => h.author !== own)
  const offline = node.online === false
  const ready = search.phase === 'ready'
  const listed = ready || search.phase === 'loading'
  const searchable = cls.kind === 'name' || cls.kind === 'handle'

  const contasHosted = (
    <>
      {cls.kind === 'key'
        ? <View style={styles.addRow}><Pill label='Seguir' filled onPress={doAdd} pending={add.pending} disabled={changing || !followsReady} /></View>
        : null}
      {cls.kind === 'partial-key' ? <Soft>{PARTIAL_KEY_TEXT}</Soft> : null}
      {handle !== null && !hits.some((h) => typeof h.username === 'string' && h.username.toLowerCase() === handle)
        ? <View style={styles.addRow}><Pill label='Seguir' accessibilityLabel={'seguir @' + handle} filled onPress={doAdd} pending={add.pending} disabled={changing || offline || !followsReady} /></View>
        : null}
      {searchable && (offline || search.phase === 'offline') ? <EmptyState icon='lupa' title='Sem conexão' body='A busca precisa de internet.' actionLabel='Tentar de novo' onAction={handleRetry} secondaryLabel='Limpar' onSecondary={() => onChangeText('')} /> : null}
      {searchable && search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
      {searchable && search.phase === 'error'
        ? (
          <EmptyState icon='lupa' title='Não foi possível buscar' body={search.error} actionLabel='Tentar de novo' onAction={handleRetry} secondaryLabel='Limpar' onSecondary={() => onChangeText('')} />
          )
        : null}
      {search.phase === 'loading' && hits.length === 0
        ? <View accessibilityLiveRegion='polite'><Soft>Buscando pessoas…</Soft><View style={styles.bleed}><SkeletonRow /><SkeletonRow /></View></View>
        : null}
      {hits.length > 0
        ? (
          <View style={styles.bleed}>
            {hits.map((hit) => (
              <MemberRow
                key={hit.author}
                hit={hit}
                hint={names.profileOf(hit.author)}
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
      {ready && hits.length === 0 && search.unchecked === 0 ? <EmptyState icon='gente' title='Ninguém encontrado com esse nome.' actionLabel='Limpar' onAction={() => onChangeText('')} secondaryLabel='Tentar de novo' onSecondary={handleRetry} /> : null}
      {ready && hits.length === 0 && search.unchecked > 0
        ? (
          <EmptyState icon='gente' title='Não deu para conferir todo mundo agora.' actionLabel='Tentar de novo' onAction={handleRetry} secondaryLabel='Limpar' onSecondary={() => onChangeText('')} />
          )
        : null}
      {ready && hits.length > 0 && search.unchecked > 0 ? <Soft>Algumas pessoas não puderam ser conferidas agora.</Soft> : null}
      {listed && search.complete === false ? <Soft>Ainda montando a lista; alguém pode faltar.</Soft> : null}
      {listed && search.more ? <Soft>Há mais gente com esse nome. Tente um nome mais específico.</Soft> : null}
    </>
  )

  const contasPlain = (
    <View style={styles.addRow}>
      <Pill label='Seguir' filled onPress={doAdd} pending={add.pending} disabled={!typed || changing || !followsReady} />
    </View>
  )

  const contasScroll = useRef(null)
  useEffect(() => {
    if (tops.contas > 0 && contasScroll.current) contasScroll.current.scrollTo({ y: 0, animated: true })
  }, [tops.contas])
  const postsScroll = useRef(null)
  useEffect(() => {
    if (tops.publicacoes > 0 && postsScroll.current) postsScroll.current.scrollTo({ y: 0, animated: true })
  }, [tops.publicacoes])

  const contasPane = (
    <ScrollView
      ref={contasScroll}
      keyboardShouldPersistTaps='handled'
      contentContainerStyle={[styles.pane, { paddingBottom: bottomPad }]}
    >
      {hosted ? contasHosted : contasPlain}
      <ErrorText>{localError || add.error}</ErrorText>
      <ErrorText>{follow.error || remove.error}</ErrorText>
      <Notice>{done}</Notice>
      {cls.kind === 'empty' && hits.length === 0
        ? <EmptyState icon='gente' title={CATEGORY_LABEL.contas} body={hosted ? BUSCA_EMPTY.contas : BUSCA_EMPTY_CODE} actionLabel={hosted ? BUSCA_LABEL.contas : 'Digitar código'} onAction={() => inputRef.current?.focus()} secondaryLabel={hosted ? CATEGORY_LABEL.publicacoes : undefined} onSecondary={() => setCategory('publicacoes')} />
        : null}
    </ScrollView>
  )

  // Publicações.
  const [query, setQuery] = useState(null)
  const postsGate = buscaNotice({ hosted })
  // While typing, debouncePlan holds a query back until the person pauses
  // (the seeder allows a few /index requests per client per 10 s); submit
  // runs it at once. Every edit advances the sequence so a pending timer of
  // an older draft never fires.
  const postsSeq = useRef(0)
  const postsTimer = useRef(null)
  const postsSent = useRef('')
  // The path Busca fetches for the query on screen: an edit that folds to the
  // same path (case, accents, punctuation, a 9th word) keeps the list and its pages.
  const shownPath = useRef(null)
  const stopPostsTimer = () => {
    if (postsTimer.current !== null) clearTimeout(postsTimer.current)
    postsTimer.current = null
  }
  useEffect(() => stopPostsTimer, [])
  // A pause timer left running behind Contas would search a hidden pane.
  useEffect(() => {
    if (category === 'publicacoes') return
    postsSeq.current += 1
    stopPostsTimer()
  }, [category])
  const runPosts = (text, typing) => {
    if (postsGate !== null) return
    const r = plan('publicacoes', text)
    if (r.query === null) {
      if (!typing && typeof onToast === 'function') onToast(SEARCH_INVALID)
      postsSent.current = ''
      shownPath.current = null
      setQuery(null)
      return
    }
    if (r.truncated && !typing && typeof onToast === 'function') onToast(SEARCH_TRUNCATED)
    postsSent.current = text
    // Typing that folds to the same path keeps the list; Enter or "pesquisar"
    // always searches again (after a failed load, that is the retry).
    if (typing && r.query.path === shownPath.current) return
    if (!followsAsked.current) {
      followsAsked.current = true
      loadFollows()
    }
    shownPath.current = r.query.path
    setQuery(r.query)
  }
  const submit = () => {
    postsSeq.current += 1
    stopPostsTimer()
    runPosts(drafts.publicacoes, false)
  }
  const typePosts = (text) => {
    const seq = ++postsSeq.current
    stopPostsTimer()
    const next = debouncePlan(text, postsSent.current)
    if (text.trim() === '') {
      postsSent.current = ''
      shownPath.current = null
      setQuery(null)
      return
    }
    if (text.trim().length < next.minLength) {
      postsSent.current = ''
      shownPath.current = null
      setQuery(null)
      return
    }
    if (!next.run) return
    const fresh = staleGuard(seq)
    postsTimer.current = setTimeout(() => {
      postsTimer.current = null
      if (fresh(postsSeq.current)) runPosts(text, true)
    }, next.delayMs)
  }
  // Own and followed authors only: a stranger's photo stays no-store.
  const avatarOf = (author) => {
    const a = typeof author === 'string' ? author.toLowerCase() : null
    const kept = a !== null && (a === own || (follows !== null && follows.has(a)))
    return kept ? names.profileOf(a) : undefined
  }

  let postsPane
  if (postsGate === 'not-hosted') {
    postsPane = <EmptyState icon='lupa' title={BUSCA_NOT_HOSTED_TITLE} body={BUSCA_NOT_HOSTED} actionLabel={CATEGORY_LABEL.contas} onAction={() => setCategory('contas')} />
  } else if (query === null) {
    postsPane = (
      <ScrollView ref={postsScroll} keyboardShouldPersistTaps='handled' contentContainerStyle={[styles.pane, { paddingBottom: bottomPad }]}>
        {drafts.publicacoes.trim() === ''
          ? <EmptyState icon='lupa' title={CATEGORY_LABEL.publicacoes} body={BUSCA_EMPTY.publicacoes} actionLabel={BUSCA_LABEL.publicacoes} onAction={() => inputRef.current?.focus()} secondaryLabel={CATEGORY_LABEL.contas} onSecondary={() => setCategory('contas')} />
          : plan('publicacoes', drafts.publicacoes).query === null
            ? <EmptyState icon='lupa' title={SEARCH_INVALID} actionLabel='Editar busca' onAction={() => inputRef.current?.focus()} secondaryLabel='Limpar' onSecondary={() => onChangeText('')} />
            : postsTimer.current !== null
              ? <View accessibilityLiveRegion='polite'><Soft>Buscando publicações…</Soft><SkeletonRow /><SkeletonRow /><SkeletonRow /></View>
              : <EmptyState icon='lupa' title={CATEGORY_LABEL.publicacoes} body={BUSCA_EMPTY.publicacoes} actionLabel='Editar busca' onAction={() => inputRef.current?.focus()} secondaryLabel='Limpar' onSecondary={() => onChangeText('')} />}
        <HelpNote doc={HELP.busca}><Soft>{SHORT.search}</Soft></HelpNote>
      </ScrollView>
    )
  } else {
    postsPane = (
      <Busca
        query={query}
        header={null}
        avatarOf={avatarOf}
        ownKey={ownKey}
        active={active && category === 'publicacoes'}
        scrollToTop={tops.publicacoes}
        refresh={refresh}
        onReply={onReply}
        onReport={onReport}
        onQuote={onQuote}
        onOpenThread={onOpenThread}
        onOpenMember={onOpenMember}
        onOpenMention={onOpenMention}
        onOpenEngagers={onOpenEngagers}
        onFollowsChanged={onFollowsChanged}
        onToast={onToast}
        onClear={() => onChangeText('')}
      />
    )
  }

  const showField = category === 'contas' || postsGate === null
  const onChangeText = (t) => {
    setDraft(t)
    if (category !== 'contas') return typePosts(t)
    setLocalError('')
    const c = plan('contas', t)
    if (hosted) setSearchQuery(c.kind === 'name' || c.kind === 'handle' ? t : '')
  }

  return (
    <View style={styles.flex}>
      <View style={styles.top}>
        {showField
          ? (
            <SearchField
              inputRef={inputRef}
              label={category === 'contas' && !hosted ? CODE_FIELD_LABEL : BUSCA_LABEL[category]}
              placeholder={category === 'contas' && !hosted ? 'código da pessoa (64 letras e números)' : BUSCA_PLACEHOLDER[category]}
              value={draft}
              onChangeText={onChangeText}
              maxLength={SEARCH_INPUT_MAX}
              onSubmitEditing={category === 'contas' ? (hosted ? handleSearch : undefined) : submit}
            />
            )
          : null}
      </View>
      <View style={styles.tabs} accessibilityRole='tablist'>
        {CATEGORIES.map((k) => {
          const selected = k === category
          return (
            <Pressable
              key={k}
              accessibilityRole='tab'
              accessibilityState={{ selected }}
              onPress={() => setCategory(k)}
              style={[styles.tab, selected && styles.tabOn]}
            >
              <Text style={[styles.tabText, selected && styles.tabTextOn]}>{CATEGORY_LABEL[k]}</Text>
            </Pressable>
          )
        })}
      </View>
      <View style={[styles.flex, category !== 'contas' && styles.hidden]}>{contasPane}</View>
      {/* The hidden pane stays mounted and still measures as on screen, so a
          music player in it must learn that it left the visible screen. */}
      <ScreenVisible.Provider value={visible && category === 'publicacoes'}>
        <View style={[styles.flex, category !== 'publicacoes' && styles.hidden]}>{postsPane}</View>
      </ScreenVisible.Provider>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  hidden: { display: 'none' },
  top: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 8 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    minHeight: layout.hit,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.inputOff
  },
  searchFocused: { borderColor: colors.accent, backgroundColor: colors.card },
  input: { ...type.postText, flex: 1, minWidth: 0, minHeight: layout.hit - 3, paddingVertical: 0, color: colors.ink },
  clear: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' },
  pane: { paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  bleed: { marginHorizontal: -16 },
  addRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { ...type.pill, color: colors.soft },
  tabTextOn: { color: colors.accent }
})
