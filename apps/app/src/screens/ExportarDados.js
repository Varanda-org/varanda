import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { collectExport, EXPORT_HELP, EXPORT_TEXTS } from '../dataExport'
import { clearExportCache, exportDelivery, saveExport, shareExport } from '../dataExportFile'
import { useNode } from '../node'
import { previewPrefStore } from '../previewBuild'
import { previewsEnabled } from '../previewPref'
import { wifiOnly } from '../wifiOnly'
import { Btn, ErrorText, Page, Soft } from '../ui'
import { HelpNote } from '../ui/Help'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { space } from '../ui/theme'

export default function ExportarDados ({ active }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const { mode } = useTheme()
  const operation = useRef(null)
  const [state, setState] = useState({ phase: 'idle' })

  useEffect(() => {
    return () => {
      if (operation.current) operation.current.cancelled = true
      operation.current = null
      setState({ phase: 'idle' })
      clearExportCache()
    }
  }, [active])

  const cancel = () => {
    if (operation.current) operation.current.cancelled = true
    operation.current = null
    setState({ phase: 'idle' })
  }

  const prepare = async () => {
    if (!active || operation.current) return
    const run = { cancelled: false, delivering: false }
    operation.current = run
    setState({ phase: 'running', done: 0, total: 0 })
    try {
      const file = await collectExport({
        request: node.request,
        prefs: { previews: previewsEnabled(previewPrefStore()), wifiOnly: wifiOnly(), appearance: mode },
        cancelled: () => run.cancelled,
        onProgress: ({ done, total }) => {
          if (!run.cancelled) setState({ phase: 'running', done, total })
        }
      })
      if (run.cancelled) return
      if (file.ok) setState({ phase: 'ready', file })
      else {
        operation.current = null
        setState({ phase: file.reason === 'cancelled' ? 'idle' : 'error' })
      }
    } catch {
      if (run.cancelled) return
      operation.current = null
      setState({ phase: 'error' })
    }
  }

  const deliver = async (save) => {
    const run = operation.current
    if (!active || !run || run.cancelled || run.delivering || state.phase !== 'ready') return
    run.delivering = true
    setState({ ...state, delivering: true })
    try {
      const result = await save(state.file.name, state.file.text)
      if (run.cancelled) return
      if (result.reason === 'cancelled') setState({ ...state, delivering: false })
      else {
        operation.current = null
        setState({ phase: result.ok ? 'done' : 'error' })
      }
    } catch {
      if (run.cancelled) return
      operation.current = null
      setState({ phase: 'error' })
    } finally {
      run.delivering = false
    }
  }

  return (
    <Page>
      <View style={styles.content}>
        {state.phase === 'idle' && <HelpNote doc={EXPORT_HELP}><Soft>{EXPORT_TEXTS.note}</Soft></HelpNote>}
        {state.phase === 'running' && <Soft>{EXPORT_TEXTS.reading(state.done, state.total)}</Soft>}
        {state.phase === 'ready' && <Soft>{EXPORT_TEXTS.ready(state.file.records, state.file.bytes)}</Soft>}
        {state.phase === 'done' && <Soft>{EXPORT_TEXTS.saved}</Soft>}
        <ErrorText>{state.phase === 'error' ? EXPORT_TEXTS.failed : null}</ErrorText>
        {['idle', 'done', 'error'].includes(state.phase) && <Btn label={EXPORT_TEXTS.prepare} onPress={prepare} disabled={!active} />}
        {state.phase === 'running' && <Btn label={EXPORT_TEXTS.cancel} onPress={cancel} secondary />}
        {state.phase === 'ready' && (
          <>
            <Btn label={EXPORT_TEXTS.save} onPress={() => deliver(saveExport)} disabled={state.delivering || !active} />
            {exportDelivery.share && <Btn label={EXPORT_TEXTS.share} onPress={() => deliver(shareExport)} disabled={state.delivering || !active} secondary />}
          </>
        )}
      </View>
    </Page>
  )
}

const makeStyles = () => StyleSheet.create({
  content: { gap: space.md }
})
