/* global navigator */

// Ajustes: the cog area, a sheet with a grouped list over sub-screens that
// render embedded inside the sheet. The main list is for people: Editar
// perfil, Conta e @nome, Guardar dados neste aparelho, Instalar o app and,
// apart, Sair. Everything technical sits behind a collapsed 'Avançado' row:
// Conexão, Sincronização (state, log and the old top-bar chip text),
// Identidade técnica (public key behind a reveal, association, certificate)
// and Recomeçar. Rows that only exist on the browser node (passkey) hide when
// `node.passkey === null`. Sair drops the key derived from the passkey from
// memory (signOut, or lock on a provider without it) and the shell returns to
// Entrar. Instalar o app shows an 'Instalar' button that opens the browser's
// install dialog whenever the browser offers installation, above the text that
// stays as the fallback.

import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { useNames } from '../names'
import { useOutbox } from '../outboxProvider'
import { askPersist } from '../persist'
import { useInstall } from '../install'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { colors, type } from '../ui/theme'
import { Btn, ErrorText, Notice, Page, Row, Soft, useAction } from '../ui'
import Conexao from './Conexao'
import Identidade from './Identidade'
import Perfil from './Perfil'
import Sincronizar from './Sincronizar'

const TITLES = {
  lista: 'Ajustes',
  perfil: 'Editar perfil',
  conta: 'Conta e @nome',
  instalar: 'Instalar o app',
  conexao: 'Conexão',
  sincronizar: 'Sincronização',
  identidade: 'Identidade técnica'
}

const INSTALL_TEXT = 'Abra o menu do navegador e escolha instalar o app (no iPhone: Compartilhar e depois Adicionar à Tela de Início). Depois de instalado, ele abre mesmo sem internet e mostra o que já está neste aparelho. Apagar os dados do site apaga o que está guardado aqui. Outra aba deste navegador fica bloqueada enquanto esta estiver aberta.'
const SIGN_OUT_TEXT = 'Sair desta conta neste aparelho? Para voltar, use sua passkey.'
const RESET_TEXT = 'Isto apaga a conta guardada neste aparelho e as publicações que ainda aguardam envio. A conta antiga não pode ser reconstruída: será preciso entrar de novo e vincular outra vez. Para voltar à mesma conta, use a mesma passkey.'

function Item ({ icon, label, onPress, first = false, trailing = 'seta', pending = false, disabled = false }) {
  return (
    <Pressable
      style={[styles.row, !first && styles.rowDivider]}
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || pending }}
      disabled={disabled || pending}
      onPress={onPress}
    >
      <Icon name={icon} size={22} color={colors.soft} />
      <Text style={styles.label}>{pending ? label + '…' : label}</Text>
      {trailing ? <Icon name={trailing} size={20} color={colors.soft} /> : null}
    </Pressable>
  )
}

