// Eventos (entry { screen: 'eventos', key: hex64, params }): two readings of
// the same list. Without params.groups it is the events of one member's
// diary (key = the member), listed from the seeder's index (a claim: each
// post is read from its own diary, and one that is gone shows 'cancelado').
// With params.groups (the public groups of a community, key = the community)
// it is the Agenda: a local fold over group.events of each group, whose RSVPs
// the member's own node counted. Upcoming events come first, soonest first,
// then the ones that passed. Events are immutable: to change or cancel one
// the post is deleted. Hosted nodes only; no PostRow here, so no sheet host.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { fetchEvents } from '../indexClient'
import { eventRow, splitEvents } from '../events'
import { planPeeks } from '../thread'
import { whoOf } from '../who'
import { ErrorText, Soft, errorText, useNow } from '../ui'
import { EventCard } from '../ui/EventCard'
import { Pill } from '../ui/Pill'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { peekAll } from './Conversa'

const HEX64 = /^[0-9a-f]{64}$/
const HOSTED_ONLY = 'Eventos disponíveis no site da associação ou no app ligado à instalação.'
const MAX_GROUPS = 12

function peekedRecord (peeked, author, seq) {
  const peek = peeked.get(author)
  const entry = peek && Array.isArray(peek.entries) ? peek.entries.find((e) => e && e.seq === seq && e.record && e.record.type === 'post') : null
  return entry ? entry.record : null
}

