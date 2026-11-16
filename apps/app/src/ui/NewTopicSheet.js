// Novo tópico: the title and text of a root post of a public group, and an
// optional poll (2 to 4 options, polls.js editor). The sheet only collects;
// onCreate(text, poll | null) does the one request and answers
// { ok: true } or { ok: false }. A failure keeps the draft and shows the error
// the caller gives; nothing here sends a second time on its own.

import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MAX_TEXT } from '@varanda/rpc'
import { countChars } from '../format'
import {
  NOTICES, editorAddOption, editorCanAdd, editorCanRemove, editorInit, editorPoll, editorRemoveOption, editorSetOption
} from '../polls'
import { Btn, ErrorText, Field, Soft } from './index'
import { Pill } from './Pill'
import { Sheet } from './Sheet'
import { space } from './theme'
import { useStyles } from './ThemeProvider'

export function NewTopicSheet ({ open, onClose, onCreate, pending = false, error = '' }) {
  const styles = useStyles(makeStyles)
  const [text, setText] = useState('')
  const [withPoll, setWithPoll] = useState(false)
  const [poll, setPoll] = useState(editorInit)
  const [note, setNote] = useState('')

  const parsed = withPoll ? editorPoll(poll) : null
  const left = MAX_TEXT - countChars(text)
  const blank = text.trim() === ''
  const cannot = blank || left < 0 || pending

  async function submit () {
    if (cannot) return
    if (parsed !== null && !parsed.ok) { setNote(parsed.error); return }
    setNote('')
    const done = await onCreate(text.trim(), parsed === null ? null : parsed.poll)
    if (done && done.ok) {
      setText('')
      setWithPoll(false)
      setPoll(editorInit())
    }
  }

  return (
    <Sheet open={open} onClose={pending ? undefined : onClose} title='Novo tópico' dismissable={!pending}>
      <View style={styles.body}>
        <Field label='Assunto' value={text} onChangeText={(t) => { setText(t); setNote('') }} multiline lines={4} editable={!pending} placeholder='Primeira linha é o título' />
        {left < 0 ? <ErrorText>{'Passou ' + (-left) + ' caracteres do limite.'}</ErrorText> : null}
        {withPoll
          ? (
            <View style={styles.poll}>
              {poll.options.map((option, i) => (
                <View key={i} style={styles.optionRow}>
                  <View style={styles.optionField}>
                    <Field value={option} onChangeText={(t) => { setPoll((s) => editorSetOption(s, i, t)); setNote('') }} maxLength={60} editable={!pending} placeholder={'Opção ' + (i + 1)} />
                  </View>
                  {editorCanRemove(poll) ? <Pill label='Tirar' onPress={() => setPoll((s) => editorRemoveOption(s, i))} disabled={pending} accessibilityLabel={'tirar a opção ' + (i + 1)} /> : null}
                </View>
              ))}
              <View style={styles.optionRow}>
                {editorCanAdd(poll) ? <Pill label='Mais uma opção' icon='mais' onPress={() => setPoll((s) => editorAddOption(s))} disabled={pending} /> : null}
                <Pill label='Sem enquete' onPress={() => { setWithPoll(false); setNote('') }} disabled={pending} />
              </View>
              <Soft>{NOTICES.publicVote}</Soft>
            </View>
            )
          : <Pill label='Adicionar enquete' icon='lista' onPress={() => setWithPoll(true)} disabled={pending} />}
        {note ? <ErrorText>{note}</ErrorText> : null}
        <ErrorText>{error}</ErrorText>
        <Btn label='Criar tópico' onPress={submit} pending={pending} disabled={cannot} block />
      </View>
    </Sheet>
  )
}

const makeStyles = () => StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  poll: { gap: space.sm },
  optionRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  optionField: { flex: 1, minWidth: 160 }
})
