// The bottom tabs per mode: five when the node is not hosted (manual
// configuration, varanda-serve), six wherever the node is hosted. The sixth
// tab is Conversas, but its id stays 'comunidades' because callers compare
// that id.
export const TABS = [
  { id: 'rua', label: 'A Rua', icon: 'casa' },
  { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
  { id: 'seguindo', label: 'Seguindo', icon: 'gente' },
  { id: 'avisos', label: 'Avisos', icon: 'sino' },
  { id: 'diario', label: 'Diário', icon: 'pessoa' }
]

const HOSTED_TABS = [
  ...TABS.slice(0, 2),
  { id: 'comunidades', label: 'Conversas', icon: 'conversas' },
  ...TABS.slice(2)
]

export function tabsFor (mode) {
  return mode === 'hosted' ? HOSTED_TABS : TABS
}
