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
const cliSource = read('apps/cli/lib/cli.js')
const { ALLOWED } = require('../lib/sealed-secrets')
const cosignRef = read('deploy/seeder/cosign.ref').trim()
const EM_DASH = String.fromCharCode(0x2014)
const HEADING = '### Atualização por imagem (pull)'
const COSIGN_PREFIX = 'ghcr.io/sigstore/cosign/cosign:'

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
  t.alike(commands, ['install', 'run', 'check', 'apply', 'reconfigure', 'rollback', 'status', 'compose', 'secrets-key'], 'the nine commands')
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

test('no em dash in the README section, the CHANGELOG entry or verification section 252', (t) => {
  t.is(section.includes(EM_DASH), false, 'README section')
  const changelog = read('CHANGELOG.md')
  const top = changelog.indexOf('## [Não lançado]\n\n')
  t.ok(top > -1, 'CHANGELOG has the Não lançado section')
  const first = changelog.slice(top + 18, changelog.indexOf('\n- ', top + 18))
  t.ok(first.includes('feat/seeder-pull-updater'), 'the top entry is the pull-updater entry')
  t.is(first.includes(EM_DASH), false, 'CHANGELOG entry')
  const secondFrom = top + 18 + first.length + 1
  const second = changelog.slice(secondFrom, changelog.indexOf('\n- ', secondFrom + 1))
  t.ok(second.startsWith('- ') && second.includes('feat/seeder-sealed-secrets'), 'the next entry is the sealed-secrets entry')
  t.is(second.includes(EM_DASH), false, 'CHANGELOG sealed-secrets entry')
  const verification = read('docs/verification.md')
  const at = verification.indexOf('\n## 252. ')
  t.ok(at > -1, 'verification has section 252')
  const next = verification.indexOf('\n## ', at + 1)
  const part = next === -1 ? verification.slice(at) : verification.slice(at, next)
  t.is(part.includes(EM_DASH), false, 'verification section 252')
  t.ok(part.startsWith('\n## 252. Versões do semeador por imagem (PRs build/seeder-release-images, feat/seeder-pull-updater, feat/seeder-sealed-secrets)\n'), 'section 252 has its title')
  t.ok(part.includes('Manage Actions access'), 'section 252 checks the Write access of the packages')
})

// The flags of `secrets seal` as the HELP block of cli.js lists them.
function sealFlags () {
  const line = /^ {2}secrets seal .*\((--[a-z-]+(?:, --[a-z-]+)*)\)$/m.exec(cliSource)
  return line ? line[1].split(', ') : []
}

test('the section documents the sealed secrets flow as the code does it', (t) => {
  const keyFile = shValue('chave_segredos')
  t.is(keyFile, '/etc/varanda/secrets-key.json', 'update.sh keeps the server key here')
  t.ok(section.includes(keyFile), 'the section names the server key file')
  t.ok(section.includes('update.sh secrets-key'), 'and the command that creates it')
  t.ok(section.includes('secrets-key --image ghcr.io/varanda-org/varanda-seeder@sha256:'), 'including the form before install')
  t.ok(section.includes('secrets.sealed.json'), 'the sealed file is named')
  t.ok(section.includes('deploy/seeder/secrets.sealed.json'), 'with its path in the repository')
  t.ok(section.includes('efetivo.env'), 'the effective env file is named')
  t.ok(section.includes(shValue('state') + '/segredos/efetivo.env'), 'with the path update.sh gives it')
  const mark = /^marca_segredos='(.*)'$/m.exec(updateSh)
  t.ok(mark, 'update.sh has the marker line')
  t.ok(section.includes(mark[1]), 'the marker line is shown')
  for (const log of ['este servidor não é destinatário', 'variáveis aplicadas', 'segredos compartilhados:', 'chave dos segredos:']) {
    t.ok(updateSh.includes(log), 'update.sh prints ' + log)
    t.ok(section.includes(log), 'the section says ' + log)
  }
  for (const name of ALLOWED) t.ok(section.includes('`' + name + '`'), name + ' is named as shareable')
  for (const name of ['VARANDA_PHONE_KEY', 'VARANDA_PAGE_KEYS', 'VARANDA_TRIAGE_TOKEN', 'VARANDA_PUSH_TOKEN']) {
    t.ok(section.includes('`' + name + '`'), name + ' is named as never shared')
  }
  t.ok(section.includes('--network none --read-only --cap-drop ALL'), 'the isolation of the open step')
  t.ok(updateSh.includes('--network none --read-only --cap-drop ALL'), 'which update.sh uses')
})

