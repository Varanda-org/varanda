// Ajustes > Aparelhos conectados (#350): the devices that entered this
// account with its passkey, as the node lists them (device.list). This device
// first, then the other connected ones, "Aparelhos anteriores" when the node
// reports writers no device claims, and the disconnected ones last, without
// actions. Desconectar asks first and is never repeated on its own: a failed
// device.disconnect shows the node's text, or for an uncertain one says it
// may be partly done. Device names are peer text and go through displayText.
// `active`: this screen is showing, so the list is read.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import {
  CONFIRM_CANCEL, CONFIRM_LINES, CONFIRM_TITLE, CONNECTED_SECTION, DEVICES_NOTE, DISCONNECT, DISCONNECTED_SECTION, DONE_TOAST,
  EMPTY_OTHERS, LOAD_FAILED, NO_NAME, PARTLY_DONE, PREVIOUS_NOTE, PREVIOUS_TITLE, THIS_DEVICE,
  deviceStore, disconnectLabel, disconnectParams, otherLabel, readDevices, shapeList, sinceText
} from '../devices'
import { useDeviceState } from '../useDevices'
import { Btn, ConfirmStack, ErrorText, FlushSectionHeader, Notice, Page, Soft, useAction } from '../ui'
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
  const [done, setDone] = useState('')
  const [partly, setPartly] = useState('')

  const load = useCallback(async () => {
    try {
      await readDevices({ request: requestRef.current, store: deviceStore })
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  // A fresh read every time the screen shows, and again after a change
  // elsewhere cleared the list (a reconnect).
  useEffect(() => {
    if (active && node.phase === 'ready' && state.list === null) load()
  }, [active, node.phase, state.list, load])

  const view = shapeList(state.list)
  const loading = state.list === null && !failed

  const close = () => { if (!act.pending) { act.clearError(); setTarget(null) } }
  const disconnect = async () => {
    const which = target
    setPartly('')
    const r = await act.run(() => requestRef.current('device.disconnect', disconnectParams(which)))
    if (r.ok) {
      setTarget(null)
      setDone(DONE_TOAST)
      load()
    } else if (r.uncertain) {
      setTarget(null)
      setPartly(PARTLY_DONE)
      load()
    }
  }

  let body
  if (loading) body = <Skeleton />
  else if (failed && state.list === null) body = <ErrorState message={LOAD_FAILED} onRetry={load} />
  else {
    const own = view.self
    body = (
      <>
        <Soft>{DEVICES_NOTE}</Soft>
        <FlushSectionHeader>{THIS_DEVICE}</FlushSectionHeader>
        <DeviceRow icon='smartphone' title={own !== null && own.name !== null ? displayText(own.name) : THIS_DEVICE} caption={own !== null ? sinceText(own.since) : null} />
        <FlushSectionHeader>{CONNECTED_SECTION}</FlushSectionHeader>
        {view.others.length === 0 && view.previous === null ? <Soft>{EMPTY_OTHERS}</Soft> : null}
        {view.others.map((d) => (
          <DeviceRow
            key={d.id}
            icon='smartphone'
            title={d.name === null ? NO_NAME : displayText(otherLabel(d))}
            caption={sinceText(d.since)}
            action={DISCONNECT}
            accessibilityLabel={disconnectLabel({ name: d.name === null ? null : displayText(d.name) })}
            disabled={node.online === false}
            onAction={() => { act.clearError(); setDone(''); setPartly(''); setTarget(d.id) }}
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
              disabled={node.online === false}
              onAction={() => { act.clearError(); setDone(''); setPartly(''); setTarget('previous') }}
            />
            )
          : null}
        {view.disconnected.length > 0
          ? (
            <>
              <FlushSectionHeader>{DISCONNECTED_SECTION}</FlushSectionHeader>
              {view.disconnected.map((d) => (
                <DeviceRow key={d.id} icon='smartphone' title={d.name === null ? NO_NAME : displayText(d.name)} caption={sinceText(d.since)} />
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
      <Sheet open={active && target !== null} onClose={close} dismissable={!act.pending} title={CONFIRM_TITLE} closeLabel={CONFIRM_CANCEL}>
        <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.confirm}>
          {CONFIRM_LINES.map((line) => <Soft key={line}>{line}</Soft>)}
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
  confirm: { gap: space.md, padding: space.lg }
})
