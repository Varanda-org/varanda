// Sobre o Varanda, opened from Ajustes: the build, the license and the channel
// of the encarregado. Addresses stay plain selectable text, not links, as in
// Termos: copying is enough, and opening one would leave this screen.

import { Fragment } from 'react'
import { Text } from 'react-native'
import { aboutSections } from '../about'
import { Body, Label, Page } from '../ui'

export default function Sobre ({ appLine = '', serverLine = '' }) {
  return (
    <Page>
      {aboutSections({ appLine, serverLine }).map((section) => (
        <Fragment key={section.title}>
          <Label>{section.title}</Label>
          {section.lines.map((line) => <Body key={line}><Text selectable>{line}</Text></Body>)}
        </Fragment>
      ))}
    </Page>
  )
}
