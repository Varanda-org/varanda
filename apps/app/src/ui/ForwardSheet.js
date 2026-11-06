// Encaminhar: the sheet that forwards one chat message (a DM or a group
// message) into up to FORWARD_MAX recent conversations. The rows are the
// inbox DMs (dm.list, a few pages) and the groups the person posts in
// (community.list, then community.info), merged newest first like Conversas
// (forward.js loadForwardDestinations over conversas.js mergeRows). A failed
// list shows its error and a reload; a community that could not be read is
// left out with a short note.
//
// Enviar runs the destinations one after the other, in tap order, each with
// forward.js forwardPlan and runForward: every photo or voice note is read
// on this device (the chat's own cache first, then a fresh read through the
// node or the installation) and uploaded again into that conversation, then
// one dm.send or group.post goes with fwd: 1. Each row shows its own state:
// waiting, sending, sent, failed or uncertain. An uncertain send keeps its
// exact request and only a tap on "Tentar de novo" sends it again, once:
// nothing here repeats a send by itself. Before any upload of a private item
// into a public group, the audience question is asked (AUDIENCE_QUESTION),
// and the selection stays locked while it shows.
//
// While any destination is queued or sending the sheet cannot close, and
// every answer is tied to the open it started in: a late answer never lands
// on a reopened sheet, and an uncertain row keeps "Tentar de novo" until the
// person closes the sheet.
//
// Media bytes stay on the device: a cached chat entry is read back from its
// blob: or file:// URL, otherwise chatMedia bytesFor hands the plaintext over
// without any display URL (a native display only takes images, so a voice
// note must not go through one). runForward wipes them after the upload, and
// nothing here names the original author.
//
// Props: { open, onClose, source, refs, identity }, where source is the
// forwardPlan source and refs[i] the chatMedia ref of source.media[i]
// (chatSend.js chatMediaRefs).

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { isAppClient } from '../appClient'
import { whoOf, UNNAMED } from '../who'
import { UNSURE_SEND } from '../dm'
import {
  AUDIENCE_QUESTION, EXPIRED, FORWARD_MAX, canRetry, forwardBusy, forwardPlan, loadForwardDestinations, needsAudience,
  retryForward, runForward, stateOfPhase, targetOf, toggleSelection
} from '../forward'
import { createChatMedia, pinChatMedia, sourceFor } from '../media/chatMedia'
import { readReportAudio as readLocalBytes } from '../media/reportAudio'
import { ErrorText, Soft, errorText } from './index'
import { Icon } from './Icon'
import { Pill } from './Pill'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type } from './theme'

const fetchDeps = () => (isAppClient() ? { fetch: expoFetch } : {})

const STATE_TEXT = Object.freeze({
  waiting: 'Na fila',
  pending: 'Enviando…',
  sent: 'Encaminhada',
  uncertain: 'Não deu para confirmar o envio.',
  failed: 'Não foi enviada.'
})
const WAIT_HINT = 'Aguarde o envio terminar.'
const PARTIAL_NOTE = 'Alguns grupos não puderam ser carregados.'

const unsure = (err) => !!(err && (err.uncertain === true || err.message === UNSURE_SEND))

// The plaintext of one chat item the chat already holds: the device-local
// URL of a cache hit, read back into bytes while pinned. A miss reads
// nothing here (cachedOnly); the fresh read does it once.
async function readCached (ref, ctx) {
  if (!ref) return null
  const entry = await sourceFor(ref, { ...ctx, cachedOnly: true })
  if (!entry || entry.unavailable === true || typeof entry.uri !== 'string') return null
  const unpin = pinChatMedia(entry.uri)
  try {
    const bytes = await readLocalBytes(entry.uri)
    return { bytes, mime: entry.mime, w: entry.w, h: entry.h, ...(Number.isInteger(entry.ms) ? { ms: entry.ms } : {}) }
  } finally {
    unpin()
  }
}

