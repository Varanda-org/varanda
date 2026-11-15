// Posts salvos: the refs this person saved on this device (savedProvider.js),
// pushed above the tabs (entry { screen: 'salvos' }). Hosted nodes only. When
// the screen opens, each ref is read again with diary.peek (verified by the
// node); a post that is gone, invalid or from a blocked author is one neutral
// row with 'Tirar dos salvos'. Nothing is persisted but the refs, nothing is
// counted or shown to anyone. Reads only: no request here changes state
// except the local list. peekAll retries a read itself (seeder down, busy);
// past that a failed read is never repeated on its own: the rows of that
// author read 'Não deu para conferir agora' until the next pull to refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { poolMap } from '../engagement'
import { fetchMember } from '../indexClient'
import { installationOrigin } from '../installation'
import { postLink } from '../postLink'
import { useSaved } from '../savedProvider'
import {
  END_TEXT, FAILED_TEXT, LOADING_TEXT, MAX_IN_FLIGHT, SAVED_TITLE, UNAVAILABLE_TEXT, UNCHECKED_TEXT, UNSAVE_LABEL,
  buildRows, planLoads, refKey, unsaveNotice, viewOf
} from '../savedView'
import { Soft, useBottomPad, useNow } from '../ui'
import { OfflineNote } from '../ui/OfflineNote'
import { PostRow } from '../ui/PostRow'
import { PostSheetProvider } from '../ui/PostSheetHost'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, ListFooter, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { isBusy, peekAll, postAt } from './Conversa'

// The seeder index's hints for the authors of `list` (not blocked): they make
// diary.peek return each author's verified profile and username. Authors are
// looked up two at a time and at most HINT_AUTHORS_MAX per call (the same
// cap as planWithHints, so one open stays within the index rate limits); a
// failed lookup, or an author past the cap, just means no hint for that one.
const HINT_WIDTH = 2
const HINT_AUTHORS_MAX = 10
async function lookupHints (list, isBlocked, alive) {
  const authors = [...new Set(list.map((e) => e.author))].filter((a) => !isBlocked(a)).slice(0, HINT_AUTHORS_MAX)
  const hints = {}
  await poolMap(authors, HINT_WIDTH, async (author) => {
    if (!alive()) return
    try {
      const m = await fetchMember(author)
      if (m && m.ok) hints[author] = { profileSeq: m.value.profileSeq, usernameSeq: m.value.usernameSeq }
    } catch {}
  })
  return hints
}

// One planned peek through peekAll. peekAll gives up quietly on 'ocupado'
// once its retries run out (the posts would then read as unavailable): here
// that is a failed read, so the rows say 'Não deu para conferir agora' and
// an earlier copy is kept. Other callers of peekAll are not affected.
async function peekChunk (request, params, peeked, alive) {
  let busy = false
  const watch = async (method, p) => {
    try {
      const result = await request(method, p)
      busy = false
      return result
    } catch (err) {
      busy = isBusy(err)
      throw err
    }
  }
  await peekAll(watch, [params], peeked, alive)
  if (busy && alive()) {
    const err = new Error('ocupado')
    err.code = 'USAGE'
    throw err
  }
}

function NoteRow ({ text }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.gone}>
      <Text style={styles.goneText}>{text}</Text>
    </View>
  )
}

function GoneRow ({ row, onUnsave }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.gone}>
      <Text style={styles.goneText}>{UNAVAILABLE_TEXT}</Text>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={UNSAVE_LABEL}
        onPress={() => onUnsave(row)}
        style={({ pressed }) => [styles.goneButton, pressed && styles.pressed]}
      >
        <Text style={styles.goneButtonText}>{UNSAVE_LABEL}</Text>
      </Pressable>
    </View>
  )
}

// One actions sheet for the whole list instead of two per row.
export default function Salvos (props) {
  return <PostSheetProvider><SalvosList {...props} /></PostSheetProvider>
}

