// Ajustes > Aparelhos conectados (#350): the devices that entered this
// account with its passkey, as the node lists them (device.list). This device
// first, then the other connected ones, "Aparelhos anteriores" when the node
// reports writers no device claims, and the disconnected ones last, without
// actions. Desconectar asks first and is never repeated on its own: a failed
// device.disconnect shows the node's text, or for an uncertain one says it
// may be partly done. While this device is itself disconnected, Desconectar
// is off and the note with "Conectar de novo" shows. Device names are peer
// text and go through displayText.
// `active`: this screen is showing; the list is read each time it shows.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import {
  CONFIRM_CANCEL, CONNECTED_SECTION, DISCONNECT, DISCONNECTED_SECTION, EMPTY_OTHERS, LOAD_FAILED, NO_NAME, OFF_NOTE,
  PARTLY_DONE, PREVIOUS_NOTE, PREVIOUS_TITLE, RECONNECT, RECONNECT_ACCESSIBILITY, THIS_DEVICE,
  confirmCopy, deviceStore, disconnectDone, disconnectLabel, disconnectParams, otherLabel, readDevices, reconnectDevice, reconnectFailure, rowCaption, shapeList
} from '../devices'
import { currentDeviceName, useDeviceState } from '../useDevices'
import { HelpNote } from '../ui/Help'
import { HELP } from '../help'
import { Btn, ConfirmStack, ErrorText, FlushSectionHeader, Notice, Page, Soft, errorText, useAction } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { ErrorState, Skeleton } from '../ui/States'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { layout, space, type } from '../ui/theme'

function DeviceRow ({ icon, title, caption, action, onAction, disabled, accessibilityLabel }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View style={styles.row}>
      <Icon name={icon} size={22} color={colors.soft} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={2}>{title}</Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
      {action ? <Pill label={action} accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={onAction} danger /> : null}
    </View>
  )
}

// This device is off: one tap, one device.reconnect.
function OffBox ({ request }) {
  const styles = useStyles(makeStyles)
  const act = useAction()
  const [failure, setFailure] = useState('')
  const press = async () => {
    setFailure('')
    await act.run(async () => {
      try {
        await reconnectDevice({ request, store: deviceStore, name: currentDeviceName() })
      } catch (err) {
        setFailure(reconnectFailure(err, (m) => errorText({ message: m })))
        throw err
      }
    })
  }
  return (
    <View style={styles.offBox}>
      <Notice>{OFF_NOTE}</Notice>
      <ErrorText>{failure}</ErrorText>
      <Btn label={RECONNECT} accessibilityLabel={RECONNECT_ACCESSIBILITY} onPress={press} pending={act.pending} block />
    </View>
  )
}

export default function Aparelhos ({ active }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const state = useDeviceState()
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const act = useAction()
  const [failed, setFailed] = useState(false)
  // null, 'previous' or a device id: what the open sheet would disconnect.
  const [target, setTarget] = useState(null)
  // What the sheet last asked about, kept so the closing sheet keeps its text.
  const [asked, setAsked] = useState(null)
  const [done, setDone] = useState('')
  const [partly, setPartly] = useState('')
  const ready = node.phase === 'ready'

  const load = useCallback(async () => {
    try {
      await readDevices({ request: requestRef.current, store: deviceStore })
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  // Read each time the screen shows, and again when something cleared the
  // list meanwhile (a reconnect). Leaving forgets the toasts.
  const shown = useRef(false)
  const listNull = state.list === null
  useEffect(() => {
    if (!active) {
      shown.current = false
      setDone('')
      setPartly('')
      return
    }
    if (!ready || state.member === null) return
    if (!shown.current || listNull) {
      shown.current = true
      load()
    }
  }, [active, ready, listNull, state.member, load])

  const view = shapeList(state.list)
  const loading = listNull && !failed
  const copy = confirmCopy(asked)

  const close = () => { if (!act.pending) { act.clearError(); setTarget(null) } }
  const disconnect = async () => {
    const which = target
    setPartly('')
    const r = await act.run(() => requestRef.current('device.disconnect', disconnectParams(which)))
    if (r.ok) {
      setTarget(null)
      setDone(disconnectDone(which, r.value))
      load()
    } else if (r.uncertain) {
      setTarget(null)
      setPartly(PARTLY_DONE)
      load()
    }
  }
  const ask = (which) => { act.clearError(); setDone(''); setPartly(''); setAsked(which); setTarget(which) }
  // Off: this device cannot disconnect others until it connects again.
  const off = view.off || state.off
  const blocked = node.online === false || off

  let body
  if (loading) body = <Skeleton />
  else if (failed && listNull) body = <ErrorState message={LOAD_FAILED} onRetry={load} />
  else {
    const own = view.self
    body = (
      <>
        {off ? <OffBox request={node.request} /> : null}
        <HelpNote doc={HELP.aparelhos}><Soft>Os aparelhos em que você entrou com a sua passkey.</Soft></HelpNote>
        <FlushSectionHeader>{THIS_DEVICE}</FlushSectionHeader>
        <DeviceRow icon='smartphone' title={displayText(own !== null && own.name !== null ? own.name : currentDeviceName())} caption={own !== null ? rowCaption(own) : null} />
        <FlushSectionHeader>{CONNECTED_SECTION}</FlushSectionHeader>
        {view.others.length === 0 && view.previous === null ? <Soft>{EMPTY_OTHERS}</Soft> : null}
        {view.others.map((d) => (
          <DeviceRow
            key={d.id}
            icon='smartphone'
            title={d.name === null ? NO_NAME : displayText(otherLabel(d))}
            caption={rowCaption(d)}
            action={DISCONNECT}
            accessibilityLabel={disconnectLabel({ name: d.name === null ? null : displayText(d.name) })}
            disabled={blocked}
            onAction={() => ask(d.id)}
          />
        ))}
        {view.previous !== null
          ? (
            <DeviceRow
              icon='smartphone'
              title={PREVIOUS_TITLE}
              caption={PREVIOUS_NOTE}
              action={DISCONNECT}
              accessibilityLabel={DISCONNECT + ' ' + PREVIOUS_TITLE}
              disabled={blocked}
              onAction={() => ask('previous')}
            />
            )
          : null}
        {view.disconnected.length > 0
          ? (
            <>
              <FlushSectionHeader>{DISCONNECTED_SECTION}</FlushSectionHeader>
              {view.disconnected.map((d) => (
                <DeviceRow key={d.id} icon='smartphone' title={d.name === null ? NO_NAME : displayText(d.name)} caption={rowCaption(d)} />
              ))}
            </>
            )
          : null}
      </>
    )
  }

  return (
    <Page>
      <Notice>{done}</Notice>
      <ErrorText>{partly}</ErrorText>
      {body}
      <Sheet open={active && target !== null} onClose={close} dismissable={!act.pending} title={copy.title} closeLabel={CONFIRM_CANCEL}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.confirm}>
          {copy.lines.map((line) => <Soft key={line}>{line}</Soft>)}
          <ErrorText>{act.error}</ErrorText>
          <ConfirmStack
            confirm={<Btn label={DISCONNECT} danger onPress={disconnect} pending={act.pending} />}
            cancel={<Btn label={CONFIRM_CANCEL} secondary onPress={close} disabled={act.pending} />}
          />
        </ScrollView>
      </Sheet>
    </Page>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingVertical: space.sm },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  caption: { ...type.postMeta, color: colors.soft },
  confirm: { gap: space.md, padding: space.lg },
  offBox: { backgroundColor: colors.warm, borderRadius: 12, padding: space.md, gap: space.sm }
})
