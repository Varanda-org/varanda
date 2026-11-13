import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import { displayText, feira } from '@varanda/rpc'
import { UF_OPTIONS, searchQuery } from '../feiraScreen'
import { Btn, ErrorText, Field } from './index'
import { FilterChips } from './FilterChips'
import { Sheet } from './Sheet'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

const cityText = (city) => displayText(typeof city === 'string' ? city : '')

export function PlaceSheet ({ open, onClose, uf = '', city = '', onPick }) {
  const styles = useStyles(makeStyles)
  const [draftUf, setDraftUf] = useState(uf)
  const [draftCity, setDraftCity] = useState(() => cityText(city))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setDraftUf(uf)
    setDraftCity(cityText(city))
    setError('')
  }, [open, uf, city])
  const pick = () => {
    const place = { uf: draftUf, city: cityText(draftCity).trim() }
    if (!searchQuery(place)) {
      setError('Escolha o estado e escreva a cidade.')
      return
    }
    onPick(place)
    onClose()
  }
  return (
    <Sheet open={open} onClose={onClose} title='Localização'>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
        <Text style={styles.label}>Estado</Text>
        <FilterChips options={UF_OPTIONS} selected={draftUf} onSelect={(next) => { setDraftUf(next); setError('') }} />
        <Field label='Cidade' value={draftCity} onChangeText={(next) => { setDraftCity(next); setError('') }} maxLength={feira.MAX_PLACE} returnKeyType='search' onSubmitEditing={pick} />
        <ErrorText>{error}</ErrorText>
        <Btn label='Ver anúncios' onPress={pick} block />
      </ScrollView>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  label: { ...type.postName, color: colors.ink }
})
