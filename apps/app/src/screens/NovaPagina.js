// Nova página: @nome, name and bio, then one signed 'create' (pages.js: the
// service mints the page key, page.sign signs the genesis roster, the
// service countersigns and writes the profile). The @nome follows the
// account rules (isUsername) and is looked up first, so a taken one never
// reaches the signature. A create answered UNCERTAIN is never resent: the
// person is sent to Páginas to check whether the page exists.
//
// Props: { onBack, onCreated(pageKey) }. Gated on pagesOn; a core node acts
// through its delegate (usePageMember: page.register and the Terms first).

import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MAX_BIO, MAX_NAME } from '@varanda/rpc'
import { useNode } from '../node'
import { isUsername, lookupUsername } from '../account'
import { countChars } from '../format'
import { actAs, pagesOrigin, TEXTS } from '../pages'
import { pagesOn } from '../pageGate'
import { ActorKey, usePageMember } from './Paginas'
import { Btn, ErrorText, Field, Page, Soft, useAction } from '../ui'
import { refusalOf } from '../wordCheck'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { useStyles } from '../ui/ThemeProvider'

const NAME_RULE = '@nome inválido: de 3 a 20 letras minúsculas, números ou _, começando por letra'
const SOON = 'Disponível em breve.'
const LOCKED = 'Desbloqueie a conta para criar uma página.'
const LOOKUP_FAILED = 'Não foi possível conferir o @nome agora. Tente de novo.'

export default function NovaPagina ({ onBack, onCreated }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const who = usePageMember(node)
  const member = who.member
  const retryMember = who.retry
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [uncertain, setUncertain] = useState(null) // the error of an uncertain create: retry() resends the same signed bytes
  const action = useAction()
  const lastError = useRef(null)

  const nameLen = countChars(name)
  const bioLen = countChars(bio)
  const username = isUsername(handle)
  const refused = refusalOf(username, name, bio)
  const valid = username !== null && nameLen >= 1 && nameLen <= MAX_NAME && name.trim() !== '' && bioLen <= MAX_BIO && refused === ''

  const submit = async () => {
    if (!valid || member === null) return
    if (uncertain !== null) return
    lastError.current = null
    const r = await action.run(async () => {
      let found
      try {
        found = await lookupUsername(username, { origin: pagesOrigin(node) })
      } catch {
        throw new Error(LOOKUP_FAILED)
      }
      if (found) throw new Error(TEXTS['nome-em-uso'])
      const at = new Date().toISOString()
      try {
        return await actAs(node, {
          member,
          action: 'create',
          page: '',
          op: ({ nonce }) => ({ username, name, bio, roster: { gen: 1, admins: [], prev: null, at, nonce } })
        })
      } catch (err) {
        lastError.current = err
        throw err
      }
    })
    if (r.ok) {
      if (typeof r.value.page === 'string' && typeof onCreated === 'function') onCreated(r.value.page)
      else if (typeof onBack === 'function') onBack()
      return
    }
    if (r.uncertain) setUncertain(lastError.current || {})
  }

  // Same signed bytes, same key: never a second create.
  const retry = async () => {
    const err = uncertain
    if (!err || typeof err.retry !== 'function') return
    lastError.current = null
    const r = await action.run(async () => {
      try {
        return await err.retry()
      } catch (e) {
        lastError.current = e
        throw e
      }
    })
    if (r.ok) {
      if (typeof r.value.page === 'string' && typeof onCreated === 'function') onCreated(r.value.page)
      else if (typeof onBack === 'function') onBack()
      return
    }
    if (r.uncertain) setUncertain(lastError.current || err)
  }

  let body
  if (!pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })) body = <Soft>{SOON}</Soft>
  else if (who.core && member === null) {
    body = who.error
      ? <><ErrorText>{who.error}</ErrorText><Pill label='Tentar de novo' onPress={retryMember} /></>
      : <Soft>Preparando a sua conta nas páginas…</Soft>
  } else if (member === null) body = <Soft>{LOCKED}</Soft>
  else {
    body = (
      <>
        <Field label='@nome da página' value={handle} onChangeText={setHandle} editable={!action.pending && uncertain === null} placeholder='@minhapagina' />
        {handle.trim() !== '' && username === null ? <ErrorText>{NAME_RULE}</ErrorText> : null}
        <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={setName} editable={!action.pending && uncertain === null} />
        <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={setBio} editable={!action.pending && uncertain === null} multiline lines={3} />
        {who.core ? <ActorKey actor={who.actor} /> : null}
        <Soft>O @nome, o nome e a bio de uma página são públicos. Quem cria a página é a dona ou o dono e pode convidar administradores depois.</Soft>
        <ErrorText>{refused}</ErrorText>
        <ErrorText>{action.error}</ErrorText>
        <Btn label='Criar página' onPress={submit} disabled={!valid || uncertain !== null} pending={action.pending} />
        {uncertain !== null
          ? (
            <View style={styles.check}>
              <Soft>Confira em Páginas se ela foi criada antes de tentar de novo.</Soft>
              {typeof uncertain.retry === 'function' ? <Pill label='Tentar de novo' onPress={retry} disabled={action.pending} pending={action.pending} /> : null}
              <Pill label='Ver minhas páginas' onPress={onBack} disabled={action.pending} />
            </View>
            )
          : null}
      </>
    )
  }

  return (
    <View style={styles.flex}>
      <TopBar title='Nova página' onBack={onBack} />
      <Page>{body}</Page>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  check: { gap: 8 }
})
