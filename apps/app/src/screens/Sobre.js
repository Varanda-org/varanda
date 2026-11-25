// Sobre o Varanda, opened from Ajustes: the build, the license and the channel
// of the encarregado. Addresses stay plain selectable text, not links, as in
// Termos: copying is enough, and opening one would leave this screen.

import { Fragment } from 'react'
import { aboutSections } from '../about'
import { HELP } from '../help'
import { MODERATION_TITLE } from '../moderationStatus'
import { Body, Label, Page } from '../ui'
import { HelpNote } from '../ui/Help'

export default function Sobre ({ appLine = '', serverLine = '', moderationLine = '' }) {
  const sections = aboutSections({ appLine, serverLine })
  // After the build lines when there are any, else first.
  const at = sections.length > 0 && sections[0].title === 'Versão' ? 1 : 0
  const moderation = moderationLine === ''
    ? null
    : (
      <Fragment key={MODERATION_TITLE}>
        <Label>{MODERATION_TITLE}</Label>
        <HelpNote doc={HELP.moderacao}><Body selectable>{moderationLine}</Body></HelpNote>
      </Fragment>
      )
  const render = (section) => (
    <Fragment key={section.title}>
      <Label>{section.title}</Label>
      {section.lines.map((line) => <Body key={line} selectable>{line}</Body>)}
    </Fragment>
  )
  return (
    <Page>
      {sections.slice(0, at).map(render)}
      {moderation}
      {sections.slice(at).map(render)}
    </Page>
  )
}
