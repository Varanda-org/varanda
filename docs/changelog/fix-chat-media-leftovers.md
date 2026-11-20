- Sobras da mídia nas conversas, primeira parte da #443 (PR `fix/chat-media-leftovers`): semeador, nó e serviço de conta. Verificação em `docs/verification/fix-chat-media-leftovers.md`.

### Corrigido

- Semeador: cada blob de mídia de conversa ganha um diário `acks` ao lado dos quadros, e o `meta.json` passa à versão 2. Depois de um reinício, um quadro confirmado que sumiu, ou um selo ou ficha alterados no disco, quebram o blob em vez de servi-lo, e a ficha continua gasta. Um blob da versão 1 abre como antes. Voltar a uma versão anterior apaga os blobs gravados por esta (as fichas continuam gastas), então quem enviou mídia nesse intervalo precisa enviá-la de novo.
- Semeador: uma falha de disco no meio de um envio não quebra mais o blob no reinício nem deixa um quadro fora da conta.
- Semeador: um blob vencido deixa de ser lido e de aceitar quadros antes da varredura; um envio para ele varre primeiro e recomeça o blob.
- Mensagens diretas: um pedido de mídia por vez em cada conexão com o semeador, não por canal, então uma resposta atrasada nunca responde a um canal reaberto.
- Semeador: o selo de postagem servido é o do arquivo de chaves que ficou no disco, mesmo quando outro processo grava logo depois deste.
- Serviço de conta: o tempo máximo de um pedido cobre o maior anexo de denúncia no ritmo mínimo que o prazo dele aceita (cerca de 17 s, antes 10 s). O corpo das outras rotas continua cortado 10 s depois de começar a ser lido.
- Serviço de conta: cada membro tem no máximo 8 sessões vivas de GIF, de prévia de link e de música; uma nova encerra a mais antiga, então poucos membros não enchem a tabela de 10000.
- Prévia de link: um nome que o serviço recusa conta no limite diário, como qualquer outra prévia que falha.

### Adicionado

- Laboratório hospedado: a busca de GIF fica ligada, com um provedor simulado no próprio laboratório (`apps/cli/scripts/gif-stub.js`, imagens de uma cor, sem chave nem rede externa).
