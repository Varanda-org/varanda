// The poll of a post, inside a PostRow. The options are peer text and go
// through displayText. The totals are the seeder's claim (fetchPoll) and say
// so; the own pick is read from the own diary (choice.mine), the only verified
// number here. A vote is a public record in the voter's diary, so the notice
// shows before the first vote. 'Quem votou' lists the voters of one option:
// the seeder only points, and each voter is shown only when their own diary
// returned a signed choice for this poll and option (a seeder can omit a
// voter, never add one). Voting needs the hosted node (decided by capability,
// not by platform); without it the card is read-only. A vote is never resent.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { fetchPoll, fetchPollVoters } from '../indexClient'
import { nextPick, pollCard } from '../polls'
import { whoOf } from '../who'
import { confirmedVoters, voterSeqs } from './pollVoters'
import { learnPeeked, peekAll } from '../screens/Conversa'
import { tap } from './haptics'
import { layout, type } from './theme'
import { useStyles } from './ThemeProvider'

const HEX64 = /^[0-9a-f]{64}$/
const VOTE_FAILED = 'Não deu para registrar o voto. Tente de novo.'
const VOTERS_FAILED = 'Não deu para ver quem votou agora.'
const NO_VOTERS = 'Ninguém conferido nesta opção.'
const NOT_HOSTED = 'Para votar, use a versão web do Varanda.'

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// author: the post's diary key; seq: its seq; poll: the bare options array.
export function PollCard ({ author, seq, poll }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const key = typeof author === 'string' ? author.toLowerCase() : ''
  const valid = HEX64.test(key) && Number.isSafeInteger(seq) && seq > 0
  const hosted = node.hosted === true && valid
  const { request } = node
  const online = node.online !== false
  const count = Array.isArray(poll) ? poll.length : 0
  const [own, setOwn] = useState(undefined)
  const [totals, setTotals] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)
  const [voters, setVoters] = useState({ pick: null, phase: 'idle', rows: [] })
  const gen = useRef(0)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const readTotals = useCallback(async () => {
    if (!hosted || !online) return
    const res = await fetchPoll(key, seq, count)
    if (alive.current && res.ok) setTotals(res.value)
  }, [hosted, online, key, seq, count])

  useEffect(() => {
    if (!hosted || !online) return undefined
    let live = true
    request('choice.mine', { to: { author: key, seq } }).then((r) => {
      if (live && alive.current && isObject(r)) setOwn(Number.isSafeInteger(r.pick) ? r.pick : null)
    }, () => {})
    readTotals()
    return () => { live = false }
  }, [hosted, online, request, key, seq, readTotals])

  const card = pollCard({ poll, totals, own })
  const vote = async (index) => {
    if (busy || card === null) return
    const plan = nextPick(card, index)
    if (!plan.write) return
    setBusy(true)
    setError('')
    tap('light')
    try {
      await request('choice.set', { to: { author: key, seq }, pick: plan.pick })
      if (!alive.current) return
      setOwn(plan.pick)
      readTotals()
    } catch {
      if (alive.current) setError(VOTE_FAILED)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const showVoters = async (index) => {
    if (open === index) { gen.current++; setOpen(null); return }
    const mine = ++gen.current
    setOpen(index)
    setVoters({ pick: index, phase: 'loading', rows: [] })
    const fail = () => { if (mine === gen.current) setVoters({ pick: index, phase: 'error', rows: [] }) }
    try {
      const res = await fetchPollVoters(key, seq, index)
      if (mine !== gen.current) return
      if (!res.ok) return fail()
      const peeked = new Map()
      for (const it of res.value.items) await peekAll(request, [{ author: it.key, seqs: voterSeqs(it.seq) }], peeked, () => mine === gen.current)
      if (mine !== gen.current) return
      learnPeeked(names.learnMany, peeked)
      setVoters({ pick: index, phase: 'ready', rows: confirmedVoters(res.value.items, peeked, key, seq, index) })
    } catch {
      fail()
    }
  }

  if (card === null) return null
  const canVote = hosted && online && card.ownKnown && !busy
  const spoken = (row) => displayText(row.label) + (row.countLabel ? ', ' + row.countLabel : '') + (row.own ? ', seu voto' : '')
  return (
    <View style={styles.card}>
      {card.options.map((row) => (
        <View key={row.index} style={styles.optionBox}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={spoken(row)}
            accessibilityState={{ selected: row.own, disabled: !canVote }}
            disabled={!canVote}
            onPress={() => vote(row.index)}
            style={({ pressed }) => [styles.option, row.own && styles.optionOn, pressed && styles.pressed]}
          >
            <View style={[styles.fill, { width: row.percent + '%' }]} />
            <Text style={[styles.label, row.own && styles.labelOn]} numberOfLines={3}>{displayText(row.label)}</Text>
            {row.countLabel ? <Text style={styles.count}>{row.countLabel}</Text> : null}
          </Pressable>
          {row.count !== null && row.count > 0
            ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={'quem votou em ' + displayText(row.label)}
                accessibilityState={{ expanded: open === row.index }}
                onPress={() => showVoters(row.index)}
                style={({ pressed }) => [styles.who, pressed && styles.pressed]}
              >
                <Text style={styles.whoText}>quem votou</Text>
              </Pressable>
              )
            : null}
          {open === row.index ? <Voters state={voters} names={names} /> : null}
        </View>
      ))}
      {card.notice !== null && hosted ? <Text style={styles.note}>{card.notice}</Text> : null}
      {!hosted ? <Text style={styles.note}>{NOT_HOSTED}</Text> : null}
      {hosted && online
        ? <Text style={styles.note}>{(card.totalLabel ? card.totalLabel + '. ' : '') + card.totalsNote + (card.claimed && card.incomplete ? ' ' + 'A contagem pode estar incompleta.' : '')}</Text>
        : null}
      {error ? <Text style={styles.error} accessibilityLiveRegion='polite'>{error}</Text> : null}
    </View>
  )
}

function Voters ({ state, names }) {
  const styles = useStyles(makeStyles)
  if (state.phase === 'loading') return <Text style={styles.note}>Conferindo…</Text>
  if (state.phase === 'error') return <Text style={styles.note}>{VOTERS_FAILED}</Text>
  if (state.rows.length === 0) return <Text style={styles.note}>{NO_VOTERS}</Text>
  return (
    <View style={styles.voters}>
      {state.rows.map((row) => {
        const known = names.profileOf(row.key)
        const who = whoOf(known && (known.name || known.username) ? known : { name: row.name, username: row.username })
        return <Text key={row.key} style={styles.voter} numberOfLines={1}>{displayText(who.title)}</Text>
      })}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: { marginTop: 8, gap: 8 },
  optionBox: { gap: 2 },
  option: { minHeight: layout.hit, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 12, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  optionOn: { borderColor: colors.accent },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accentSoft },
  label: { ...type.postText, color: colors.ink, flex: 1 },
  labelOn: { fontWeight: '700' },
  count: { ...type.meta, color: colors.soft },
  who: { minHeight: layout.hit, justifyContent: 'center', alignSelf: 'flex-start' },
  whoText: { ...type.meta, color: colors.accent },
  voters: { gap: 2, paddingLeft: 12 },
  voter: { ...type.meta, color: colors.ink },
  note: { ...type.meta, color: colors.soft },
  error: { ...type.meta, color: colors.danger },
  pressed: { opacity: 0.6 }
})
