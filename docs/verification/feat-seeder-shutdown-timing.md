# Medição do desligamento do semeador (branch feat/seeder-shutdown-timing)

Mudança: só medição, sem mudança de comportamento. Os eventos `ws` e `ready` do log JSON de `seed` ganham `at` (instante absoluto em ms desde 1970) e, em SIGTERM, o evento `stopped` registra `drainMs` (do sinal ao fim do drain do WebSocket), `closeMs` (do sinal ao fim do fechamento do armazenamento) e `stopListeningAt` (instante em que a escuta WebSocket parou). Com isso, uma implantação dá: (a) o tempo de fechamento C = `closeMs` do processo antigo; (b) o tempo da porta sem escuta = `ws.at` do processo novo menos `stopListeningAt` do antigo. Sem `--ws-port`, `stopped` não traz `stopListeningAt`; se o semeador se fechou sozinho (falha fatal), `stopped` traz `fatal: true` em vez de `closeMs`. Descrição em `docs/protocol.md` (seção 5, passo 5 da partida do semeador, e o item `seed` da seção 7).

## Comandos de teste

```sh
node apps/cli/test/seed-shutdown-timing.test.js
node apps/cli/test/seed-ws-drain.test.js
node packages/core/test/seeder-start-timing.test.js
node apps/cli/test/seed-ops.test.js
node apps/cli/test/changelog.test.js
node apps/cli/test/readme-help.test.js
```

## Limites conhecidos

- [ ] Os números vêm de uma única implantação, não de uma distribuição.
- [ ] O tempo da porta sem escuta precisa dos logs dos dois contêineres (o antigo e o novo) e supõe relógios da mesma máquina; entre máquinas diferentes o desvio de relógio entra na conta.
- [ ] `stopListeningAt` é lido logo antes de chamar o drain, que para de escutar em seguida; o erro é de milissegundos.
- [ ] Um SIGTERM que chega antes de `seed ready` conta o resto da partida em `drainMs` e `closeMs` (os dois contam a partir do sinal); uma amostra assim superestima C.
- [ ] O caminho fatal (`fatal: true`, sem `closeMs`) não tem teste próprio; o teste novo cobre só o SIGTERM.
