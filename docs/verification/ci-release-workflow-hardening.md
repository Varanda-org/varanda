# Endurecimento dos fluxos de envio às lojas (branch ci/release-workflow-hardening)

Os três pontos da auditoria do `android-release` (PR #868), que valiam igual para o `ios-release`, corrigidos nos dois fluxos juntos. Sem mudança de RPC, formato ou Termos.

## O que mudou

- `.github/eas-cli/package.json` e `.github/eas-cli/package-lock.json`: projeto próprio, fora dos workspaces, só com `eas-cli` 27.2.0 (versão exata). O lockfile (versão 3, 527 pacotes) tem cada pacote em `registry.npmjs.org` com integridade `sha512`.
- `.github/workflows/ios-release.yml` e `.github/workflows/android-release.yml`, nos jobs `testflight` e `play`:
  - o `eas-cli` sai de `npm ci --ignore-scripts` em `.github/eas-cli`, não mais de `npm install --global`, e o build roda `"$GITHUB_WORKSPACE"/.github/eas-cli/node_modules/.bin/eas build ...`;
  - o `setup-node` perde `cache: npm` e ganha `package-manager-cache: false`, que impede o cache automático do `setup-node` se o `package.json` um dia declarar `packageManager` npm;
  - o primeiro passo, `fresh`, repete depois da aprovação a consulta do job `supersede` (execuções deste fluxo em `main` com `run_number` maior) e, se existe uma mais nova, termina verde com um aviso, sem build; os outros passos só rodam com `steps.fresh.outputs.go == 'true'`. Para isso o job ganha `permissions` `actions: read` e `contents: read`. O passo usa só o token do job, nunca o `EXPO_TOKEN`.
- Testes: `apps/cli/test/android-release.test.js` (instalação pelo lockfile, conteúdo do lockfile, sem cache, passo `fresh`, permissões), `apps/cli/test/ios-release.test.js` (o mesmo, menos o conteúdo do lockfile) e `apps/cli/test/supersede.test.js` (o script do `fresh` começa com a mesma consulta do `supersede`, é igual nos dois fluxos, não grava nada nem compara SHA, e roda contra o `gh` falso).
- `docs/development.md` (iOS e Google Play) e `docs/google-play.md` descrevem os três pontos e como trocar a versão do `eas-cli`.

## Testes

Rodados nesta árvore (sobre `origin/main` 38f186e8), cada arquivo sozinho com `node <arquivo>`, Node 24.22.1:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/android-release.test.js` | 9/9 | 149/149 |
| `apps/cli/test/ios-release.test.js` | 8/8 | 123/123 |
| `apps/cli/test/supersede.test.js` | 8/8 | 138/138 |
| `apps/cli/test/changelog.test.js` | 9/9 | 42/42 |
| `apps/cli/test/deploy.test.js` | 67/67 | 1105/1105 |
| `apps/cli/test/promote.test.js` | 13/13 | 446/446 |
| `apps/cli/test/release.test.js` | 16/16 | 694/694 |
| `apps/cli/test/readme-pull.test.js` | 16/16 | 172/172 |
| `apps/cli/test/native.test.js` | 9/9 | 161/161 |
| `apps/cli/test/ci.test.js` | 15/15 | 369/369 |
| `apps/cli/test/update.test.js` | 80/80 | 1952/1952 |
| `apps/app/test/hardening.test.js` | 36/36 | 449/449 |
| `apps/app/test/eas-preview.test.js` | 12/12 | 129/129 |
| `apps/site/test/site.test.js` | 17/17 | 346/346 |

Cada teste novo falha sem a sua mudança (os dois fluxos alterados juntos, depois restaurados):

| Mudança desfeita | Falha |
|---|---|
| `npm install --global ... eas-cli@27.2.0` e `eas build` de volta | teste 3 de `android-release` e de `ios-release` |
| `cache: npm` de volta no lugar de `package-manager-cache: false` | teste 4 de `android-release` e de `ios-release` |
| só `package-manager-cache: false` removido | teste 4 de `android-release` e de `ios-release` |
| passo `fresh` removido | teste 6 de `android-release`, 5 de `ios-release`, 7 e 8 de `supersede` |
| `fresh` comparando com o SHA da ponta de `main` | testes 7 e 8 de `supersede` |
| lockfile sem `integrity` num pacote, com outro registro, com outra versão do `eas-cli`, ou `^27.2.0` no `package.json` | teste 5 de `android-release` |

- [x] `npm run lint`
- [x] `npm run demo` termina com `DEMO OK`
- [x] `npm ci --ignore-scripts` numa cópia de `.github/eas-cli` instala 527 pacotes e `node_modules/.bin/eas --version` imprime `eas-cli/27.2.0`.
- [x] `npm install --package-lock-only --ignore-scripts --save-exact eas-cli@<versão>` (o comando que a documentação manda usar para trocar a versão) atualiza o `package.json` e o lockfile, conferido numa cópia.
- [x] Nenhum travessão (U+2014) no texto novo. O único no diff está no lockfile gerado, no aviso de descontinuação que o npm copia do pacote `http-call`; ele não foi editado à mão.
- [x] `npm audit` na cópia de `.github/eas-cli`: 22 avisos (1 baixo, 15 moderados, 6 altos: `eas-cli`, `joi`, `minimatch`, `nanoid`, `node-forge`, `tar`), todos da árvore do próprio `eas-cli` 27.2.0, a mesma que uma instalação global resolve hoje, e todos corrigidos no `eas-cli` 27.11.0. A versão continua 27.2.0 neste PR; a troca segue a regra de `docs/development.md` (um build local antes).

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## O que continua devido

Nada abaixo roda na CI nem num agente: um envio só roda depois da aprovação do responsável no ambiente.

- [ ] A primeira execução aprovada de cada fluxo prova que o token do job lê as execuções (`actions: read`) no passo `fresh` e que o `eas` de `.github/eas-cli` põe o build na fila como antes.
- [ ] Um Re-run dos jobs com falha de uma execução antiga, aprovado, termina verde com o aviso do `fresh` e sem build no expo.dev. (Um Re-run de todos os jobs já parava no `supersede`.)
