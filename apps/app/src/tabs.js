// The bottom tabs: four in every mode, five when the node is hosted. The fifth
// is Conversas, but its id stays 'comunidades' because callers compare that id.
// Avisos opens from the bell in the top bar, and Seguindo from the 'N seguindo'
// count on the Diário.
export const TABS = [
  { id: 'rua', label: 'A Rua', icon: 'rua' },
  { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
  { id: 'busca', label: 'Busca', icon: 'lupa' },
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
