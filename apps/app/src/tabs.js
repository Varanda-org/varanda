// The bottom tabs per mode: five everywhere, six on the hosted web, the only
// mode with Cadeiras de Praia.
export const TABS = [
  { id: 'rua', label: 'A Rua', icon: 'casa' },
  { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
  { id: 'seguindo', label: 'Seguindo', icon: 'gente' },
  { id: 'avisos', label: 'Avisos', icon: 'sino' },
  { id: 'diario', label: 'Diário', icon: 'pessoa' }
]

const HOSTED_TABS = [
  ...TABS.slice(0, 2),
  { id: 'cadeiras', label: 'Cadeiras', icon: 'cadeira' },
  ...TABS.slice(2)
]

export function tabsFor (mode) {
  return mode === 'hosted' ? HOSTED_TABS : TABS
}
