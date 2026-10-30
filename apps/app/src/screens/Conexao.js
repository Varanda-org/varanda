/* global location */

// "Conectar" (before the node runs) and the "Conexão" tab.
// Native: the installation address first (its /varanda.json starts the web
// kind); under "Avançado", association, bootstrap or public DHT, optional DHT
// host (the core kind); a change stops the node and starts it again. Web with the node in the browser: the
// association and the seeder's WebSocket address; a change closes the node
// and opens it again. Web with varanda-serve: no onboarding (the
// configuration is varanda-serve's), only the connection state and a
// reconnect button.
// On the hosted page only, the boot "Conectar" is for everyone, so it shows one
// plain sentence and a retry, with the technical view under "Detalhes técnicos";
// Ajustes > Avançado > Conexão keeps that view open.

import { useEffect, useState } from 'react'
import { Platform, Pressable, Switch, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { checkForm, checkWebForm, formOf, webFormOf } from '../config'
import * as configStore from '../configStore'
import { installationOrigin } from '../installation'
import { connectProblem, DETAILS_LABEL, RETRY_LABEL } from '../connectText'
import { useNode } from '../node'
import { colors, type } from '../ui/theme'
import { Body, Btn, Card, ErrorText, Field, Label, Mono, Notice, Page, Row, Soft, Title, errorText, useAction } from '../ui'

const { canConfigure, hostedPage } = configStore
// Native only (configStore.native.js).
const saveInstallation = typeof configStore.saveInstallation === 'function' ? configStore.saveInstallation : null

// Fixed for the app's lifetime (src/client/mode.js on the web).
const BROWSER_NODE = Platform.OS === 'web' && canConfigure
// Native: the installation address comes first; the manual core form is
// under "Avançado".
const NATIVE_INSTALLATION = Platform.OS !== 'web' && saveInstallation !== null

const BAD_INSTALLATION = 'endereço da instalação inválido: use https:// seguido do nome, em minúsculas e sem caminho'

function initialAddress () {
  return installationOrigin() || process.env.EXPO_PUBLIC_VARANDA_INSTALLATION || ''
}

export default function Conexao (props) {
  return BROWSER_NODE ? <ConexaoNavegador {...props} /> : <ConexaoNo {...props} />
}

// node.info while the screen is shown and the node is ready.
function useInfo (node, active, ready) {
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  useEffect(() => {
    if (!active || !ready) return
    let off = false
    node.request('node.info', {}).then(
      (r) => { if (!off) { setInfo(r); setInfoError('') } },
      (err) => { if (!off) setInfoError(errorText(err)) }
    )
    return () => { off = true }
  }, [active, ready, node.request])
  return [info, infoError]
}

function ConexaoNavegador ({ active = true, embedded = false }) {
  const node = useNode()
  const [form, setForm] = useState(() => webFormOf(node.config))
  const [localError, setLocalError] = useState('')
  // Hosted page: the form stays hidden until asked for.
  const [manual, setManual] = useState(false)
  // Going back to the installation's configuration with a diary already in
  // this browser asks first: the diary is bound to the association it was
  // created with, and the installation may use another one.
  const [confirmBack, setConfirmBack] = useState(false)
  const [details, setDetails] = useState(false)
  const apply = useAction()
  const ready = node.phase === 'ready'
  const [info, infoError] = useInfo(node, active, ready)

  useEffect(() => { setForm(webFormOf(node.config)) }, [node.config])

  const hasIdentity = info !== null && info.publicKey !== null
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:'
    // Once the identity exists the association is fixed (the field is gone).
    const checked = checkWebForm(hasIdentity && node.config ? { ...form, association: node.config.association } : form, { secure })
    if (checked.error) return setLocalError(checked.error)
    setLocalError('')
    await apply.run(() => node.restart(checked.config))
  }

  const busy = node.phase === 'connecting' || node.phase === 'loading' || apply.pending
  const copy = (
    <Soft>Na web, o seu nó roda neste navegador. A identidade vem da sua passkey; só os diários ficam neste navegador.</Soft>
  )

  // node.hosted is false on the hosted page once a manual configuration was
  // saved, and node.config is still null during the first connect.
  if (!embedded && !manual && hostedPage === true) {
    const configError = node.phase === 'config-error'
    const problem = connectProblem(node.error || apply.error)
    return (
      <Page>
        <Title>Conectar</Title>
        {busy && problem.text === '' ? <Notice>conectando…</Notice> : <ErrorText>{problem.text}</ErrorText>}
        <Btn
          label={RETRY_LABEL}
          onPress={() => apply.run(() => configError ? node.retryDiscovery() : node.reconnect())}
          pending={busy || apply.pending}
        />
        <Pressable
          onPress={() => setDetails((d) => !d)}
          accessibilityRole='button'
          accessibilityLabel={DETAILS_LABEL}
          accessibilityState={{ expanded: details }}
          hitSlop={10}
        >
          <Text style={{ ...type.counter, color: colors.accent }}>{DETAILS_LABEL}</Text>
        </Pressable>
        {details
          ? (
            <Card>
              {problem.detail ? <Soft>{problem.detail}</Soft> : null}
              {copy}
              {node.config
                ? (
                  <View style={{ gap: 4 }}>
                    <Label>{node.hosted ? 'detectados nesta instalação' : 'configuração em uso'}</Label>
                    <Mono>{displayText(node.config.association)}</Mono>
                    <Mono>{displayText(node.config.seederUrl)}</Mono>
                  </View>
                  )
                : null}
              {node.hostedSource === 'remembered'
                ? <Soft>sem resposta da instalação: usando a configuração guardada da última visita</Soft>
                : null}
              <Btn label={configError ? 'configurar manualmente' : 'usar outra configuração'} onPress={() => setManual(true)} secondary />
              <Notice>Limpar os dados deste site apaga os diários guardados; a identidade volta com a mesma passkey.</Notice>
            </Card>
            )
          : null}
      </Page>
    )
  }

  // Hosted page, no configuration found: an error with a retry, never the form
  // (until the person asks for it).
  if (node.phase === 'config-error' && !manual) {
    return (
      <Page>
        {embedded ? null : <Title>Conectar</Title>}
        <Card>
          <ErrorText>{node.error}</ErrorText>
          <Btn label='tentar de novo' onPress={() => apply.run(() => node.retryDiscovery())} pending={apply.pending} />
          <Btn label='configurar manualmente' onPress={() => setManual(true)} secondary />
        </Card>
      </Page>
    )
  }

  // Hosted page with the installation's own configuration: read-only, with a
  // way to use another one.
  if (node.hosted && node.config && !manual) {
    return (
      <Page>
        {embedded ? null : <Title>{ready ? 'Conexão' : 'Conectar'}</Title>}
        {copy}
        {busy ? <Notice>conectando…</Notice> : null}
        <ErrorText>{node.error || apply.error || infoError}</ErrorText>
        <Card>
          {ready
            ? (
              <View style={{ gap: 4 }}>
                <Label>estado</Label>
                <Body>o nó roda neste navegador</Body>
              </View>
              )
            : null}
          <View style={{ gap: 4 }}>
            <Label>detectados nesta instalação</Label>
            <Mono>{displayText(node.config.association)}</Mono>
            <Mono>{displayText(node.config.seederUrl)}</Mono>
          </View>
          {node.hostedSource === 'remembered'
            ? <Soft>sem resposta da instalação: usando a configuração guardada da última visita</Soft>
            : null}
          {ready ? null : <Btn label='tentar de novo' onPress={() => apply.run(() => node.reconnect())} pending={busy} />}
          <Btn label='usar outra configuração' onPress={() => setManual(true)} secondary />
        </Card>
        <Notice>Limpar os dados deste site apaga os diários guardados; a identidade volta com a mesma passkey.</Notice>
      </Page>
    )
  }

  const backToHosted = async () => {
    if (hasIdentity && !confirmBack) return setConfirmBack(true)
    setConfirmBack(false)
    setManual(false)
    setLocalError('')
    await apply.run(() => node.forgetConfig())
  }
  return (
    <Page>
      {embedded ? null : <Title>{ready ? 'Conexão' : 'Conectar'}</Title>}
      {!ready ? copy : null}
      {busy ? <Notice>conectando…</Notice> : null}
      <ErrorText>{node.error || apply.error || infoError}</ErrorText>
      <Card>
        {ready
          ? (
            <View style={{ gap: 4 }}>
              <Label>estado</Label>
              <Body>o nó roda neste navegador</Body>
            </View>
            )
          : null}
        {hasIdentity
          ? (
            <View style={{ gap: 4 }}>
              <Label>chave da associação (não muda depois que a identidade existe)</Label>
              <Mono>{displayText(node.config ? node.config.association : form.association)}</Mono>
            </View>
            )
          : <Field label='chave da associação (64 dígitos hexadecimais)' value={form.association} onChangeText={set('association')} mono multiline lines={3} />}
        <Field
          label='endereço do semeador (ws:// ou wss://)'
          value={form.seederUrl}
          onChangeText={set('seederUrl')}
          mono
          placeholder='wss://semeador.exemplo/seeder'
        />
        <ErrorText>{localError}</ErrorText>
        <Btn label={ready ? 'aplicar e reconectar' : 'conectar'} onPress={submit} pending={busy} />
        {confirmBack
          ? <Notice>O diário deste navegador foi criado com a associação desta configuração. Se a instalação usa outra associação, ele deixa de funcionar aqui.</Notice>
          : null}
        {manual || hostedPage
          ? <Btn label={confirmBack ? 'voltar mesmo assim' : 'voltar à configuração detectada'} onPress={backToHosted} disabled={busy} secondary />
          : null}
      </Card>
      <Notice>Limpar os dados deste site apaga os diários guardados; a identidade volta com a mesma passkey.</Notice>
    </Page>
  )
}

