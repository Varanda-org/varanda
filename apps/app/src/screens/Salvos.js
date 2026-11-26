// Posts salvos: the refs this person saved on this device (savedProvider.js),
// pushed above the tabs (entry { screen: 'salvos' }). Hosted nodes only. When
// the screen opens, each ref is read again with diary.peek (verified by the
// node); a post that is gone, invalid or from a blocked author is one neutral
// row with 'Tirar dos salvos'. A bound snapshot paints saved posts while
// those reads answer; nothing is counted or shown to anyone. Reads only:
// no request here changes state
// except the local list. peekAll retries a read itself (seeder down, busy);
// past that a failed read is never repeated on its own: the rows of that
// author read 'Não deu para conferir agora' until the next pull to refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useBlocks } from '../blocksProvider'
import { cachedRowsShown, withoutBlockedRows } from '../cachedRows'
import { cacheGeneration } from '../localCaches'
import { buildScreenSnapshot } from '../screenSnapshot'
import { loadScreenSnapshot, saveScreenSnapshot } from '../screenSnapshotStore'
import { pageMode } from '../groups'
import { pagesOn } from '../pageGate'
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
import { isBusy, peekAll, postAt, useActing } from './Conversa'
import { memberSnapshotBinding, sameSnapshotBinding } from './Comunidades'

const SAVE_DELAY_MS = 2000

function savedRowAuthors ({ post }) {
  const authors = [post.author]
  if (post.to) authors.push(post.to.author)
  if (post.quote) authors.push(post.quote.author)
  if (post.replyTo) authors.push(post.replyTo.author)
  return authors
}

// Keep the same per-author representation as live diary.peek answers.
function seedPeeked (rows) {
  const peeked = new Map()
  for (const { post } of rows) {
    const known = peeked.get(post.author)
    const record = { ...post, type: post.kind, on: true, media: post.media || [] }
    peeked.set(post.author, {
      key: post.author,
      entries: [...(known ? known.entries : []), { seq: post.seq, record }],
      profile: post.name === null ? null : { name: post.name },
      username: post.username
    })
  }
  return peeked
}

