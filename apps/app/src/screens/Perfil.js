// Perfil: the "Editar perfil" sheet and, with `page`, the onboarding step
// 'Como você quer aparecer' (no Sheet: a Stepper with the same form, 'Continuar'
// and 'Pular por enquanto'). Name (1..80 code points, not only whitespace) and
// bio (0..280 code points), published with profile.set. The draft lives here,
// outside the Sheet (its Modal unmounts the children when closed).
//
// An uncertain save is never resent: the own profile is re-read with
// profile.read (the whole log, verified name/bio) and only an equal result
// counts as saved; otherwise the draft stays for the person to decide.

import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text } from 'react-native'
import { MAX_BIO, MAX_NAME } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { ErrorText, Field, Page, Soft, colors, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { Stepper } from '../ui/Stepper'

// The own profile as the node shows it (profile.read, docs/rpc.md 5.21), or
// null when the node lists the own key as missing or does not know the method.
async function readOwnProfile (node, ownKey) {
  const key = typeof ownKey === 'string' ? ownKey : (await node.request('node.info', {})).publicKey
  if (typeof key !== 'string') return null
  const res = await node.request('profile.read', { authors: [key] })
  const lower = key.toLowerCase()
  for (const p of (res && res.profiles) || []) {
    if (p && typeof p.author === 'string' && p.author.toLowerCase() === lower) return p
  }
  return null
}

export default function Perfil ({ open, current, onClose, onSaved, ownKey, page = false, index, total, onSkip }) {
  const node = useNode()
  const action = useAction()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  // An uncertain save is being checked against the diary.
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)
  const currentRef = useRef(current)
  currentRef.current = current
  // The page is always shown; the sheet only while open.
  const shown = page || open

  // The form starts from `current` each time the sheet opens; a reload
  // while it is open never overwrites the draft.
  useEffect(() => {
    if (!shown) return
    const c = currentRef.current || {}
    setName(c.name || '')
    setBio(c.bio || '')
    action.clearError()
  }, [shown])

  const nameLen = countChars(name)
  const bioLen = countChars(bio)
  const valid = nameLen >= 1 && nameLen <= MAX_NAME && name.trim() !== '' && bioLen <= MAX_BIO
  // While a save or its uncertain re-read runs, the fields are locked: a
  // success closes the sheet and the next open restarts from the saved profile.
  const saving = action.pending || checking

  const save = async () => {
    if (!valid || checkingRef.current) return
    const sent = { name, bio }
    const r = await action.run(() => node.request('profile.set', sent))
    if (r.ok) {
      onSaved(sent)
      return
    }
    if (!r.uncertain) return
    // The request may have been applied: read the own profile before letting
    // the person try again (a mutation is never resent).
    checkingRef.current = true
    setChecking(true)
    try {
      const mine = await readOwnProfile(node, ownKey)
      if (mine && mine.name === sent.name && (mine.bio || '') === sent.bio) onSaved(sent)
    } catch {
      // Keep the draft and the uncertain message.
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const fields = (
    <>
      <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={setName} editable={!saving} />
      <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={setBio} editable={!saving} multiline lines={3} />
      <ErrorText>{action.error}</ErrorText>
    </>
  )

  if (page) {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page flush padBottom={16}>
          <Stepper index={index} total={total} title={STEP_TITLES.perfil} hint={STEP_HINTS.perfil}>
            {fields}
            <Pill label='Continuar' filled onPress={save} pending={saving} disabled={!valid} />
            <Pressable
              accessibilityRole='button'
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              onPress={onSkip}
              hitSlop={4}
              style={styles.skip}
            >
              <Text style={styles.skipText}>Pular por enquanto</Text>
            </Pressable>
          </Stepper>
        </Page>
      </KeyboardAvoidingView>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title='Editar perfil'
      background={colors.bg}
      right={<Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid} />}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page>
          {fields}
          <Soft>O perfil novo vale a partir do momento em que é publicado. É preciso ter o certificado de membro gravado.</Soft>
        </Page>
      </KeyboardAvoidingView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  skip: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 4, minHeight: 44, justifyContent: 'center' },
  skipText: { fontSize: 15, fontWeight: '600', color: colors.accent }
})