function ConexaoNo ({ active = true, embedded = false }) {
  const node = useNode()
  const [form, setForm] = useState(() => formOf(node.config))
  const [localError, setLocalError] = useState('')
  const [info, setInfo] = useState(null)
  const apply = useAction()
  const [infoError, setInfoError] = useState('')
  const ready = node.phase === 'ready'
  const coreConfig = node.config !== null && typeof node.config === 'object' && node.config.kind !== 'hosted'
  // A core configuration in use (saved or tried) opens the manual form.
  const [advanced, setAdvanced] = useState(() => coreConfig)
  const [address, setAddress] = useState(initialAddress)
  const [addressError, setAddressError] = useState('')

  useEffect(() => { setForm(formOf(node.config)) }, [node.config])
  useEffect(() => { if (coreConfig) setAdvanced(true) }, [coreConfig])
  // The saved installation is read while the app starts (src/node.js).
  useEffect(() => { setAddress((a) => (a === '' ? initialAddress() : a)) }, [node.phase])

  useEffect(() => {
    if (!active || !ready) return
    let off = false
    node.request('node.info', {}).then(
      (r) => { if (!off) { setInfo(r); setInfoError('') } },
      (err) => { if (!off) setInfoError(errorText(err)) }
    )
    return () => { off = true }
  }, [active, ready, node.request])

  const hasIdentity = info !== null && info.publicKey !== null
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    // With the public DHT on, the bootstrap text is ignored (kept in the form).
    const checked = checkForm(form.publicDht ? { ...form, bootstrapText: '' } : form)
    if (checked.error) return setLocalError(checked.error)
    setLocalError('')
    await apply.run(() => node.restart(checked.config))
  }

  if (!node.canConfigure) {
    return (
      <Page>
        {embedded ? null : <Title>Conexão</Title>}
        <Card>
          <Label>estado</Label>
          <Body>{{ ready: 'conectado ao varanda-serve', connecting: 'conectando…', loading: 'conectando…' }[node.phase] || 'desconectado'}</Body>
          {ready && info !== null ? <Soft>{info.publicDht ? 'o nó usa a DHT pública' : 'o nó usa a rede privada (bootstrap)'}</Soft> : null}
          <ErrorText>{node.error || infoError}</ErrorText>
          {node.phase === 'error' ? <Soft>Para conectar, abra o endereço impresso pelo varanda-serve.</Soft> : null}
          {node.phase === 'ready' || node.phase === 'error' ? <Btn label='reconectar' onPress={() => node.reconnect()} secondary /> : null}
        </Card>
        <Soft>Na web, a associação, o bootstrap e a DHT são as opções do varanda-serve.</Soft>
      </Page>
    )
  }

  const busy = node.phase === 'connecting' || node.phase === 'loading' || apply.pending

  // The installation's own /varanda.json then starts the web kind
  // (src/node.js); a saved core configuration is dropped, since it would win.
  const submitInstallation = async () => {
    const value = address.trim()
    if (value === '') return setAddressError('informe o endereço da instalação, por exemplo https://varanda.exemplo')
    setAddressError('')
    // The same address over a working connection to it: nothing to change,
    // and closing it would only lose the connection (offline, no way back).
    if (ready && node.hosted && value.replace(/\/$/, '') === installationOrigin()) return
    await apply.run(async () => {
      if (!(await saveInstallation(value))) return setAddressError(BAD_INSTALLATION)
      await node.forgetConfig()
    })
  }

  if (NATIVE_INSTALLATION && !advanced) {
    const configError = node.phase === 'config-error'
    return (
      <Page>
        {embedded ? null : <Title>{ready ? 'Conexão' : 'Conectar'}</Title>}
        {!ready ? <Soft>Informe o endereço da instalação do Varanda. O app usa a mesma passkey e o mesmo diário do site.</Soft> : null}
        {busy ? <Notice>conectando…</Notice> : null}
        <ErrorText>{node.error || apply.error || infoError}</ErrorText>
        <Card>
          {ready
            ? (
              <View style={{ gap: 4 }}>
                <Label>estado</Label>
                <Body>o nó roda neste aparelho e sincroniza com a instalação</Body>
              </View>
              )
            : null}
          <Field
            label='Endereço da instalação'
            value={address}
            onChangeText={(v) => { setAddress(v); setAddressError('') }}
            mono
            placeholder='https://varanda.exemplo'
            returnKeyType='go'
            onSubmitEditing={submitInstallation}
          />
          <ErrorText>{addressError}</ErrorText>
          <Btn label={ready ? 'aplicar e reconectar' : 'conectar'} onPress={submitInstallation} pending={busy} />
          {configError ? <Btn label='tentar de novo' onPress={() => apply.run(() => node.retryDiscovery())} pending={busy} secondary /> : null}
          {node.hosted && node.config
            ? (
              <View style={{ gap: 4 }}>
                <Label>detectados nesta instalação</Label>
                <Mono>{displayText(node.config.association)}</Mono>
                <Mono>{displayText(node.config.seederUrl)}</Mono>
              </View>
              )
            : null}
          {node.hostedSource === 'remembered'
            ? <Soft>sem resposta da instalação: usando a configuração guardada da última vez</Soft>
            : null}
          <Btn label='Avançado' onPress={() => setAdvanced(true)} disabled={busy} secondary />
        </Card>
      </Page>
    )
  }

  return (
    <Page>
      {embedded ? null : <Title>{ready ? 'Conexão' : 'Conectar'}</Title>}
      {!ready ? <Soft>Informe a associação e como achar outros aparelhos. Nada aqui é segredo: as chaves ficam dentro do app.</Soft> : null}
      {busy ? <Notice>conectando…</Notice> : null}
      <ErrorText>{node.error || apply.error || infoError}</ErrorText>
      <Card>
        {hasIdentity
          ? (
            <View style={{ gap: 4 }}>
              <Label>chave da associação (não muda depois que a identidade existe)</Label>
              <Mono>{displayText(node.config ? node.config.association : form.association)}</Mono>
            </View>
            )
          : <Field label='chave da associação (64 dígitos hexadecimais)' value={form.association} onChangeText={set('association')} mono multiline lines={3} />}
        <Field
          label='bootstrap (host:porta, um por linha)'
          value={form.bootstrapText}
          onChangeText={set('bootstrapText')}
          multiline
          lines={3}
          mono
          editable={!form.publicDht}
          placeholder='127.0.0.1:49737'
        />
        <Row>
          <Switch value={form.publicDht} onValueChange={set('publicDht')} accessibilityLabel='DHT pública' />
          <Label>DHT pública</Label>
        </Row>
        {form.publicDht ? <Notice>O nó vai usar a DHT pública da internet para achar pares.</Notice> : null}
        <Field label='endereço local da DHT (opcional)' value={form.dhtHost} onChangeText={set('dhtHost')} mono />
        <ErrorText>{localError}</ErrorText>
        <Btn label={ready ? 'aplicar e reiniciar o nó' : 'conectar'} onPress={submit} pending={busy} />
        {NATIVE_INSTALLATION
          ? <Btn label='usar o endereço da instalação' onPress={() => setAdvanced(false)} disabled={busy} secondary />
          : null}
      </Card>
    </Page>
  )
}
