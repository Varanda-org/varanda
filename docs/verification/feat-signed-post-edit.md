# feat/signed-post-edit

Refs #23. Correção de publicação por substituição assinada.

## O que mudou

- `packages/core/lib/records.js`: registro novo `post-edit` `{ type, seq, text, at }`, chaves exatas, sem campo de autor (a assinatura do Hypercore do diário é a autoridade). `seq` aponta para um bloco anterior do mesmo diário.
- `packages/core/lib/post-edit.js` (puro): a edição viva e válida de maior seq de bloco vence; `at` nunca decide. Edição apagada cai para a anterior; publicação apagada não recebe edição; enquetes e eventos não se editam. Só `text` muda, e `preview` sai quando o link deixa o texto.
- Escritores (`packages/core/lib/member.js`, `packages/web-member/lib/member-ops.js`): um append com a edição nova e as lápides das edições vivas anteriores, depois a limpeza desses blocos. O bloco da publicação nunca é apagado nem limpo. `post.delete` também apaga as edições vivas no mesmo append.
- Leitores: `feed.read`, `peek.read` e `log.read` (core e web) mostram o texto atual com `edited: true`. O semeador guarda um ponteiro por publicação; `postPublic` falha fechado quando a edição mais alta não serve ou quando o mapa estourou o teto. A página pública mostra "editado".
- RPC `post.edit` (docs/rpc.md 5.181), `node.info.postEdit`.
- App: "Editar" no menu de uma publicação própria no Diário (só quando `node.info.postEdit`), folha "Editar publicação" com ajuda atrás do (i), marca " · editado" na hora em A Rua e no Diário.

## Testes

- `packages/core/test/post-edit.test.js`: ordem (bloco mais alto vence mesmo com `at` anterior; ordem de entrada irrelevante), falsificação (edição de outro diário não toca a publicação), lápides, alvos que não se editam, limites do texto, `editPlan`, entrada hostil.
- `packages/core/test/records.test.js` e `compat.test.js`: formato e leitor antigo (um leitor que ignora `post-edit` continua mostrando o original).
- `packages/core/test/post-edit-sync.test.js`: dois nós por DHT local; a versão converge depois da sincronização, o bloco da publicação continua byte a byte igual, o diário só cresce, `fork` continua 0.
- `packages/core/test/session-post-edit.test.js` e `packages/web-member/test/post-edit.test.js`: o RPC nos dois nós, recusas sem escrita, `changed: false`, apagamento leva as edições, convergência entre dois nós web por um semeador local.
- `packages/core/test/seeder-post-public.test.js` e `apps/cli/test/post-page.test.js`: página pública com o texto novo e "editado".
- App: `postActions`, `postEdit`, `vitrine`, `help`, `diarioSnapshot`, `postRowLayout`, `platformGate`.

## Comandos

```sh
npm run lint
node packages/core/test/records.test.js
node packages/core/test/compat.test.js
node packages/core/test/post-edit.test.js
node packages/core/test/post-edit-sync.test.js
node packages/core/test/session-post-edit.test.js
node packages/core/test/session.test.js
node packages/core/test/seeder-post-public.test.js
node packages/core/test/delete-session.test.js
node packages/core/test/delete-e2e.test.js
node packages/core/test/feed.test.js
node packages/core/test/peek.test.js
node packages/rpc/test/methods.test.js
node packages/rpc/test/sizes.test.js
node packages/web-member/test/session.test.js
node packages/web-member/test/post-edit.test.js
node apps/cli/test/post-page.test.js
node apps/cli/test/commands.test.js
node apps/cli/test/cli.test.js
node apps/app/test/postActions.test.js
node apps/app/test/postEdit.test.js
node apps/app/test/vitrine.test.js
node apps/app/test/help.test.js
node apps/app/test/diarioSnapshot.test.js
node apps/app/test/postRowLayout.test.js
node apps/app/test/platformGate.test.js
npm run demo
```

Todos passaram localmente; a suíte inteira roda na CI do PR.

## Ficou de fora

- `diary.peek` devolve o bloco como foi escrito: o pai de uma resposta, uma citação e o original de uma republicação lidos por ele mostram o texto original (docs/rpc.md 5.27). Aplicar a edição ali exige o semeador indicar a seq da edição.
- O índice de tópicos e os avisos continuam lendo o texto original.
- Conferência em aparelho (Android, iOS) e no PWA não foi feita.