export default function Ajustes ({ screen, onNavigate, onClose, onInfo }) {
  const node = useNode()
  const names = useNames()
  const outbox = useOutbox()
  // The embedded screens reload when the node becomes ready again.
  const ready = node.phase === 'ready'
  const passkey = node.passkey
  const hasPasskey = passkey !== null && passkey !== undefined
  const unlocked = hasPasskey && passkey.status !== null && passkey.status.unlocked === true
  const install = useInstall()

  const [advanced, setAdvanced] = useState(false)
  const [confirm, setConfirm] = useState(null) // null | 'sair' | 'recomecar'
  const exit = useAction()
  const reset = useAction()
  // Result of asking the browser to keep this origin's data (null: not asked yet).
  const [persisted, setPersisted] = useState(null)
  const [persistPending, setPersistPending] = useState(false)
  // The own key and profile for the editor (read when it opens).
  const [own, setOwn] = useState({ key: null })
  const [saved, setSaved] = useState('')

  // A closed sheet forgets the open confirmations.
  useEffect(() => {
    if (screen === null) {
      setConfirm(null)
      setSaved('')
    }
  }, [screen])

  useEffect(() => {
    if (screen !== 'perfil' || !ready) return
    let alive = true
    node.request('node.info', {}).then((i) => {
      if (alive && typeof i.publicKey === 'string') {
        setOwn({ key: i.publicKey })
        names.resolve(i.publicKey)
      }
    }, () => {})
    return () => { alive = false }
  }, [screen, ready, node.request])

  const doExit = async () => {
    const out = typeof passkey.signOut === 'function' ? passkey.signOut : passkey.lock
    const r = await exit.run(() => out())
    if (r.ok) {
      setConfirm(null)
      onClose()
    }
  }

  const doReset = async () => {
    const oldKey = passkey.status ? passkey.status.publicKey : null
    if (typeof oldKey === 'string' && !outbox.forgetAuthor(oldKey)) {
      return reset.run(() => { throw new Error('não foi possível apagar as publicações que aguardam envio neste aparelho') })
    }
    const r = await reset.run(() => passkey.reset())
    if (r.ok) {
      setConfirm(null)
      onClose()
    }
  }

  const doPersist = async () => {
    setPersistPending(true)
    try {
      setPersisted(await askPersist(typeof navigator === 'object' && navigator !== null ? navigator.storage : null))
    } finally {
      setPersistPending(false)
    }
  }

  const left = screen === 'lista'
    ? (
      <Pressable accessibilityRole='button' accessibilityLabel='Fechar' onPress={onClose} hitSlop={8}>
        <Text style={styles.cancel}>Fechar</Text>
      </Pressable>
      )
    : (
      <Pressable
        style={styles.back}
        accessibilityRole='button'
        accessibilityLabel='voltar para Ajustes'
        onPress={() => onNavigate('lista')}
        hitSlop={8}
      >
        <Icon name='voltar' size={22} color={colors.ink} />
        <Text style={styles.cancel}>Ajustes</Text>
      </Pressable>
      )

  const profile = own.key ? names.profileOf(own.key) : undefined
  const current = { name: (profile && profile.name) || '', bio: (profile && profile.bio) || '' }
  const account = node.hosted === true && hasPasskey

  // While the sheet is open every sub-screen stays mounted (drafts typed in
  // Conexão or Identidade survive going back to the list); the inactive ones
  // are hidden. Closing the whole sheet discards them.
  const shown = (id) => (screen === id ? styles.flex : styles.hidden)
  const body = screen === null
    ? null
    : (
      <>
        <View style={shown('lista')}>
          <Page>
            <Notice>{saved}</Notice>
            <View style={styles.group}>
              <Item first icon='user' label='Editar perfil' onPress={() => { setSaved(''); onNavigate('perfil') }} />
              {account ? <Item icon='at-sign' label='Conta e @nome' onPress={() => onNavigate('conta')} /> : null}
              {hasPasskey
                ? <Item icon='download' label='Guardar dados neste aparelho' trailing={null} pending={persistPending} onPress={doPersist} />
                : null}
              {hasPasskey ? <Item icon='smartphone' label='Instalar o app' onPress={() => onNavigate('instalar')} /> : null}
            </View>
            {persisted === null
              ? null
              : <Soft>{persisted ? 'Pronto: seus dados ficam guardados neste aparelho.' : 'O navegador não garantiu guardar seus dados: ele pode apagá-los se faltar espaço.'}</Soft>}
            {unlocked
              ? (
                <>
                  <View style={styles.group}>
                    <Item first icon='log-out' label='Sair' trailing={null} onPress={() => { exit.clearError(); setConfirm(confirm === 'sair' ? null : 'sair') }} />
                  </View>
                  {confirm === 'sair'
                    ? (
                      <View style={styles.confirm}>
                        <Soft>{SIGN_OUT_TEXT}</Soft>
                        <Row>
                          <Btn label='Sair' danger onPress={doExit} pending={exit.pending} />
                          <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={exit.pending} />
                        </Row>
                      </View>
                      )
                    : null}
                  <ErrorText>{exit.error}</ErrorText>
                </>
                )
              : null}

            <View style={styles.group}>
              <Item
                first
                icon='sliders'
                label='Avançado'
                trailing={advanced ? 'chevron-up' : 'chevron-down'}
                onPress={() => setAdvanced((v) => !v)}
              />
              {advanced
                ? (
                  <>
                    <Item icon='wifi' label='Conexão' onPress={() => onNavigate('conexao')} />
                    <Item icon='refresh-cw' label='Sincronização' onPress={() => onNavigate('sincronizar')} />
                    <Item icon='key' label='Identidade técnica' onPress={() => onNavigate('identidade')} />
                    {hasPasskey
                      ? <Item icon='rotate-ccw' label='Recomeçar' trailing={null} onPress={() => { reset.clearError(); setConfirm(confirm === 'recomecar' ? null : 'recomecar') }} />
                      : null}
                  </>
                  )
                : null}
            </View>
            {advanced && confirm === 'recomecar'
              ? (
                <View style={styles.confirm}>
                  <Soft>{RESET_TEXT}</Soft>
                  <Row>
                    <Btn label='Apagar e recomeçar' danger onPress={doReset} pending={reset.pending} />
                    <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={reset.pending} />
                  </Row>
                  <ErrorText>{reset.error}</ErrorText>
                </View>
                )
              : null}
          </Page>
        </View>
        <View style={shown('perfil')}>
          {/* Mounted only once the own profile is known: the form starts from
              `current` and never sees a later update, so an early mount would
              show (and save) empty fields over an existing profile. */}
          {own.key && profile !== undefined
            ? (
              <Perfil
                embedded
                open={screen === 'perfil'}
                ownKey={own.key}
                current={current}
                onClose={() => onNavigate('lista')}
                onSaved={(values) => {
                  names.learn(own.key, { name: values.name, bio: values.bio })
                  // The authoritative answer also replaces a cleared bio.
                  names.invalidate([own.key])
                  setSaved('Perfil salvo.')
                  onNavigate('lista')
                }}
              />
              )
            : <Page><Soft>carregando…</Soft></Page>}
        </View>
        <View style={shown('conta')}>
          <Identidade active={ready && screen === 'conta'} embedded view='conta' onInfo={onInfo} />
        </View>
        <View style={shown('instalar')}>
          <Page>
            {install.canPrompt ? <Btn label='Instalar' onPress={() => { install.promptInstall() }} /> : null}
            <Soft>{INSTALL_TEXT}</Soft>
          </Page>
        </View>
        <View style={shown('conexao')}>
          <Conexao active={ready && screen === 'conexao'} embedded />
        </View>
        <View style={shown('sincronizar')}>
          <Sincronizar embedded onOpenConnection={() => onNavigate('conexao')} />
        </View>
        <View style={shown('identidade')}>
          <Identidade active={ready && screen === 'identidade'} embedded view='tecnica' onInfo={onInfo} />
        </View>
      </>
      )

  return (
    <Sheet open={screen !== null} onClose={onClose} title={TITLES[screen]} left={left} background={colors.bg}>
      {body}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  cancel: { ...type.cancel, color: colors.ink },
  back: { flexDirection: 'row', alignItems: 'center', marginLeft: -6 },
  group: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    marginBottom: 12
  },
  confirm: { gap: 8, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  label: { flex: 1, fontSize: 16, color: colors.ink }
})
