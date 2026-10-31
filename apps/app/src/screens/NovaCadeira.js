// Nova cadeira: the sheet that creates a group (group.create, docs/rpc.md
// 5.36) and hands the new group to the caller.
// Props: visible, onClose(), onCreated(group) where group is the hex64 root
// key. A create that comes back uncertain is never resent: the sheet asks the
// person to check ("conferir") before trying again: group.create always makes
// a new root, so a resend could leave two groups. Only that check or closing
// the sheet lifts the lock.

import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
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

function Choice ({ label, options, value, onChange, disabled }) {
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

// Every group the caller created, read page by page from the local list.
async function createdGroups (request) {
  const out = []
  for (let offset = 0; ; offset += rpc.GROUP_LIMIT_MAX) {
    const res = await request('group.list', { offset, limit: rpc.GROUP_LIMIT_MAX })
    const page = Array.isArray(res && res.groups) ? res.groups : []
    for (const g of page) if (g && g.role === 'creator') out.push(g)
    const total = Number.isSafeInteger(res && res.total) ? res.total : 0
    if (page.length === 0 || offset + page.length >= total) return out
  }
}

export function NovaCadeira ({ visible, onClose, onCreated }) {
  const node = useNode()
  const [name, setName] = useState('')
  const [join, setJoin] = useState('open')
  const [visibility, setVisibility] = useState('public')
  // After an uncertain create: { before }, the set of groups the caller had
  // created already (null if that read failed).
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
  const ready = trimmed.length > 0 && !tooLong && !offline && uncertain === null

  const create = async () => {
    if (!ready) return
    let before = null
    try {
      before = new Set((await createdGroups(node.request)).map((g) => g.group))
    } catch {}
    setCheckNote('')
    const res = await action.run(() => node.request('group.create', {
      name: trimmed,
      join: priv ? 'approval' : join,
      visibility
    }))
    if (res.ok && res.value && typeof res.value.group === 'string') {
      if (typeof onCreated === 'function') onCreated(res.value.group)
      return
    }
    if (res.uncertain) setUncertain({ before })
  }

  // Names are not compared: a private group's name can read null (locked).
  // A creator group that was not there before the create is the new one.
  const confirm = async () => {
    if (uncertain === null) return
    if (uncertain.before === null) {
      setCheckNote('Não dá para conferir daqui. Confira em Minhas cadeiras antes de tentar de novo.')
      return
    }
    const res = await check.run(() => createdGroups(node.request))
    if (!res.ok) return
    const fresh = res.value.filter((g) => typeof g.group === 'string' && !uncertain.before.has(g.group))
    if (fresh.length > 0) {
      if (typeof onCreated === 'function') onCreated(fresh[fresh.length - 1].group)
      return
    }
    setUncertain(null)
    setCheckNote('A cadeira não foi criada. Você pode tentar de novo.')
  }

  return (
    <Sheet open={!!visible} onClose={onClose} title='Nova cadeira'>
      <View style={styles.body}>
        <Field
          label='Nome'
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX * 2}
          placeholder='Nome da cadeira'
        />
        {tooLong ? <ErrorText>{'O nome pode ter até ' + NAME_MAX + ' caracteres.'}</ErrorText> : null}
        <Choice
          label='Visibilidade'
          value={visibility}
          onChange={setVisibility}
          options={[{ value: 'public', label: 'Pública' }, { value: 'private', label: 'Privada' }]}
        />
        {priv
          ? <Soft>As mensagens de uma cadeira privada são cifradas de ponta a ponta: só os membros leem. Ela não aparece na busca e sempre pede aprovação para entrar.</Soft>
          : <Soft>Qualquer pessoa pode encontrar uma cadeira pública na busca e ler as mensagens.</Soft>}
        <Choice
          label='Entrada'
          value={priv ? 'approval' : join}
          onChange={setJoin}
          disabled={priv}
          options={[{ value: 'open', label: 'Aberta' }, { value: 'approval', label: 'Com aprovação' }]}
        />
        {offline ? <Text style={styles.note}>Sem internet: conecte-se para criar a cadeira.</Text> : null}
        {uncertain !== null
          ? (
            <View style={styles.check}>
              <ErrorText>{UNCERTAIN + '. Confira se a cadeira já foi criada antes de tentar de novo.'}</ErrorText>
              <ErrorText>{check.error}</ErrorText>
              <Btn label='Conferir' onPress={confirm} pending={check.pending} secondary />
            </View>
            )
          : <ErrorText>{action.error}</ErrorText>}
        {checkNote ? <Soft>{checkNote}</Soft> : null}
        <Btn label='Criar cadeira' onPress={create} disabled={!ready} pending={action.pending} />
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
