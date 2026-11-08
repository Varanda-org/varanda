// The one-time notice before a first message to a Pagina, shared by the
// profile (Membro) and a page listing (Anuncio). Continuar remembers the page
// on this device and hands over to the caller.

import { StyleSheet, View } from 'react-native'
import { PAGE_DM_NOTICE, notePageNotice } from '../pageNotice'
import { pageNoticeStore } from '../pageNoticeStore'
import { Sheet } from './Sheet'
import { ConfirmStack, Soft } from './index'
import { space } from './theme'

export function PageNoticeSheet ({ open, page, onClose, onContinue }) {
  const proceed = () => {
    notePageNotice(pageNoticeStore(), page)
    onContinue()
  }
  return (
    <Sheet open={open} onClose={onClose} title='Conversar com a página'>
      <View style={styles.body}>
        <Soft>{PAGE_DM_NOTICE}</Soft>
        <ConfirmStack confirm={{ label: 'Continuar', onPress: proceed }} cancel={{ onPress: onClose }} />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg }
})
