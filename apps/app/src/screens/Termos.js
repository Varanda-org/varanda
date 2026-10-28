// Termos de Uso and the Política de Privacidade, from the bundled copy
// (src/legal.js). `gate` is the block before entering: the person reads both
// documents and accepts, or stays out. Ajustes opens the same screen without
// `gate` to show the acceptance this device recorded. Nothing is fetched.
// Addresses stay plain selectable text, not links: copying is enough, and
// opening one would leave this screen.

import { Fragment, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { LEGAL_DATE, PRIVACY, REVIEW_NOTE, TERMS } from '../legal'
import { HELP, SHORT } from '../help'
import { formatAcceptedAt } from '../terms'
import { HelpLink } from '../ui/Help'
import { Body, Btn, Card, Label, Page, Soft, Title, colors } from '../ui'

const NEEDED_TEXT = 'Antes de entrar no Varanda, leia e aceite os Termos de Uso e a Política de Privacidade.'
const ACCOUNT_TEXT = 'Esta conta ainda não aceitou os Termos de Uso e a Política de Privacidade neste aparelho. Leia e aceite para continuar.'
const SAVED_TEXT = 'Não foi possível guardar o aceite neste aparelho; ele será pedido de novo quando você abrir o Varanda outra vez.'
const BLOCKED_TEXT = 'Sem aceitar, não é possível entrar no Varanda.'
const ACCEPT_LABEL = 'Li e aceito os Termos de Uso e a Política de Privacidade'

const SYNC_TEXT = {
  registrado: 'Também registrado na sua conta da associação.',
  pendente: 'Ainda não registrado na sua conta da associação; tentaremos de novo.'
}

function gateText (reason, version) {
  if (reason === 'updated') return 'Os Termos de Uso e a Política de Privacidade mudaram. Leia e aceite a versão ' + version + ' para continuar.'
  if (reason === 'account') return ACCOUNT_TEXT
  return NEEDED_TEXT
}

function acceptedText (version, acceptedAt) {
  return 'Você aceitou a versão ' + version + ' em ' + formatAcceptedAt(acceptedAt) + ' neste aparelho.'
}

// No line for null, for 'so-aparelho' (short text plus a help link) or for an unknown state.
function syncText (syncState) {
  if (syncState === 'registrado' || syncState === 'pendente') return SYNC_TEXT[syncState]
  return ''
}

// Collapsed until opened: both documents are long, and in the gate the
// accept button stays within reach. Each one opens in place; the Page scrolls.
function LegalDoc ({ doc, expanded, onToggle }) {
  return (
    <Card>
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ expanded }}
        accessibilityLabel={doc.title}
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
      >
        <Text style={styles.headerTitle}>{doc.title}</Text>
        <Text style={styles.cue}>{expanded ? 'esconder' : 'mostrar'}</Text>
      </Pressable>
      {expanded && doc.sections.map((section) => (
        <Fragment key={section.heading}>
          <Label>{section.heading}</Label>
          {section.paragraphs.map((paragraph, i) => (
            <Text key={i} selectable style={styles.paragraph}>{paragraph}</Text>
          ))}
        </Fragment>
      ))}
    </Card>
  )
}

export default function Termos ({ gate = false, reason = 'needed', version, acceptedAt = null, saved = true, syncState = null, onAccept }) {
  const [openTerms, setOpenTerms] = useState(false)
  const [openPrivacy, setOpenPrivacy] = useState(false)
  const syncLine = syncText(syncState)
  return (
    <Page>
      {gate ? <Title>Termos de Uso e Política de Privacidade</Title> : null}
      {gate ? <Body>{gateText(reason, version)}</Body> : null}
      {!gate && acceptedAt ? <Body>{acceptedText(version, acceptedAt)}</Body> : null}
      {!gate && saved === false ? <Soft>{SAVED_TEXT}</Soft> : null}
      {!gate && syncLine ? <Soft>{syncLine}</Soft> : null}
      {!gate && syncState === 'so-aparelho' ? <Soft>{SHORT.termsDeviceOnly}</Soft> : null}
      {!gate && syncState === 'so-aparelho' ? <HelpLink doc={HELP.termosAparelho} /> : null}
      <Soft>{REVIEW_NOTE}</Soft>
      <Soft>{'Versão ' + version + ', de ' + LEGAL_DATE}</Soft>
      <LegalDoc doc={TERMS} expanded={openTerms} onToggle={() => setOpenTerms((v) => !v)} />
      <LegalDoc doc={PRIVACY} expanded={openPrivacy} onToggle={() => setOpenPrivacy((v) => !v)} />
      {gate ? <Btn label={ACCEPT_LABEL} onPress={onAccept} /> : null}
      {gate ? <Soft>{BLOCKED_TEXT}</Soft> : null}
    </Page>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44
  },
  headerPressed: { opacity: 0.8 },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.ink },
  cue: { fontSize: 14, color: colors.soft },
  paragraph: { fontSize: 16, lineHeight: 22, color: colors.ink }
})
