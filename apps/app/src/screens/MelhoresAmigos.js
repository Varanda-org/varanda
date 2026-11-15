// Melhores amigos (entry { screen: 'melhores-amigos' }): the editor of the own
// top friends list. Up to the contract's limit of people the account follows,
// in order, moved with buttons (no drag). Hosted nodes only.
//
// What the diary holds is read from the own diary (ui/FanButton.js useOwnMarks),
// so the editor never starts from an older list than the one the person saved.
// When that walk stops short (a long diary) without a list, the seeder's
// pointer to the own list is read back from the own diary instead, and with no
// pointer the editor opens empty with a note (fansView.js editorSource). It
// does not save until one of those is known. One write per press, never
// resent: an uncertain answer holds the editor until 'Conferir' re-reads the
// own diary and compares it with what was sent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { useBlocks } from '../blocksProvider'
import { fetchProfile } from '../indexClient'
import { useNames } from '../names'
import { useNode } from '../node'
import { diaryPeekSlots } from '../engagement'
import { NOT_HOSTED } from '../pessoas'
import { whoOf } from '../who'
import { addPick, canMoveDown, canMoveUp, editorChanged, editorRecordKeys, moveDown, moveUp, removePick } from '../fans.js'
import { FILTER_EMPTY, FILTER_LABEL, FILTER_PLACEHOLDER } from '../peopleFilter'
import {
  TEXTS, addCandidates, canAddMore, editorIntroText, editorSource, openEditor, ownTopRows, rebase, topCheck, topFromPeek
} from '../fansView.js'
import { ErrorText, Notice, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { useOwnMarks } from '../ui/FanButton'
import { Icon } from '../ui/Icon'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { SearchField } from '../ui/SearchField'
import { EmptyState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { useTopFriends } from '../ui/TopFriendsRow'

const FOLLOW_PAGES_MAX = 10

function IconButton ({ icon, label, onPress, disabled }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, disabled && styles.off, pressed && styles.pressed]}
    >
      <Icon name={icon} size={20} color={colors.ink} />
    </Pressable>
  )
}

function Person ({ keyHex, profile, children, caption }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  return (
    <View style={styles.row}>
      <Avatar name={who.avatarName} publicKey={keyHex} size={40} picture={(profile || {}).avatar} />
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={2}>{displayText(who.title)}</Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
      {children}
    </View>
  )
}