// A missing entry in a successful answer must evict its earlier copy,
// while other chunks of the same author can still be waiting or failed.
function replacePeeked (peeked, params, answer, liveAuthors) {
  const previous = peeked.get(params.author)
  const next = answer.get(params.author)
  // Cached identity fields cannot become live when a hintless chunk answers.
  const known = liveAuthors.has(params.author) ? previous : null
  const keep = previous ? previous.entries.filter((e) => !params.seqs.includes(e.seq)) : []
  peeked.set(params.author, {
    ...(next || previous || { key: params.author }),
    entries: keep.concat(next ? next.entries : []),
    profile: known?.profile || next?.profile || null,
    username: known?.username || next?.username || null
  })
  liveAuthors.add(params.author)
}

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
  const acting = useActing()
  const pageKey = pageMode({ acting, on: pagesOn({ hosted: node.hosted === true, accountOrigin: node.accountOrigin }) }).key
  const binding = memberSnapshotBinding({ node, acting, pageKey })
  const snapshotContext = useRef(null)
  snapshotContext.current = { node, acting, pageKey, blocked: blocks.keys }
  const cachedRefs = useRef(new Set())
  const seedBinding = useRef(binding)
  const seedGeneration = useRef(cacheGeneration())
  const bottomPad = useBottomPad()
  const now = useNow(60000)
  const hosted = node.hosted === true
  const online = node.online
  const { request } = node
  const [load, setLoad] = useState(() => {
    const base = { phase: 'idle', peeked: new Map(), attempted: new Set(), failedAuthors: new Set(), refreshing: false }
    if (binding === null) return base
    const snapshot = loadScreenSnapshot('listas', binding)
    const list = snapshot && snapshot.body.lists.salvos
    if (!list || list.scope !== '') return base
    const savedRefs = new Set(saved.entries.map((e) => refKey(e.author, e.seq)))
    const rows = list.rows.filter((row) => savedRefs.has(row.ref))
    cachedRefs.current = new Set(rows.map((row) => row.ref))
    return { ...base, peeked: seedPeeked(rows) }
  })
  const gen = useRef(0)
  const liveAuthorsRef = useRef(new Set())
  const entriesRef = useRef(saved.entries)
  entriesRef.current = saved.entries
  const loadRef = useRef(load)
  loadRef.current = load
  const blockedRef = useRef(blocks.has)
  blockedRef.current = blocks.has
  // Ref keys a late read already tried: one try per key, no loop on failure.
  const lateTried = useRef(new Set())

  const saveTimer = useRef(null)
  const lastLive = useRef(null)
  const cancelSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = null
  }, [])
  const armSave = useCallback((gen, b, rows) => {
    cancelSave()
    if (b === null || cacheGeneration() !== gen) return
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const ctx = snapshotContext.current
      const now = memberSnapshotBinding(ctx)
      if (cacheGeneration() !== gen || !sameSnapshotBinding(b, now)) return
      const refs = new Set(entriesRef.current.map((e) => refKey(e.author, e.seq)))
      const kept = withoutBlockedRows(rows.filter((row) => refs.has(row.ref)), ctx.blocked, savedRowAuthors).slice(0, 30)
      // Another screen may have saved one of the other five lists meanwhile.
      const previous = loadScreenSnapshot('listas', b)
      const snapshot = buildScreenSnapshot('listas', { ...b, previous: previous === null ? null : previous.body, name: 'salvos', scope: '', rows: kept, blocked: ctx.blocked })
      if (snapshot !== null) saveScreenSnapshot('listas', snapshot, gen)
    }, SAVE_DELAY_MS)
  }, [cancelSave])
  const settleSave = useCallback((gen, b, peeked, confirmed) => {
    const rows = entriesRef.current.map((e) => {
      const ref = refKey(e.author, e.seq)
      return { ref, post: confirmed.has(ref) ? postAt(peeked, ref) : null }
    }).filter((row) => row.post !== null)
    lastLive.current = { gen, b, rows }
    armSave(gen, b, rows)
  }, [armSave])

  useEffect(() => () => {
    gen.current++
    cancelSave()
  }, [cancelSave])
  useEffect(() => {
    const last = lastLive.current
    if (last !== null) armSave(last.gen, last.b, last.rows)
  }, [saved.entries, armSave])

  const read = useCallback(async (refreshing) => {
    if (refreshing && online === false) return
    const cacheGen = cacheGeneration()
    const b = memberSnapshotBinding(snapshotContext.current)
    cancelSave()
    const mine = ++gen.current
    const alive = () => gen.current === mine
    const entries = entriesRef.current
    const attempted = new Set(entries.map((e) => refKey(e.author, e.seq)))
    setLoad((cur) => ({ ...cur, phase: refreshing ? cur.phase : 'loading', refreshing }))
    const peeked = new Map(loadRef.current.peeked)
    const confirmed = new Set()
    const liveAuthors = new Set()
    liveAuthorsRef.current = liveAuthors
    const failedAuthors = new Set()
    const plan = planLoads(entries, blockedRef.current, await lookupHints(entries, blockedRef.current, alive))
    if (!alive()) return
    let failedChunks = 0
    // One chunk per call keeps at most MAX_IN_FLIGHT peeks going; a failed
    // chunk marks its author and is not retried here.
    await poolMap(plan, MAX_IN_FLIGHT, async (params) => {
      if (!alive()) return
      try {
        const answer = new Map()
        await peekChunk(request, params, answer, alive)
        if (!alive()) return
        replacePeeked(peeked, params, answer, liveAuthors)
        for (const seq of params.seqs) {
          const ref = refKey(params.author, seq)
          cachedRefs.current.delete(ref)
          confirmed.add(ref)
        }
        setLoad((cur) => ({ ...cur, peeked: new Map(peeked), attempted: new Set([...cur.attempted, ...params.seqs.map((seq) => refKey(params.author, seq))]) }))
      } catch {
        failedChunks++
        failedAuthors.add(params.author)
      }
    })
    if (!alive()) return
    // The quoted posts, best effort: a miss shows the quote as unavailable.
    const quoted = []
    for (const e of entries) {
      if (cachedRefs.current.has(refKey(e.author, e.seq))) continue
      const post = postAt(peeked, refKey(e.author, e.seq))
      if (post && post.quote && !confirmed.has(refKey(post.quote.author, post.quote.seq))) quoted.push({ author: post.quote.author, seq: post.quote.seq })
    }
    const quotedPlan = planLoads(quoted, blockedRef.current, await lookupHints(quoted, blockedRef.current, alive))
    if (!alive()) return
    await poolMap(quotedPlan, MAX_IN_FLIGHT, async (params) => {
      if (!alive()) return
      try {
        const answer = new Map()
        await peekChunk(request, params, answer, alive)
        if (alive()) replacePeeked(peeked, params, answer, liveAuthors)
      } catch {}
    })
    if (!alive()) return
    const phase = plan.length > 0 && failedChunks === plan.length && loadRef.current.phase !== 'ready' ? 'error' : 'ready'
    setLoad({ phase, peeked, attempted, failedAuthors, refreshing: false })
    settleSave(cacheGen, b, peeked, confirmed)
  }, [request, online, cancelSave, settleSave])

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
    const cacheGen = cacheGeneration()
    const b = memberSnapshotBinding(snapshotContext.current)
    ;(async () => {
      const peeked = new Map(loadRef.current.peeked)
      const last = lastLive.current
      const confirmed = new Set(last !== null && last.gen === cacheGen && sameSnapshotBinding(last.b, b) ? last.rows.map((row) => row.ref) : [])
      const failed = new Set()
      const liveAuthors = liveAuthorsRef.current
      const lateHints = await lookupHints(missing, blockedRef.current, alive)
      if (!alive()) return
      await poolMap(planLoads(missing, blockedRef.current, lateHints), MAX_IN_FLIGHT, async (params) => {
        if (!alive()) return
        try {
          const answer = new Map()
          await peekChunk(request, params, answer, alive)
          if (!alive()) return
          replacePeeked(peeked, params, answer, liveAuthors)
          for (const seq of params.seqs) {
            const ref = refKey(params.author, seq)
            cachedRefs.current.delete(ref)
            confirmed.add(ref)
          }
        } catch { failed.add(params.author) }
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
      settleSave(cacheGen, b, peeked, confirmed)
    })()
  }, [load.phase, load.attempted, saved.entries, online, request, settleSave])

  const owner = binding === null ? null : binding.owner
  const seedAllowed = sameSnapshotBinding(seedBinding.current, binding) && seedGeneration.current === cacheGeneration()
  const rows = useMemo(() => {
    const all = buildRows({ entries: saved.entries, peeked: load.peeked, isBlocked: blocks.has, attempted: load.attempted, failedAuthors: load.failedAuthors })
    const cached = all.filter((row) => row.kind === 'post' && cachedRefs.current.has(row.ref))
    const shown = new Set(cachedRowsShown(seedAllowed ? cached : [], { loadState: blocks.loadState, blocked: blocks.keys, owner, authorsOf: savedRowAuthors }).map((row) => row.ref))
    return all.filter((row) => !cachedRefs.current.has(row.ref) || shown.has(row.ref))
  }, [saved.entries, load.peeked, load.attempted, load.failedAuthors, blocks.has, blocks.loadState, blocks.keys, owner, seedAllowed])
  const unsave = useCallback(async (row) => {
    const ok = await saved.unsave(row.author, row.seq)
    if (typeof onToast === 'function') onToast(unsaveNotice(ok))
  }, [saved, onToast])

  const noLiveRows = !rows.some((row) => row.kind === 'post' && !cachedRefs.current.has(row.ref))
  const phase = load.phase === 'error' && noLiveRows
    ? 'error'
    : rows.some((row) => row.kind === 'post') || (load.phase === 'idle' && saved.loaded && saved.entries.length === 0) ? 'ready' : load.phase
  const v = viewOf({ hosted, online, phase, count: saved.entries.length })
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
    const cached = cachedRefs.current.has(item.ref)
    const quoteRef = post.quote ? refKey(post.quote.author, post.quote.seq) : null
    const q = !cached && quoteRef !== null && !cachedRefs.current.has(quoteRef) ? postAt(load.peeked, quoteRef) : null
    const quote = !post.quote
      ? null
      : q && !blocks.has(q.author)
        ? { author: q.author, name: q.name || null, username: q.username || null, avatar: q.avatar || null, at: q.at, text: q.text, media: q.media, preview: q.preview || null, persist: false, missing: false, onOpen: !cached && typeof onOpenThread === 'function' ? () => onOpenThread({ ref: refKey(q.author, q.seq), seed: q }) : undefined }
        : { author: post.quote.author, name: null, username: null, avatar: null, at: null, text: null, media: null, persist: false, missing: true, onOpen: undefined }
    const name = post.name || null
    const username = post.username || null
    return (
      <PostRow
        author={post.author}
        seq={cached ? undefined : post.seq}
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
        link={!cached && origin ? postLink(origin, item.ref) : null}
        onNotice={cached ? undefined : onToast}
        onOpen={!cached && typeof onOpenThread === 'function' ? () => onOpenThread({ ref: item.ref, seed: post }) : undefined}
        onOpenAuthor={!cached && typeof onOpenMember === 'function' ? () => onOpenMember(post.author, { name, username }) : undefined}
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
