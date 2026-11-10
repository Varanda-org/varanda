// The one-time note before a first message to a Pagina, shared by the
// profile (Membro), a page listing (Anuncio) and a page's post (App).
// Continuar remembers the page on this device and hands over to the caller.
// While open it reads the page's published dm-key: a page that has not
// activated its private Conversas yet gets one more line.

import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useNode } from '../node'
import { PAGE_DM_NOTICE, PAGE_DM_NOT_ACTIVE, notePageNotice, pageNotActivated } from '../pageNotice'
import { pageNoticeStore } from '../pageNoticeStore'
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
  const proceed = () => {
    notePageNotice(pageNoticeStore(), page)
    onContinue()
  }
  return (
    <Sheet open={open} onClose={onClose} title='Conversar com a página'>
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
