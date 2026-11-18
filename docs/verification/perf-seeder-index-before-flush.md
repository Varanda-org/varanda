# Índice antes do anúncio na DHT (PR perf/seeder-index-before-flush)

Os testes cobrem a regra em `packages/core/test/seeder-serve-early.test.js`: com o flush do tópico de encontro preso, o índice já responde `indexing: false` e `complete: true`; o `ready` sai antes do anúncio dos núcleos, que entra depois com `cores-joined`; uma falha nesse anúncio vira `cores-join-failed` e o semeador continua servindo. O que só o servidor de verdade mostra está abaixo, num servidor em modo pull, depois de `sudo /opt/varanda-release/current/update.sh apply` com uma versão que traz esta mudança.

- [ ] 1. `sudo /opt/varanda-release/current/update.sh compose logs --since 10m seeder | grep '"event":"ready"'`. Esperado: `phases.flushMs` e `totalMs` bem menores que os 68 s e 69 s de 2026-11-17, e `acceptingMs` parecido com antes (cerca de 1 s).
- [ ] 2. `sudo /opt/varanda-release/current/update.sh compose logs --since 10m seeder | grep '"event":"cores-joined"'`. Esperado: uma linha com `topics` perto do número de diários, mídias e grupos guardados e `ms` com o tempo do anúncio em segundo plano. Nenhuma linha `cores-join-failed`.
- [ ] 3. Logo depois da atualização, abra no app a Varandinha de um vizinho e a aba Pessoas. Esperado: "A varanda ainda está sendo montada" some em poucos segundos depois de o app reconectar, sem esperar o minuto do anúncio.
- [ ] 4. Depois de `cores-joined`, publique de outro aparelho e confira que a publicação chega como antes (o anúncio por diário continua valendo, só não segura mais o `ready`).