function SalvosList ({ onBack, onOpenThread, onOpenMember, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const saved = useSaved()
  const blocks = useBlocks()
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const [load, setLoad] = useState({ phase: 'idle', peeked: new Map(), attempted: new Set(), failedAuthors: new Set(), refreshing: false })
  const gen = useRef(0)
  const entriesRef = useRef(saved.entries)
  entriesRef.current = saved.entries
  const loadRef = useRef(load)
  loadRef.current = load
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  // Ref keys a late read already tried: one try per key, no loop on failure.
  const lateTried = useRef(new Set())

  useEffect(() => () => { gen.current++ }, [])

  const read = useCallback(async (refreshing) => {
    if (refreshing && online === false) return
    const mine = ++gen.current
    const alive = () => gen.current === mine
    const entries = entriesRef.current
    const attempted = new Set(entries.map((e) => refKey(e.author, e.seq)))
    setLoad((cur) => ({ ...cur, phase: refreshing ? cur.phase : 'loading', refreshing }))
    const peeked = new Map()
    const failedAuthors = new Set()
    const plan = planLoads(entries, blockedRef.current, await lookupHints(entries, blockedRef.current, alive))
    if (!alive()) return
    let failedChunks = 0
    const succeeded = new Set()
    // One chunk per call keeps at most MAX_IN_FLIGHT peeks going; a failed
    // chunk marks its author and is not retried here.
    await poolMap(plan, MAX_IN_FLIGHT, async (params) => {
      if (!alive()) return
      try {
        await peekChunk(request, params, peeked, alive)
        succeeded.add(params.author)
      } catch {
        failedChunks++
        failedAuthors.add(params.author)
      }
    })
    if (!alive()) return
    // A failed read keeps what was known before for that author, unless
    // another chunk of that author did read: that fresh copy stays.
    const prev = loadRef.current.peeked
    for (const author of failedAuthors) {
      if (succeeded.has(author)) continue
      if (prev.has(author)) peeked.set(author, prev.get(author))
      else peeked.delete(author)
    }
    // The quoted posts, best effort: a miss shows the quote as unavailable.
    const quoted = []
    for (const e of entries) {
      const post = postAt(peeked, refKey(e.author, e.seq))
      if (post && post.quote && postAt(peeked, refKey(post.quote.author, post.quote.seq)) === null) quoted.push({ author: post.quote.author, seq: post.quote.seq })
    }
    const quotedPlan = planLoads(quoted, blockedRef.current, await lookupHints(quoted, blockedRef.current, alive))
    if (!alive()) return
    await poolMap(quotedPlan, MAX_IN_FLIGHT, async (params) => {
      if (!alive()) return
      try { await peekChunk(request, params, peeked, alive) } catch {}
    })
    if (!alive()) return
    const phase = plan.length > 0 && failedChunks === plan.length && loadRef.current.phase !== 'ready' ? 'error' : 'ready'
    setLoad({ phase, peeked, attempted, failedAuthors, refreshing: false })
  }, [request, online])

  useEffect(() => {
    if (!hosted || !saved.available || !saved.loaded || online === false || load.phase !== 'idle' || saved.entries.length === 0) return
    read(false)
  }, [hosted, saved.available, saved.loaded, saved.entries.length, online, load.phase, read])

  // A ref saved while this screen stays mounted: only the missing refs are
  // read, once per key.
  useEffect(() => {
    if (load.phase !== 'ready' || online === false) return
    const missing = saved.entries.filter((e) => !load.attempted.has(refKey(e.author, e.seq)) && !lateTried.current.has(refKey(e.author, e.seq)))
    if (missing.length === 0) return
    for (const e of missing) lateTried.current.add(refKey(e.author, e.seq))
    const mine = gen.current
    const alive = () => gen.current === mine
    ;(async () => {
      const peeked = new Map(loadRef.current.peeked)
      const failed = new Set()
      const lateHints = await lookupHints(missing, blockedRef.current, alive)
      if (!alive()) return
      await poolMap(planLoads(missing, blockedRef.current, lateHints), MAX_IN_FLIGHT, async (params) => {
        if (!alive()) return
        try { await peekChunk(request, params, peeked, alive) } catch { failed.add(params.author) }
      })
      if (!alive()) return
      setLoad((cur) => cur.phase !== 'ready'
        ? cur
        : {
            ...cur,
            peeked,
            attempted: new Set([...cur.attempted, ...missing.map((e) => refKey(e.author, e.seq))]),
            failedAuthors: new Set([...cur.failedAuthors, ...failed])
          })
    })()
  }, [load.phase, load.attempted, saved.entries, online, request])

  const rows = useMemo(
    () => buildRows({ entries: saved.entries, peeked: load.peeked, isBlocked: blocks.has, attempted: load.attempted, failedAuthors: load.failedAuthors }),
    [saved.entries, load.peeked, load.attempted, load.failedAuthors, blocks.has]
  )
  const unsave = useCallback(async (row) => {
    const ok = await saved.unsave(row.author, row.seq)
    if (typeof onToast === 'function') onToast(unsaveNotice(ok))
  }, [saved, onToast])

  const v = viewOf({ hosted, online, phase: load.phase === 'idle' && saved.loaded && saved.entries.length === 0 ? 'ready' : load.phase, count: saved.entries.length })
  let empty = null
  if (v.view === 'loading' || v.view === 'off') empty = <Skeleton />
  else if (v.view === 'error') empty = <ErrorState message={displayText(v.message)} onRetry={() => read(false)} />
  else if (v.view === 'empty' || v.view === 'offline') empty = <EmptyState icon='salvar' title={v.title} body={v.body} />

  const origin = installationOrigin() || globalThis.location?.origin || null
  const renderItem = ({ item }) => {
    if (item.kind === 'loading') return <NoteRow text={LOADING_TEXT} />
    if (item.kind === 'unchecked') return <NoteRow text={UNCHECKED_TEXT} />
    if (item.kind !== 'post') return <GoneRow row={item} onUnsave={unsave} />
    const post = item.post
    const q = post.quote ? postAt(load.peeked, refKey(post.quote.author, post.quote.seq)) : null
    const quote = !post.quote
      ? null
      : q && !blocks.has(q.author)
        ? { author: q.author, name: q.name || null, username: q.username || null, avatar: q.avatar || null, at: q.at, text: q.text, media: q.media, preview: q.preview || null, persist: false, missing: false, onOpen: typeof onOpenThread === 'function' ? () => onOpenThread({ ref: refKey(q.author, q.seq), seed: q }) : undefined }
        : { author: post.quote.author, name: null, username: null, avatar: null, at: null, text: null, media: null, persist: false, missing: true, onOpen: undefined }
    const name = post.name || null
    const username = post.username || null
    return (
      <PostRow
        author={post.author}
        seq={post.seq}
        name={name}
        username={username}
        avatar={post.avatar || undefined}
        at={post.at}
        text={post.text}
        media={post.media || null}
        preview={post.preview || null}
        quote={quote}
        persistMedia={false}
        now={now}
        link={origin ? postLink(origin, item.ref) : null}
        onNotice={onToast}
        onOpen={typeof onOpenThread === 'function' ? () => onOpenThread({ ref: item.ref, seed: post }) : undefined}
        onOpenAuthor={typeof onOpenMember === 'function' ? () => onOpenMember(post.author, { name, username }) : undefined}
      />
    )
  }

  const ready = v.view === 'ready'
  const header = ready && load.failedAuthors.size > 0
    ? <View style={styles.head}><Soft>{FAILED_TEXT}</Soft></View>
    : null

  return (
    <View style={styles.flex}>
      <TopBar title={SAVED_TITLE} onBack={onBack} />
      <OfflineNote />
      <RefreshableList
        data={ready ? rows : []}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        extraData={{ now, load }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={ready && rows.length > 0 ? <ListFooter atEnd endText={END_TEXT} /> : null}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        onRefresh={hosted ? () => read(true) : undefined}
        refreshing={load.refreshing}
        atEnd
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  head: { paddingHorizontal: space.lg, paddingVertical: space.md },
  gone: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  goneText: { ...type.meta, color: colors.soft },
  goneButton: { alignSelf: 'flex-start', minHeight: layout.hit, minWidth: layout.hit, justifyContent: 'center' },
  goneButtonText: { ...type.pill, color: colors.accent },
  pressed: { opacity: 0.6 }
})
