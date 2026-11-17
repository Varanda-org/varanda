# Clientes durante a implantação do semeador, segunda parte (branch fix/seeder-deploy-hold)

Mudança: o Caddy repete por até 5 s a discagem a `/seeder` enquanto a porta do semeador está fechada (`lb_try_duration 5s`, `lb_try_interval 250ms`); o semeador aceita fluxos externos (`Seeder#accepting()`) assim que todos os núcleos foram reavaliados e preparados e o swarm existe, antes de entrar na DHT e terminar o flush, e o log `ready` ganha `acceptingMs` em `phases`; em SIGTERM, a escuta WebSocket fecha cada conexão de app com o código 1012 e o motivo `reiniciando` antes do desligamento (no máximo cerca de 1 s a mais), e antes disso para de escutar: uma conexão nova é recusada e o Caddy a repete, e um upgrade numa conexão que já estava aberta recebe 503; durante a partida, uma conexão `/seeder` é segurada por até 8 s e aceita assim que `accepting()` fica verdadeiro; o nó do navegador, ao ver o 1012, registra "aviso: semeador reiniciando; reconectando em instantes", emite `seeder-restarting` antes de `link-closed` e redisca após 0,5 a 1,5 s sem contar como falha, uma vez por queda: outro 1012 antes de um hello verificado conta como qualquer falha. Descrição em `docs/protocol.md` (seção 7, "Seeder WebSocket entry", e o passo 5 da partida do semeador) e `docs/rpc.md` (seção 6).

## Comandos de teste

```sh
node apps/cli/test/seed-ws-drain.test.js
node packages/core/test/seeder-serve-early.test.js
node packages/core/test/seeder-start-timing.test.js
node apps/cli/test/caddyfile.test.js
node packages/web-member/test/sync-reconnect.test.js
node apps/cli/test/changelog.test.js
```

## Limites conhecidos

- [ ] A repetição da discagem do Caddy não foi executada aqui (não há binário `caddy` nesta máquina); só o texto do `Caddyfile` é conferido por teste.
- [ ] Nada foi exercitado em aparelho (celular), nem contra um semeador de verdade sendo reimplantado.
- [ ] A lacuna fica menor, não some: durante a troca do contêiner ainda há um intervalo sem semeador. Zero de indisponibilidade pede o desenho de um semeador reserva ou réplica, que é outra frente.
- [ ] "Não reiniciar serviços que não mudaram" foi descartado: o `deploy.sh` já recria só o que mudou e as duas imagens trazem o commit embutido, então mudam a cada versão.
- [ ] O 1012 e a espera de discagem do Caddy só ajudam enquanto o próprio Caddy fica de pé. Na atualização por versão (`update.sh`), a imagem `web` traz o commit e o Caddy é recriado no mesmo `up -d` que o semeador: enquanto ele está fora, o 1012 pode não chegar ao cliente e as primeiras rediscagens encontram a porta 443 fechada, onde o `lb_try_duration` não vale; o cliente cai na espera normal (até 5 s nos primeiros 3 minutos).
- [ ] Até o semeador terminar a partida (`ready`), a descoberta responde defasada e as páginas de índice, de grupo e de assunto dizem que ainda estão indexando ou incompletas, como os pares da DHT já viam durante o flush.
- [ ] A espera de partida e a do Caddy valem para toda conexão `/seeder`, não só a da sincronização: durante uma implantação, uma Espiadinha, os avisos, uma página de feed ou um link curto de DM esperam até cerca de 13 s antes de dar certo ou falhar, onde antes falhavam na hora.
- [ ] Nenhum teste isola que as reavaliações das caixas de grupo terminam antes de `accepting()`; os testes de caixa existentes passam.
- [ ] As vagas da espera de partida são de quem chega primeiro: um único cliente pode ocupar as `maxExternal` vagas durante a partida (a rota `/seeder` não tem `rate_limit` no Caddy). Não abre nada novo, porque conexões ociosas já podiam ocupar as 32 vagas externas; um limite por endereço nas conexões WebSocket barraria membros atrás do mesmo NAT de operadora.
