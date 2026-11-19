// Excluir conta sem a passkey (Ajustes 'excluirSms', opened from the Entrar
// step): the @nome and the number the member verified, then the code texted
// to that number. A correct code only files a request: the screen then says
// that nothing happens until the owner writes to the team. The service
// answers the send the same way whether or not the pair matches, so this
// screen always moves to the code step and never says which. Every request
// is sent once per press; an uncertain check is never sent again (its text
// asks the person to write in anyway). The code field asks for no SMS
// autofill, like Telefone.js.

import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { accountStatus, deleteSmsCheck, deleteSmsSend, lookupUsername } from '../account'
import { SMS_TEXTS, confirmSmsCode, requestSmsCode, resendLabel, resendWait, smsAlreadyText, smsCodeOk, smsErrorText, smsName, smsPhone } from '../accountDeletion'
import { Body, Btn, ErrorText, Field, Page, Soft, useNow } from '../ui'
import { useStyles } from '../ui/ThemeProvider'
import { KeyboardForm } from './Perfil'

const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false, autoCapitalize: 'none', spellCheck: false, importantForAutofill: 'no', textContentType: 'none' }

const makeStyles = () => StyleSheet.create({
  gap: { gap: 12 }
})

// Field spreads inputProps last, so NO_AUTOFILL overrides its defaults.
function Input ({ label, value, onChangeText, keyboardType, maxLength, editable }) {
  return (
    <Field
      label={label}
      value={value}
      onChangeText={onChangeText}
      keyboardType={keyboardType}
      maxLength={maxLength}
      editable={editable}
      inputProps={NO_AUTOFILL}
    />
  )
}

// onDone: closes the sheet (the screen is opened from Entrar).
export default function ExcluirSemPasskey ({ active = true, offline = false, onDone }) {
  const styles = useStyles(makeStyles)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  // 'pedir' (the pair), 'codigo' (the code), 'feito' (the request filed, or
  // the date of a deletion already waiting).
  const [step, setStep] = useState('pedir')
  const [sentAt, setSentAt] = useState(null)
  const [scheduled, setScheduled] = useState(null)
  // The date was already on file before this screen asked anything.
  const [already, setAlready] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(1000)
  const wait = step === 'codigo' ? resendWait(sentAt, now) : 0
  const locked = pending || offline || !active

  const run = async (fn) => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(smsErrorText(err))
    } finally {
      setPending(false)
    }
  }

  const send = () => run(async () => {
    const out = await requestSmsCode({ username: name, phone, send: deleteSmsSend, lookup: (username) => lookupUsername(username), status: (member) => accountStatus(member) })
    if (out.scheduled) {
      setScheduled(out.scheduled)
      setAlready(true)
      setStep('feito')
      return
    }
    setSentAt(Date.now())
    setCode('')
    setStep('codigo')
  })

  const confirm = () => run(async () => {
    await confirmSmsCode({ username: name, phone, code, check: deleteSmsCheck })
    setScheduled(null)
    setAlready(false)
    setStep('feito')
  })

  const back = () => {
    setError('')
    setCode('')
    setStep('pedir')
  }

  if (step === 'feito') {
    return (
      <Page>
        <View style={styles.gap}>
          <Body>{already ? smsAlreadyText(scheduled) : SMS_TEXTS.requested}</Body>
          {already ? <Soft>{SMS_TEXTS.after}</Soft> : null}
          {typeof onDone === 'function' ? <Btn label='Fechar' secondary onPress={onDone} block /> : null}
        </View>
      </Page>
    )
  }

  return (
    <KeyboardForm>
      <Page>
        <View style={styles.gap}>
          {step === 'pedir'
            ? (
              <>
                <Body>{SMS_TEXTS.intro}</Body>
                <Input label={SMS_TEXTS.nameLabel} value={name} onChangeText={setName} maxLength={21} editable={!locked} />
                <Input label={SMS_TEXTS.phoneLabel} value={phone} onChangeText={setPhone} keyboardType='phone-pad' maxLength={20} editable={!locked} />
                <Btn label={SMS_TEXTS.send} onPress={send} pending={pending} disabled={locked || smsName(name) === null || smsPhone(phone) === null} block large />
              </>
              )
            : (
              <>
                <Body>{SMS_TEXTS.codeIntro}</Body>
                <Input label={SMS_TEXTS.codeLabel} value={code} onChangeText={setCode} keyboardType='number-pad' maxLength={12} editable={!locked} />
                <Btn label={SMS_TEXTS.confirm} onPress={confirm} pending={pending} disabled={locked || smsCodeOk(code) === null} danger block large />
                <Btn label={resendLabel(wait)} secondary onPress={send} disabled={locked || wait > 0} block />
                <Btn label='Corrigir o @nome ou o número' secondary onPress={back} disabled={pending} block />
              </>
              )}
          <ErrorText>{error}</ErrorText>
          <Soft>{SMS_TEXTS.help}</Soft>
        </View>
      </Page>
    </KeyboardForm>
  )
}
