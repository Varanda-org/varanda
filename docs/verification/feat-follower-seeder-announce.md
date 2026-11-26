# feat/follower-seeder-announce

Closes #67. Semeadores recebem diários de quem segue e de outros semeadores.

## O que mudou

- `packages/core/lib/announce-relay.js` (novo): o ritmo do `announce` repassado numa conexão. Balde de `RELAY_ANNOUNCE_BURST` = 5 anúncios, reposto a `RELAY_ANNOUNCE_RATE` = 4 por segundo, abaixo do balde do receptor (20 e 10/s). Um anúncio novo só vai para o canal quando nada nosso espera na fila de envio dele, então os anúncios não saem em rajada atrás do inventário. No máximo 4 anúncios ficam sem resposta ao mesmo tempo: uma vaga abre quando o par responde a chave (`admitted` ou `rejected`) ou depois de 30 s, então uma rede que segura mensagens e as solta juntas não entrega mais de 4 de uma vez. Cada chave no máximo uma vez por conexão, e no máximo `max` chaves anunciadas ou descartadas.
- `packages/core/lib/sync.js`: num `runSync` contínuo (nunca no `--once`), o seguidor anuncia aos semeadores verificados cada diário seguido ativo, com o certificado do bloco 0 lido do próprio armazenamento (sem esperar nem buscar). A lista de bloqueio, a revogação de emissores e o inventário do semeador são conferidos de novo na hora de cada anúncio. Um `rejected` de um diário seguido tira a chave da conexão; o de outra chave (um semeador manda `rejected` a todos os pares quando larga um diário) não conta no limite. As opções `announceFollows`, `relayBurst` e `relayRate` servem só para testes e para voltar atrás.
- `packages/core/lib/seeder.js`: um semeador anuncia a outro semeador (papel `seeder`, certificado válido para a chave Noise e para a associação) cada diário que serve. A condição é que o diário tenha passado no portão, tenha bloco presente, não esteja bloqueado nem com reconferência de revogação pendente, e que a lista não esteja retida. O certificado é o do bloco 0 que o portão julgou. O lado que recebe não mudou: lista própria, revogação, `seeder-full`, `storage-full`, portão do bloco 0 e cota decidem. As opções `announceRelay`, `relayBurst` e `relayRate` servem só para testes e para voltar atrás.
- Sem mudança no formato: a mensagem é o `announce` de sempre, então nós antigos continuam funcionando. `docs/protocol.md`, seção 5, ganhou "Relayed announces", e o README atualiza o limite "Relay de certificados".

## Não feito

- O nó do navegador (`packages/web-member`) não repassa anúncios. Ele sincroniza por um semeador só, então todo diário que segue veio de um semeador.
- O `sync --once` não repassa anúncios: ele termina assim que as metas valem.

## Critérios de aceite

- "Um diário chega a um semeador só por meio de um seguidor, com o autor desligado":
  - `packages/core/test/sync-relay.test.js` (a): a autora para, e um semeador que nunca a viu passa a servir o diário inteiro, anunciado pelo seguidor. Uma terceira pessoa baixa o diário só desse semeador.
  - `packages/core/test/seeder-relay.test.js` (a): o mesmo de semeador para semeador, sem nenhum membro conectado ao segundo.
- "Anúncios repetidos ou diários revogados não contornam orçamento nem listas":
  - `sync-relay.test.js`: (d) bloqueado e emissor revogado nunca são anunciados; (e) recusa do semeador anunciada uma vez só e sem derrubar o sync; (f) e (g) o ritmo padrão não estoura o balde, e sem ritmo o par é derrubado (`announce-rate`).
  - `seeder-relay.test.js`: (d) a lista de bloqueio do destino recusa e nada é guardado; (e) `seeder-full`, `storage-full` dentro do orçamento, e um anúncio repetido de uma chave já servida responde `admitted` sem cobrar nada a mais; (f) 25 diários com os limites padrão do destino, sem `peer-dropped`.

## Testes

Rodados no Node local, um arquivo por vez:

- `node packages/core/test/announce-relay.test.js`: 12/12 testes, 36/36 asserções.
- `node packages/core/test/sync-relay.test.js`: 8/8, 35/35 (duas vezes).
- `node packages/core/test/seeder-relay.test.js`: 6/6, 28/28. O caso (b)+(c) falha sem a regra de só retirar chave servida.
- Sem regressão nos arquivos vizinhos, rodados sozinhos: `sync.test.js` 43/43, `slots-e2e.test.js` 2/2, `blocklist-member.test.js` 6/6, `seeder.test.js` 29/29, `seeder-slots.test.js` 10/10, `seeder-storage-budget.test.js` 14/14, `blocklist-seeder.test.js` 17/17, `seeder-groups-cuts.test.js` 20/20, `sync-slots.test.js` 8/8, `seeder-discovery.test.js` 6/6, `seeder-stream.test.js` 20/20, `seeder-media.test.js` 9/9, `seeder-delete.test.js` 37/37, `seeder-dm.test.js` 17/17, `seeder-communities.test.js` 10/10, `sync-groups-2/4/5/8`, `apps/cli/test/seeder-topic.test.js`, `blocklist-e2e.test.js`, `moderation-e2e.test.js`, `seed-ops.test.js`.
- `npm run lint`: ok. `npm run demo`: `DEMO OK`.
- A suíte inteira roda na CI do GitHub (Node 20 e 24).

## Limites

- Sem conferência em aparelho: a mudança é só do protocolo e não tem tela. O app nativo usa o `runSync` contínuo do core, coberto pelos testes acima.
- Uma recusa passageira (`blocklist-pending`, `storage-full`, `seeder-full`, `timeout`) também tira a chave daquela conexão até ela ser refeita. O diário volta a ser anunciado na próxima conexão com aquele semeador.
- Não testado à parte: a reconferência de revogação que termina e volta a anunciar o diário no semeador.
