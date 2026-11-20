import { REGIONS, REGION_LABELS, DESIGN_LABELS } from './inviteCardCopy.js'

// The region belongs to the design the inviter picked. The lines welcome
// the person arriving without placing them in that region or faking an accent.

export const WELCOME_TITLE = 'Tem lugar pra você.'
export const WELCOME_NEUTRAL_LINE = 'A varanda está aberta.'

export const DESIGN_LINES = Object.freeze({
  marajoara: 'Losangos e espirais, feitos com calma.',
  aguas: 'Dois rios lado a lado, sem pressa.',
  vitoria: 'Folhas largas sobre a água parada.',
  cordel: 'Sol alto e história boa de contar.',
  bandeirinhas: 'As bandeirinhas já estão no alto.',
  chita: 'Flor miúda, cor por todo lado.',
  ipe: 'O ipê abriu, é tempo de visita.',
  pantanal: 'Água rasa e horizonte largo.',
  azulejo: 'Azulejo na parede, café na mesa.',
  copacabana: 'O mar vai e volta, sem cansar.',
  minas: 'Conversa baixa ao pé da serra.',
  araucaria: 'Sombra de araucária e ar frio.',
  chimarrao: 'A cuia está passando na roda.'
})

// One walk of the shared list: a new design does not need a second table.
export function regionOf (design) {
  if (typeof design !== 'string') return null
  for (const region of REGIONS) {
    if (region.designs.includes(design)) return region.id
  }
  return null
}

export function welcomeCopy (design) {
  const region = regionOf(design)
  if (region === null) {
    return {
      region: null,
      tag: null,
      tagLabel: null,
      title: WELCOME_TITLE,
      line: WELCOME_NEUTRAL_LINE
    }
  }
  const line = Object.hasOwn(DESIGN_LINES, design) ? DESIGN_LINES[design] : WELCOME_NEUTRAL_LINE
  return {
    region,
    tag: REGION_LABELS[region] + ' \u00b7 ' + DESIGN_LABELS[design],
    tagLabel: 'Cartão ' + DESIGN_LABELS[design] + ', ' + REGION_LABELS[region],
    title: WELCOME_TITLE,
    line
  }
}
