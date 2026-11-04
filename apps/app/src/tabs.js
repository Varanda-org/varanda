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

// Screens that belong to Conversas: a private conversation, a group and a
// community open on top of that tab.
const CONVERSAS_SCREENS = new Set(['mensagem', 'grupo', 'comunidade', 'comunidade-info'])

// The floating "publicar" button belongs to posts: it is hidden on the
// Conversas tab and on its screens. `screen` is the top of the stack, or
// null when no screen is open above the tabs.
export function showPostButton ({ tab, screen }) {
  if (typeof screen === 'string') return !CONVERSAS_SCREENS.has(screen)
  return tab !== 'comunidades'
}
