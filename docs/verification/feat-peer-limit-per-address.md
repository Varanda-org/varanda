# feat/peer-limit-per-address

Fecha #32: vagas de conexão divididas por endereço, com prioridade para semeadores verificados e membros que provam ser donos de um diário certificado. Decisões do mantenedor: divisão justa com deslocamento (sem teto fixo por endereço), prova numa mensagem `prove` atrás de um bit de capacidade, e a entrada WebSocket incluída (endereço vindo do Caddy). Sem mudança nos Termos.

## O que mudou

- `packages/core/lib/peer-slots.js` (novo, sem módulos do Node): `addressGroup` (IPv4; IPv6 mapeado vira o IPv4; IPv6 por /64; o resto é `unknown`) e `createSlots`, a tabela de vagas. Com a tabela cheia, as cotas contam só as entradas sem proteção: um grupo com `n + 2` ou mais (sendo `n` o do recém-chegado) cede a sua entrada mais nova a qualquer idade; um endereço sem entrada desprotegida toma uma vaga com mais de 10 s (`PROBATION_MS`); um endereço reveza as próprias entradas com mais de 10 s. Grupos a um de distância nunca trocam entre si.
- `packages/core/lib/peer-proof.js` (novo): `signPeerProof` / `verifyPeerProof`, assinatura pela chave do diário sobre `'varanda-peer-proof-v1\n' + chave Noise do próprio membro + '\n' + diário`, e `MAX_PROOFS_PER_DIARY = 4`.
- `packages/core/lib/admission.js`: `CAP_PEER_PROOF = 8`, validação de `prove` e `Peer.badMessage()`.
- `packages/core/lib/seeder.js`: duas tabelas (swarm, `maxConnections`; externas, `maxExternal`), proteção de conexão externa local (`acceptStream({ local: true })`: as mais antigas ainda abertas, no máximo um quarto de `maxExternal` e pelo menos 1, contadas na hora de escolher quem sai; as outras são entradas comuns do endereço e herdam o lugar quando uma mais antiga fecha), de semeador verificado (só no swarm, uma conexão por chave Noise de semeador) e de membro com prova válida para diário servido, aceito e não bloqueado, `_onProve`, fila de provas que chegam com o diário no limite (a mais antiga ainda aberta herda a vaga de uma conexão que fecha), limite de tabela menor que 1 tratado como 1, motivo de descarte `connection-displaced`.
- `packages/core/lib/sync.js`: tabela de vagas no `runSync` (protege semeadores verificados) e o envio de `prove` a semeador verificado que oferece `CAP_PEER_PROOF`, só quando o membro também anunciaria o próprio diário.
- `packages/web-member/lib/sync.js`, `session.js`, `seeder-link.js`: o nó do navegador manda a mesma prova; com a identidade travada, segue sem prova.
- `apps/cli/lib/seed-ws.js`: `clientAddress(req)` (última entrada de `X-Forwarded-For` só quando a conexão TCP vem de loopback) e `isLocalClient(req)` (loopback sem `X-Forwarded-For`: um processo do próprio servidor, como os links de página do serviço de conta) passados a `acceptStream`; uma conexão deslocada fecha com 1013.
- `deploy/seeder/Caddyfile`: `header_up X-Forwarded-For {remote_host}` em `handle /seeder`.
- `docs/protocol.md` (seções 4, 5, 7 e riscos), `docs/design.md` (linha LGPD: o endereço só na memória).

## Testes

- `packages/core/test/peer-slots.test.js` (16 testes, 308 asserções): agrupamento de endereços, regras de deslocamento, proteção, `isProtected` que lança, "protected entries do not count toward their address, so its newcomers still get in", "groups one apart never swap their established entries", "an address with no slot takes an expired one; an address one behind does not".
- `packages/core/test/peer-proof.test.js`: ida e volta, adulteração, entrada malformada, diário Hypercore 11 (chave do manifesto).
- `packages/core/test/seeder-slots.test.js` (9 testes): endereço do testnet (127.0.0.1), enxurrada de um endereço contra outro, membros atrás de um endereço compartilhado que provam e mantêm a vaga, semeador com certificado válido (mantém a vaga só no swarm) e inválido, uma conexão protegida por chave de semeador, conexões externas locais mais antigas que mantêm a vaga até um quarto de `maxExternal` (a que fica mais antiga herda o lugar), regras do `prove` (ordem, papel, contagem, assinatura, dono, limite por diário, fila e promoção), tabela externa por /64, limite menor que 1.
- `packages/core/test/sync-slots.test.js` (8), `packages/core/test/slots-e2e.test.js` (2: membros atrás de um endereço compartilhado continuam sincronizando sob uma enxurrada de conexões sem prova; enxurrada de um endereço não toma as vagas de outro).
- `packages/web-member/test/sync-prove.test.js` (11), `packages/web-member/test/prove-real-seeder.test.js` (1, semeador real).
- `apps/cli/test/seed-ws-address.test.js` (5, com `isLocalClient`), `caddyfile.test.js`, `seed-ws-discovery.test.js`, `net.test.js`, `browser-safe.test.js`, `seeder-discovery.test.js` atualizados.

