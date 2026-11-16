// The one-time note before a first message to a Pagina, shared by the
// profile (Membro), a page listing (Anuncio) and a page's post (App).
// Continuar remembers the page on this device (and in the synced seen
// document, when there is one), closes the sheet and hands over to the
// caller once the sheet is gone.
// While open it reads the page's published dm-key: a page that has not
// activated its private Conversas yet gets one more line.

import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { useNode } from '../node'
import { PAGE_DM_NOTICE, PAGE_DM_NOT_ACTIVE, notePageNotice, pageNotActivated } from '../pageNotice'
import { pageNoticeStore } from '../pageNoticeStore'
import { syncedPageNoticeStore } from '../onceMarks'
import { onceMember, onceRegistry } from '../onceSync'
import { Sheet } from './Sheet'
import { ConfirmStack, Soft } from './index'
import { space } from './theme'

export function PageNoticeSheet ({ open, page, onClose, onContinue }) {
  const { request } = useNode()
  const [inactive, setInactive] = useState(false)
  useEffect(() => {
    setInactive(false)
    if (!open || typeof page !== 'string' || typeof request !== 'function') return
    let live = true
    request('dm.lookup', { member: page }).then((r) => {
      if (live) setInactive(pageNotActivated(r))
    }, () => {})
    return () => { live = false }
  }, [open, page, request])
  // onContinue runs only once the sheet is gone: the iOS page sheet dismisses
  // asynchronously, and the offer sheet that Mensagem presents right away
  // collided with it and left the listing behind ignoring every touch. As in
  // ActionsSheet, iOS and the web flush on the Modal's onDismiss; Android's
  // Modal has none, so there the timer waits out the slide (about 250 ms),
  // and elsewhere it covers a dismissal that never reports. The press-time
  // onContinue is kept, since the caller's own state is cleared by onClose.
  const shown = !!open
  const pending = useRef(null)
  const gone = useRef(false)
  // iOS can report a dismissal after the sheet was opened again during its
  // slide; marking that late flush as gone would leave the new opening dead.
  const shownNow = useRef(shown)
  shownNow.current = shown
  const flush = () => {
    const fn = pending.current
    pending.current = null
    if (!shownNow.current) gone.current = true
    if (typeof fn === 'function') fn()
  }
  useEffect(() => {
    if (shown) {
      // Reopened during the slide: the note shows again and decides anew.
      gone.current = false
      pending.current = null
      return undefined
    }
    const t = setTimeout(flush, Platform.OS === 'android' ? 320 : 700)
    return () => clearTimeout(t)
  }, [shown])
  useEffect(() => () => { pending.current = null }, [])
  const proceed = () => {
    // On the web the sheet takes touches while it slides out; the caller's
    // state is already cleared by then.
    if (!shownNow.current || gone.current || pending.current !== null) return
    notePageNotice(syncedPageNoticeStore(pageNoticeStore(), onceMember(), onceRegistry), page)
    pending.current = onContinue
    onClose()
  }
  return (
    <Sheet open={open} onClose={onClose} onDismiss={flush} title='Conversar com a página'>
      <View style={styles.body}>
        <Soft>{PAGE_DM_NOTICE}</Soft>
        {inactive ? <Soft>{PAGE_DM_NOT_ACTIVE}</Soft> : null}
        <ConfirmStack confirm={{ label: 'Continuar', onPress: proceed }} cancel={{ onPress: onClose }} />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg }
})
