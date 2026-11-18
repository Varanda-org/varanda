# Reações nas Conversas de uma Página (branch feat/page-dm-reactions)

## O que mudou

- `packages/rpc/lib/dm-budget.js`, `packages/rpc/index.js`: mensagens internas v11 (as chaves da v4) e v12 (as chaves da v5), e `DM_INNER_DIGEST_VERSIONS` igual a `[3, 11, 12]`: as três são assinadas pelo resumo, com validade.
- `packages/core/lib/dm.js`: monta, assina e lê v11 e v12; uma v11 ou v12 vencida ou com assinatura falsa é descartada.
- `packages/rpc/lib/methods.js`: `dm.pageDraft` com kind `react` (exatamente `to`, `target` e `emoji`; `emoji` vazio tira a reação) e `moment` numa msg de um só emoji, sem resposta, mídia, cartão nem encaminhamento. `dm.react` continua sem `page`.
- `packages/web-member/lib/dm.js`, `packages/web-member/lib/session.js`: a recusa "conversas com uma Página não têm reações" saiu; a Página guarda as reações v4 e v5 das pessoas e rascunha v11 e v12; `dm.pageSend` envia o rascunho assinado.
- `apps/app/src/dm-screen.js`: `dmReactionGate` não esconde mais as reações numa conversa com Página nem agindo como Página; `pageDmClient` leva `dm.react` para `dm.pageDraft` kind `react` e `moment` para a msg.
- `apps/app/src/screens/Mensagem.js`: a reação usa o cliente da conversa (pessoa ou Página); uma reação da Página sem confirmação guarda o reenvio dos mesmos bytes assinados e só o usa com um toque no mesmo emoji.
- `apps/app/src/screens/Momentos.js`, `apps/app/src/momentReaction.js`: agindo como Página, a reação ao momento de uma pessoa sai pela Página; sem confirmação, "Tentar de novo" reenvia os mesmos bytes assinados.
- `docs/protocol.md` (seção 11), `docs/rpc.md`, `docs/app.md`.
- `apps/app/src/legal.js`, `packages/core/lib/terms.js`: Termos e Política versão 92, com novo aceite.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node packages/core/test/dm.test.js
node packages/core/test/terms.test.js
node packages/rpc/test/methods.test.js
node packages/rpc/test/dm-budget.test.js
node packages/web-member/test/dm.test.js
node packages/web-member/test/page-dm.test.js
node apps/app/test/dmReactions.test.js
node apps/app/test/pageReactions.test.js
node apps/app/test/momentosScreen.test.js
node apps/app/test/vitrine.test.js
node apps/app/test/platformGate.test.js
node apps/app/test/legal.test.js
node apps/site/test/legal.test.js
```

## Conferir no app

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Precisa de uma Página com conversas abertas e de uma pessoa que a segue, com nós já atualizados.

- [ ] Como pessoa, numa conversa com a Página: reagir a uma mensagem da Página, trocar o emoji e tirar. A Página vê a ficha. Pendente.
- [ ] Agindo como a Página, na mesma conversa: reagir a uma mensagem da pessoa, trocar e tirar. A pessoa vê a ficha. Pendente.
- [ ] Como pessoa, reagir a um momento da Página; agindo como a Página, reagir a um momento da pessoa. A bolha de reação aparece nas duas conversas. Pendente.
- [ ] Agindo como a Página, sem rede no meio do envio: a ficha fica com "Não deu para confirmar a reação." e nada é reenviado sozinho; um toque no mesmo emoji reenvia uma vez. Pendente.
- [ ] Uma mensagem antiga da Página, de antes dos resumos, continua sem fichas. Pendente.

## Não verificado / limites conhecidos

- Não há teste de nó para a reação v12 da Página ao momento de uma pessoa; a v12 tem teste no core e o caminho do app tem teste puro.
- As telas têm testes de texto do código e de funções puras, sem teste de renderização; nada foi rodado em aparelho.
- Implantação: este build traz juntos os leitores (`openInner` do core, o pull do nó do navegador, a loja da Página) e o único remetente, os controles de reação da Página no app sobre `dm.pageDraft`, então a web e o PWA leem e enviam a partir da mesma implantação. Um app nativo ou nó de antes dele ignora v11 e v12 sem mostrar nada e sem erro até ser atualizado.
- Revisão fixável: quem administra a Página com um app modificado pode assinar uma reação com `rev` igual a `DM_REACT_REV_MAX`. Ela vence qualquer outra reação da Página àquela mensagem, e o nó recusa o rascunho seguinte ("limite de reações para esta mensagem atingido"), então a reação fica presa até o fim da conversa. Só afeta a reação da própria Página, nunca a da pessoa; nenhum código muda nesta branch.
- Uma mensagem que uma Página movida recebeu na chave antiga, aberta pela caixa legada trazida, fica sem resumo: a Página não reage a ela, porque a pessoa a guarda na conversa com a chave antiga. Uma reação a um momento da chave antiga, de uma pessoa (v5) ou de outra Página (v12), é descartada.
- Reação da Página incerta, depois um bloqueio, depois outro emoji: as revisões rascunhadas vão embora com o bloqueio, então o rascunho seguinte pode sair com o mesmo `rev` da reação incerta. Se as duas chegarem, quem lê desempata pelo `id` maior, como em qualquer empate de `rev`.
