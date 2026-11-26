// Ajustes > Aparecer na busca (issue #166): whether the seeders' account
// search may list the person. The current choice is read from the own diary
// (search.state); a read that fails says so and offers no guess. A change is
// one search.show, never repeated by itself: an uncertain answer only
// re-reads.
import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import { useNode } from '../node'
import { HELP } from '../help'
import { HelpNote } from '../ui/Help'
import { Sheet } from '../ui/Sheet'
import { SwitchRow } from '../ui/SwitchRow'
import { Btn, ErrorText, Soft, useAction } from '../ui'
import { space } from '../ui/theme'

export const SEARCH_SHOW_TITLE = 'Aparecer na busca'
export const SEARCH_SHOW_LABEL = 'Deixar que me encontrem pelo nome na busca de contas'

export function SearchShowSheet ({ open, onClose, ready }) {
  const node = useNode()
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const [on, setOn] = useState(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const act = useAction()

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setOn(null)
    setFailed(false)
    requestRef.current('search.state', {}).then(
      (r) => { if (alive) setOn(r.on !== false) },
      () => { if (alive) setFailed(true) }
    )
    return () => { alive = false }
  }, [open, tick])

  const close = () => {
    if (act.pending) return
    act.clearError()
    onClose()
  }
  const retry = () => setTick((n) => n + 1)
  const disabled = !ready || node.online === false || act.pending
  const change = async (next) => {
    if (!open || disabled || on === null || next === on) return
    const result = await act.run(() => node.request('search.show', { on: next }))
    if (result.ok) setOn(result.value.on)
    else if (result.uncertain) {
      setOn(null)
      retry()
    }
  }

  return (
    <Sheet open={open} onClose={close} dismissable={!act.pending} title={SEARCH_SHOW_TITLE} closeLabel='Fechar'>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
        {on !== null
          ? <SwitchRow label={SEARCH_SHOW_LABEL} value={on} onValueChange={change} disabled={disabled} />
          : failed
            ? (
              <>
                <ErrorText>Não foi possível ler agora.</ErrorText>
                <Btn label='Tentar de novo' onPress={retry} />
              </>
              )
            : <Soft>Lendo…</Soft>}
        <HelpNote doc={HELP.aparecerNaBusca}><Soft>Quem tem o seu @nome ou link continua chegando a você.</Soft></HelpNote>
        <ErrorText>{act.error}</ErrorText>
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg }
})
