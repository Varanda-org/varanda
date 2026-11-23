# Verificação: seeder em standby e revezamento na atualização

Branch `feat/seeder-standby-handoff`. Todo tempo citado abaixo é estimativa ("estimativa"): nada no repositório mede um fechamento real em escala de produção.

## Automática

Da raiz, um arquivo por chamada:

```sh
node apps/cli/test/seed-start-wait.test.js
node apps/cli/test/seed-shutdown-timing.test.js
node apps/cli/test/seed-ws-drain.test.js
node apps/cli/test/cli.test.js
node apps/cli/test/account.test.js
node apps/cli/test/caddyfile.test.js
node apps/cli/test/deploy.test.js
node apps/cli/test/update.test.js
node apps/cli/test/readme-pull.test.js
node apps/cli/test/release-bundle.test.js
bash -n deploy/seeder/update.sh
npm run lint
npm run demo
```

A suíte inteira roda na CI do GitHub.

## Docker local: o Compose com `--scale`

Passo para o mantenedor (nada foi rodado aqui). Num projeto descartável com uma imagem alpine, `network_mode: host` e `restart: unless-stopped`:

```sh
docker compose -p teste up -d
# troque a imagem do serviço `svc` no arquivo e:
docker compose -p teste up -d --no-recreate --no-deps --scale svc=2
docker stop <contêiner 1> && docker rm <contêiner 1>
docker compose -p teste up -d
docker compose -p teste exec --index 2 svc true
```

Esperado: o `--scale` cria o contêiner 2 e não toca no 1; depois de parar e remover o 1, o `up -d` simples não recria nada; o `exec --index 2` alcança o contêiner. Resultado: a conferir.

## Staging e primeira implantação

1. A versão N entra no lugar, sob o `update.sh` antigo, e o Caddy é recriado uma vez.
2. A versão N+1 é a primeira com revezamento. Em `update.log`, anotar:
   - as linhas `revezamento: o contêiner novo <id> do serviço <serviço> está em espera`, `revezamento: parando o contêiner em uso <id> do serviço <serviço>` e `revezamento: <serviço> parou: ...` (os tempos `closeMs` e `stopListeningAt` de `stopped`), e o `ws.at` e o `ready` do semeador novo;
   - um POST a `/account/*` durante a troca não recebe 502;
   - um GET em andamento pode ser repetido pelo Caddy: confirmar que isso é inofensivo nas rotas GET de `/account/*`;
   - o intervalo de fechamento do serviço de conta (o listener fecha primeiro e o lock sai por último, com até 5 s de espera do embedder no meio) contra os 5 s de `lb_try_duration` (estimativa);
   - o próximo `update.sh compose up -d --no-build` não recria nada;
   - `docker ps` mostra um contêiner por serviço, numerado 2.
3. Aborto sem custo: uma versão cujo semeador sai ao iniciar, se der para montar. Esperado: o digest em `recusadas`, o em uso nunca parado, saída 1.
4. Reinício no meio da troca, se der para montar. Esperado: a execução seguinte recusa o digest, o diário `/var/lib/varanda-update/revezamento` é apagado e a versão instalada volta. O primeiro disparo do timer vem de 3 a 18 minutos depois do boot (`OnBootSec=3min` mais `RandomizedDelaySec=15min`): anotar o que serve nessa janela, quando o contêiner antigo e o novo sobem de novo e disputam as portas (um serve, o outro espera em standby).
5. Treino de recuperação de queda, se der para montar: matar o `update.sh` com SIGKILL depois de os contêineres novos chegarem ao standby e rodar `update.sh run`. Conferir que o `efetivo.env` e o registro da versão anterior voltaram, que o digest está em `recusadas`, que só ficaram os contêineres da versão instalada e que o diário sumiu. Enquanto o diário existir, `update.sh status` o mostra.

Resultados: a conferir.

## Comportamento do Docker a conferir

Nada disto foi rodado contra um Docker real. Cada item está "a conferir":

- a. `compose up -d --no-build --no-recreate --no-deps --scale seeder=2` com a imagem trocada cria exatamente um contêiner novo por serviço e não toca no contêiner 1: a conferir.
- b. Depois de parar e remover o contêiner antigo, um `up -d` simples (e `up -d web`) não recria nada; anotar qual contêiner uma redução posterior para 1 escolhe: a conferir.
- c. `stop_grace_period: 30s` aparece como StopTimeout do contêiner (`docker inspect`): a conferir.
- d. `exec --index 2` alcança o contêiner 2, e `exec` simples funciona quando o único contêiner é o número 2: a conferir.
- e. O formato da saída de `docker inspect` que o script lê (State.Running, State.Restarting, RestartCount, o rótulo do número do contêiner e `.Image`): a conferir.
- f. `docker stop` e `docker rm` em contêineres nos estados created, exited e restarting: a conferir.
- g. O RestartCount de um contêiner novo que cai ao iniciar, e em quanto tempo a linha `standby` aparece em `docker logs`: a conferir.
- h. A disputa das portas depois de um reinício no meio da troca, descrita no item 4 da lista acima: a conferir.
- i. Os tempos reais da troca contra a verificação de saúde de 180 s (estimativa até medir): a conferir.
- j. Um SIGINT durante o `up --scale`: a conferir.
