# refactor/dm-engine-identity

Refatoração interna, sem mudança de comportamento (parte da #352). `createDmEngine` aceita `identity` com leitores opcionais (`cert`, `memberBlocks`, `blocklist`, `follows`); sem eles, lê do `storage` como antes. Prepara o nó core para usar o mesmo motor de Conversas, com os dados da identidade no próprio armazenamento.

- `packages/web-member/test/dm.test.js`: 80 testes e 777 asserções antes, 81 e 787 depois. O teste novo ("an injected identity is what the engine reads") mostra que o certificado, a lista de bloqueio da associação, os bloqueios da pessoa e os seguidos vêm de `identity`. Sem o leitor de `blocklist` no motor, a asserção dele falha (786/787).
- O resto da suíte de `packages/web-member` mantém as contagens por arquivo (peek e sync-gate variam com a carga da máquina, antes e depois).
- Como rodar: `node packages/web-member/test/dm.test.js` e `npm test -w packages/web-member`.
