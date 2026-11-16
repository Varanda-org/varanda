// 'Sou fã' / 'Deixar de ser fã' on someone else's profile (hosted node only),
// and the hook that holds what the own diary says about the own fan marks and
// the own top list. The marks are read from the own diary (log.read, newest
// page first), never from the seeder, so the button never writes the opposite
// of what the person really did (fansView.js ownFansScan).
//
// One write per press, never resent: an uncertain answer holds the button
// until 'Conferir' re-reads the own diary. The marks are shared by every
// FanButton, the top editor and the profile row (one store, one walk).

import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { ErrorText, Notice, Soft, useAction } from './index'
import { Icon } from './Icon'
import { Pill } from './Pill'
import { layout, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'
import { tap } from './haptics'
import { ownLogParams } from '../profileExtraView.js'
import {
  NO_MARKS, OWN_LOG_PAGES, TEXTS, fanButtonLabel, fanButtonView, fanCheck, fanDoneText,
  marksFromScan, ownFansScan, withFan, withTop
} from '../fansView.js'

const HEX64 = /^[0-9a-f]{64}$/
const TTL_MS = 300000

// ---- the shared store of the own marks ------------------------------------

const store = { key: null, marks: NO_MARKS, at: 0, inflight: null, epoch: 0, fanWrites: new Map(), topWrite: null, listeners: new Set() }

function publish (marks, at) {
  store.marks = marks
  if (at !== undefined) store.at = at
  for (const listener of [...store.listeners]) listener()
}

function reset (own) {
  store.epoch += 1
  store.key = own
  store.inflight = null
  store.fanWrites = new Map()
  store.topWrite = null
  publish(NO_MARKS, 0)
}

async function walk (request, own) {
  const pages = []
  let scan = ownFansScan(pages, own)
  for (let i = 0; i < OWN_LOG_PAGES; i++) {
    pages.push(await request('log.read', ownLogParams(scan.next === null ? undefined : scan.next)))
    scan = ownFansScan(pages, own)
    if (scan.settled || scan.next === null) break
  }
  return marksFromScan(scan)
}

// The held marks after a read, or null when it failed. A write made while the
// walk ran may be newer than what the walk saw: it is laid over the result.
// `force` reads even when the held marks are fresh. A walk that stopped short
// is held as long as a settled one: walking a long diary again on every mount
// would read the same pages and stop at the same place.
function read (request, own, force) {
  if (store.key !== own) reset(own)
  const fresh = (store.marks.status === 'ready' || store.marks.status === 'unsure') && Date.now() - store.at < TTL_MS
  if (!force && fresh) return Promise.resolve(store.marks)
  if (store.inflight !== null) return store.inflight
  const mine = store.epoch
  store.fanWrites = new Map()
  store.topWrite = null
  const run = walk(request, own).then((marks) => marks, () => null).then((marks) => {
    if (mine !== store.epoch) return null
    store.inflight = null
    if (marks === null) {
      if (store.marks.status === 'loading') publish({ ...NO_MARKS, status: 'failed' })
      return null
    }
    let next = marks
    for (const [key, w] of store.fanWrites) next = withFan(next, key, w.on, w.seq)
    if (store.topWrite !== null) next = withTop(next, store.topWrite.keys, store.topWrite.seq)
    publish(next, Date.now())
    return next
  })
  store.inflight = run
  return run
}

// { marks, reload(force) -> marks | null, markFan(key, on, seq), markTop(keys, seq) }.
// `enabled` false reads nothing. The same store is shared by every caller; it
// is dropped when another identity asks.
export function useOwnMarks ({ request, ownKey, enabled }) {
  const [, setTick] = useState(0)
  const valid = typeof ownKey === 'string' && HEX64.test(ownKey)
  useEffect(() => {
    const listener = () => setTick((n) => n + 1)
    store.listeners.add(listener)
    return () => { store.listeners.delete(listener) }
  }, [])
  const reload = useCallback((force = false) => {
    if (!valid) return Promise.resolve(null)
    return read(request, ownKey, force === true)
  }, [request, ownKey, valid])
  useEffect(() => {
    if (enabled && valid) reload(false)
  }, [enabled, valid, reload])
  const markFan = useCallback((key, on, seq) => {
    if (!valid || store.key !== ownKey) return
    store.fanWrites.set(key, { on, seq })
    publish(withFan(store.marks, key, on, seq))
  }, [ownKey, valid])
  const markTop = useCallback((keys, seq) => {
    if (!valid || store.key !== ownKey) return
    store.topWrite = { keys: keys.slice(), seq }
    publish(withTop(store.marks, keys, seq))
  }, [ownKey, valid])
  const marks = valid && store.key === ownKey ? store.marks : NO_MARKS
  return { marks, reload, markFan, markTop }
}

// ---- the button ---------------------------------------------------------

// `author` the profile's key, `title` its display-safe name. `page` and
// `blocked` hide the button (a page is neither fanned nor listed; a blocked
// person cannot be fanned). `onToast(text)` optional: the screen's toast.
export function FanButton ({ author, ownKey, title, page = false, blocked = false, onToast }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const hosted = node.hosted === true
  const online = node.online !== false
  const { request } = node
  const wanted = hosted && !page && !blocked && typeof ownKey === 'string' && ownKey !== author
  const { marks, reload, markFan } = useOwnMarks({ request, ownKey, enabled: wanted })
  const action = useAction()
  const [uncertain, setUncertain] = useState(false)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState('')
  // Another profile starts clean: an unchecked write belongs to the one it was for.
  useEffect(() => { setUncertain(false); setNote('') }, [author])

  const view = fanButtonView({ hosted, online, ownKey, author, page, blocked, marks, busy: action.pending || checking, uncertain })
  if (view === null) return null

  const say = (text) => {
    if (typeof onToast === 'function') onToast(text)
    else setNote(text)
  }

  const press = async () => {
    if (view.disabled) return
    setNote('')
    if (view.kind === 'retry') {
      await reload(true)
      return
    }
    const on = view.on !== true
    tap('light')
    const r = await action.run(() => request('fan.set', { key: author, on }))
    if (r.ok) {
      markFan(author, on, r.value && r.value.seq)
      say(fanDoneText(on))
    } else if (r.uncertain) {
      setUncertain(true)
    }
  }

  const check = async () => {
    setChecking(true)
    action.clearError()
    try {
      const result = fanCheck(await reload(true), author)
      if (result.settled) setUncertain(false)
      setNote(result.text)
    } finally {
      setChecking(false)
    }
  }

  const on = view.on === true
  const label = view.pending && view.pendingLabel ? view.pendingLabel : view.label
  const ink = view.kind === 'fan' ? colors.accentInk : colors.ink
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={view.kind === 'retry' ? TEXTS.retry : fanButtonLabel(on, title)}
        accessibilityState={{ disabled: view.disabled, busy: view.pending }}
        disabled={view.disabled}
        onPress={press}
        style={({ pressed }) => [styles.button, view.kind === 'fan' ? styles.fan : styles.unfan, view.disabled && styles.off, pressed && styles.pressed]}
      >
        {view.kind === 'retry' ? null : <Icon name='estrela' size={18} color={ink} filled={on} />}
        <Text style={[styles.label, { color: ink }]} maxFontSizeMultiplier={1.5}>{label}</Text>
      </Pressable>
      {uncertain
        ? (
          <View style={styles.check}>
            <Soft>{TEXTS.uncertain}</Soft>
            <Pill label={TEXTS.check} pending={checking} onPress={check} />
          </View>
          )
        : null}
      {uncertain ? null : <ErrorText>{action.error}</ErrorText>}
      <Notice>{note}</Notice>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: space.sm, alignItems: 'flex-start' },
  button: { minHeight: layout.hit, minWidth: layout.hit, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.lg },
  fan: { backgroundColor: colors.accent },
  unfan: { backgroundColor: colors.inputOff },
  label: { ...type.pill },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  check: { gap: space.sm, alignItems: 'flex-start' }
})
