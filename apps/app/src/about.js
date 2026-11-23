// What the Sobre screen says besides the build lines Ajustes already shows.
// The contact and the encarregado wording follow src/legal.js: the encarregado
// is not named yet, so pedidos go to the association's address until then.

export const ABOUT_TITLE = 'Sobre o Varanda'
export const CONTACT = 'contato@varanda.app'
export const REPOSITORY = 'https://github.com/Varanda-org/varanda'
export const LICENSE_NAME = 'PolyForm Noncommercial 1.0.0'
export const LICENSE_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'

// -> [{ title, lines: [text] }] in reading order. Empty or missing build lines are dropped.
export function aboutSections ({ appLine, serverLine } = {}) {
  const build = [appLine, serverLine].filter((line) => typeof line === 'string' && line !== '')
  return [
    ...(build.length > 0 ? [{ title: 'Versão', lines: build }] : []),
    { title: 'Licença', lines: ['O código está disponível sob a licença ' + LICENSE_NAME + ', para uso não comercial.', LICENSE_URL, REPOSITORY] },
    { title: 'Encarregado de dados', lines: ['Ainda não nomeado. Até a nomeação, pedidos sobre seus dados podem ser enviados para ' + CONTACT + '.'] }
  ]
}
