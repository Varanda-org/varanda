// Sobre mim: the about text and the filled fields of a profile, in a card.
// `about` comes from aboutView (peer text already through displayText).
// Also here, useProfileExtra: the hook that reads a profile's about and mood
// records. The seeder only gives two seqs; each record is re-read from the
// author's diary with diary.peek and checked (profileExtraView.js), so the
// seeder cannot make a profile say something it did not sign. With `own`
// (the editor of the own profile) the seeder is not asked at all: the records
// come from the member's own diary through log.read. Hosted nodes only:
// elsewhere nothing is read and the profile looks as it always did.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { diaryPeekSlots } from '../engagement'
import { fetchProfile } from '../indexClient'
import { OWN_LOG_PAGES, TEXTS, extraStatus, newerExtra, ownExtraScan, ownLogParams, ownRecordAt, planExtraPeeks, readExtra, settledExtra, withoutExtra } from '../profileExtraView.js'
import { themeColors } from '../profileThemes.js'
import { radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const NONE = Object.freeze({ about: null, mood: null })

async function peekAll (request, plan, alive) {
  const peeks = []
  for (const params of plan) {
    if (!alive()) return peeks
    const peek = await diaryPeekSlots.run(() => (alive() ? request('diary.peek', params) : null), { front: true })
    if (peek) peeks.push(peek)
  }
  return peeks
}

// The own diary, newest page first, until both kinds are settled. null when
// `alive` turned false; settled false when the walk stopped short.
async function scanOwn (request, author, alive) {
  const pages = []
  let scan = ownExtraScan(pages, author)
  for (let i = 0; i < OWN_LOG_PAGES; i++) {
    pages.push(await request('log.read', ownLogParams(scan.next === null ? undefined : scan.next)))
    if (!alive()) return null
    scan = ownExtraScan(pages, author)
    if (scan.settled || scan.next === null) break
  }
  return scan
}

// { held: { about, mood } (each { seq, record } or null), status, reload(),
//   check(dropKinds), apply(kind, seq), drop(kind) }. status: 'loading', 'ready' (every
// kind is settled: the seeder's index of this author is complete or named
// it, and each named record was read back and checked; with `own`, the own
// diary was read far enough), 'unsure' (something is not settled: the seeder
// is still indexing, a named record did not verify, or the own diary walk
// stopped short) or 'failed' (no answer). A failed read leaves what is held:
// the profile then looks as it did, never worse. The editor writes only from
// 'ready', so an unread record is never overwritten by a form that started
// empty.
export function useProfileExtra ({ author, enabled, request, own = false }) {
  const [held, setHeld] = useState(NONE)
  const [status, setStatus] = useState('loading')
  const [tick, setTick] = useState(0)
  const heldRef = useRef(NONE)
  const requestRef = useRef(request)
  requestRef.current = request
  const gen = useRef(0)

  const merge = useCallback((incoming) => {
    heldRef.current = newerExtra(heldRef.current, incoming)
    setHeld(heldRef.current)
  }, [])

  // One read of the seeder's pointers and of the records they name. Returns
  // the status it reached, or null when `alive` turned false on the way.
  const read = useCallback(async (alive, drop = []) => {
    try {
      if (own) {
        const scan = await scanOwn(requestRef.current, author, alive)
        if (scan === null) return null
        // The own diary is the authority: what it holds replaces what was held.
        if (scan.settled) {
          heldRef.current = scan.held
          setHeld(heldRef.current)
          return 'ready'
        }
        return 'unsure'
      }
      const res = await fetchProfile(author)
      if (!alive()) return null
      if (!res.ok) return 'failed'
      const peeks = await peekAll(requestRef.current, planExtraPeeks(res.value, author), alive)
      if (!alive()) return null
      const got = readExtra(res.value, peeks, author)
      merge(got)
      if (drop.length > 0) {
        heldRef.current = settledExtra(heldRef.current, res.value, drop)
        setHeld(heldRef.current)
      }
      return extraStatus(res.value, got)
    } catch {
      return alive() ? 'failed' : null
    }
  }, [author, own, merge])

  useEffect(() => {
    heldRef.current = NONE
    setHeld(NONE)
    setStatus('loading')
  }, [author])

  useEffect(() => {
    if (!enabled || typeof author !== 'string' || author === '') return undefined
    const mine = ++gen.current
    read(() => mine === gen.current).then((next) => { if (next !== null) setStatus(next) })
    return () => { gen.current += 1 }
  }, [enabled, author, tick, read])

  const reload = useCallback(() => { setStatus('loading'); setTick((n) => n + 1) }, [])

  // A read the caller waits for (the person asked to check an uncertain
  // write): the held records afterwards, or null when it could not be read.
  // `dropKinds` are the kinds of an uncertain delete: a kind the seeder, with
  // a complete index, has no record of any more is let go of. With `own`
  // only a settled walk of the own diary answers: one that stopped short
  // could miss a record that is still there.
  const check = useCallback(async (dropKinds = []) => {
    const next = await read(() => true, dropKinds)
    if (next === null || next === 'failed' || (own && next !== 'ready')) return null
    return heldRef.current
  }, [read, own])

  // After a write: read the record the node just returned the seq of, so the
  // screen shows it without waiting for the seeder to index it.
  const apply = useCallback(async (kind, seq) => {
    if (typeof author !== 'string' || !Number.isSafeInteger(seq)) return false
    try {
      if (own) {
        const got = ownRecordAt(await requestRef.current('log.read', { limit: 1, before: seq + 1 }), author, kind, seq)
        if (got === null) return false
        merge({ [kind]: got })
        return true
      }
      const peeks = await peekAll(requestRef.current, planExtraPeeks({ [kind]: seq }, author), () => true)
      const got = readExtra({ [kind]: seq }, peeks, author)
      if (got[kind] === null) return false
      merge(got)
      return true
    } catch {
      return false
    }
  }, [author, own, merge])

  // After a delete: the kind is no longer held, so the profile stops showing it.
  const drop = useCallback((kind) => {
    heldRef.current = withoutExtra(heldRef.current, kind)
    setHeld(heldRef.current)
  }, [])

  return { held, status, reload, check, apply, drop }
}

export function AboutCard ({ about, theme = null }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  if (!about || about.empty) return null
  const c = theme === null ? null : themeColors(theme, scheme)
  return (
    <View style={[styles.card, c !== null && { borderLeftColor: c.accent }]}>
      <Text style={styles.title}>{TEXTS.aboutTitle}</Text>
      {about.about ? <Text style={styles.about}>{about.about}</Text> : null}
      {about.rows.map((r) => (
        <View key={r.key} style={styles.row} accessible accessibilityLabel={r.label + ': ' + r.value}>
          <Text style={styles.label}>{r.label}</Text>
          <Text style={styles.value}>{r.value}</Text>
        </View>
      ))}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderLeftWidth: 4, borderLeftColor: colors.accent, padding: space.md, gap: space.sm },
  title: { ...type.section, color: colors.soft },
  about: { ...type.postText, color: colors.ink },
  row: { gap: 2 },
  label: { ...type.caption, color: colors.soft },
  value: { ...type.postText, color: colors.ink }
})
