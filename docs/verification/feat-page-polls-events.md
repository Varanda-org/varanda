# Enquetes, eventos e votos da Página (branch feat/page-polls-events)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`: a ação `post` da Página aceita `poll` ou `event` numa publicação raiz, montada pelo mesmo `postRecord` da pessoa; nunca os dois, nunca com mídia ou prévia, e nunca em resposta ou citação. O texto, as opções da enquete e o título e o local do evento passam pela lista de termos (`termo-recusado`). Nova ação `choice` `{ to, pick }` grava o mesmo `choiceRecord` da pessoa; `pick: null` retira o voto. No diário da própria Página, o alvo tem de ser uma enquete viva com aquela opção, ou um evento; num diário de outra pessoa, só a forma é conferida, e quem lê ignora um voto que a publicação não tem. O `status` da Página traz `picked`: para cada alvo, os votos desde a última retirada, do mais novo ao mais antigo (os 1024 alvos mais novos); o app conta o primeiro que a enquete tem, como quem lê. Encerrar a Página apaga todos os votos (`choice` em `CLOSE_DELETES` e em `DELETABLE` do escritor); a ação `delete` continua recusando um voto, como para a pessoa.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`, `apps/app/src/pages.js`: `choice` entra nas listas de ações da Página.
- `apps/app/src/screens/Publicar.js`, `pagePost.js`: como Página, a tela Publicar publica enquete e evento com os mesmos limites da pessoa. Um envio incerto é refeito só com um toque.
- `apps/app/src/ui/PollCard.js`, `EventCard.js`, `pageChoice.js`, `screens/Conversa.js`, `ARua.js`: agindo como Página, o cartão mostra o voto da Página e vota pela ação `choice`; a enquete e o evento de uma publicação da Página aparecem para quem lê. O link na web de uma publicação da Página continua desligado (próximo PR).
- `apps/app/src/legal.js`: Termos e Política versão 80, com novo aceite. A lista de termos cobre as opções da enquete e o título e o local do evento, e o diário público da Página inclui enquetes, eventos, votos e confirmações de presença.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-choice.test.js
node apps/cli/test/account-pages.test.js
node apps/cli/test/pages-writer.test.js
node packages/core/test/page-proof.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/pages.test.js
node apps/app/test/pageChoice.test.js
node apps/app/test/pagePost.test.js
node apps/app/test/pollDraftGuard.test.js
node apps/app/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Como Página, publicar uma enquete: o seguidor vê a enquete e vota. Pendente.
- [ ] Como Página, publicar um evento: o seguidor vê o evento e confirma presença. Pendente.
- [ ] Como Página, votar numa enquete de uma pessoa, trocar o voto e retirar. Pendente.
- [ ] Como Página, confirmar presença num evento. Pendente.
- [ ] Voltar a agir como a própria pessoa: o cartão mostra o voto da pessoa, não o da Página. Pendente.
- [ ] Uma opção com termo bloqueado é recusada com aviso. Pendente.

## Não verificado / limites conhecidos

- Não conferido em aparelho.
- Um voto da Página numa publicação de outro diário só tem a forma conferida pelo serviço.
- O `status` traz só os 1024 votos mais novos: um voto mais antigo aparece como "sem voto" até a Página votar de novo.
- Um nó do aparelho sem instalação hospedada continua sem enquete e evento como Página, como para a pessoa.
