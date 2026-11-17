# Momentos da Página (branch feat/page-moments)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`, `pages-writer.js`: nova ação `moment` da Página, com a mesma entrada do `moment.create` da pessoa (`{ text, media, music? }`), em que `media` é o item que o aparelho recebeu de `moment.putMedia` (um blob anônimo). O texto passa pela lista de termos. A ação `delete` aceita um momento vivo da Página, e encerrar a Página apaga os momentos dela (`moment` em `DELETABLE` do escritor e na lista do encerramento). Contrato em `docs/rpc.md` 5.84 e `docs/protocol.md` seção 12.
- `packages/core/lib/page-proof.js`, `packages/rpc/lib/methods.js`, `apps/app/src/pages.js`: `moment` entra nas listas de ações da Página; `pageMomentOp` e `pagesMoment` montam o pedido.
- `apps/app/src/actingAs.js`, `App.js`: abrir o compositor de Momento deixa de trocar a identidade para a pessoa (`enterMoment` e `leaveMoment` saíram). O momento sai em nome de quem está agindo.
- `apps/app/src/pageMoment.js`, `screens/Publicar.js`: como Página, o modo Momento fica disponível; a mídia sobe com `moment.putMedia`, como a pessoa, e o envio usa `pagesMoment` no lugar de `moment.create`. Só vai o item que `moment.putMedia` respondeu nesta abertura do compositor, para a Página que está agindo; trocar de identidade, publicar ou descartar o rascunho esquece o item. Um envio incerto trava o rascunho: `Tentar de novo` reenvia o mesmo pedido assinado, uma vez por toque. A fila offline continua só da pessoa.
- `apps/app/src/screens/Momentos.js`: agindo como a Página, o momento dela tem **Apagar** pela ação `delete` da Página. O comportamento da pessoa não muda; reagir e responder não aparecem no momento da própria Página.
- `apps/app/src/legal.js`: Termos e Política versão 82, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-moment.test.js
node apps/app/test/pages.test.js
node apps/app/test/pageMoment.test.js
node apps/app/test/actingAs.test.js
node apps/app/test/momentosScreen.test.js
node apps/app/test/videoCompose.test.js
node packages/rpc/test/methods.test.js
node packages/core/test/page-proof.test.js
node apps/app/test/legal.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Como Página, publicar um momento com foto. Pendente.
- [ ] Como Página, publicar um momento com vídeo. Pendente.
- [ ] Como Página, publicar um momento com música. Pendente.
- [ ] O seguidor vê o momento da Página. Pendente.
- [ ] Apagar o momento como Página. Pendente.
- [ ] Trocar de identidade com o compositor aberto: a foto escolhida é enviada de novo para a nova identidade, nunca reaproveitada. Pendente.
- [ ] Voltar a agir como pessoa: o compositor de Momento publica como a pessoa. Pendente.

## Não verificado / limites conhecidos

- Não conferido em aparelho.
- Risco residual: quando o aparelho compra selos logo antes de enviar a mídia, o semeador que recebe o envio pode ligar o momento da Página à pessoa administradora que o publicou (a compra de selos passa pelo vínculo identificado). Quem lê o diário da Página não aprende nada disso.
- O serviço não confere que a mídia veio deste aparelho: confere só a forma do descritor. Uma administradora ou um administrador com um cliente modificado pode publicar o descritor de outro momento público, como já pode no diário de uma pessoa.
- Um nó do aparelho sem instalação hospedada continua sem Momento, como para a pessoa.