export default function Eventos ({ entry, onBack, onOpenThread, onToast }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { request } = node
  const hosted = node.hosted === true
  const now = useNow(60 * 1000)
  const key = entry && typeof entry.key === 'string' && HEX64.test(entry.key) ? entry.key : null
  const groups = entry && entry.params && Array.isArray(entry.params.groups)
    ? entry.params.groups.filter((g) => typeof g === 'string' && HEX64.test(g)).slice(0, MAX_GROUPS)
    : null
  const agenda = groups !== null
  const capped = agenda && entry.params.truncated === true
  const [rows, setRows] = useState(null)
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [error, setError] = useState('')
  const [partial, setPartial] = useState(false)
  const gen = useRef(0)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; gen.current++ }, [])

  const readDiary = useCallback(async (before) => {
    const res = await fetchEvents(key, before)
    if (!res.ok) throw new Error('Não deu para ler os eventos agora.')
    const peeked = new Map()
    await peekAll(request, planPeeks({ refs: res.value.posts.map((s) => key + ':' + s) }), peeked)
    // No answer from the diary is a failed read, not a page of cancellations.
    if (res.value.posts.length > 0 && !peeked.get(key)) throw new Error('Não deu para ler os eventos agora.')
    const out = res.value.posts.map((seq) => {
      const record = peekedRecord(peeked, key, seq)
      // A live post without an event is a seeder pointer that does not hold.
      if (record && !record.event) return null
      const row = eventRow({ ref: key + ':' + seq, event: record ? record.event : null, gone: !record }, Date.now())
      return row === null ? null : { ...row, key: key + ':' + seq, author: key, seq, event: record && record.event ? record.event : null, text: record && typeof record.text === 'string' ? record.text : '' }
    }).filter(Boolean)
    return { rows: out, next: res.value.next, partial: res.value.indexing === true || res.value.complete === false }
  }, [key, request])

  const readAgenda = useCallback(async () => {
    const out = []
    // Groups the entry did not carry (Comunidade capped the list) or a page
    // the group has beyond the first (res.next) are not read: partial.
    let missed = capped
    for (const group of groups) {
      try {
        const res = await request('group.events', { group })
        if (res && (res.incomplete === true || (res.next !== null && res.next !== undefined))) missed = true
        for (const it of (res && Array.isArray(res.items) ? res.items : [])) {
          const ref = it.writer + ':' + it.seq
          const row = eventRow({ ref, event: it.event, gone: it.hidden === true || !it.event }, Date.now())
          if (row === null) continue
          const who = whoOf({ name: it.name, username: it.username }).title
          out.push({ ...row, key: group + ':' + ref, author: it.diary, seq: it.seq, event: it.event, group, writer: it.writer, totals: it.totals, mine: it.mine, who: displayText(who), text: '' })
        }
      } catch {
        missed = true
      }
    }
    return { rows: out, next: null, partial: missed }
  }, [request, capped, groups && groups.join(',')])

  const load = useCallback(async (pull = false) => {
    if (!hosted || key === null) return
    const mine = ++gen.current
    if (pull) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const got = agenda ? await readAgenda() : await readDiary(null)
      if (mine !== gen.current || !alive.current) return
      setRows(got.rows)
      setNext(got.next)
      setPartial(got.partial)
    } catch (err) {
      if (mine === gen.current && alive.current) setError(errorText(err))
    } finally {
      if (mine === gen.current && alive.current) { setLoading(false); setRefreshing(false) }
    }
  }, [hosted, key, agenda, readAgenda, readDiary])

  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { loadRef.current() }, [key, groups && groups.join(',')])

  const older = async () => {
    if (next === null || moreBusy || agenda) return
    const mine = gen.current
    setMoreBusy(true)
    setError('')
    try {
      const got = await readDiary(next)
      if (mine !== gen.current || !alive.current) return
      setRows((list) => (list || []).concat(got.rows))
      setNext(got.next)
    } catch (err) {
      if (alive.current) setError(errorText(err))
    } finally {
      if (alive.current) setMoreBusy(false)
    }
  }

  const data = useMemo(() => {
    if (rows === null) return []
    const { upcoming, past } = splitEvents(rows.filter((r) => r.card), now)
    const cancelled = rows.filter((r) => r.cancelled)
    const out = []
    if (upcoming.length > 0) out.push({ id: 'h:up', section: 'Próximos' }, ...upcoming)
    if (past.length > 0) out.push({ id: 'h:past', section: 'Já passaram' }, ...past)
    if (cancelled.length > 0) out.push({ id: 'h:gone', section: 'Cancelados' }, ...cancelled)
    return out
  }, [rows, now])

  const title = agenda ? 'Agenda' : 'Eventos'
  if (!hosted || key === null) {
    return (
      <View style={styles.root}>
        <TopBar title={title} onBack={onBack} />
        <View style={styles.pad}><Soft>{HOSTED_ONLY}</Soft></View>
      </View>
    )
  }

  const renderItem = ({ item }) => {
    if (item.section) return <Text style={styles.section} accessibilityRole='header' maxFontSizeMultiplier={1.3}>{item.section}</Text>
    if (item.cancelled) {
      return (
        <View style={styles.row}>
          <Text style={styles.gone} maxFontSizeMultiplier={1.3}>{agenda ? 'Evento cancelado' : 'Evento cancelado ou apagado'}</Text>
        </View>
      )
    }
    const open = typeof onOpenThread === 'function' && !agenda ? () => onOpenThread({ ref: item.key }) : null
    return (
      <View style={styles.row}>
        {agenda && item.who ? <Text style={styles.who} numberOfLines={1} maxFontSizeMultiplier={1.3}>{item.who}</Text> : null}
        {item.text ? <Text style={styles.text} numberOfLines={3} maxFontSizeMultiplier={1.3}>{displayText(item.text, { multiline: true })}</Text> : null}
        <EventCard author={item.author} seq={item.seq} event={item.event} group={item.group || null} writer={item.writer || null} totals={item.totals || null} mine={item.mine === undefined ? null : item.mine} onChanged={agenda ? () => loadRef.current(true) : undefined} now={now} />
        {open ? <View style={styles.inline}><Pill label='Abrir a publicação' onPress={open} /></View> : null}
      </View>
    )
  }

  const body = loading && rows === null
    ? <Skeleton rows={3} />
    : error && rows === null
      ? <ErrorState message={error} onRetry={() => load()} />
      : (
        <RefreshableList
          data={data}
          keyExtractor={(i) => i.id || i.key}
          renderItem={renderItem}
          extraData={{ now }}
          ListHeaderComponent={partial ? <View style={styles.pad}><Soft>{agenda ? 'Alguns grupos ainda não chegaram: a agenda pode estar incompleta.' : 'O índice ainda está sendo atualizado: a lista pode estar incompleta.'}</Soft></View> : null}
          ListEmptyComponent={rows !== null ? <EmptyState icon='evento' title={agenda ? 'Nada na agenda ainda' : 'Nenhum evento ainda'} body={agenda ? 'Eventos dos grupos públicos desta comunidade aparecem aqui.' : 'Os eventos publicados aparecem aqui.'} /> : null}
          ListFooterComponent={error || next !== null
            ? (
              <View style={styles.pad}>
                <ErrorText>{error}</ErrorText>
                {next !== null ? <Pill label='Ver mais eventos' pending={moreBusy} onPress={older} /> : null}
              </View>
              )
            : null}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          atEnd={rows !== null && next === null}
        />
        )

  return (
    <View style={styles.root}>
      <TopBar title={title} onBack={onBack} />
      {body}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: space.lg, gap: space.sm },
  section: { ...type.section, color: colors.soft, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
  row: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs },
  who: { ...type.meta, color: colors.soft },
  text: { ...type.postText, color: colors.ink },
  gone: { ...type.postMeta, color: colors.soft, paddingVertical: space.sm },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }
})
