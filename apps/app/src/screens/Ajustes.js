/* global navigator */

// Ajustes: a sheet with a grouped list (Conexão, Sincronizar, Identidade)
// over the technical screens, which render embedded inside the sheet. On the
// web's browser node it also offers 'bloquear identidade': the key derived
// from the passkey is dropped from memory and the shell returns to Entrar.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNode } from '../node'
import { askPersist } from '../persist'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { colors, type } from '../ui/theme'
import { ErrorText, Page, Soft, useAction } from '../ui'
import Conexao from './Conexao'
import Identidade from './Identidade'
import Sincronizar from './Sincronizar'

const TITLES = { lista: 'Ajustes', conexao: 'Conexão', sincronizar: 'Sincronizar', identidade: 'Identidade' }

const ITEMS = [
  { id: 'conexao', label: 'Conexão', icon: 'rede' },
  { id: 'sincronizar', label: 'Sincronizar', icon: 'sinc' },
  { id: 'identidade', label: 'Identidade', icon: 'pessoa' }
]

export default function Ajustes ({ screen, onNavigate, onClose, onInfo }) {
  const node = useNode()
  // The embedded screens reload when the node becomes ready again.
  const ready = node.phase === 'ready'
  const lockAction = useAction()
  const canLock = node.passkey !== null && node.passkey.status !== null && node.passkey.status.unlocked === true
  const doLock = async () => {
    const r = await lockAction.run(() => node.passkey.lock())
    if (r.ok) onClose()
  }
  // Result of asking the browser to keep this origin's data (null: not asked yet).
  const [persisted, setPersisted] = useState(null)
  const [persistPending, setPersistPending] = useState(false)
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
            <View style={styles.group}>
              {ITEMS.map((item, i) => (
                <Pressable
                  key={item.id}
                  style={[styles.row, i > 0 && styles.rowDivider]}
                  accessibilityRole='button'
                  accessibilityLabel={item.label}
                  onPress={() => onNavigate(item.id)}
                >
                  <Icon name={item.icon} size={22} color={colors.soft} />
                  <Text style={styles.label}>{item.label}</Text>
                  <Icon name='seta' size={20} color={colors.soft} />
                </Pressable>
              ))}
            </View>
            {canLock
              ? (
                <>
                  <View style={styles.group}>
                    <Pressable
                      style={styles.row}
                      accessibilityRole='button'
                      accessibilityLabel='bloquear identidade'
                      accessibilityState={{ disabled: lockAction.pending }}
                      disabled={lockAction.pending}
                      onPress={doLock}
                    >
                      <Icon name='lock' size={22} color={colors.soft} />
                      <Text style={styles.label}>{lockAction.pending ? 'bloquear identidade…' : 'bloquear identidade'}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.group}>
                    <Pressable
                      style={styles.row}
                      accessibilityRole='button'
                      accessibilityLabel='manter os dados neste aparelho'
                      accessibilityState={{ disabled: persistPending }}
                      disabled={persistPending}
                      onPress={doPersist}
                    >
                      <Icon name='rede' size={22} color={colors.soft} />
                      <Text style={styles.label}>{persistPending ? 'manter os dados neste aparelho…' : 'manter os dados neste aparelho'}</Text>
                    </Pressable>
                  </View>
                  {persisted === null
                    ? null
                    : <Soft>{persisted ? 'os dados ficam guardados neste aparelho' : 'o navegador não garantiu a guarda dos dados (pode apagá-los se faltar espaço)'}</Soft>}
                  <Soft>Para instalar, use o menu do navegador (no iPhone: Compartilhar e depois Adicionar à Tela de Início). Depois de uma visita com rede, o app abre e deixa entrar com a passkey mesmo sem rede, e mostra o que já está neste aparelho. A fila de saída aparece no Diário: o que você escreve com a página aberta sai sozinho quando a conexão volta; o que ficou de uma visita anterior espera você tocar em enviar. Apagar os dados do site apaga os diários guardados e a fila de saída. Outra aba deste navegador fica bloqueada enquanto esta estiver aberta.</Soft>
                </>
                )
              : null}
            <ErrorText>{lockAction.error}</ErrorText>
            <Soft>As telas técnicas de hoje: a conexão com o nó, a sincronização com os pares e a identidade do diário.</Soft>
          </Page>
        </View>
        <View style={shown('conexao')}>
          <Conexao active={ready && screen === 'conexao'} embedded />
        </View>
        <View style={shown('sincronizar')}>
          <Sincronizar embedded onOpenConnection={() => onNavigate('conexao')} />
        </View>
        <View style={shown('identidade')}>
          <Identidade active={ready && screen === 'identidade'} embedded onInfo={onInfo} />
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  label: { flex: 1, fontSize: 16, color: colors.ink }
})
