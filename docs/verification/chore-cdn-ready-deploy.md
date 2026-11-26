# Implantação preparada para um CDN

Branch `chore/cdn-ready-deploy`. Passa `VARANDA_TRUSTED_PROXIES` e `VARANDA_MEDIA_ORIGIN` do `.env` ao Caddy (`deploy/seeder/compose.web.yaml`, `deploy/seeder/.env.example`) e ensina o `deploy.sh`, o `update.sh` e o `build-web.sh` a conferir e usar a segunda. O Caddyfile e o service worker vêm de outras tarefas da mesma série. Com as duas variáveis vazias nada muda.

## Conferido

- `apps/cli/test/deploy.test.js`:
  - o compose passa as duas variáveis só ao serviço `web`, com `:-` e vazias por padrão, e o `.env.example` traz a linha de cada uma, vazia;
  - `conferir_antes` aceita `VARANDA_MEDIA_ORIGIN` ausente, vazia ou uma origem https (com porta, com comentário no fim da linha) e recusa `http://`, caminho, barra no fim, maiúsculas, curinga, usuário, consulta e valor entre aspas;
  - `servido_json` espera `{"v":1,"association":"…"}` sem a variável e, com ela, o mesmo corpo com `,"media":"<origem>"` como última chave; falha com a chave fora de lugar, com outra origem ou ausente; e, com um Caddyfile que não lê a variável (uma volta), espera o corpo antigo;
  - o build do app: `build-web.sh` repassa `VARANDA_MEDIA_ORIGIN` ao contêiner só quando definida e válida, não passa nada com ela ausente ou vazia, recusa uma forma inválida antes do build, e sem argumento lê o `.env` e ignora a variável de quem chamou; o `construir_web` do `deploy.sh` descarta uma variável herdada e passa só a do `.env` conferido.
  - Dois testes antigos sobre o Caddyfile (`the CSP is unchanged` e o de `/media/*`) liam o Caddyfile anterior à tarefa do Caddy: agora leem as linhas `@semMidia` (o CSP sem a variável, igual ao de sempre) e a regra única que só acrescenta `s-maxage=60` ao valor do semeador.
- `apps/cli/test/update.test.js`: a sonda de `/varanda.json` passa sem a variável e com ela (com o Caddyfile do alvo lendo-a), falha em cada corpo que não bate, espera o corpo antigo com um Caddyfile que não a lê, e o `conferir_env` recusa uma origem malformada com o nome da variável.
- Revisão de segurança, achados corrigidos nesta branch:
  - `VARANDA_TRUSTED_PROXIES` é conferida pelo `conferir_antes` (`deploy.sh`) e pelo `conferir_env_web` (`update.sh`): vazia, ou CIDRs IPv4 (prefixo de /8 a /32) e IPv6 (de /16 a /128) separados por um espaço. Recusa `private_ranges` e qualquer outra palavra, endereço sem prefixo, prefixo mais curto que o mínimo, zeros à esquerda, `}` e aspas. Os testes aceitam intervalos reais de CDN e recusam mais de 60 formas malformadas, nos dois scripts.
  - `VARANDA_MEDIA_ORIGIN` preenchida com `VARANDA_TRUSTED_PROXIES` vazia é recusada pelos dois scripts, com mensagem em português (sem os intervalos do CDN, todo `/media/*` dividiria um só limite por endereço).
  - `deploy.sh`, mesmo commit já no ar e saudável: o contêiner `web` em execução é comparado ao `.env` (`docker inspect`, as duas variáveis) e recriado com `compose up -d --force-recreate --no-deps web`, sondando a saúde de novo, quando uma delas difere. Testado com `docker` simulado: igual, cada variável acrescentada, trocada e removida, sem contêiner, falha do `compose` e da sonda.
  - `update.sh`: `restaurar_segredos` relê `VARANDA_MEDIA_ORIGIN` do ambiente restaurado (a volta e o `rollback` esperam o corpo antigo de `/varanda.json`, não o do candidato que falhou).
  - Caddyfile: o Caddy remove `Forwarded`, `CF-Connecting-IP`, `True-Client-IP`, `Fastly-Client-IP` e `X-Client-IP` além de `X-Forwarded-For` e `X-Real-Ip` em todo `reverse_proxy` (inclusive `/seeder`, que só põe o seu `X-Forwarded-For`); os erros de `/media/*` (o 429 e o 502) saem com `Cache-Control: no-store`. Conferido no Caddy em contêiner: com um semeador falso, os cabeçalhos forjados não chegam ao semeador e o 429 e o 502 saem `no-store`.
  - `deploy.sh` avisa (não recusa) quando `VARANDA_MEDIA_RATE` x 10 fica abaixo de 1920: o limite por endereço de `/media/*` (480 a cada 10 s) passaria de 25% do total do semeador.
  - `docs/protocol.md` (`/media`, `/index`, endereço do cliente, riscos residuais) descreve `{client_ip}` (só a zona de `/media/*`; as demais zonas e o `/seeder` usam `{remote_host}`), os ranges confiáveis (compartilhados com todos os clientes do CDN), `s-maxage=60`, o CORS só para a origem da instalação e os limites 480 e 60; `.env.example` diz que só os intervalos publicados do CDN cabem em `VARANDA_TRUSTED_PROXIES` e que a origem do CDN entra só em `connect-src`.
- `bash -n` em `deploy.sh`, `update.sh` e `build-web.sh`; `npx standard` nos arquivos de teste.

## Passos do mantenedor (nada disto foi feito por agente)

O agente não mexe em DNS, não abre conta em CDN e não escreve o `.env` de nenhum servidor. Ligar o CDN é, nesta ordem:

1. **Termos e política de privacidade.** Ligar espera a mudança dos Termos e da política de privacidade que passam a citar o CDN (o pedido de mídia passa a sair do domínio do servidor para o do CDN, que vê o endereço de quem pede). Sem ela publicada, as variáveis ficam vazias.
2. **DNS.** Criar o nome do CDN (por exemplo `midia.<domínio>`) apontando para o provedor escolhido.
3. **Conta no CDN.** Abrir a conta e criar a origem apontando para `https://<domínio>/media/*`, respeitando `s-maxage=60` que o Caddy acrescenta (uma foto apagada sai da borda em até um minuto).
4. **`.env` do servidor.** Preencher `VARANDA_TRUSTED_PROXIES` com os CIDRs que o provedor publica (separados por espaço) e `VARANDA_MEDIA_ORIGIN` com a origem https do passo 2. Depois, `deploy.sh` (ou `update.sh`): a sonda de `/varanda.json` confere a chave `media`.
5. **Conferir pelo navegador** numa instalação de teste antes de ligar na principal: `/varanda.json` com `media`, uma foto carregando pela origem do CDN e a resposta de `/media/*` com `Access-Control-Allow-Origin`.

## Não conferido

- Nenhum CDN real: os testes usam `curl` e `docker` simulados, sem rede.
- A validação de `VARANDA_TRUSTED_PROXIES` confere o formato, não que os CIDRs sejam mesmo os do CDN: isso é do mantenedor (passo 4 acima). Um intervalo largo mas válido (por exemplo `10.0.0.0/8`) é aceito.
- Servidores atualizados por imagem (`update.sh`) recebem o app web pronto da versão: se o build da versão publicada carrega `VARANDA_MEDIA_ORIGIN` no service worker depende do fluxo de release, que este PR não altera e não foi conferido aqui.
