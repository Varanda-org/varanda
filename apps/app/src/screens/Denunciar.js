// Denunciar: the report sheet. A member reports another member's post, or the
// whole account, to the association's moderation. Only the hosted browser
// node can sign the statement (RPC report.sign is answered by the web session
// only, packages/web-member/lib/session.js; the native/CLI key cannot sign,
// docs/protocol.md:13), and only a member whose Google account is linked may
// report (the account service refuses 'nao-vinculado').
// Flow: /account/status -> /account/report/start (nonce) -> report.sign ->
// /account/report. Nothing is stored: no localStorage, no diary write.
// `target` = { author, name, seq, text } with the RAW peer strings; they are
// rendered through displayText here (the PostRow rule).

import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { accountStatus } from '../account'
import { NOT_LINKED_MESSAGE, REASONS, TEXT_MAX, reportSend, reportStart, validateReportText, wellFormed } from '../report'
import { countChars, handleOf } from '../format'
import { Btn, ErrorText, Field, Label, Soft, errorText, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { colors, type } from '../ui/theme'

const NOT_HOSTED_MESSAGE = 'Nesta versão, denúncias só pela versão web no site da associação.'

export default function Denunciar ({ open, target, onClose, onSent }) {
  const node = useNode()
  const hosted = node.hosted === true && node.passkey !== null
  const member = hosted && node.passkey.status ? node.passkey.status.publicKey : null
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [whole, setWhole] = useState(false)
  const [reason, setReason] = useState(null)
  const [note, setNote] = useState('')
  const send = useAction()
  const seqRef = useRef(0)

  // A new target (or reopening) starts a fresh form and a fresh status read.
  useEffect(() => {
    setWhole(false)
    setReason(null)
    setNote('')
    setStatus(null)
    setStatusError('')
    send.clearError()
    const mine = ++seqRef.current
    if (!open || target === null || !hosted || typeof member !== 'string') return
    accountStatus(member).then((s) => {
      if (mine === seqRef.current) setStatus(s)
    }, (err) => {
      if (mine === seqRef.current) setStatusError(errorText(err))
    })
  }, [open, target, hosted, member])

  const fromPost = target !== null && target.seq !== null && target.seq !== undefined
  const postMode = fromPost && !whole
  // The exact text that is signed and sent (lone surrogates normalized, D5).
  const quote = postMode ? wellFormed(target.text) : ''
  const noteText = validateReportText(wellFormed(note))
  const shownName = target === null
    ? ''
    : displayText(typeof target.name === 'string' && target.name.trim() !== '' ? target.name : handleOf(target.author))

  const submit = async () => {
    if (reason === null || noteText === null || target === null || typeof member !== 'string') return
    // A close, a lock or a new target while this runs makes it stale: a stale
    // run stops before signing and before sending, not only before the toast.
    const mine = seqRef.current
    const r = await send.run(async () => {
      const { nonce } = await reportStart({ member })
      if (mine !== seqRef.current) return null
      // seq omitted (and quote empty) for a report of the whole account.
      const params = { nonce, target: target.author, reason, text: noteText }
      if (postMode) {
        params.seq = target.seq
        params.quote = quote
      }
      const { signature } = await node.request('report.sign', params)
      if (mine !== seqRef.current) return null
      return reportSend({
        member,
        nonce,
        target: target.author,
        seq: postMode ? target.seq : null,
        reason,
        text: noteText,
        quote,
        signature
      })
    })
    if (r.ok && r.value !== null && mine === seqRef.current) onSent(r.value.duplicate ? 'você já tinha denunciado isso' : 'denúncia enviada')
  }

  let body
  if (!hosted) {
    body = <Soft>{NOT_HOSTED_MESSAGE}</Soft>
  } else if (statusError) {
    body = <ErrorText>{statusError}</ErrorText>
  } else if (status === null) {
    body = <Soft>carregando…</Soft>
  } else if (status.linked !== true) {
    body = <Soft>{NOT_LINKED_MESSAGE}</Soft>
  } else {
    body = (
      <>
        <Text style={styles.line}>
          {'Denunciar ' + (postMode ? 'a publicação de ' : 'a conta de ')}
          <Text style={styles.name}>{shownName}</Text>
        </Text>
        {fromPost
          ? (
            <View style={styles.pills}>
              <ChoicePill label='esta publicação' selected={!whole} onPress={() => setWhole(false)} />
              <ChoicePill label='a conta toda' selected={whole} onPress={() => setWhole(true)} />
            </View>
            )
          : null}
        {postMode
          ? (
            <View style={styles.quoteBox}>
              <Label>Texto que será enviado</Label>
              <Text style={styles.quote}>{displayText(quote, { multiline: true })}</Text>
            </View>
            )
          : null}
        <View style={styles.pills}>
          {REASONS.map(([id, label]) => (
            <ChoicePill key={id} label={label} selected={reason === id} onPress={() => setReason(id)} />
          ))}
        </View>
        {/* maxLength counts UTF-16 units and the limit is in characters
            (code points), so the input only caps at two units per character;
            the counter and validateReportText enforce TEXT_MAX. */}
        <Field label='observação (opcional)' value={note} onChangeText={setNote} maxLength={TEXT_MAX * 2} />
        <Text style={[styles.counter, noteText === null && styles.over]}>{String(countChars(note)) + '/' + String(TEXT_MAX)}</Text>
        <Soft>A denúncia vai para a moderação da associação. A pessoa denunciada não vê quem denunciou.</Soft>
        <Soft>Se a moderação bloquear, a conta inteira deixa de aparecer para quem usa o app oficial.</Soft>
        <ErrorText>{send.error}</ErrorText>
        <Btn
          label='enviar denúncia'
          onPress={submit}
          pending={send.pending}
          disabled={reason === null || noteText === null}
        />
      </>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title='Denunciar'>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps='handled'>
        {body}
      </ScrollView>
    </Sheet>
  )
}

// A Pill whose wrapper carries the selection state (Pill sets only
// `disabled` in its own accessibilityState).
function ChoicePill ({ label, selected, onPress }) {
  return (
    <View accessibilityState={{ selected }}>
      <Pill label={label} filled={selected} onPress={onPress} />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 12 },
  line: { ...type.postText, color: colors.ink },
  name: { fontWeight: '700' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quoteBox: { gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
  quote: { ...type.postText, color: colors.ink },
  counter: { ...type.counter, color: colors.soft, alignSelf: 'flex-end' },
  over: { color: colors.danger }
})