test('the seal command in the section has the flags cli.js lists', (t) => {
  const flags = sealFlags()
  t.alike(flags, ['--file', '--recipients', '--signing-key', '--seq', '--out'], 'cli.js lists five flags for secrets seal')
  const command = /`varanda secrets seal ([^`]*)`/.exec(section)
  t.ok(command, 'the section shows the seal command')
  for (const flag of flags) t.ok(command[1].includes(flag + ' '), 'the seal command passes ' + flag)
  t.ok(command[1].includes('--out deploy/seeder/secrets.sealed.json'), 'and writes the file the bundle carries')
})

test('section 252 checks the sealed secrets flow', (t) => {
  const verification = read('docs/verification.md')
  const at = verification.indexOf('\n## 252. ')
  const next = verification.indexOf('\n## ', at + 1)
  const part = next === -1 ? verification.slice(at) : verification.slice(at, next)
  for (const needle of ['secrets-key', '/etc/varanda/secrets-key.json', 'efetivo.env', 'não é destinatário', 'docker inspect', 'rollback', 'secrets.test.js']) {
    t.ok(part.includes(needle), 'section 252 names ' + needle)
  }
  t.ok(part.includes('- [ ] 41. ') && part.includes('- [ ] 50. '), 'the sealed checks are numbered 41 to 50')
})

test('the section and section 252 document the seq of the sealed file as update.sh enforces it', (t) => {
  const floor = shValue('state') + '/segredos/seq'
  t.ok(updateSh.includes('local f="$segredos/seq"'), 'update.sh keeps the floor in segredos/seq')
  t.ok(section.includes(floor), 'the section names the floor file')
  t.ok(section.includes('O `--seq` é um a mais que o do arquivo atual'), 'sealing takes one more than the current seq')
  t.ok(section.includes('assinatura válida: <assinante>, seq <n>, <n> servidor(es)'), 'the verify line shows the seq')
  t.ok(cliSource.includes("'--seq'"), 'cli.js takes --seq')
  t.ok(section.includes('git show origin/main:deploy/seeder/secrets.sealed.json'), 'a reviewer compares with the seq on main')
  const refusal = 'o arquivo selado da nova versão tem seq X, menor que o último aplicado Y; nada mudou. Para aplicar mesmo assim, rode update.sh apply'
  t.ok(updateSh.includes(refusal.replace('X', '$segredos_seq').replace('Y', '$piso')), 'update.sh logs the timer refusal')
  t.ok(section.includes(refusal), 'the section quotes it')
  t.ok(section.includes('O `update.sh apply` (e o `reconfigure`) aplica mesmo assim'), 'apply takes a lower seq')
  t.ok(section.includes('secrets verify --json'), 'the seq comes from secrets verify --json')
  t.ok(updateSh.includes('secrets verify --file /segredos/selado.json --signers /segredos/assinantes.txt --json'), 'which update.sh runs')
  t.ok(section.includes('não foi possível conferir o arquivo selado (saída N); nada mudou'), 'the verify refusal is quoted')
  t.ok(updateSh.includes('não foi possível conferir o arquivo selado (saída $rc'), 'and update.sh logs it')
  t.ok(section.includes('no `run`, vale a regra do timer acima'), 'a non-recipient server goes on only outside the timer rule')
  t.ok(section.includes('`erro: assinatura do arquivo selado inválida`'), 'the section shows a known CLI message')
  t.ok(updateSh.includes("'erro: assinatura do arquivo selado inválida'"), 'which update.sh lets into the log')

  const verification = read('docs/verification.md')
  const at = verification.indexOf('\n## 252. ')
  const next = verification.indexOf('\n## ', at + 1)
  const part = next === -1 ? verification.slice(at) : verification.slice(at, next)
  for (const n of [57, 58, 59, 60]) t.ok(part.includes('- [ ] ' + n + '. '), 'section 252 has item ' + n)
  t.ok(part.includes('--seq 1 --out deploy/seeder/secrets.sealed.json'), 'item 43 seals with --seq')
  t.ok(part.includes(refusal.replace('X', '1').replace('Y', '2')), 'item 57 checks the timer refusal')
  t.ok(part.includes('aplicando o arquivo selado com seq 1, menor que o último aplicado 2'), 'item 58 checks the override')
  t.ok(updateSh.includes('aplicando o arquivo selado com seq $segredos_seq, menor que o último aplicado $piso'), 'which update.sh logs')
  t.ok(part.includes('Só num servidor de teste: depois do item 57, `update.sh apply`'), 'the override runs on a test server')
  t.ok(part.includes('e rode `update.sh apply` (ou use um servidor que nunca recebeu segredos compartilhados'), 'item 45 no longer expects the timer to go on')
})

test('the new files carry no em dash', (t) => {
  const files = [
    'apps/cli/test/readme-pull.test.js', 'deploy/seeder/.env.example'
  ]
  for (const file of files) t.is(read(file).includes(EM_DASH), false, file)
})
