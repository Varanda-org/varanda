# Imagem do semeador sem o código do web-member (branch fix/seeder-image-web-member)

A atualização do servidor para 99b079dd (seq 641, canal stable) falhou: o semeador não respondeu 200 em `/health` em 180 s, e o `update.sh` voltou para 3636e3f7 e anotou a versão em `recusadas`. O #876 fez `apps/cli/lib/account/review-account.js` exigir `@varanda/web-member/lib/passkey` e `lib/recovery` ao carregar. `commands/account.js` e `account/server.js` carregam esse arquivo, e `bin/varanda.js` carrega todos os comandos ao abrir. A imagem (`deploy/seeder/Dockerfile`) não copiava `packages/web-member`, então todo comando parava com `Cannot find module '@varanda/web-member/lib/passkey'`, `seed` inclusive. O `npm ci` da imagem já instalava as dependências desse workspace (o `apps/cli` depende dele); faltava só o código.

## O que muda

- **`.dockerignore` e `deploy/seeder/Dockerfile`.** A imagem passa a levar `packages/web-member/package.json` e `packages/web-member/lib` (44 arquivos, cerca de 1,8 MB), nada mais desse workspace. O `npm ci` não muda.
- **`apps/cli/lib/account/review-account.js`.** `keyPairFromPrf` e as funções do código de recuperação são exigidas dentro de `createReviewAccount`, como `commands/page.js` já faz com `core-dm`. Nenhum comando carrega o web-member ao abrir, então o `seed` não depende desse código.
- **Teste novo `apps/cli/test/seeder-image.test.js` e `test/helpers/image-files.js`.** O helper, carregado com `node -r`, lê o `.dockerignore` da raiz e recusa carregar qualquer arquivo do repositório que a imagem não leva (fora de `node_modules`, que o `npm ci` preenche). O teste roda `varanda --help` assim, confere que nenhum módulo de comando nem `account/server.js` carrega o web-member ao abrir e que o helper recusa o que a imagem deixa de fora. `account-review.test.js` passa a rodar a CLI e o serviço `account` com o mesmo helper.

## Testes

- `node apps/cli/test/seeder-image.test.js`: 3/3. Sem a correção (o `review-account.js` e o `.dockerignore` da `main`), o teste 1 falha com `Cannot find module '@varanda/web-member/lib/passkey' (packages/web-member/lib/passkey.js is not in the seeder image)`, o mesmo erro do servidor. Só com o `.dockerignore` corrigido, o teste 2 falha (o web-member carrega ao abrir). Só com o carregamento tardio, o teste 3 falha, e `account-review.test.js` falha no `account review`. Conferido nos três casos.
- `node apps/cli/test/account-review.test.js` 10/10 e `node apps/cli/test/release-bundle.test.js` (a lista exata de regras de admissão do `.dockerignore` agora inclui as duas do web-member).
- Reprodução sem Docker: numa pasta com só os `package.json` e o `package-lock.json` que o estágio `deps` copia, `npm ci --omit=dev --workspace apps/cli --ignore-scripts` e os arquivos que o `.dockerignore` admite. Com o código da `main`, `node apps/cli/bin/varanda.js seed --help` para com o erro acima. Com a correção, todos os comandos carregam e `account key`, `account cert add` e `account review --username revisao` rodam; o código impresso, aberto com o `lib/recovery.js` e o `lib/passkey.js` da própria pasta, devolve a mesma chave.
- Na raiz: `npm run lint` e `npm run demo`. A suíte afetada roda na CI do PR.

## Fora desta branch

- A imagem não foi construída com Docker localmente. A CI de release constrói a imagem; a conferência final é o `update.sh apply` no servidor depois da promoção.
- O `seed` com a rede de verdade não roda nos testes (DHT pública fora dos testes). O teste confere o carregamento de todos os módulos dos comandos, que é o que o #876 quebrou.
