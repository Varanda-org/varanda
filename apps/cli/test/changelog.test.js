const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tmpDir } = require('./helpers/net')

// Every case folds a throwaway changelog, never the real CHANGELOG.md or
// docs/changelog/, so adding an entry file reaches no test.
const SCRIPT = path.resolve(__dirname, '../../../scripts/changelog.js')
const { parseEntry, fold, foldRepo, SECTIONS } = require(SCRIPT)

const BASE = [
  '# Histórico de mudanças',
  '',
  '## [Não lançado]',
  '',
  '- Antiga A.',
  '- Antiga B.',
  '  Continuação de B.',
  '',
  '### Segurança',
  '',
  '- Segurança antiga.',
  '',
  '### Corrigido',
  '',
  '- Correção antiga.',
  '',
  '## [0.1.0] - 2026-01-01',
  '',
  '- Lançada.',
  ''
].join('\n')

function folded (t, changelog, entries) {
  const res = fold(changelog, entries)
  t.absent(res.error, 'no error')
  return res.text
}

test('changelog: items with no heading go above the top list, in the given order', (t) => {
  const text = folded(t, BASE, [
    { name: 'a.md', text: '- Nova 1.\n  Continuação de 1.\n- Nova 2.\n' },
    { name: 'b.md', text: '\n- Nova 3.\n\n' }
  ])
  t.is(text, BASE.replace('- Antiga A.', '- Nova 1.\n  Continuação de 1.\n- Nova 2.\n- Nova 3.\n- Antiga A.'))
})

test('changelog: a heading sends its items to the top of that subsection', (t) => {
  const text = folded(t, BASE, [
    { name: 'a.md', text: '- Topo.\n\n### Corrigido\n\n- Corrige 1.\n' },
    { name: 'b.md', text: '### Segurança\n- Seg 1.\n### Corrigido\n- Corrige 2.\n' }
  ])
  t.is(text, BASE
    .replace('- Antiga A.', '- Topo.\n- Antiga A.')
    .replace('- Segurança antiga.', '- Seg 1.\n- Segurança antiga.')
    .replace('- Correção antiga.', '- Corrige 1.\n- Corrige 2.\n- Correção antiga.'))
})

test('changelog: a missing subsection is added at the end of Não lançado', (t) => {
  const text = folded(t, BASE, [{ name: 'a.md', text: '### Removido\n\n- Sai.\n' }])
  t.is(text, BASE.replace('- Correção antiga.\n', '- Correção antiga.\n\n### Removido\n\n- Sai.\n'))
  t.is(fold(text, []).text, text, 'no entries changes nothing')
})

test('changelog: an empty Não lançado gets blank lines around the new items', (t) => {
  const empty = '# H\n\n## [Não lançado]\n\n## [0.1.0]\n\n- Lançada.\n'
  t.is(folded(t, empty, [{ name: 'a.md', text: '- Nova.\n' }]), '# H\n\n## [Não lançado]\n\n- Nova.\n\n## [0.1.0]\n\n- Lançada.\n')
  t.is(folded(t, '## [Não lançado]', [{ name: 'a.md', text: '- Nova.\n### Corrigido\n- Fix.' }]), '## [Não lançado]\n\n- Nova.\n\n### Corrigido\n\n- Fix.')
  t.is(folded(t, '## [Não lançado]\n### Corrigido\n### Removido\n', [{ name: 'a.md', text: '### Corrigido\n- Fix.' }]), '## [Não lançado]\n### Corrigido\n\n- Fix.\n\n### Removido\n')
})

test('changelog: CRLF entries fold as LF lines', (t) => {
  t.is(folded(t, BASE, [{ name: 'a.md', text: '- Nova.\r\n  Mais.\r\n' }]), BASE.replace('- Antiga A.', '- Nova.\n  Mais.\n- Antiga A.'))
})

test('changelog: a malformed entry or changelog fails with its file and line', (t) => {
  const bad = [
    ['Texto solto.\n- Item.\n', 'x.md:1: texto fora de um item da lista'],
    ['- Item.\n## Outro\n- Mais.\n', 'x.md:2: título fora da lista'],
    ['- Item.\n### Adicionados\n- Mais.\n', 'x.md:2: título fora da lista'],
    ['# Título\n', 'x.md:1: título fora da lista'],
    ['\n\n', 'x.md: nenhum item'],
    ['- Item.\n### Corrigido\n', 'x.md: ### Corrigido sem itens']
  ]
  for (const [text, message] of bad) {
    const res = parseEntry('x.md', text)
    t.ok(res.error && res.error.startsWith(message), JSON.stringify(text) + ' -> ' + res.error)
    t.ok(fold(BASE, [{ name: 'x.md', text }]).error, 'fold refuses it too')
  }
  t.alike(parseEntry('x.md', '### ' + SECTIONS[0] + '\n- Item.').groups, [{ section: SECTIONS[0], items: ['- Item.'] }])
  t.ok(fold('# H\n\n## [0.1.0]\n', [{ name: 'a.md', text: '- Nova.' }]).error.includes('[Não lançado]'))
})

function repo (t, entries) {
  const root = tmpDir(t, 'varanda-changelog-')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), BASE)
  fs.mkdirSync(path.join(root, 'docs/changelog'), { recursive: true })
  for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(root, 'docs/changelog', name), text)
  return root
}

function listing (root) {
  return fs.readdirSync(path.join(root, 'docs/changelog')).sort()
}

test('changelog: foldRepo folds every entry file in name order and keeps the README', (t) => {
  const root = repo(t, {
    'README.md': '# Guia\n\nTexto que não é entrada.\n',
    'fix-b.md': '- B.\n',
    'feat-a.md': '- A.\n',
    'notas.txt': 'não é markdown'
  })
  t.alike(foldRepo(root), { folded: ['feat-a.md', 'fix-b.md'] })
  t.is(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), BASE.replace('- Antiga A.', '- A.\n- B.\n- Antiga A.'))
  t.alike(listing(root), ['README.md', 'notas.txt'])
})

test('changelog: one bad entry writes and deletes nothing', (t) => {
  const root = repo(t, { 'a.md': '- A.\n', 'b.md': 'solto\n' })
  const res = foldRepo(root)
  t.ok(res.error.startsWith('docs/changelog/b.md:1: '), res.error)
  t.is(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), BASE)
  t.alike(listing(root), ['a.md', 'b.md'])
})

test('changelog: the command line reports the fold, nothing to fold and errors', (t) => {
  const run = (root) => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })

  const done = run(repo(t, { 'a.md': '- A.\n' }))
  t.is(done.status, 0, done.stderr)
  t.is(done.stdout, 'changelog: 1 entrada(s) juntada(s) ao CHANGELOG.md\n')

  const none = repo(t, {})
  const idle = run(none)
  t.is(idle.status, 0, idle.stderr)
  t.is(idle.stdout, 'changelog: nenhuma entrada em docs/changelog\n')
  t.is(fs.readFileSync(path.join(none, 'CHANGELOG.md'), 'utf8'), BASE)

  const failed = run(repo(t, { 'a.md': '## Errado\n' }))
  t.is(failed.status, 1)
  t.ok(failed.stderr.startsWith('changelog: docs/changelog/a.md:1: título fora da lista'), failed.stderr)
})
