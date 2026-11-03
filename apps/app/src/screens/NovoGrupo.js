// Novo grupo: the sheet that creates a group inside a community (group.create,
// docs/rpc.md 5.36) and hands the new group to the caller.
// Props: community (hex64 root key), visible, onClose(), onCreated(group)
// where group is the hex64 root key (null when the check found it already
// made). A create that comes back uncertain is never resent: the sheet asks
// the person to check ("conferir") before trying again: group.create always
// makes a new root, so a resend could leave two groups. Only that check or
// closing the sheet lifts the lock.

import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { reconcile } from '../groups'
import { Btn, ErrorText, Field, Label, Soft, UNCERTAIN, colors, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { useNode } from '../node'
import { type } from '../ui/theme'

// MAX_GROUP_NAME (rpc 5.36, also the community name limit) counts code points.
export const NAME_MAX = rpc.MAX_GROUP_NAME

export function nameLength (text) {
  return Array.from(text).length
}

// App's web Escape handler pops the stack unless the event was handled:
// while a sheet is open, capture Escape first so it only closes the sheet.
export function useEscapeClose (visible, onClose) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (typeof closeRef.current === 'function') closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])
}

export function Choice ({ label, options, value, onChange, disabled }) {
  return (
    <View style={styles.choice}>
      <Label>{label}</Label>
      <View style={styles.pills} accessibilityRole='radiogroup' accessibilityLabel={label}>
        {options.map((o) => (
          <Pill
            key={o.value}
            label={o.label}
            filled={value === o.value}
            disabled={disabled}
            accessibilityLabel={o.label + (value === o.value ? ', escolhido' : '')}
            onPress={() => onChange(o.value)}
          />
        ))}
      </View>
    </View>
  )
}

// What the community says about its groups, for the reconcile of an
// uncertain create (community.info lists each group by name and role).
async function communityView (request, community) {
  const info = await request('community.info', { community })
  return { community: info && info.community, groups: info && info.groups, incomplete: !!info && info.incomplete === true }
}

export function NovoGrupo ({ community, visible, onClose, onCreated }) {
  const node = useNode()
  const [name, setName] = useState('')
  const [join, setJoin] = useState('open')
  const [visibility, setVisibility] = useState('public')
  // After an uncertain create: { name }, the name that was sent.
  const [uncertain, setUncertain] = useState(null)
  const [checkNote, setCheckNote] = useState('')
  const action = useAction()
  const check = useAction()
  const clearRef = useRef(action.clearError)
  clearRef.current = action.clearError

  // A fresh form every time the sheet opens.
  useEffect(() => {
    if (!visible) return
    setName('')
    setJoin('open')
    setVisibility('public')
    setUncertain(null)
    setCheckNote('')
    clearRef.current()
  }, [visible])

  useEscapeClose(visible, onClose)

  const priv = visibility === 'private'
  const trimmed = name.trim()
  const tooLong = nameLength(trimmed) > NAME_MAX
  const offline = node.online === false
  const ready = trimmed.length > 0 && !tooLong && !offline && uncertain === null && typeof community === 'string'

  const create = async () => {
    if (!ready) return
    setCheckNote('')
    const res = await action.run(() => node.request('group.create', {
      name: trimmed,
      join: priv ? 'approval' : join,
      visibility,
      community
    }))
    if (res.ok && res.value && typeof res.value.group === 'string') {
      if (typeof onCreated === 'function') onCreated(res.value.group)
      return
    }
    if (res.uncertain) setUncertain({ name: trimmed })
  }

  // A private group's name can read null (locked), so only a group with the
  // sent name and the caller as creator counts as the new one.
  const confirm = async () => {
    if (uncertain === null) return
    const res = await check.run(() => communityView(node.request, community))
    if (!res.ok) return
    const verdict = reconcile({ action: 'create', community, name: uncertain.name }, res.value)
    if (verdict === 'landed') {
      if (typeof onCreated === 'function') onCreated(null)
      return
    }
    if (verdict === 'unknown') {
      setCheckNote('Não dá para conferir agora. Espere um pouco e confira a lista de grupos da comunidade antes de tentar de novo.')
      return
    }
    setUncertain(null)
    setCheckNote('O grupo não foi criado. Você pode tentar de novo.')
  }

  return (
    <Sheet open={!!visible} onClose={onClose} title='Novo grupo'>
      <View style={styles.body}>
        <Field
          label='Nome'
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX * 2}
          placeholder='Nome do grupo'
        />
        {tooLong ? <ErrorText>{'O nome pode ter até ' + NAME_MAX + ' caracteres.'}</ErrorText> : null}
        <Choice
          label='Visibilidade'
          value={visibility}
          onChange={setVisibility}
          options={[{ value: 'public', label: 'Pública' }, { value: 'private', label: 'Privada' }]}
        />
        {priv
          ? <Soft>As mensagens de um grupo privado são cifradas de ponta a ponta: só os membros leem. Ele não aparece na busca e sempre pede aprovação para entrar.</Soft>
          : <Soft>Qualquer pessoa pode encontrar um grupo público na busca e ler as mensagens.</Soft>}
        <Choice
          label='Entrada'
          value={priv ? 'approval' : join}
          onChange={setJoin}
          disabled={priv}
          options={[{ value: 'open', label: 'Aberta' }, { value: 'approval', label: 'Com aprovação' }]}
        />
        {offline ? <Text style={styles.note}>Sem internet: conecte-se para criar o grupo.</Text> : null}
        {uncertain !== null
          ? (
            <View style={styles.check}>
              <ErrorText>{UNCERTAIN + '. Confira se o grupo já foi criado antes de tentar de novo.'}</ErrorText>
              <ErrorText>{check.error}</ErrorText>
              <Btn label='Conferir' onPress={confirm} pending={check.pending} secondary />
            </View>
            )
          : <ErrorText>{action.error}</ErrorText>}
        {checkNote ? <Soft>{checkNote}</Soft> : null}
        <Btn label='Criar grupo' onPress={create} disabled={!ready} pending={action.pending} />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  choice: { gap: 6 },
  check: { gap: 8 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { ...type.postMeta, color: colors.dim }
})
