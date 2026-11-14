// The confirmation before blocking someone, opened by useBlocks().ask({ author,
// name, username }) from a post menu or a profile. It says plainly what a block
// can and cannot do. The name is raw peer text, so it goes through displayText.

import { StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useBlockAsk, useBlocks } from '../blocksProvider'
import { BLOCK_TEXTS, confirmTitle } from '../memberBlocks'
import { whoOf } from '../who'
import { Btn, ConfirmStack, ErrorText, Soft, useAction } from './index'
import { Sheet } from './Sheet'
import { space } from './theme'

export function BlockSheet ({ onToast }) {
  const blocks = useBlocks()
  const { asking, close } = useBlockAsk()
  const act = useAction()
  const named = asking !== null && (asking.name || asking.username)
  const name = named ? displayText(whoOf({ name: asking.name, username: asking.username }).title) : null
  const dismiss = () => {
    if (act.pending) return
    act.clearError()
    close()
  }
  const confirm = async () => {
    const r = await act.run(() => blocks.setBlock(asking.author, true))
    if (!r.ok) return
    close()
    onToast(BLOCK_TEXTS.done)
  }
  return (
    <Sheet open={asking !== null} onClose={dismiss} title={confirmTitle(name)}>
      <View style={styles.body}>
        <Soft>{BLOCK_TEXTS.confirmNote}</Soft>
        <ErrorText>{act.error}</ErrorText>
        <ConfirmStack
          confirm={<Btn label={BLOCK_TEXTS.block} danger onPress={confirm} pending={act.pending} />}
          cancel={<Btn label={BLOCK_TEXTS.cancel} secondary onPress={dismiss} disabled={act.pending} />}
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg }
})