## Falha sem a correção

Cada caso trocou uma coisa, rodou o teste e restaurou o arquivo (conferido com `cmp`).

- Tabela do swarm trocada pelo teto antigo, ou um grupo só para todos: `seeder-slots` falha ("one address fills the table", "the other address holds a slot").
- Sem proteção: `seeder-slots` e `sync-slots` falham ("the seeder was never displaced"); `slots-e2e` falha ("both members keep their connections under pressure").
- Sem verificação da prova, sem o limite por diário, sem `CAP_PEER_PROOF` oferecido, sem `badMessage` exposto: `seeder-slots` falha em cada caso.
- No membro: sem checar a capacidade, o certificado do semeador ou o próprio certificado, `sync-slots` falha ("no prove without CAP_PEER_PROOF", "no prove to a seeder whose cert does not verify", "no prove when the member has no valid cert to announce"); sem a prova, `slots-e2e` falha.
- No navegador: as reversões de `sync-prove` falham, exceto duas que o código atual não deixa quebrar sozinhas (prova antes da verificação: o link não verificado é destruído no mesmo tick; segunda prova: um segundo hello já derruba a conexão).
- `seed-ws`: sem passar o endereço, sem `dropWrite` no `onRefuse`, ou com a conexão deslocada destruída na hora, `seed-ws-address` falha; sem o cabeçalho no Caddyfile, `caddyfile` falha.
- Revisão: com a regra anterior (entradas protegidas contando na cota do endereço, troca entre grupos a um de distância), os três testes novos de `peer-slots` falham ("the L newcomer is admitted inside A probation", 12 de 12 "only its own address rotates", "B, one behind A, only rotates its own entry").
- Sem a fila de provas: `seeder-slots` para em "waiting proof takes the freed place". Sem tratar o limite menor que 1: `TypeError: limit must be an integer >= 1`.
- Auditoria: com a proteção de semeador valendo também em conexão externa, `seeder-slots` falha (o recém-chegado é recusado e o cliente para em "stream fechado antes do handshake"); sem o limite de uma conexão protegida por chave de semeador, falha "a second one of the same key, while the first is live"; sem a proteção da conexão local, falham "the oldest external streams from this host keep their slots, up to a quarter of maxExternal" e a checagem local do teste por chave; sem o teto de um quarto, o mesmo teste para em "tempo esgotado: displaced"; com a proteção decidida uma vez na entrada (sem herança) ou sem tirar do conjunto a conexão que fecha, falha "the local stream that became the oldest is protected"; com o `seed-ws` sem passar `local`, `seed-ws-address` falha ("direct loopback client: local").

## Comandos

```sh
npm run lint
node packages/core/test/peer-slots.test.js
node packages/core/test/peer-proof.test.js
node packages/core/test/seeder-slots.test.js
node packages/core/test/sync-slots.test.js
node packages/core/test/slots-e2e.test.js
node packages/web-member/test/sync-prove.test.js
node packages/web-member/test/prove-real-seeder.test.js
node apps/cli/test/seed-ws-address.test.js
npm test -- --affected=origin/main
npm run demo
```

## O que não foi conferido

- Caddy real: o teste lê o Caddyfile, mas nenhum Caddy rodou. Com `header_up X-Forwarded-For {remote_host}` o Caddy põe o endereço do cliente no fim do cabeçalho; o semeador usa só a última entrada, então funciona tanto se o Caddy substituir quanto se acrescentar. O operador confere depois do deploy (#224).
- Aparelhos: nenhuma tela mudou; o app só manda a prova pelo nó (testes do `web-member` e do core).
- Rede pública: os testes usam a DHT local presa a 127.0.0.1, onde todo socket do swarm tem o mesmo endereço; endereços diferentes vêm de `addressOf` (só em teste) e do `address` de `acceptStream`. No swarm o endereço é o que o hyperdht dá ao `rawStream.remoteHost`, tirado do handshake da DHT, e o semeador não confirma que os pacotes vêm dele: os grupos do swarm são o melhor possível, e o que mantém membros certificados e semeadores é a proteção (veja `docs/protocol.md`, riscos que restam).
