// The signup invite card again, above the tabs once the newcomer arrives
// (App.js, inviteCardCopy.js arrivalGate): the frame and the message, with
// two taps toward the member who wrote it, Seguir and Mandar um oi, and
// Agora não. A plain card in the shell, not a Sheet (Sheet.js unmounts its
// children while closed).
//
// Nothing here writes on its own. Every tap first resolves the card again
// (resolve), then writes through inviteCardFlow.js arrivalActions with the
// guard App.js bound to the identity generation and this record: a lock,
// another identity or a replaced card answers 'stale' and writes nothing.
// The oi text is the fixed ARRIVAL_DM, never the card message. An uncertain
// answer shows the UNCERTAIN wording and is never retried here.

import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText } from '@varanda/rpc'
import { arrivalActions, canAttribute } from '../inviteCardFlow'
import { ARRIVAL_DM, ARRIVAL_TITLE, FOLLOW_LABEL, HI_LABEL, LATER_LABEL, NO_DM_TEXT } from '../inviteCardCopy'
import { InviteCard } from './InviteCard'
import { Btn, Card, ErrorText, Soft, UNCERTAIN, errorText } from './index'
import { space, type } from './theme'
import { useStyles } from './ThemeProvider'

const FOLLOWING_LABEL = 'Seguindo'
// The follow list is read page by page up to this many keys.
const FOLLOW_SCAN_MAX = 10000

async function follows (request, member) {
  const want = member.toLowerCase()
  for (let offset = 0; offset < FOLLOW_SCAN_MAX;) {
    const r = await request('follow.list', { offset, limit: FOLLOW_LIMIT_MAX })
    const page = Array.isArray(r && r.follows) ? r.follows : []
    if (page.some((k) => typeof k === 'string' && k.toLowerCase() === want)) return true
    offset += page.length
    if (page.length === 0 || !(r && Number.isSafeInteger(r.total)) || offset >= r.total) return false
  }
  return false
}

const outcomeText = (outcome) => outcome === 'uncertain' ? UNCERTAIN : outcome === 'failed' ? errorText(null) : ''

// result: a resolveInviteCard answer that passed canAttribute, with a
// username. resolve() -> a fresh answer; guard() -> true while this card is
// current; onStale() when a fresh answer no longer matches; onFollowed after
// a follow.add; onLater and onDone drop the card.
export function InviteArrival ({ result, request, resolve, guard, onStale, onFollowed, onLater, onDone }) {
  const styles = useStyles(makeStyles)
  const { card, member, username, recordId } = result
  // null while unknown. A failed read leaves Seguir offered (follow.add is
  // idempotent) and the oi offered (the tap asks dm.lookup again).
  const [following, setFollowing] = useState(null)
  const [box, setBox] = useState(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [followNote, setFollowNote] = useState('')
  const [hiBusy, setHiBusy] = useState(false)
  const [hiNote, setHiNote] = useState('')
  const [sent, setSent] = useState(false)
  const tapped = useRef(false)
  const doneRef = useRef(false)

  useEffect(() => {
    let alive = true
    follows(request, member).then((on) => { if (alive) setFollowing(on) }, () => {})
    request('dm.lookup', { member }).then((r) => {
      if (alive) setBox(!!r && typeof r.box === 'string')
    }, () => {})
    return () => { alive = false }
  }, [request, member, recordId])

  // Complete once a tap settled both: following, and the oi sent or no box.
  useEffect(() => {
    if (!tapped.current || doneRef.current) return
    if (following === true && (sent || box === false)) {
      doneRef.current = true
      onDone()
    }
  }, [following, sent, box, onDone])

  // A fresh resolve before every tap: the actions for it, or null (stale).
  const fresh = async () => {
    let r
    try { r = await resolve() } catch { r = null }
    if (!r || !canAttribute(r) || r.recordId !== recordId || r.member !== member || !guard()) {
      onStale()
      return null
    }
    return arrivalActions({ request, result: r, member, text: ARRIVAL_DM, guard })
  }

  const follow = async () => {
    if (followBusy || following === true) return
    setFollowBusy(true)
    setFollowNote('')
    try {
      const actions = await fresh()
      if (actions === null) return
      // Already following: nothing to write.
      let on = false
      try { on = await follows(request, member) } catch {}
      if (on) {
        tapped.current = true
        setFollowing(true)
        return
      }
      const outcome = await actions.follow()
      if (outcome === 'stale') return onStale()
      if (outcome === 'done') {
        tapped.current = true
        setFollowing(true)
        onFollowed()
        return
      }
      setFollowNote(outcomeText(outcome))
    } finally {
      setFollowBusy(false)
    }
  }

  const hi = async () => {
    if (hiBusy || sent) return
    setHiBusy(true)
    setHiNote('')
    try {
      const actions = await fresh()
      if (actions === null) return
      const outcome = await actions.oi()
      if (outcome === 'stale') return onStale()
      tapped.current = true
      if (outcome === 'sent') return setSent(true)
      if (outcome === 'nodm') return setBox(false)
      setHiNote(outcomeText(outcome))
    } finally {
      setHiBusy(false)
    }
  }

  const name = displayText(username)
  // At most 60% of the window, scrolling inside: on a short screen (a phone
  // web page in landscape) Agora não and the tab bar stay reachable.
  const { height } = useWindowDimensions()
  return (
    <View style={[styles.wrap, { maxHeight: Math.round(height * 0.6) }]}>
      <ScrollView>
        <Card>
          <Text style={styles.title} numberOfLines={2}>{ARRIVAL_TITLE + name}</Text>
          {/* Above the tabs, outside any scroll view: a message of many short
            lines is cut so the actions and the tabs stay on screen. */}
          <InviteCard design={card.design} name={card.name} message={card.message} maxMessageLines={3}>
            <View style={styles.actions}>
              {following === true
                ? <Btn secondary disabled label={FOLLOWING_LABEL} />
                : <Btn label={FOLLOW_LABEL + name} onPress={follow} pending={followBusy} />}
              <ErrorText>{followNote}</ErrorText>
              {box === false
                ? <Soft>{NO_DM_TEXT}</Soft>
                : sent ? null : <Btn secondary label={HI_LABEL} onPress={hi} pending={hiBusy} />}
              <ErrorText>{hiNote}</ErrorText>
              <Btn secondary label={LATER_LABEL} onPress={onLater} />
            </View>
          </InviteCard>
        </Card>
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.sm },
  title: { ...type.postName, color: colors.ink },
  actions: { gap: space.sm, marginTop: space.sm }
})
