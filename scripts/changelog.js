// Folds the changelog entries of docs/changelog/ into the "## [Não lançado]"
// section of CHANGELOG.md and deletes their files; run it when a release is
// cut: `node scripts/changelog.js [repo root]`. Each pull request adds its own
// file instead of a line at the top of that section, because that line made
// every open pull request conflict after each merge, and GitHub ignores a
// merge=union attribute when it decides whether a pull request conflicts.
//
// An entry file is Markdown list items: a line that starts with "- " and the
// non-blank lines after it, up to the next item. Items before any heading go
// to the top of "Não lançado", above its first "###" subsection. A heading
// from SECTIONS sends the items after it to the top of that subsection,
// which is added at the end of "Não lançado" when missing. Files fold in
// name order; README.md is the folder's own guide and never folds. Anything
// else (text before the first item, another heading, a file with no item)
// fails the whole fold before any file is written.
const fs = require('node:fs')
const path = require('node:path')

const DIR = 'docs/changelog'
const UNRELEASED = '## [Não lançado]'
const SECTIONS = ['Segurança', 'Adicionado', 'Alterado', 'Removido', 'Corrigido']

// -> { groups: [{ section: null | name, items: [lines] }] } or { error }
function parseEntry (name, text) {
  const groups = []
  let group = null
  let item = false
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const where = name + ':' + (i + 1) + ': '
    if (line.trim() === '') continue
    if (line.startsWith('#')) {
      const m = /^### (.+)$/.exec(line)
      if (!m || !SECTIONS.includes(m[1].trim())) return { error: where + 'título fora da lista: use ### ' + SECTIONS.join(', ### ') }
      group = { section: m[1].trim(), items: [] }
      groups.push(group)
      item = false
    } else if (line.startsWith('- ')) {
      if (!group) {
        group = { section: null, items: [] }
        groups.push(group)
      }
      group.items.push(line)
      item = true
    } else if (item) {
      group.items.push(line)
    } else {
      return { error: where + 'texto fora de um item da lista (comece com "- ")' }
    }
  }
  const empty = groups.find((g) => g.items.length === 0)
  if (groups.length === 0 || empty) return { error: name + ': ' + (empty ? '### ' + empty.section + ' sem itens' : 'nenhum item') }
  return { groups }
}

// Before the first item of the region that starts at `from`, or, with no
// item there, where the region's content would start, with blank lines kept
// around the new items.
function insertTop (lines, from, items) {
  let i = from
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && lines[i].startsWith('- ')) {
    lines.splice(i, 0, ...items)
    return
  }
  const before = i === from ? [''] : []
  const after = i < lines.length ? [''] : []
  lines.splice(i, 0, ...before, ...items, ...after)
}

// -> { text } or { error }; `entries` is [{ name, text }] in fold order.
function fold (changelog, entries) {
  const groups = []
  for (const entry of entries) {
    const parsed = parseEntry(entry.name, entry.text)
    if (parsed.error) return { error: parsed.error }
    for (const g of parsed.groups) {
      const same = groups.find((x) => x.section === g.section)
      if (same) same.items.push(...g.items)
      else groups.push({ section: g.section, items: [...g.items] })
    }
  }
  const newline = changelog.endsWith('\n')
  const lines = changelog.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const top = lines.indexOf(UNRELEASED)
  if (top === -1) return { error: 'CHANGELOG.md sem a seção ' + UNRELEASED }
  // Top items first, so a subsection added at the end stays below them.
  groups.sort((a, b) => (a.section === null ? 0 : 1) - (b.section === null ? 0 : 1))
  for (const g of groups) {
    let end = top + 1
    while (end < lines.length && !lines[end].startsWith('## ')) end++
    if (g.section === null) {
      insertTop(lines, top + 1, g.items)
      continue
    }
    const heading = lines.slice(top + 1, end).indexOf('### ' + g.section)
    if (heading !== -1) {
      insertTop(lines, top + 1 + heading + 1, g.items)
      continue
    }
    let at = end
    while (at > top + 1 && lines[at - 1].trim() === '') at--
    const after = at === end && end < lines.length ? [''] : []
    lines.splice(at, 0, '', '### ' + g.section, '', ...g.items, ...after)
  }
  return { text: lines.join('\n') + (newline ? '\n' : '') }
}

function entryNames (root) {
  let names
  try {
    names = fs.readdirSync(path.join(root, DIR))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return names.filter((n) => n.endsWith('.md') && n !== 'README.md').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// -> { folded: [names] } or { error }
function foldRepo (root) {
  const names = entryNames(root)
  if (names.length === 0) return { folded: [] }
  const file = path.join(root, 'CHANGELOG.md')
  const entries = names.map((name) => ({ name: DIR + '/' + name, text: fs.readFileSync(path.join(root, DIR, name), 'utf8') }))
  const res = fold(fs.readFileSync(file, 'utf8'), entries)
  if (res.error) return res
  fs.writeFileSync(file, res.text)
  for (const name of names) fs.unlinkSync(path.join(root, DIR, name))
  return { folded: names }
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const res = foldRepo(root)
  if (res.error) {
    console.error('changelog: ' + res.error)
    process.exit(1)
  }
  console.log(res.folded.length === 0
    ? 'changelog: nenhuma entrada em ' + DIR
    : 'changelog: ' + res.folded.length + ' entrada(s) juntada(s) ao CHANGELOG.md')
}

module.exports = { parseEntry, fold, foldRepo, SECTIONS }
