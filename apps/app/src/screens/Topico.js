// Topico (entry { screen: 'topico', key: root ref 'writer:seq', params: { group } }):
// one topic of a public group, pushed above Grupo. Shows the root, its poll
// and the replies (group.read with topic, newest first as the node answers; a
// page holds at most GROUP_MARKED_LIMIT items, so older ones come with the
// cursor it returns), and a reply box (group.post with replyTo the root).
// The root sits on the oldest page of a long topic: its header comes from the
// list that opened the topic (params.root) until the page holding it loads,
// and the reply box never waits for it. Hosted nodes only.
//
// The poll: a tap votes with group.choose (the same option again takes the
// vote back); the vote is public, and the notice says so before the first one.
// The totals are folded by the member's own node, so no seeder-claim notice;
// the own pick comes from the own diary. "Quem votou" reads group.voters. A vote or a reply answered
// UNCERTAIN is never resent: the screen re-reads and the person decides.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { countChars, relativeTime } from '../format'
import { HIDDEN_LABEL, keepsTail, refOf, replyAllowed, threadOf, topicTitle } from '../forum'
import { nextPick, pollCard } from '../polls'
import { useNames } from '../names'
import { useNode } from '../node'
import { publicGroupRefusal } from '../wordCheck'
import { UNNAMED, whoOf } from '../who'
import { ErrorText, Soft, errorText, useAction, useNow } from '../ui'
import { useKeyboardAvoidEnabled } from '../ui/keyboardAvoid'
import { ChatComposer } from '../ui/ChatComposer'
import { OfflineNote } from '../ui/OfflineNote'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

const HEX64 = /^[0-9a-f]{64}$/
const HOSTED_ONLY = 'Fóruns disponíveis no site da associação ou no app ligado à instalação.'
const HIDDEN = HIDDEN_LABEL
const DENOUNCE = 'Denunciar'

function refParts (key) {
  const m = typeof key === 'string' ? /^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(key) : null
  return m ? { writer: m[1], seq: Number(m[2]) } : null
}

function Author ({ item }) {
  const names = useNames()
  const diary = typeof item.diary === 'string' ? item.diary : null
  const resolve = names ? names.resolve : null
  useEffect(() => { if (resolve && diary !== null) resolve(diary) }, [resolve, diary])
  const cached = names && diary !== null ? names.profileOf(diary) : undefined
  const who = whoOf({ name: cached ? cached.name : item.name, username: cached ? cached.username : item.username }).title
  return who === UNNAMED ? 'Pessoa' : displayText(who)
}

