'use strict'

// Keeps the README section "Atualização por imagem (pull)" in step with the
// code it describes: the cosign pin, the signing identities and issuer, the
// commands of update.sh, the order of the maintainer steps. Also keeps the
// em dash out of the new prose (AGENTS.md). No network, nothing is run.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8')

const readme = read('README.md')
const updateSh = read('deploy/seeder/update.sh')
const cosignRef = read('deploy/seeder/cosign.ref').trim()
const EM_DASH = String.fromCharCode(0x2014)
const HEADING = '### Atualização por imagem (pull)'
const COSIGN_PREFIX = 'ghcr.io/sigstore/cosign/cosign:'
const VERIFICATION = 'docs/verification/feat-seeder-pull-updater.md'

// The text from the heading up to the next "### " heading, or null.
function readmeSection (text) {
  const start = text.indexOf('\n' + HEADING + '\n')
  if (start === -1) return null
  const from = start + 1
  const next = text.indexOf('\n### ', from + HEADING.length)
  return next === -1 ? text.slice(from) : text.slice(from, next)
}

// The value of a `name=value` assignment at the start of a line of update.sh.
function shValue (name) {
  const match = new RegExp('^' + name + '=(\\S+)$', 'm').exec(updateSh)
  return match ? match[1].replace(/^"|"$/g, '') : null
}

// Every cosign image reference the section shows.
function cosignRefsIn (section) {
  const found = []
  const re = new RegExp(COSIGN_PREFIX.replace(/[./]/g, '\\$&') + '\\S+', 'g')
  for (const match of section.matchAll(re)) found.push(match[0])
  return found
}

// True when the section shows the pinned cosign reference, and only it.
function showsPin (section, pin) {
  const refs = cosignRefsIn(section)
  return refs.length > 0 && refs.every((ref) => ref === pin)
}

const section = readmeSection(readme)

test('README has the pull section, right before "### systemd"', (t) => {
  t.ok(section, 'the section exists')
  const headings = readme.split('\n').filter((line) => line.startsWith('### '))
  const at = headings.indexOf(HEADING)
  t.is(headings[at + 1], '### systemd', 'the next ### heading is systemd')
  t.is(headings[at - 1], '### Implantação automática pelo GitHub Actions', 'it follows the GitHub Actions section')
})

test('the cosign reference in the section is the pin of cosign.ref', (t) => {
  t.is(cosignRef.split('\n').length, 1, 'cosign.ref is a single line')
  t.ok(cosignRef.startsWith(COSIGN_PREFIX), 'the pin is a cosign image reference')
  t.ok(showsPin(section, cosignRef), 'every cosign reference shown is the pin')
  t.ok(cosignRefsIn(section).length > 0, 'the verify command shows it')
})

test('a drifted cosign pin in the README would be caught', (t) => {
  const last = cosignRef.slice(-1)
  const drifted = cosignRef.slice(0, -1) + (last === '0' ? '1' : '0')
  t.is(showsPin(section.replace(cosignRef, drifted), cosignRef), false, 'one changed digit is caught')
  const older = cosignRef.replace(/:v\d+\.\d+\.\d+@/, ':v0.0.1@')
  t.is(showsPin(section.replace(cosignRef, older), cosignRef), false, 'a changed version is caught')
  t.is(showsPin(section.replace(cosignRef, 'x'), cosignRef), false, 'a missing reference is caught')
  t.is(showsPin('no cosign here', cosignRef), false, 'no reference at all is caught')
})

test('the section shows the identities and the issuer update.sh verifies with', (t) => {
  const stable = shValue('identidade_stable')
  const edge = shValue('identidade_edge')
  const issuer = shValue('emissor')
  t.ok(stable && stable.endsWith('/promote.yml@refs/heads/main'), 'update.sh: stable identity is promote.yml on main')
  t.ok(edge && edge.endsWith('/release.yml@refs/heads/main'), 'update.sh: edge identity is release.yml on main')
  t.is(issuer, 'https://token.actions.githubusercontent.com', 'update.sh: the GitHub Actions issuer')
  t.ok(section.includes('--certificate-identity ' + stable), 'the verify command uses the stable identity')
  t.ok(section.includes('--certificate-oidc-issuer ' + issuer), 'the verify command uses the issuer')
  t.ok(section.includes('`' + edge + '`'), 'the edge identity is named')
  t.ok(section.includes('`' + stable + '`'), 'the stable identity is named')
  t.ok(section.includes(shValue('seeder_repo')), 'the seeder repository is named')
})

