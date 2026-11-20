# Página pública na web para uma Página (branch feat/page-web-share)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`, `pages-writer.js`: ações de Página `post-share` `{ seq }` (responde `{ shareSeq, created }`) e `post-unshare` `{ seq }` (responde `{ ok: true, changed }`), só para o dono e os administradores, com as regras do `post.share` / `post.unshare` da pessoa: só uma publicação viva do próprio diário da Página, nunca o bloco 0, o limite `POST_SHARES_PER_DIARY` contando os compartilhamentos apagados, no máximo 8 lápides por pedido (`MAX_UNSHARE`, um novo pedido termina o resto). Encerrar a Página apaga os compartilhamentos. A leitura `status` responde `shared`.
- `packages/core/lib/seeder.js`, `name-index.js`: `postPublic` deixa de recusar o diário de uma Página. Uma Página encerrada ou que mudou de chave continua fora, e também uma cujo `page-close` ou `page-moved` não se confere mais (emissor revogado depois): o índice de nomes guarda isso e a resposta é `null`, antes e depois das leituras.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`, `apps/app/src/pages.js`: as duas ações nas listas fixas.
- `apps/app/src/pageShare.js` (novo), `postShareCompose.js`, `screens/Publicar.js`, `ui/PostShareSheet.js`, `App.js`, `screens/ARua.js`, `screens/Conversa.js`: a caixa no Publicar como Página (uma só ação `post-share` depois da publicação, nunca reenviada) e a folha "Página pública na web" em modo Página nas publicações da própria Página.
- `docs/protocol.md` (seções 2, 12 e 16), `docs/rpc.md` (5.84), `docs/app.md`.
- `apps/app/src/legal.js`, `packages/core/lib/terms.js`: Termos e Política versão 86, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-share.test.js
node apps/cli/test/pages-writer.test.js
node apps/cli/test/account-pages.test.js
node apps/cli/test/pages-moment.test.js
node packages/core/test/seeder-post-page.test.js
node packages/core/test/seeder-post-public.test.js
node packages/core/test/name-index.test.js
node apps/cli/test/seeder-post-http.test.js
node packages/core/test/page-proof.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/pageShare.test.js
node apps/app/test/postShareCompose.test.js
node apps/app/test/postShareRow.test.js
node apps/app/test/postShare.test.js
node apps/app/test/pages.test.js
node apps/app/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Precisa da página pública ligada na instalação (`VARANDA_POSTS_ORIGIN`).

- [ ] Agindo como uma Página, publicar com "Publicar também na web" marcada: a publicação abre em `/p/` sem conta. Pendente.
- [ ] No menu de uma publicação da Página, "Página pública na web" mostra o estado certo, publica e retira; depois de retirar, `/p/` volta para a página inicial. Pendente.
- [ ] Numa publicação de outra Página ou de uma pessoa, agindo como a Página, o menu não oferece "Página pública na web". Pendente.
- [ ] Como pessoa, a caixa e o menu continuam como antes. Pendente.
- [ ] Encerrar a Página: a publicação some de `/p/`. Pendente.

## Não verificado / limites conhecidos

- A folha em modo Página e o `useMemo` do `App.js` têm só testes de texto do código, sem teste de renderização.
- Um compartilhamento de uma publicação apagada depois não sai com `post-unshare`; quem lê não mostra a publicação apagada, e encerrar a Página apaga o compartilhamento.
- O serviço de conta guarda a chave da Página, então a associação poderia compartilhar uma publicação da Página sem pedido de um administrador, a mesma confiança de toda escrita da Página.