export function Topico ({ entry, onBack, onReport, isTop = true }) {
  const styles = useStyles(makeStyles)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  const node = useNode()
  const names = useNames()
  const { request } = node
  const hosted = node.hosted === true
  const group = entry && entry.params && typeof entry.params.group === 'string' && HEX64.test(entry.params.group) ? entry.params.group : null
  const root = refParts(entry && entry.key)
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const navRoot = entry && entry.params && entry.params.root && typeof entry.params.root === 'object' && typeof entry.params.root.text === 'string'
    ? { hidden: entry.params.root.hidden === true, text: entry.params.root.text }
    : null
  const now = useNow(60 * 1000)

  const [read, setRead] = useState(null)
  const [tail, setTail] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [replyRefusal, setReplyRefusal] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState('')
  const [voters, setVoters] = useState(null)
  const [votersError, setVotersError] = useState('')
  const [note, setNote] = useState('')
  const vote = useAction()
  const reply = useAction()
  const seq = useRef(0)
  const moreSeq = useRef(0)
  const headRef = useRef(null)
  useEffect(() => () => { seq.current += 1; moreSeq.current += 1 }, [])

  const load = useCallback(async (pull = false) => {
    if (!hosted || group === null || root === null) return
    const mine = ++seq.current
    if (pull) setRefreshing(true)
    else setLoading(true)
    setLoadError('')
    try {
      const value = await request('group.read', { group, topic: root })
      if (mine === seq.current) {
        // A page of older replies loaded earlier stays only while it still
        // joins the fresh newest page.
        if (!keepsTail(headRef.current, value)) { setTail(null); moreSeq.current += 1 }
        headRef.current = value
        setRead(value)
      }
    } catch (err) {
      if (mine === seq.current) setLoadError(errorText(err))
    } finally {
      if (mine === seq.current) { setLoading(false); setRefreshing(false) }
    }
  }, [hosted, group, request, entry && entry.key])

  const thread = useMemo(() => threadOf(read, tail), [read, tail])
  const threadRef = useRef(thread)
  threadRef.current = thread

  const loadOlder = useCallback(async () => {
    const before = threadRef.current.next
    if (before === null || loadingMore || !hosted || group === null || root === null) return
    const mine = ++moreSeq.current
    setLoadingMore(true)
    setMoreError('')
    try {
      const value = await request('group.read', { group, topic: root, before })
      if (mine !== moreSeq.current) return
      const items = value && Array.isArray(value.items) ? value.items : []
      setTail((prev) => ({ items: (prev ? prev.items : []).concat(items), next: value && value.next ? value.next : null }))
    } catch (err) {
      if (mine === moreSeq.current) setMoreError(errorText(err))
    } finally {
      if (mine === moreSeq.current) setLoadingMore(false)
    }
  }, [loadingMore, hosted, group, request, entry && entry.key])

  const loadRef = useRef(load)
  loadRef.current = load
  const version = hosted && group !== null ? node.getGroupVersion(group) : null
  useEffect(() => { loadRef.current() }, [version, group, entry && entry.key])

  const rootKey = root === null ? null : refOf(root)
  const items = thread.items
  const rootItem = items.find((i) => refOf(i) === rootKey) || null
  const replies = items.filter((i) => refOf(i) !== rootKey)
  const poll = read && read.poll && typeof read.poll === 'object' ? read.poll : null
  const card = useMemo(() => (poll === null ? null : pollCard({ poll, totals: poll.totals, own: poll.mine })), [poll])

  useEffect(() => {
    const keys = [...new Set(items.map((i) => i.diary).filter((k) => typeof k === 'string'))]
    if (keys.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(keys)
  }, [read])

  async function choose (index) {
    const next = nextPick(card, index)
    if (!next.write || root === null || vote.pending) return
    setNote('')
    const r = await vote.run(() => request('group.choose', { group, target: root, pick: next.pick }))
    if (r.ok) setVoters(null)
    // Uncertain or not, the screen only re-reads: the vote is never resent here.
    loadRef.current(true)
  }

  async function sendReply () {
    const text = draft.trim()
    if (text === '' || root === null || reply.pending) return
    // A reply is public text like a chat post: the word check runs first and
    // the draft stays for editing.
    const refused = publicGroupRefusal('public', text)
    setReplyRefusal(refused)
    if (refused !== '') return
    const r = await reply.run(() => request('group.post', { group, text, replyTo: root }))
    if (r.ok) setDraft('')
    loadRef.current(true)
  }

  async function showVoters () {
    setVotersError('')
    try {
      const value = await request('group.voters', { group, target: root })
      const list = value && Array.isArray(value.voters) ? value.voters : []
      const keys = [...new Set(list.flatMap((v) => (Array.isArray(v.by) ? v.by : [])))]
      if (keys.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(keys)
      setVoters(list)
    } catch (err) {
      setVotersError(errorText(err))
      setVoters([])
    }
  }

  // The same target Grupo builds for a group message: the item's writer and
  // seq, never its photos (a public group's report carries the text only).
  const report = (item) => {
    if (typeof onReport !== 'function' || typeof item.diary !== 'string') return
    onReport({
      author: item.diary,
      name: item.name || null,
      username: item.username || null,
      seq: item.seq,
      text: item.text,
      group,
      writer: item.writer,
      private: false
    })
  }
  const canReport = (item) => typeof onReport === 'function' && !item.hidden && typeof item.diary === 'string' && item.diary !== '' && item.diary !== ownKey

  const nameOfKey = (key) => {
    const p = names ? names.profileOf(key) : undefined
    const who = whoOf({ name: p ? p.name : null, username: p ? p.username : null }).title
    return who === UNNAMED ? 'Pessoa' : displayText(who)
  }

  if (!hosted || group === null || root === null) {
    return (
      <View style={styles.root}>
        <TopBar title='Tópico' onBack={onBack} />
        <View style={styles.pad}><Soft>{HOSTED_ONLY}</Soft></View>
      </View>
    )
  }

  const title = rootItem ? (rootItem.hidden ? 'Tópico' : topicTitle(rootItem.text)) : navRoot !== null && !navRoot.hidden ? topicTitle(navRoot.text) : 'Tópico'
  const left = MAX_TEXT - countChars(draft)

  const header = (
    <View>
      {rootItem
        ? (
          <View style={styles.rootBox}>
            <Text style={styles.rootMeta} maxFontSizeMultiplier={1.3}><Author item={rootItem} /></Text>
            <Text style={styles.rootText} selectable maxFontSizeMultiplier={1.3}>{rootItem.hidden ? HIDDEN : displayText(rootItem.text)}</Text>
            {canReport(rootItem) ? <View style={styles.inline}><Pill label={DENOUNCE} icon='bandeira' danger small onPress={() => report(rootItem)} accessibilityLabel='denunciar o tópico' /></View> : null}
          </View>
          )
        : navRoot !== null
          ? (
            <View style={styles.rootBox}>
              <Text style={styles.rootText} selectable maxFontSizeMultiplier={1.3}>{navRoot.hidden ? HIDDEN : displayText(navRoot.text)}</Text>
            </View>
            )
          : null}
      {card !== null
        ? (
          <View style={styles.pollBox} accessibilityLabel='enquete'>
            {card.notice ? <Soft>{card.notice}</Soft> : null}
            {card.options.map((o) => (
              <Pressable
                key={o.index}
                accessibilityRole='button'
                accessibilityState={{ selected: o.own, disabled: !card.ownKnown || vote.pending }}
                accessibilityLabel={displayText(o.label) + (o.countLabel ? ', ' + o.countLabel : '') + (o.own ? ', seu voto' : '')}
                disabled={!card.ownKnown || vote.pending || !node.online}
                onPress={() => choose(o.index)}
                style={({ pressed }) => [styles.option, o.own && styles.optionOwn, pressed && styles.pressed]}
              >
                <View style={[styles.bar, { width: o.percent + '%' }]} />
                <Text style={styles.optionLabel} maxFontSizeMultiplier={1.3}>{(o.own ? '✓ ' : '') + displayText(o.label)}</Text>
                {o.countLabel ? <Text style={styles.optionCount} maxFontSizeMultiplier={1.3}>{o.countLabel + ' · ' + o.percent + '%'}</Text> : null}
              </Pressable>
            ))}
            <Soft>{card.claimed ? card.totalLabel : card.totalsNote}</Soft>
            <View style={styles.inline}>
              <Pill label='Quem votou' onPress={showVoters} />
            </View>
            <ErrorText>{vote.error}</ErrorText>
            {note ? <ErrorText>{note}</ErrorText> : null}
          </View>
          )
        : null}
      {replies.length > 0 ? <Text style={styles.section} maxFontSizeMultiplier={1.3}>Respostas</Text> : null}
    </View>
  )

  const renderItem = ({ item }) => {
    const at = typeof item.at === 'string' ? relativeTime(item.at, now) : null
    return (
      <View style={styles.reply}>
        <Text style={styles.replyMeta} maxFontSizeMultiplier={1.3}><Author item={item} />{at ? ' · ' + at : ''}</Text>
        <Text style={styles.replyText} selectable maxFontSizeMultiplier={1.3}>{item.hidden ? HIDDEN : displayText(item.text)}</Text>
        {canReport(item) ? <View style={styles.inline}><Pill label={DENOUNCE} icon='bandeira' danger small onPress={() => report(item)} accessibilityLabel='denunciar a resposta' /></View> : null}
      </View>
    )
  }

  const body = loading && read === null
    ? <Skeleton rows={4} />
    : loadError && read === null
      ? <ErrorState message={loadError} onRetry={() => load()} />
      : (
        <RefreshableList
          data={replies}
          keyExtractor={(i) => refOf(i) || String(i.seq)}
          renderItem={renderItem}
          extraData={{ names, now }}
          ListHeaderComponent={header}
          ListEmptyComponent={read !== null ? <EmptyState icon='resposta' title='Ainda sem respostas' body='Seja a primeira pessoa a responder.' /> : null}
          ListFooterComponent={loadError || moreError
            ? (
              <View style={styles.pad}>
                <ErrorText>{loadError || moreError}</ErrorText>
                {moreError ? <Pill label='Tentar de novo' onPress={loadOlder} /> : null}
              </View>
              )
            : null}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onLoadMore={thread.next !== null && !moreError && !loading ? loadOlder : undefined}
          loadingMore={loadingMore}
          loadMoreError={moreError !== ''}
          atEnd={read !== null && thread.next === null}
        />
        )

  return (
    <KeyboardAvoidingView style={styles.root} behavior='padding' enabled={avoidKeyboard}>
      <TopBar title={title} onBack={onBack} compact />
      <OfflineNote />
      {body}
      {isTop && replyAllowed({ loaded: read !== null, rootItem, navRoot })
        ? (
          <ChatComposer
            value={draft}
            onChangeText={(t) => { setDraft(t); setReplyRefusal('') }}
            onSend={sendReply}
            sending={reply.pending}
            sendDisabled={!node.online || left < 0 || draft.trim() === ''}
            placeholder='Responder'
            accessibilityLabel='resposta ao tópico'
            mentions={false}
            notice={replyRefusal || reply.error ? <ErrorText>{replyRefusal || reply.error}</ErrorText> : null}
          />
          )
        : null}
      <Sheet open={voters !== null} onClose={() => setVoters(null)} title='Quem votou'>
        <View style={styles.pad}>
          {votersError ? <ErrorText>{votersError}</ErrorText> : null}
          {(voters || []).map((v) => (
            <View key={v.pick} style={styles.voterGroup}>
              <Text style={styles.voterOption} maxFontSizeMultiplier={1.3}>{card && card.options[v.pick] ? displayText(card.options[v.pick].label) : 'Opção ' + (v.pick + 1)}</Text>
              {(v.by || []).length === 0
                ? <Soft>Ninguém ainda.</Soft>
                : (v.by || []).map((key) => <Text key={key} style={styles.voterName} maxFontSizeMultiplier={1.3}>{nameOfKey(key)}</Text>)}
            </View>
          ))}
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: space.lg, gap: space.sm },
  pressed: { opacity: 0.6 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  rootBox: { padding: space.lg, gap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rootMeta: { ...type.meta, color: colors.soft },
  rootText: { ...type.postText, color: colors.ink },
  pollBox: { padding: space.lg, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  option: {
    minHeight: layout.hit,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  optionOwn: { borderColor: colors.accent },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.line, opacity: 0.5 },
  optionLabel: { ...type.postText, color: colors.ink },
  optionCount: { ...type.meta, color: colors.soft },
  section: { ...type.section, color: colors.soft, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  reply: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  replyMeta: { ...type.meta, color: colors.soft },
  replyText: { ...type.postText, color: colors.ink },
  voterGroup: { gap: space.xs, paddingVertical: space.xs },
  voterOption: { ...type.postName, color: colors.ink },
  voterName: { ...type.postMeta, color: colors.soft }
})
