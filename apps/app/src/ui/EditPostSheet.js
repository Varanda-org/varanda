import { useState } from 'react'
import { KeyboardAvoidingView, ScrollView, StyleSheet } from 'react-native'
import { HELP } from '../help'
import { canSaveEdit } from '../postEdit'
import { Btn, ErrorText, Field, Row, Soft, useAction } from './index'
import { HelpButton } from './Help'
import { Sheet } from './Sheet'

export function EditPostSheet ({ target, request, onClose, onEdited, onUncertain }) {
  const [text, setText] = useState(target.text)
  const [uncertain, setUncertain] = useState(false)
  const action = useAction()
  const ready = !uncertain && canSaveEdit(text, target, target.text)
  const close = () => {
    if (!action.pending) onClose()
  }
  const save = async () => {
    if (!ready) return
    const result = await action.run(() => request('post.edit', { to: target.ref, text }))
    if (result.ok) {
      await onEdited({ ref: result.value.ref, text, seq: result.value.seq })
    } else if (result.uncertain) {
      setUncertain(true)
      if (onUncertain) await onUncertain()
    }
  }
  return (
    <Sheet open onClose={close} dismissable={!action.pending} title='Editar publicação' right={<HelpButton doc={HELP.postEdit} />}>
      <KeyboardAvoidingView behavior='padding' style={styles.body}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps='handled'>
          <Field label='Texto' value={text} onChangeText={setText} multiline editable={!action.pending && !uncertain} />
          <Soft>{Array.from(text).length + '/1000'}</Soft>
          <ErrorText>{action.error}</ErrorText>
          <Row><Btn label='Salvar' onPress={save} disabled={!ready} pending={action.pending} /></Row>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  content: { padding: 16, gap: 12 }
})