test('the cosign run flags match verificar_assinatura', (t) => {
  const flags = [
    '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges',
    '--tmpfs /cosign-home:rw,nosuid,nodev,noexec,size=64m,mode=1777', '-e HOME=/cosign-home'
  ]
  const body = updateSh.slice(updateSh.indexOf('verificar_assinatura() {'))
  for (const flag of flags) {
    t.ok(body.includes(flag), 'update.sh runs cosign with ' + flag)
    t.ok(section.includes(flag), 'the README runs cosign with ' + flag)
  }
})

test('every command of the update.sh usage line appears in the section', (t) => {
  const usage = /^uso='uso: update\.sh (.*)'$/m.exec(updateSh)
  t.ok(usage, 'update.sh has a usage line')
  const commands = usage[1].split('|').map((part) => part.trim().split(' ')[0])
  t.alike(commands, ['install', 'run', 'check', 'apply', 'reconfigure', 'rollback', 'status', 'compose'], 'the eight commands')
  for (const command of commands) {
    t.ok(new RegExp('(update\\.sh |`)' + command + '\\b').test(section), command + ' is documented')
  }
})

test('the maintainer steps create the release-stable environment before VARANDA_PROMOTE', (t) => {
  const marker = section.indexOf('Para quem mantém o repositório')
  t.ok(marker > 0, 'the maintainer steps exist')
  const steps = section.slice(marker)
  const env = steps.indexOf('release-stable')
  const promote = steps.indexOf('VARANDA_PROMOTE')
  t.ok(env > -1 && promote > -1, 'both are named')
  t.ok(env < promote, 'release-stable is named first')
  t.ok(steps.slice(env, promote).includes('ANTES'), 'and the text says it comes BEFORE')
  t.ok(steps.indexOf('VARANDA_RELEASE') < env, 'VARANDA_RELEASE is the first step')
  t.is(section.indexOf('VARANDA_PROMOTE') > section.indexOf('release-stable'), true, 'in the whole section too')
})

test('the section says a return to the old checkout keeps the intervention on purpose', (t) => {
  const at = section.indexOf('**Intervenção.**')
  t.ok(at > -1, 'the intervention paragraph exists')
  const paragraph = section.slice(at, section.indexOf('\n\n', at))
  t.ok(paragraph.includes('checkout antigo'), 'it names the old checkout')
  t.ok(paragraph.includes('de propósito'), 'it says on purpose')
  t.ok(paragraph.includes('`apply`') && paragraph.includes('`rollback`'), 'it says how it is cleared')
  t.ok(/rollback`? volta ao checkout de novo/.test(paragraph), 'and that a second rollback does not clear it')
})

test('the Write access of the packages is a check, not an unconditional step', (t) => {
  const steps = section.slice(section.indexOf('Para quem mantém o repositório'))
  t.ok(/Confira, em cada pacote \(Package settings > Manage Actions access\)/.test(steps), 'phrased as a check')
  t.ok(steps.includes('Pode não ser preciso'), 'and says it may not be needed')
})

test('the section names the files and the marker that update.sh uses', (t) => {
  for (const name of ['marcador', 'lock_dir', 'conf_file', 'env_padrao', 'releases', 'state']) {
    t.ok(shValue(name), 'update.sh sets ' + name)
  }
  t.ok(section.includes(shValue('conf_file')), 'update.conf path')
  t.ok(section.includes(shValue('env_padrao')), 'varanda.env path')
  t.ok(section.includes(shValue('releases')), 'releases directory')
  t.ok(section.includes(shValue('state')), 'state directory')
  const marker = shValue('marcador').replace('$lock_dir', shValue('lock_dir'))
  t.ok(section.includes(marker), 'modo-pull marker')
})

test('no em dash in the README section, the changelog entry or the verification file', (t) => {
  t.is(section.includes(EM_DASH), false, 'README section')
  const entry = read('docs/changelog/feat-seeder-pull-updater.md')
  t.ok(entry.startsWith('- Versões por imagem'), 'the changelog entry file holds the pull-updater entry')
  t.ok(entry.includes('`' + VERIFICATION + '`'), 'the changelog entry cites the verification file')
  t.is(entry.includes(EM_DASH), false, 'changelog entry')
  const part = read(VERIFICATION)
  t.is(part.includes(EM_DASH), false, 'verification file')
  t.ok(part.startsWith('# Versões do semeador por imagem (PRs build/seeder-release-images, feat/seeder-pull-updater)\n'), 'the verification file has its title')
  t.ok(part.includes('Manage Actions access'), 'the verification file checks the Write access of the packages')
  t.ok(section.includes('`' + VERIFICATION + '`'), 'the README maintainer steps cite the verification file')
})

test('the new files carry no em dash', (t) => {
  const files = [
    'apps/cli/test/readme-pull.test.js', 'deploy/seeder/.env.example'
  ]
  for (const file of files) t.is(read(file).includes(EM_DASH), false, file)
})
