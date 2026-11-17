# Clientes durante a implantação do semeador (branch fix/seeder-redeploy-clients)

Mudança: com a conexão com o semeador caída, o nó do navegador recusa escritas na hora, `diary.peek` falha na hora, a reconexão tenta mais rápido nos primeiros 3 minutos de queda, parar a sincronização na partida local (inclusive na leitura do diário próprio) encerra a execução sem discar, a fila de pedidos do app limita 5 leituras e 6 pedidos no total e deixa duas vagas fora da fila, e o log `ready` do semeador mede as fases da partida. Descrição em `docs/rpc.md` (seções 5.27, 6.1, 8 e 11) e `docs/protocol.md`.

## Comandos de teste

```sh
node packages/web-member/test/session.test.js
node packages/web-member/test/sync-reconnect.test.js
node packages/web-member/test/sync-early-abort.test.js
node packages/core/test/seeder-start-timing.test.js
node apps/app/test/requestQueue.test.js
node apps/app/test/webnodeHandle.test.js
node apps/cli/test/changelog.test.js
```

## Limites conhecidos

- [ ] Abrir ou trazer o app para o primeiro plano no meio de uma implantação ainda pode custar uma partida.
- [ ] Um `createSocket` que lança de forma síncrona não atualiza a marca de semeador caído.
- [ ] Depois de uma partida abortada, a limpeza dos blocos e das mídias apagados espera a próxima execução.
- [ ] O servidor RPC conta como pendente um pedido que o cliente já desistiu de esperar (30 s); numa queda longa com leituras presas, o limite do próprio servidor (`packages/rpc/lib/server.js`) ainda pode recusar um pedido de sincronização. Fica para outra mudança.
- [ ] As escritas de mídia dividem a fila de controle com `sync.start`, `sync.stop` e `sync.status`; um envio demorado pode atrasar um controle que espera atrás dele.
- [ ] Com as leituras ocupando as vagas, um controle (por exemplo `sync.status`) pode esperar atrás de outro controle que o nó ainda não respondeu.
- [ ] A reserva de duas vagas fora da fila é uma suposição: chamadas de identidade que se sobrepõem não são contadas.
- [ ] Nada foi exercitado em aparelho (celular), nem contra um semeador de verdade sendo reimplantado.