export default function MelhoresAmigos ({ ownKey, active = true, onBack, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true
  const { request } = node
  const blocks = useBlocks()
  const names = useNames()
  const { profileOf, resolveMany } = names
  const bottom = useBottomPad()
  const { marks, reload, markTop } = useOwnMarks({ request, ownKey, enabled: hosted && active })
  const save = useAction()
  const [editor, setEditor] = useState(() => openEditor(null))
  const [started, setStarted] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState('')
  const [text, setText] = useState('')
  const [follows, setFollows] = useState(null)
  const [followsError, setFollowsError] = useState('')
  const [index, setIndex] = useState(null)
  const [indexFailed, setIndexFailed] = useState(false)
  const [profileTick, setProfileTick] = useState(0)
  const [fallback, setFallback] = useState(null)
  const dirty = useRef(false)

  const source = editorSource({ marks, index, indexFailed, fallback })
  const sourceOpen = source.phase === 'open'
  const topTag = sourceOpen ? (source.top ? source.top.seq + ':' + source.top.keys.join(',') : 'none') : ''
  useEffect(() => {
    if (!sourceOpen || dirty.current) return
    setEditor(openEditor(source.top))
    setStarted(true)
  }, [topTag])

  // The seeder's pointer read back from the own diary (a walk that stopped
  // short found no list): only a top-friends record there seeds the editor.
  const peekSeq = source.peekSeq
  useEffect(() => {
    if (peekSeq === null || typeof ownKey !== 'string') return undefined
    let live = true
    diaryPeekSlots.run(() => (live ? request('diary.peek', { author: ownKey, seqs: [peekSeq] }) : null), { front: true })
      .then((got) => { if (live) setFallback({ seq: peekSeq, top: topFromPeek(got, ownKey, peekSeq) }) }, () => { if (live) setFallback({ seq: peekSeq, top: null }) })
    return () => { live = false }
  }, [peekSeq, ownKey, request])

  const loadFollows = useCallback(async () => {
    setFollowsError('')
    try {
      const all = []
      for (let page = 0; page < FOLLOW_PAGES_MAX; page++) {
        const r = await request('follow.list', { offset: all.length, limit: FOLLOW_LIMIT_MAX })
        all.push(...r.follows)
        if (r.follows.length === 0 || all.length >= r.total) break
      }
      setFollows(all)
      resolveMany(all)
    } catch (err) {
      setFollowsError(errorText(err))
    }
  }, [request, resolveMany])
  useEffect(() => {
    if (hosted && active && follows === null) loadFollows()
  }, [hosted, active])

  useEffect(() => {
    if (!hosted || !active || typeof ownKey !== 'string') return undefined
    let live = true
    setIndexFailed(false)
    fetchProfile(ownKey).then((res) => {
      if (!live) return
      if (res.ok) setIndex(res.value)
      else setIndexFailed(true)
    }, () => { if (live) setIndexFailed(true) })
    return () => { live = false }
  }, [hosted, active, ownKey, profileTick])
  const topRead = useTopFriends({ owner: ownKey, ownKey, index, request, enabled: hosted && active })

  const rows = useMemo(() => ownTopRows({ keys: editor.keys }, topRead.view), [editor.keys, topRead.view])
  const candidates = useMemo(
    () => addCandidates({ follows, state: editor, self: ownKey, isBlocked: (k) => blocks.has(k), profileOf, text }),
    [follows, editor, ownKey, blocks, profileOf, text]
  )

  const edit = (next) => { dirty.current = true; setEditor(next); setNote('') }
  const locked = uncertain || save.pending || checking || !sourceOpen
  const changed = editorChanged(editor)
  const recordKeys = editorRecordKeys(editor, ownKey)

  const onSave = async () => {
    if (locked || recordKeys === null) return
    setNote('')
    const sent = recordKeys
    const r = await save.run(() => request('top.set', { keys: sent }))
    if (r.ok) {
      markTop(sent, r.value && r.value.seq)
      setEditor(rebase(sent))
      dirty.current = false
      setNote(TEXTS.saved)
      if (typeof onToast === 'function') onToast(TEXTS.saved)
    } else if (r.uncertain) {
      setUncertain(true)
    }
  }

  const onCheck = async () => {
    setChecking(true)
    save.clearError()
    try {
      const saved = topCheck(await reload(true), recordKeys || editor.keys)
      if (saved === null) {
        setNote(TEXTS.checkFailed)
        return
      }
      setUncertain(false)
      if (saved) {
        setEditor(rebase(editor.keys))
        dirty.current = false
        setNote(TEXTS.checkedSaved)
      } else {
        setNote(TEXTS.checkedNotSaved)
      }
    } finally {
      setChecking(false)
    }
  }

  const retryRead = () => {
    if (fallback !== null && fallback.top === null) setFallback(null)
    if (indexFailed || (index !== null && index.complete !== true)) setProfileTick((n) => n + 1)
    return reload(true)
  }

  const onDiscard = () => {
    setEditor(openEditor(source.top))
    dirty.current = false
    setNote('')
  }

  if (!hosted) {
    return (
      <View style={styles.screen}>
        <TopBar title={TEXTS.topTitle} onBack={onBack} />
        <EmptyState icon='estrela' title={TEXTS.topTitle} body={NOT_HOSTED} />
      </View>
    )
  }

  const header = (
    <View style={styles.header}>
      <OfflineNote />
      <Soft>{editorIntroText()}</Soft>
      {!started && source.phase === 'loading' ? <Skeleton /> : null}
      {source.phase === 'locked'
        ? (
          <View style={styles.block}>
            <Soft>{TEXTS.checkFailed}</Soft>
            <Pill label={TEXTS.retry} onPress={retryRead} />
          </View>
          )
        : null}
      {started && sourceOpen && source.note ? <Soft>{source.note}</Soft> : null}
      {started
        ? (
          <View style={styles.block}>
            <Text style={styles.section} accessibilityRole='header'>{TEXTS.yourPicks}</Text>
            {rows.length === 0
              ? <Soft>{TEXTS.editorEmptyBody}</Soft>
              : rows.map((row) => (
                <Person key={row.key} keyHex={row.key} profile={profileOf(row.key)} caption={row.label || TEXTS.slot(row.slot + 1)}>
                  <IconButton icon='seta_cima' label={TEXTS.up + ', ' + displayText(whoOf(profileOf(row.key)).title)} disabled={locked || !canMoveUp(editor, row.key)} onPress={() => edit(moveUp(editor, row.key))} />
                  <IconButton icon='baixo' label={TEXTS.down + ', ' + displayText(whoOf(profileOf(row.key)).title)} disabled={locked || !canMoveDown(editor, row.key)} onPress={() => edit(moveDown(editor, row.key))} />
                  <IconButton icon='fechar' label={TEXTS.remove + ', ' + displayText(whoOf(profileOf(row.key)).title)} disabled={locked} onPress={() => edit(removePick(editor, row.key))} />
                </Person>
              ))}
            {editor.error ? <ErrorText>{editor.error}</ErrorText> : null}
            {uncertain
              ? (
                <View style={styles.block}>
                  <Soft>{TEXTS.uncertain}</Soft>
                  <Pill label={TEXTS.check} pending={checking} onPress={onCheck} />
                </View>
                )
              : (
                <View style={styles.actions}>
                  <Pill label={save.pending ? TEXTS.saving : TEXTS.save} filled pending={save.pending} disabled={!changed || recordKeys === null || locked} onPress={onSave} />
                  {changed ? <Pill label={TEXTS.discard} tonal disabled={locked} onPress={onDiscard} /> : null}
                </View>
                )}
            {uncertain ? null : <ErrorText>{save.error}</ErrorText>}
            <Notice>{note}</Notice>
            {canAddMore(editor) ? <Text style={styles.section} accessibilityRole='header'>{TEXTS.addSection}</Text> : null}
            {canAddMore(editor)
              ? (
                <SearchField label={FILTER_LABEL} placeholder={FILTER_PLACEHOLDER} value={text} onChangeText={setText} maxLength={80} />
                )
              : null}
            {followsError ? <View style={styles.block}><ErrorText>{TEXTS.followsFailed}</ErrorText><Pill label={TEXTS.retry} onPress={loadFollows} /></View> : null}
            {follows === null && !followsError ? <Soft>{TEXTS.loadingNames}</Soft> : null}
            {follows !== null && follows.length === 0 ? <Soft>{TEXTS.noFollows}</Soft> : null}
            {follows !== null && follows.length > 0 && candidates.length === 0 && canAddMore(editor) ? <Soft>{text.trim() === '' ? TEXTS.noMatch : FILTER_EMPTY}</Soft> : null}
          </View>
          )
        : null}
    </View>
  )

  return (
    <View style={styles.screen}>
      <TopBar title={TEXTS.topTitle} onBack={onBack} />
      <RefreshableList
        data={started && canAddMore(editor) ? candidates : []}
        keyExtractor={(k) => k}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: bottom }}
        onRefresh={async () => { await Promise.all([retryRead(), loadFollows()]) }}
        renderItem={({ item }) => (
          <View style={styles.pad}>
            <Person keyHex={item} profile={profileOf(item)}>
              <Pill small label={TEXTS.add} tonal disabled={locked} onPress={() => edit(addPick(editor, item, { self: ownKey, isBlocked: (k) => blocks.has(k) }))} />
            </Person>
          </View>
        )}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  pad: { paddingHorizontal: space.lg },
  block: { gap: space.sm, alignItems: 'flex-start', alignSelf: 'stretch' },
  section: { ...type.section, color: colors.soft },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, alignSelf: 'stretch' },
  grow: { flex: 1, flexShrink: 1 },
  name: { ...type.body, color: colors.ink },
  caption: { ...type.caption, color: colors.soft },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  iconButton: { width: layout.hit, height: layout.hit, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.35 },
  pressed: { opacity: 0.6 }
})