export function ForwardSheet ({ open, onClose, source, refs, identity }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const request = node.request
  const names = useNames()
  const { resolveMany, profileOf } = names
  const [rows, setRows] = useState(null)
  const [partial, setPartial] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState([])
  const [askAudience, setAskAudience] = useState(false)
  // key -> { state, op?, error?, dropped? }
  const [status, setStatus] = useState({})
  const [running, setRunning] = useState(false)
  const [waitHint, setWaitHint] = useState(false)
  // Bumped on every open, close and unmount: an answer from an older open is
  // dropped instead of landing on this one.
  const genRef = useRef(0)
  const runRef = useRef(null)

  useEffect(() => {
    genRef.current++
    if (!open) return
    setStatus({})
    setSelected([])
    setAskAudience(false)
    setWaitHint(false)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setRows(null)
    setPartial(false)
    setLoadError('')
    loadForwardDestinations(request).then(({ rows: list, partial: some }) => {
      if (!alive) return
      setRows(list)
      setPartial(some)
      const peers = list.filter((r) => r.kind === 'dm').map((r) => r.peer)
      if (peers.length > 0) resolveMany(peers)
    }, (err) => { if (alive) setLoadError(errorText(err)) })
    return () => { alive = false }
  }, [open, request, resolveMany, reload])

  useEffect(() => () => {
    genRef.current++
    if (runRef.current) runRef.current.live = false
  }, [])

  const busy = running || forwardBusy(status)

  // Cancelar, back and the backdrop all land here: ignored while a send is
  // queued or in flight, so its answer always has a sheet to land on.
  const close = () => {
    if (busy) {
      setWaitHint(true)
      return
    }
    if (typeof onClose === 'function') onClose()
  }

  const titleOf = (row) => {
    if (row.kind === 'dm') {
      if (typeof row.title === 'string' && row.title !== '') return row.title
      const who = whoOf(profileOf(row.peer))
      return who.title === UNNAMED ? 'Pessoa' : who.title
    }
    return row.title || 'Grupo'
  }

  // setStatus for one row, only while the open it belongs to is current.
  const setterFor = (gen) => (key, value) => {
    if (genRef.current !== gen) return
    setStatus((s) => ({ ...s, [key]: value }))
  }

  const readers = useCallback((fresh) => {
    const ctx = { node, identity, fetchDeps: fetchDeps() }
    const list = Array.isArray(refs) ? refs : []
    return {
      readCache: (i) => readCached(list[i], ctx),
      readSource: (i) => (list[i] ? fresh.bytesFor(list[i], { ...ctx, readFile: readLocalBytes }) : null)
    }
  }, [node, identity, refs])

  const sendAll = async (confirmed) => {
    if (busy || !source || !Array.isArray(rows)) return
    const chosen = selected.map((key) => rows.find((r) => r.key === key)).filter(Boolean)
    if (chosen.length === 0) return
    if (!confirmed && needsAudience(source, chosen)) {
      setAskAudience(true)
      return
    }
    setAskAudience(false)
    const gen = genRef.current
    const setOne = setterFor(gen)
    const token = { live: true }
    runRef.current = token
    setRunning(true)
    setStatus(Object.fromEntries(chosen.map((r) => [r.key, { state: 'waiting' }])))
    // A fresh source read per run, released when the run ends.
    const fresh = createChatMedia({ max: 8 })
    const { readCache, readSource } = readers(fresh)
    const live = () => token.live && genRef.current === gen
    try {
      for (const row of chosen) {
        if (!live()) break
        const target = targetOf(row)
        const plan = target ? forwardPlan(source, target) : { ok: false, error: 'destino inválido' }
        if (!plan.ok) {
          setOne(row.key, { state: 'failed', error: plan.error })
          continue
        }
        setOne(row.key, { state: 'pending' })
        const r = await runForward({ plan, target, readCache, readSource, media: node.media, request, live, uncertain: unsure })
        if (!live() && r.phase === 'cancelled') break
        setOne(row.key, { state: stateOfPhase(r.phase), op: r.op, error: r.error ? errorText(r.error) : '', dropped: r.dropped })
      }
    } finally {
      fresh.clear()
      if (runRef.current === token) {
        runRef.current = null
        setRunning(false)
      }
    }
  }

  // The explicit retry of one uncertain destination: its same request, once.
  const retry = async (key) => {
    const entry = status[key]
    if (busy || !canRetry(entry)) return
    const setOne = setterFor(genRef.current)
    setOne(key, { ...entry, state: 'pending' })
    const r = await retryForward({ op: entry.op, request, uncertain: unsure })
    setOne(key, { state: stateOfPhase(r.phase), op: r.op || entry.op, error: r.error ? errorText(r.error) : '', dropped: entry.dropped })
  }

  const started = Object.keys(status).length > 0
  const full = selected.length >= FORWARD_MAX
  // The question was asked for this selection: it stays locked until the
  // question is answered.
  const locked = started || askAudience
  const left = (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel='Cancelar'
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={close}
      hitSlop={8}
    >
      <Text style={[styles.cancel, busy && styles.sendOff]}>Cancelar</Text>
    </Pressable>
  )
  const right = locked
    ? null
    : (
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='Enviar'
        accessibilityState={{ disabled: selected.length === 0 }}
        disabled={selected.length === 0}
        onPress={() => sendAll(false)}
        hitSlop={8}
      >
        <Text style={[styles.send, selected.length === 0 && styles.sendOff]}>{selected.length > 0 ? 'Enviar (' + selected.length + ')' : 'Enviar'}</Text>
      </Pressable>
      )

  let body
  if (loadError) {
    body = (
      <View style={styles.pad}>
        <ErrorText>{loadError}</ErrorText>
        <View style={styles.inline}>
          <Pill label='Carregar de novo' onPress={() => setReload((n) => n + 1)} />
        </View>
      </View>
    )
  } else if (rows === null) {
    body = <View style={styles.pad}><Soft>Carregando conversas…</Soft></View>
  } else if (rows.length === 0) {
    body = <View style={styles.pad}><Soft>Nenhuma conversa ainda.</Soft>{partial ? <Soft>{PARTIAL_NOTE}</Soft> : null}</View>
  } else {
    const shown = started ? rows.filter((r) => status[r.key]) : rows
    body = (
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps='handled'>
        {waitHint && busy ? <View style={styles.pad}><Soft>{WAIT_HINT}</Soft></View> : null}
        {!started ? <View style={styles.pad}><Soft>{'Escolha até ' + FORWARD_MAX + ' conversas.'}</Soft></View> : null}
        {!started && partial ? <View style={styles.pad}><Soft>{PARTIAL_NOTE}</Soft></View> : null}
        {shown.map((row) => {
          const chosen = selected.includes(row.key)
          const entry = status[row.key]
          const off = !locked && !chosen && full
          return (
            <View key={row.key} style={styles.rowWrap}>
              <Pressable
                accessibilityRole='checkbox'
                accessibilityState={{ checked: chosen, disabled: off || locked }}
                accessibilityLabel={displayText(titleOf(row))}
                disabled={off || locked}
                onPress={() => setSelected((s) => toggleSelection(s, row.key))}
                style={({ pressed }) => [styles.row, pressed && styles.pressed, off && styles.off]}
              >
                <Icon name={row.kind === 'group' ? 'gente' : 'pessoa'} size={20} color={colors.soft} />
                <Text style={styles.title} numberOfLines={1}>{displayText(titleOf(row))}</Text>
                {!started && chosen ? <Icon name='ok' size={20} color={colors.accent} /> : null}
              </Pressable>
              {entry
                ? (
                  <View style={styles.state}>
                    <Soft>{STATE_TEXT[entry.state] || ''}</Soft>
                    {entry.dropped ? <Soft>{EXPIRED}</Soft> : null}
                    {entry.state === 'failed' && entry.error ? <ErrorText>{entry.error}</ErrorText> : null}
                    {canRetry(entry) ? <Pill label='Tentar de novo' onPress={() => retry(row.key)} disabled={busy} /> : null}
                  </View>
                  )
                : null}
            </View>
          )
        })}
        {askAudience
          ? (
            <View style={styles.pad}>
              <Soft>{AUDIENCE_QUESTION}</Soft>
              <View style={styles.inline}>
                <Pill label='Enviar' filled onPress={() => sendAll(true)} />
                <Pill label='Cancelar' onPress={() => setAskAudience(false)} />
              </View>
            </View>
            )
          : null}
      </ScrollView>
    )
  }

  return (
    <Sheet open={!!open} onClose={close} title='Encaminhar' left={left} right={right} dismissable={!busy}>
      {body}
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  list: { paddingBottom: space.xl },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  rowWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { minHeight: layout.hit + space.sm, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg },
  title: { ...type.cancel, color: colors.ink, flex: 1 },
  state: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.xs, alignItems: 'flex-start' },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cancel: { ...type.cancel, color: colors.ink },
  send: { ...type.cancel, color: colors.accent, fontWeight: '600' },
  sendOff: { color: colors.soft },
  pressed: { backgroundColor: colors.skeleton },
  off: { opacity: 0.4 }
})
