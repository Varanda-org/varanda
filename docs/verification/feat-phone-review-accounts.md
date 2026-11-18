# feat/phone-review-accounts

Parte de #46 (publicação na App Store). Conta de revisão para a Apple e o Google, que não têm um celular brasileiro: decisão do dono de 2026-11-18, em `docs/design.md` ("Contas de revisão").

## O que mudou

- `apps/cli/lib/account/phone-routes.js`: opção `review`, uma lista de chaves de membro. `verified()` responde verdadeiro para elas quando a verificação de celular está ligada, então todos os portões que usam `phoneChecked` (vínculo, troca de @nome, convites, push, lidas, páginas e Feira) passam, e o status responde `{ state: 'verificado' }` sem `proof`. Nada é gravado em `phone.json` e o emissor não assina atestado.
- `apps/cli/lib/account/server.js`: opção `phoneReview`, repassada às rotas.
- `apps/cli/lib/commands/account.js`: `VARANDA_PHONE_REVIEW` (até 4 chaves diferentes, separadas por vírgula, lida só com `VARANDA_PHONE_KEY`), linha de log `contas-de-revisao` no início, sem as chaves, e `account phone --waiting`, que lista até 10 chaves com idade confirmada e sem vínculo, da mais nova para a mais antiga, com `{ member, checkedAt }`. O comando só lê e não precisa da chave dos celulares.
- `apps/cli/lib/cli.js`, `README.md` (Ajuda, tabela de variáveis e "Conta de revisão"), `docs/protocol.md` (Help, status e portões), `deploy/seeder/compose.web.yaml` e `deploy/seeder/.env.example`.

## Testes

- `apps/cli/test/account-phone.test.js`
  - `phone review accounts: a listed key passes the phone gate with no number and no proof, any other still needs one`: status `verificado` sem `proof`, vínculo pelo `/account/finish` sem número (cert v2, sem linha em `phone.json`), troca de @nome, e uma chave fora da lista recebe `nenhum` e 403 `telefone-pendente`; o provedor nunca é chamado e nenhuma chave aparece num log.
  - `createPhoneRoutes: malformed options throw`: lista que não é array, chave maiúscula, curta ou não texto; desligado, uma chave da lista não conta como verificada.
- `apps/cli/test/account-phone-cli.test.js`
  - `readEnv: VARANDA_PHONE_REVIEW ...`: vazio, uma, duas com espaços e quatro chaves; ignorada com o recurso desligado; maiúscula, curta, vírgula sobrando, outro separador, repetida e cinco chaves recusadas sem ecoar a chave.
  - Os dois testes de `serve`: `contas-de-revisao` só com o recurso ligado, e a chave nunca aparece na saída.
  - `account phone --waiting`: 12 chaves com idade e uma vinculada, saída das 10 mais novas em ordem, a vinculada fora, com o lock do serviço tomado e sem alterar `age.json`; `--member`, `--username` e `--release` junto dão erro de uso. Loja vazia não imprime nada.
- `apps/cli/test/cli.test.js` e `apps/cli/test/deploy.test.js`: a linha nova da ajuda e a variável nova no compose e no `.env.example`.

## Falha sem a correção

Sem a linha `if (reviewKeys.has(member)) return true` em `verified()`, o teste da conta de revisão falha (status `nenhum` em vez de `verificado`, e o vínculo recebe 403 `telefone-pendente`). Restaurada, passa.

## Comandos

```sh
npm run lint
node apps/cli/test/account-phone.test.js
node apps/cli/test/account-phone-cli.test.js
node apps/cli/test/cli.test.js
node apps/cli/test/deploy.test.js
npm run demo   # DEMO OK
```

Além desses, rodaram localmente os arquivos de `apps/cli/test` que importam um módulo alterado (`phone-routes`, `server`, `commands/account`, `cli`) ou leem um documento alterado. A suíte inteira roda na CI do PR.

## Não rodado

- Nenhum aparelho. O fluxo da conta de revisão no app (status `verificado` sem atestado, reabrir o app depois de listar a chave) não foi conferido no iPhone nem no Android.
- Não foi conferido se o Didit aceita uma segunda verificação de idade da mesma pessoa, que a conta de revisão precisa.
- Nada foi implantado. A variável só vale no servidor depois do deploy e de `update.sh reconfigure`.
