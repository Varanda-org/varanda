# Sobras da exclusão de publicações (PR fix/sobras-exclusao-conversa)

Fecha a #228. O que mudou:

- Conversa (#218): apagar uma resposta (na Conversa, no Diário ou em A Rua) a tira também das Conversas mais antigas ainda abertas na pilha e baixa a contagem do pai, sem recarregar. `announceDeleted` (`apps/app/src/screens/Conversa.js`) avisa cada Conversa montada, e `dropDeleted` tira a resposta das listas dela. Uma Conversa que não mostra a publicação não muda, e a publicação focal de uma Conversa mais antiga não entra aqui.
- Conversa, citação e contagem (revisão): uma Conversa mais antiga que só mostra uma citação da publicação apagada também limpa a citação (o texto e a prévia saem sem recarregar), e uma resposta mostrada sob a publicação focal baixa a contagem da focal. `announceDeleted` roda antes de `forgetOwnReplies`, para a Conversa mais antiga ainda achar a resposta enviada dali e baixar a contagem do pai.
- Leitura de um bloco que não se lê (#222, `packages/web-member/lib/sync.js`): depois das 5 releituras rápidas (250 ms) de um bloco que pode ser lápide, a releitura continua a cada 30 s (`TOMB_RETRY_SLOW_MS`) enquanto ele não for lido, sem esperar outro evento. O comprimento continua sem cobri-lo.
- Réplica seguida cuja leitura inicial falha (#222): além do `errorsSoft` do resultado de `--once`, a sincronização contínua emite `{ event: 'unreadable', key }`. A réplica segue parada nesta execução, de propósito (falha fechada).

Descartado, com o motivo:

- Denúncia de uma publicação apagada antes da triagem (#218, resposta 404 e `ausente`): o serviço de conta guardar o bloco assinado ao receber a denúncia é reter conteúdo de terceiros por decisão do operador, e isso muda a seção LGPD de `docs/design.md`. Com a publicação apagada, `ausente` é o resultado honesto e a denúncia segue para a fila humana. Virou a issue #598, fora deste PR.
- Exclusão incerta na Conversa (#218): a publicação pode seguir visível até a releitura (`recheck`); apagar de novo é idempotente, e o app não repete o pedido por conta própria (princípio do AGENTS.md).
- Falha de leitura abaixo do comprimento já anunciado (#222): o bloco está guardado, só a leitura falhou. Um `have` menor faria o semeador reenviar o que já está no aparelho. A próxima conexão manda o comprimento presente já reduzido (`inventory()`).
- Réplica parada depois da leitura inicial falhar (#222): numa falha persistente do armazenamento, reabrir a varredura em laço não conserta nada, e o teste `a followed diary whose initial scan fails reports it once and opens no download` fixa a falha fechada. Recarregar tenta de novo.
- `docs/app.md`: o texto "ainda não pode ser apagada" já não existe na `main`; a exclusão está descrita como funciona hoje.

1. [ ] Android e iOS: abrir uma publicação, tocar numa resposta para abrir a Conversa dela, apagar uma resposta lá, voltar: a Conversa de baixo não mostra mais a resposta e a contagem do pai baixou (não realizada ainda).
2. [ ] Apagar uma resposta própria no Diário com uma Conversa aberta por baixo, voltar: a resposta não está lá (não realizada ainda).
3. [ ] Uma Conversa de baixo sem a publicação apagada continua igual (não realizada ainda).

Testes: `apps/app/test/conversaScreen.test.js` (confere o código, não monta a tela) e `packages/web-member/test/delete-purge.test.js`.
