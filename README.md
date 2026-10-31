# varanda

Monorepo npm da fase 0 de uma rede social ponto a ponto no Holepunch (Hypercore, Hyperswarm e HyperDHT): o programa de terminal (`varanda`, `varanda-serve`), o aplicativo iOS, Android e web (`apps/app`), o site estático (`apps/site`) e as bibliotecas compartilhadas (`packages/*`). A referência normativa dos formatos é [docs/protocol.md](docs/protocol.md). O guia de desenvolvimento está em [docs/development.md](docs/development.md).

## Estrutura do repositório

É um monorepo npm (workspaces `packages/*` e `apps/*`, um só `package-lock.json` na raiz).

- `apps/cli`: o programa de linha de comando (`varanda`, `varanda-serve`), o semeador e a demo. [README](apps/cli/README.md).
- `apps/app`: aplicativo iOS, Android e web, com o worklet Bare que roda o nó no celular e a interface de membro. [README](apps/app/README.md).
- `apps/site`: o site estático do Varanda (página de apresentação, logotipo e as fontes dos ícones do app). [README](apps/site/README.md), [docs/site.md](docs/site.md).
- `packages/core`: o núcleo do protocolo e a sessão do nó, usados pelo CLI e pelo app (Node e Bare). [README](packages/core/README.md).
- `packages/rpc`: o contrato JSON entre a interface e o nó. [README](packages/rpc/README.md).
- `deploy/seeder`: imagem Docker, Compose e unidade systemd do semeador. Ver [Operar o semeador](#operar-o-semeador).
- `docs/`: `protocol.md` (referência normativa dos formatos), `rpc.md` (contrato da interface), `design.md` (documento de design), `development.md`, `app.md`, `ios-gate.md`, `verification.md` (verificação ponta a ponta do monorepo) e `site.md` (site estático). O índice está em [docs/README.md](docs/README.md).

## O que é

Cada pessoa tem um diário assinado no próprio dispositivo. Seguidores e semeadores guardam cópias. O semeador só guarda um diário cujo bloco 0 traz um certificado de membro válido da associação em que ele confia. A identidade é a chave pública desse diário: 64 dígitos hexadecimais (32 bytes).

Quem acompanha outra pessoa pede o diário dela aos pares e ao semeador. Com o processo de sincronização da autora já encerrado, o semeador continua servindo a cópia que admitiu.

O semeador também tem certificado da mesma associação. Só um semeador verificado por esse certificado conta como admissão (`admitted`).

## Requisitos

- Node.js 20 ou mais novo (`engines.node` é `>=20`)
- npm

O programa de terminal roda no Node e não tem etapa de compilação. O núcleo (`packages/core`) também roda no runtime Bare, dentro do aplicativo (`apps/app`; veja [docs/development.md](docs/development.md) para compilar o app). Esta fase não usa o runtime Pear.

## Contribuir

Guia completo em [CONTRIBUTING.md](CONTRIBUTING.md).

- Faça fork do repositório e abra um pull request contra `main`.
- Comente na issue antes de começar, para alinhar escopo e evitar trabalho duplicado.
- Use branch no formato `<tipo>/<slug>` (por exemplo `fix/nome-curto`).
- No PR, referencie a issue com `Closes #n`.
- Vulnerabilidades: siga [SECURITY.md](SECURITY.md); não abra issue pública com detalhes sensíveis.

## Licença

O código deste repositório é distribuído sob a [PolyForm Noncommercial 1.0.0](LICENSE) (SPDX `PolyForm-Noncommercial-1.0.0`); o licenciante é Rodrigo Serviuc Pavezi.
Usar, copiar e modificar o código é permitido para fins não comerciais, nos termos da licença.
Usos comerciais não abrangidos pela licença dependem de autorização prévia do licenciante.
É código-fonte disponível, não código aberto segundo a definição da Open Source Initiative (OSI).
Ao abrir um PR, quem contribui concede ao licenciante uma licença para distribuir a contribuição sob quaisquer termos, sem CLA.
Os detalhes, e os trechos de terceiros que continuam sob a MIT, estão na seção [Licença](CONTRIBUTING.md#licença) de CONTRIBUTING.md.

## Instalação

Na raiz deste repositório:

```sh
npm install
```

Os executáveis em `bin/` na raiz são atalhos para `apps/cli/bin/` (por exemplo `bin/varanda.js`).

O programa é `node bin/varanda.js`. A ajuda:

```sh
node bin/varanda.js help
```

`--help` e `-h` imprimem o mesmo texto. Os valores vão em separado: `--flag valor`. A forma `--flag=valor` é uma opção desconhecida (código 2).

## Conceitos

### Ajuda

`node bin/varanda.js help` imprime exatamente:

```
varanda — protótipo de rede social P2P (fase 0)
Uso: node bin/varanda.js <comando> [subcomando] [opções]
Comandos:
  assoc init|show|certify    chave da associação de teste e certificados de membro
  assoc certify-seeder       certifica a chave de um semeador (--seeder)
  assoc certify-issuer       certifica a chave do emissor do serviço de conta (--issuer)
  assoc certify-moderator    certifica a chave da moderação (--moderator)
  id create|show             identidade (chave pública do diário)
  cert add                   grava o certificado como bloco 0 do diário
  profile set                define nome e bio
  post                       publica um texto (--text)
  reply                      responde a uma publicação (--to <chave>:<seq> --text)
  delete                     apaga uma publicação ou versão do perfil (--to <chave>:<seq>)
  follow|unfollow|follows    segue ou deixa de seguir uma chave pública
  log                        mostra os blocos locais de um diário
  feed                       feed com as publicações dos diários seguidos
  sync                       sincroniza com pares e com o semeador (--once, --timeout-ms)
  seed                       semeador sempre ligado (--health-port, --ws-port)
  seed key|cert add          chave do semeador e seu certificado (--cert-file)
  seed list|status           diários admitidos e estado do semeador
  seed drop <chave>          apaga um diário do semeador parado
  account                    serviço de vínculo de conta Google (--account-port, --account-host)
  account key                chave do emissor do serviço de conta (imprime só a pública)
  account cert add           grava o certificado do emissor (--cert-file <f>)
  account push-key           chave dos avisos push da versão web (imprime só a pública)
  account status             estado do serviço de conta
  account export             exporta os vínculos de conta do serviço parado
  account reports            exporta as denúncias com os e-mails do vínculo (--member)
  mod init|show              chave da moderação e estado da lista de bloqueio
  mod cert add               grava o certificado da moderação (--cert-file <f>)
  mod block|unblock <chave>  bloqueia ou desbloqueia uma conta e publica a lista
  mod revoke-issuer <chave>  revoga a chave de um emissor e publica a lista
  mod unrevoke-issuer        desfaz a revogação de um emissor (<chave>)
  mod publish                reenvia a lista gravada ao semeador (--seeder)
  mod apply                  revisa as decisões do painel, assina e publica (--server, --yes)
  group create               cria um grupo público (--name, --join open|approval)
  group join|leave <chave>   entra no grupo (ou pede entrada) e sai dele
  group post <chave>         publica no grupo (--text)
  group read <chave>         lê o grupo, das mais novas (--limit, --before <at>,<escritor>,<seq>)
  group list                 grupos dos quais você participa
  group info|members|requests <chave>  dados do grupo, membros e pedidos de entrada
  group admit|ban|admin <chave>        modera um membro (--member, --undo desfaz)
  group hide <chave>         oculta uma mensagem (--to <escritor>:<seq>, --undo)
  group meta <chave>         muda nome ou entrada do grupo (--name, --join)
  community create           cria uma comunidade de grupos (--name)
  community link <comunidade> <grupo>  vincula um grupo à comunidade (--undo desfaz)
  community admin <comunidade>         nomeia um administrador da comunidade (--member, --undo)
  community info <chave>     dados da comunidade e seus grupos
  help                       esta ajuda
Opções globais:
  --data <dir>               diretório de dados (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --json                     saída JSON na última linha
Opções dos comandos:
  --member --seeder --age-band --method --out --cert-file --name --bio --text
  --to --author --limit --before --once --timeout-ms --health-port --health-host --ws-port --ws-host
  --ws-origin --issuer --account-port --account-host --moderator --no-publish --new-list --server --yes
  --join --undo
  --timeout-ms vai até 2147483647 ms. No assoc certify*, --out recusa arquivo existente e link simbólico.
```

`--json` coloca um objeto JSON na última linha da saída padrão. Em `sync` e `seed`, cada evento é uma linha JSON e o resultado fecha a saída. Nenhum comando imprime chave secreta. `seed key` imprime só a chave pública Noise do semeador.

### Registros

O diário é uma sequência de blocos JSON. O índice do bloco é o `seq`, a partir de 0.

- Bloco 0: `{ "type": "member-cert", "cert": <certificado> }`. O campo `cert.member` é a chave pública do diário. Sem esse bloco o diário não recebe perfil, publicação nem resposta.
- `profile`: nome (1 a 80 caracteres) e bio (0 a 280).
- `post`: texto (1 a 1000 caracteres). Uma resposta é um `post` com `replyTo` apontando para `<chave>:<seq>` de outra publicação. O `seq` do alvo é um inteiro maior ou igual a 1, porque o bloco 0 é o certificado. Uma publicação pode ter `media`, até 4 fotos de um núcleo de fotos (só a versão web hospedada as grava); com fotos, o texto pode ficar vazio. A CLI mostra só `[foto]` ou `[N fotos]`.
- `follow`: `follow` e `unfollow` também gravam no diário um registro `follow` (`on` verdadeiro ou falso) quando o bloco 0 já existe. A lista de seguidos fica pública e chega igual a todos os aparelhos do membro.
- `media-core`: declara um núcleo de fotos do diário.

`log` imprime uma linha por bloco: `#<seq> certificado`, `#<seq> perfil <nome>`, `#<seq> publicação <texto>`, `#<seq> segue <8 hex>`, `#<seq> deixa de seguir <8 hex>`, `#<seq> mídia <8 hex>` ou `#<seq> inválido (<motivo>)`. Com `--json`, uma linha JSON por bloco e o resultado no fim, como antes. `--limit <n>` mostra só os últimos `n` blocos e `--before <seq>` os blocos de `seq` menor que o dado (um inteiro maior ou igual a 1, como em `log.read`); se sobram blocos mais antigos, `log` avisa na saída de erro (com `--json`, o resultado final traz `next`, o `seq` a passar em `--before`, ou `null`). Nós de antes dessa mudança pulam `follow`, `media-core` e a publicação com fotos inteira, sem recusar o diário.

O nome não leva caractere de controle (código menor que 0x20). Em bio e texto o único controle permitido é a quebra de linha (LF).

### Certificado de membro

O certificado tem exatamente estas chaves: `v` (1), `member` (chave pública do diário), `ageBand`, `method`, `date` (ISO-8601 UTC canônico, com milissegundos), `association` (chave pública da associação) e `signature` (128 hex minúsculos).

Faixas sugeridas: `13-15`, `16-17`, `18+`. O padrão de `assoc certify` é `--age-band 18+` e `--method stub`. `ageBand` casa com `/^[a-z0-9+-]{1,32}$/`; `method` casa com `/^[a-z0-9-]{1,32}$/`.

A associação guarda, por membro, só a chave pública, a faixa etária, o método e a data (`members.jsonl`). Não guarda assinatura, chave secreta, imagem nem documento. Quem opera `assoc certify` afirma a faixa etária. A checagem de idade de um provedor real está fora desta fase (comentário `TODO(phase1)` em `packages/core/lib/assoc.js`).

### Certificado de semeador

O certificado do semeador tem exatamente estas chaves: `v` (1), `seeder` (chave pública Noise, a mesma que `seed key` imprime), `date`, `association` e `signature`. O prefixo assinado é `varanda-seeder-v1`, diferente de `varanda-cert-v1`. Uma assinatura de membro não valida certificado de semeador, e uma assinatura de semeador não valida certificado de membro.

A associação registra em `seeders.jsonl` só a chave do semeador e a data. Sem assinatura e sem segredo.

### Semeador e admissão

O semeador fica ligado, no tópico da associação, e replica os diários que admitiu. Na entrada ele confere o bloco 0. Diário com certificado de outra associação, certificado malformado, bloco 0 inválido ou histórico reescrito (`fork`) é recusado.

No `sync`, um par só conta como semeador verificado quando o `hello` traz papel `seeder`, o certificado confere com a chave Noise autenticada da conexão e a associação é a raiz fixada em `config.json`. O resultado `admitted: true` exige esse semeador verificado. Um par que se diz semeador sem esse certificado aparece como `peer seeder <8 hex> não verificado`. O `admitted` desse par não é impresso e não marca o diário como admitido. Um `rejected` para o próprio diário vindo de qualquer par que não seja semeador verificado vira a linha `withdrawn <chave> <8 hex do par> <motivo>` e não decide o sucesso do `sync`.

`sync --once` sai com código 0 quando ao menos um par enviou `hello`, nenhum diário seguido ficou atrás do tamanho que um par anunciou, os pares interessados no próprio diário alcançaram o tamanho dele e, se há semeador verificado e o bloco 0 local é um certificado válido, um semeador verificado enviou `admitted` até esse tamanho. O prazo padrão é 30000 ms (`--timeout-ms`, no máximo 2147483647; acima disso o comando sai com erro de uso, código 2).

### Tópico por associação

Membros e semeadores da mesma associação se encontram num tópico de rendezvous derivado da chave pública dessa associação (`varanda/rendezvous/v1:` + hex). Cada um também anuncia a chave de descoberta dos diários que guarda.

### Raiz de confiança

Cada diretório confia numa única chave pública de associação, gravada em `config.json` e imutável depois.

- Membro: `id create` exige `--association <hex>` ou `VARANDA_ASSOCIATION` na primeira vez e grava `{ "v": 1, "role": "member", "association": "<hex64>" }`. Rodar de novo devolve a mesma chave pública do diário.
- Semeador: o primeiro entre `seed key`, `seed cert add` e `seed` grava `{ "v": 1, "role": "seeder", "association": "<hex64>" }`. Sem associação nessa primeira vez o uso é `informe --association ou VARANDA_ASSOCIATION` (código 2).

Num comando seguinte, `--association` e `VARANDA_ASSOCIATION` são opcionais. Se vierem, têm de ser o valor já gravado. Caso contrário o erro é `associação diferente da configurada` (código 1). O nó não escolhe a raiz lendo um certificado recebido.

`assoc show --data <dir>` e `id show --data <dir>` imprimem de novo a chave pública. `id show` sem identidade termina com `erro: identidade não encontrada`.

### Variáveis de ambiente

| Variável | Função |
| --- | --- |
| `VARANDA_DATA` | Diretório de dados. Padrão `./data`. O passo a passo usa `--data` no lugar dela. |
| `VARANDA_ASSOCIATION` | Chave pública da associação (64 hex, qualquer caixa; gravada em minúsculas). |
| `VARANDA_BOOTSTRAP` | Nós `host:porta` separados por vírgula. Ausente, e sem `--bootstrap`, os comandos usam a DHT pública. |
| `VARANDA_DHT_HOST` | Endereço local em que a DHT deste processo escuta. O mesmo que `--dht-host`. |
| `VARANDA_HEALTH_PORT` | Porta do endpoint de saúde do `seed`. O mesmo que `--health-port`. Ausente, não há endpoint. |
| `VARANDA_HEALTH_HOST` | Endereço do endpoint de saúde. O mesmo que `--health-host`. Padrão `127.0.0.1`. |
| `VARANDA_WS_PORT` | Porta da entrada WebSocket do `seed`. O mesmo que `--ws-port`. Ausente, nada escuta. |
| `VARANDA_WS_HOST` | Endereço da entrada WebSocket. O mesmo que `--ws-host`. Padrão `127.0.0.1`. |
| `VARANDA_WS_ORIGIN` | Origens de navegador aceitas na entrada WebSocket, separadas por vírgula (ex.: `https://app.exemplo.org`). O mesmo que `--ws-origin` (repetível). Ausente, só páginas `http` em loopback. |
| `VARANDA_MAX_MEMBERS` | Teto de contas vinculadas no serviço `account` (em `deploy/seeder/.env`), de 1 a 4096. Ausente ou vazio, sem teto. Ao chegar ao teto, um vínculo novo recebe "lista de espera" (HTTP 503); quem já é membro não muda. Ver "Vínculo de conta Google e @nome". |
| `VARANDA_INVITES_PER_WEEK` | Convites por membro e por semana, de 1 a 100 (em `deploy/seeder/.env`; reiniciar o serviço `account` para mudar). Ausente ou vazio, o cadastro segue aberto como hoje, só limitado por `VARANDA_MAX_MEMBERS`. Definido, um vínculo Google novo só termina com um convite válido e cada membro vinculado ganha esse número de convites por semana civil de Brasília. Remover a variável desliga tudo: o `invites.json` fica no disco e é ignorado pelo serviço (o `account status` ainda mostra as contagens). Ver "Convites", em "Vínculo de conta Google e @nome". |
| `VARANDA_DIDIT_API_KEY` | Chave da API do Didit para a verificação de idade (em `deploy/seeder/.env`; só o serviço `account` a recebe; reiniciar para mudar). Segredo. Vazia junto com `VARANDA_DIDIT_WORKFLOW_ID`, a checagem fica desligada. Ver "Verificação de idade (Didit)". |
| `VARANDA_DIDIT_WORKFLOW_ID` | Id do workflow do Didit (idade por rosto, com documento de reserva). Chave e id definidos ligam a checagem para todo membro hospedado, inclusive quem já está vinculado; só um dos dois é erro de uso. |
| `VARANDA_DIDIT_DAILY_LIMIT` | Teto de sessões novas no Didit por dia (padrão: 200), contado à parte para chaves sem vínculo e para membros já vinculados. Opcional. |
| `VARANDA_HODLE_API_KEY` | Chave da API do Hodle para a conta de pagamentos (em `deploy/seeder/.env`; só o serviço `account` a recebe). Segredo. O prefixo `hodle_live_` ou `hodle_test_` escolhe produção ou sandbox. Vazia, o recurso fica desligado e `GET /account/wallet/policy` responde `{ available:false }`. Ver "Conta de pagamentos (Hodle)". |
| `VARANDA_HODLE_NETWORK` | Rede da carteira: `polygon` (padrão) ou `base`. Fica fixa por membro desde a primeira carteira. Opcional. |
| `VARANDA_HODLE_MODE` | Quais rotas existem, em ordem: `cadastro` (padrão: só subconta e verificação) < `carteira` (acrescenta criar a carteira com o PIN do membro) < `pix` (acrescenta saldo, receber e pagar por Pix e a taxa da Varanda) < `completo` (vem no próximo PR e ainda não existe). Atualizar a imagem nunca liga movimento de dinheiro sozinho. Só defina `carteira` depois que o Hodle confirmar por escrito que os PINs escolhidos por cada membro funcionam em subcontas individuais. Opcional. |
| `VARANDA_HODLE_DAILY_LIMIT` | Teto por dia de subcontas novas, envios de verificação e operações de saída somados (padrão: 100; de 1 a 100000). Cada membro usa no máximo um quarto do teto (mínimo de 10 chamadas). Opcional. |
| `VARANDA_HODLE_MAX_CENTS` | Teto por operação em centavos, taxas incluídas (padrão: 300000, ou seja R$ 3.000,00; de 100 a 100000000). Opcional. |
| `VARANDA_HODLE_WEBHOOK_SECRETS` | Opcional. Lista separada por vírgula de `EVENTO:hex64`, um por webhook cadastrado no Hodle. Vazia, a rota de webhook responde 404. Cadastre `https://<domínio>/account/wallet/webhook/<EVENTO>`. O webhook só acelera a leitura do estado: a consulta continua sendo a fonte de verdade e o webhook nunca cria movimento nem dinheiro. Cada item é `EVENTO:hex64` (o segredo que o Hodle mostra) ou `EVENTO:registrar`, o primeiro passo do cadastro em dois passos (ver "Conta de pagamentos"). Outro formato recusa a partida do serviço. Segredo. |
| `VARANDA_FEE_TRANSFER_CENTS`, `VARANDA_FEE_TRANSFER_BPS` | Taxa da Varanda em transferências: parte fixa em centavos (0 a 100000) e parte proporcional em pontos-base (0 a 2000, 100 = 1%). Padrão 0. Nesta versão nenhuma transferência é cobrada, então qualquer valor diferente de zero recusa a partida do serviço. Opcional. |
| `VARANDA_FEE_PAYOUT_CENTS`, `VARANDA_FEE_PAYOUT_BPS` | O mesmo para pagar por Pix (saque). Padrão 0. Só é cobrada depois que o Hodle informa que o Pix foi concluído, em geral no próximo envio da pessoa; Pix que falha ou volta antes não paga taxa. É a única taxa aceita, e só no modo `pix`: nos modos `cadastro` e `carteira` qualquer valor diferente de zero recusa a partida do serviço. Opcional. |
| `VARANDA_FEE_CRYPTO_CENTS`, `VARANDA_FEE_CRYPTO_BPS` | O mesmo para envio a um endereço de carteira. Padrão 0. Recusada no modo `pix` se diferente de zero, como a de transferência. Opcional. |
| `VARANDA_FEE_DEPOSIT_CENTS`, `VARANDA_FEE_DEPOSIT_BPS` | Taxa sobre o Pix de entrada. Deve ficar em 0 nesta versão: qualquer valor diferente de zero recusa a partida do serviço. |
| `VARANDA_FEE_SWAP_BPS` | Troca de moeda (USDC para BRLA, numa versão futura). A troca não tem taxa da Varanda: deixe em 0. `VARANDA_FEE_SWAP_BPS` e `VARANDA_FEE_SWAP_CENTS` são aceitas vazias ou 0 e recusam a partida com qualquer outro valor, em todos os modos. Opcional. |
| `VARANDA_FEE_TREASURY` | Quem recebe a taxa: `sub:<subAccountId>` (subconta do Hodle) ou um endereço `0x` na rede configurada. Obrigatória com qualquer taxa. Não existe variável de PIN da tesouraria e nenhuma é necessária. Opcional sem taxa. `VARANDA_HODLE_PIN` e `VARANDA_FEE_TREASURY_PIN` com qualquer valor fazem a partida do serviço falhar: PIN é de cada pessoa e o serviço nunca guarda um. |
| `VARANDA_ACCOUNT_MAX_CONNECTIONS` | Conexões simultâneas do serviço `account`, de 1 a 4096. Padrão 64. |
| `VARANDA_ACCOUNT_RATE` | Requisições por segundo do balde global do serviço `account`, de 1 a 10000. Padrão 20. |
| `VARANDA_ACCOUNT_BURST` | Rajada permitida acima da taxa no balde global do serviço `account`, de 1 a 100000. Padrão 100. |
| `VARANDA_ACCOUNT_MAX_PENDING` | Vínculos pendentes ao mesmo tempo no serviço `account`, de 1 a 100000. Padrão 1000. |
| `VARANDA_PUSH_TOKEN` | Segredo do `POST /push-event` entre o semeador e o serviço de conta: 64 hex minúsculos, o mesmo valor nos dois (`openssl rand -hex 32`). Vazio ou ausente desliga os avisos push (a rota responde 404). Em `deploy/seeder/.env`. O erro de formato não repete o valor (`uso: VARANDA_PUSH_TOKEN inválido`). |
| `VARANDA_ACCOUNT_HTTP` | Onde o semeador alcança o HTTP do serviço de conta. Padrão `http://127.0.0.1:8790`. Só HTTP em loopback (`127.0.0.1`, `localhost` ou `[::1]`), com porta explícita. Outra forma é `uso: VARANDA_ACCOUNT_HTTP inválido`. |
| `VARANDA_MAX_EXTERNAL` | Conexões externas (WebSocket) que o `seed` aceita ao mesmo tempo, de 1 a 4096. Padrão 32, independente do limite do enxame. Cada aba visível da web hospedada mantém uma conexão enquanto estiver visível: dimensione para as abas visíveis ao mesmo tempo mais folga para os links curtos da Espiadinha e dos Avisos (`apps/cli/scripts/load-ws.js` mede conexões seguradas). No pior caso cada uma segura até 8 MiB de quadro: a memória fica em ≈ `VARANDA_MAX_EXTERNAL` × 8 MiB + `VARANDA_FRAME_MEMORY`. |
| `VARANDA_FRAME_MEMORY` | Memória total, em bytes, para quadros grandes em montagem no `seed`, de 8454144 (8 MiB + 64 KiB, o maior quadro válido) a 1073741824 (1 GiB). Padrão 64 MiB. Some à regra de memória: ≈ `VARANDA_MAX_EXTERNAL` × 8 MiB + `VARANDA_FRAME_MEMORY` no pior caso. |
| `VARANDA_MAX_SOCKETS` | Sockets abertos ao mesmo tempo na porta do `--ws-port` (WebSocket, `/media`, `/index` e conexões mantidas pelo proxy), de 1 a 8192. Padrão: externas + `/media` + `/index` em andamento + 64, ao menos 128. |
| `VARANDA_MEDIA_MAX_IN_FLIGHT` | Respostas de `/media` em andamento ao mesmo tempo, de 1 a 1024. Padrão 16. |
| `VARANDA_MEDIA_RATE` | Pedidos de `/media` por segundo, de 1 a 100000. Padrão 64. |
| `VARANDA_MEDIA_BURST` | Rajada de pedidos de `/media`, de 1 a 100000. Padrão 128. |
| `VARANDA_INDEX_MAX_IN_FLIGHT` | Respostas de `/index` em andamento ao mesmo tempo, de 1 a 1024. Padrão 16. |
| `VARANDA_INDEX_RATE` | Pedidos de `/index` por segundo, de 1 a 100000. Padrão 32. |
| `VARANDA_INDEX_BURST` | Rajada de pedidos de `/index`, de 1 a 100000. Padrão 64. |

As variáveis de limite do semeador (`VARANDA_MAX_EXTERNAL` até `VARANDA_INDEX_BURST`) não têm opção de linha de comando. Vazias contam como ausentes; um valor fora do intervalo ou que não seja um inteiro decimal termina com `uso: VARANDA_<NOME> inválido` (código 2), sem repetir o valor.

`--bootstrap` pode repetir. Se algum `--bootstrap` aparece na linha, ele prevalece sobre `VARANDA_BOOTSTRAP`. `--dht-host` prevalece sobre `VARANDA_DHT_HOST`.

Um `VARANDA_BOOTSTRAP` vazio ou malformado é erro de uso e não cai na DHT pública. Exemplos: `uso: bootstrap inválido (vazio)`, `uso: bootstrap inválido localhost`. A porta não leva zero à esquerda; o formato é `host:porta` com porta de 1 a 65535.

`VARANDA_DHT_HOST` e `--dht-host` aceitam uma string não vazia e sem espaço. Qualquer outro valor termina com `uso: dht-host inválido`.

`VARANDA_HEALTH_PORT` e `--health-port` aceitam um número de 0 a 65535, sem zero à esquerda (`0` deixa o sistema escolher a porta); senão `uso: health-port inválido`. `VARANDA_HEALTH_HOST` e `--health-host` seguem a regra do `--dht-host` (`uso: health-host inválido`). A opção prevalece sobre a variável. Detalhes em "Operar o semeador".

`VARANDA_WS_PORT` e `--ws-port` seguem a regra do `--health-port` (`uso: ws-port inválido`); `VARANDA_WS_HOST` e `--ws-host` seguem a do `--dht-host` (`uso: ws-host inválido`). Cada origem de `--ws-origin` / `VARANDA_WS_ORIGIN` é escrita exatamente como o navegador a envia: `http` ou `https`, host e porta só se não for a padrão, sem caminho nem barra no fim; outra forma é `uso: ws-origin inválido <valor>`, e uma lista vazia é `uso: ws-origin inválido (vazio)`. Qualquer `--ws-origin` vale mais que a variável.

A DHT local de `apps/cli/scripts/local-dht.js` escuta só em `127.0.0.1`. Com ela, defina `VARANDA_DHT_HOST=127.0.0.1` ou passe `--dht-host 127.0.0.1`. Testes e `npm run demo` usam esse endereço. Sem bootstrap (DHT pública, uso manual), o endereço local é opcional e a DHT fica nos padrões da biblioteca.

### Um processo por diretório de dados

`store/` é um Corestore em RocksDB e segura um lock do sistema. Antes de abri-lo, o `varanda` também cria o lock `<dir>/.varanda-lock` (com o pid do processo). Um segundo processo no mesmo `--data` falha com `erro: diretório de dados em uso` enquanto o primeiro não fecha o store; um lock deixado por um processo que morreu é retomado sozinho. Um lock com o pid do próprio processo que ele não pegou também é retomado: é o caso de um contêiner reiniciado, em que o semeador é sempre o pid 1. Um lock sem pid legível só é retomado quando o diretório do lock tem mais de 10 segundos. Se `.varanda-lock` não for um diretório (um arquivo ou um link simbólico), a abertura falha na hora com `erro: lock inválido (não é um diretório): <caminho>`; um link simbólico em `<dir>/store` também é recusado. Se o pid de um processo morto foi reaproveitado por outro processo seu, o lock continua em uso: confira que nenhum processo `varanda` usa o diretório e apague `<dir>/.varanda-lock` à mão. Comandos curtos abrem e fecham. `sync` e `seed` seguram o diretório o tempo todo em que estão rodando. `seed status` nunca pega o lock.

O store principal abre antes de `quarantine/` ser apagado. O segundo processo esbarra no lock e não apaga a quarentena de um `sync` ou `seed` que já está de pé.

Não misture papéis no mesmo diretório. Comando de membro em diretório de semeador: `diretório não é de um membro`. Comando de semeador em diretório de membro: `diretório não é de um semeador`.

### Publicação no futuro e diário reescrito

Uma publicação válida cuja data `at` está mais de 24 horas à frente do relógio de quem lê (`MAX_FUTURE_MS` = 86400000 em `packages/core/lib/feed.js`) fica de fora do feed. O comando avisa em stderr `aviso: publicação <chave>:<seq> ignorada (future)`. Ela volta sozinha quando o relógio do leitor chega em `at` menos 24 horas. Publicação no passado permanece e afunda na ordem `(at, autor, seq)`. O corte é pular, não redatar: redatar mudaria a posição em cada leitor e em cada execução.

Nenhum escritor desta fase trunca o diário. Se `fork` deixa de ser zero, o detentor da chave reescreveu o histórico. Esse diário é descartado em todo lugar, motivo `fork`: o semeador para de servi-lo, o `sync` apaga a réplica e o `feed` avisa `aviso: diário <8 hex> ignorado (fork)`. O `feed` só lê; o próximo `sync` é que apaga a cópia local.

## Passo a passo manual

Dois diários (Alice e Bob) e um semeador, na mesma máquina, em diretórios novos:

- `data/assoc` — associação de teste
- `data/seeder` — semeador
- `data/alice` — diário da Alice
- `data/bob` — diário do Bob
- `data/certs` — JSON dos certificados (`--out` / `--cert-file`); `--out` só grava arquivo novo (recusa arquivo existente e link simbólico, código 1): apague o antigo antes de emitir de novo; não é um diretório de papel

Rode tudo na raiz do repositório, em bash ou zsh (as linhas com `$(...)` e `${var##padrão}` dependem disso). `data/` está no `.gitignore`. Se esses diretórios já existem de uma tentativa anterior, use outros caminhos ou apague-os antes: `assoc init` recusa uma associação já criada, e `cert add` recusa um bloco 0 diferente do que já está no diário.

Cada comando deve terminar com código 0 antes do próximo. A chave secreta da associação fica em `data/assoc/association.json` (modo `0600`). A chave secreta Noise do semeador fica em `data/seeder/seeder-key.json` (modo `0600`). Nenhum comando as imprime. Não as copie para o terminal.

### 1. DHT local, ou a DHT pública

**DHT local** (um computador, sem a DHT pública). Num terminal, deixe rodando:

```sh
node apps/cli/scripts/local-dht.js
```

A porta padrão é 49737 (`node apps/cli/scripts/local-dht.js --port 49800` escolhe outra). O processo escuta só em `127.0.0.1` e imprime uma linha `export VARANDA_BOOTSTRAP=127.0.0.1:<porta>`. Ctrl-C encerra.

Nos outros terminais, use a linha impressa e o endereço local. Com a porta padrão:

```sh
export VARANDA_BOOTSTRAP=127.0.0.1:49737
export VARANDA_DHT_HOST=127.0.0.1
```

**DHT pública.** Não inicie `apps/cli/scripts/local-dht.js` e deixe `VARANDA_BOOTSTRAP` e `VARANDA_DHT_HOST` sem definir (`unset VARANDA_BOOTSTRAP VARANDA_DHT_HOST`: um `VARANDA_DHT_HOST=127.0.0.1` que sobrou da DHT local prenderia a DHT ao loopback, longe dos pares públicos). Os comandos usam a DHT pública. Não passe `--bootstrap` nem `--dht-host`. Nas linhas de `seed` e `sync` abaixo, apague `--bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"`.

### 2. Associação

```sh
line=$(node bin/varanda.js assoc init --data data/assoc)
printf '%s\n' "$line"
ASSOC=${line##* }
```

A linha é `chave pública da associação: ` seguida de 64 hex. `$ASSOC` é essa chave.

### 3. Chave do semeador, certificado, depois o processo

`seed key` cria `data/seeder`, grava a raiz de confiança e cria `seeder-key.json` se ele ainda não existe. Na segunda vez devolve a mesma chave pública.

```sh
line=$(node bin/varanda.js seed key --data data/seeder --association "$ASSOC")
printf '%s\n' "$line"
SEEDER=${line##* }
```

A linha é `chave do semeador: ` seguida de 64 hex.

```sh
mkdir -p data/certs
node bin/varanda.js assoc certify-seeder --data data/assoc --seeder "$SEEDER" --out data/certs/seeder.json
node bin/varanda.js seed cert add --data data/seeder --association "$ASSOC" --cert-file data/certs/seeder.json
```

A primeira imprime `certificado do semeador gravado em <caminho absoluto>`. A segunda imprime `certificado do semeador gravado`. Sem `--seeder` o uso é `uso: informe --seeder <hex>`. Sem `--cert-file` o uso é `uso: informe --cert-file <arquivo>`.

Noutro terminal, com as mesmas variáveis `VARANDA_BOOTSTRAP`, `VARANDA_DHT_HOST` e `ASSOC`, deixe o semeador ligado:

```sh
node bin/varanda.js seed --data data/seeder --association "$ASSOC" --bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"
```

Espere `seed ready`. Esse processo segura `data/seeder` até Ctrl-C, e então sai com código 0. Não rode outro comando com `--data data/seeder` enquanto ele estiver no ar.

`seed` sem `seeder-key.json` sai 1 com `erro: chave do semeador não encontrada (use seed key)`. Sem `seeder-cert.json`: `erro: certificado do semeador não encontrado (use seed cert add)`. Certificado que não bate com a chave ou com a associação: `erro: certificado do semeador inválido (<motivo>)`. Esses três erros acontecem antes de qualquer rede.

### 4. Alice e Bob

```sh
line=$(node bin/varanda.js id create --data data/alice --association "$ASSOC")
printf '%s\n' "$line"
ALICE=${line##* }

line=$(node bin/varanda.js id create --data data/bob --association "$ASSOC")
printf '%s\n' "$line"
BOB=${line##* }
```

Cada linha é `chave pública: ` seguida da chave do diário. Essa chave é a identidade. Repetir `id create` no mesmo diretório imprime a mesma chave.

```sh
node bin/varanda.js assoc certify --data data/assoc --member "$ALICE" --age-band '18+' --method stub --out data/certs/alice.json
node bin/varanda.js assoc certify --data data/assoc --member "$BOB" --age-band '18+' --method stub --out data/certs/bob.json
node bin/varanda.js cert add --data data/alice --cert-file data/certs/alice.json
node bin/varanda.js cert add --data data/bob --cert-file data/certs/bob.json
```

`cert add` imprime `certificado gravado (bloco 0)`. O certificado tem de ser desta chave e desta associação. Um certificado de outra associação falha com `certificado inválido (untrusted-association)` (código 1).

```sh
node bin/varanda.js profile set --data data/alice --name 'Alice' --bio 'protótipo'
line=$(node bin/varanda.js post --data data/alice --text 'primeira publicação')
printf '%s\n' "$line"
SEQ=${line##*#}
printf '%s\n' "$ALICE:$SEQ"
```

`profile set` imprime `perfil atualizado #<seq>`. `post` imprime `publicado #<seq>`. `$SEQ` é esse número (inteiro maior ou igual a 1). Perfil, publicação e resposta exigem o bloco 0; sem ele a mensagem é `erro: grave o certificado de membro antes de publicar`.

### 5. Alice sincroniza e sai

```sh
node bin/varanda.js sync --data data/alice --once --timeout-ms 30000 --bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"
```

A saída passa por `sync ready`, `peer seeder <8 hex>` e `admitted <chave da Alice> <tamanho>`, e fecha com `sync done` (código 0). O processo da Alice termina aí. O semeador permanece com a cópia.

Bob recebe a publicação por esse semeador com o `sync` da Alice já encerrado. A cópia está em `data/seeder` (`admitted.json` e `store/`). Parar o semeador com Ctrl-C (código 0) e subir de novo o mesmo comando `seed`, no mesmo diretório, continua servindo o diário depois de `seed ready`. É o que a demo automática confere. Os comandos abaixo valem para o processo que já imprimiu `seed ready`, seja o original, seja o que subiu do disco.

Sem par até o prazo, `sync` imprime `sync failed: sem pares` ou `sync failed: tempo esgotado: ...` e sai com código 1. Confira o terminal do semeador e o `VARANDA_BOOTSTRAP` / `--dht-host`.

### 6. Bob segue, sincroniza, lê e responde

```sh
node bin/varanda.js follow --data data/bob --author "$ALICE"
node bin/varanda.js sync --data data/bob --once --timeout-ms 30000 --bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"
node bin/varanda.js feed --data data/bob
```

`follow` imprime `seguindo ` e a chave da Alice, e grava no diário do Bob o registro `follow` (o Bob já tem o bloco 0). O `sync` do Bob baixa o diário dela pelo semeador (`downloaded <chave da Alice> <tamanho>`) e termina com `sync done`. `feed` lista a publicação, no formato `[<data>] Alice (<8 hex>) #<seq>` e o texto na linha seguinte. `feed` não abre a rede.

```sh
node bin/varanda.js reply --data data/bob --to "$ALICE:$SEQ" --text 'também li'
node bin/varanda.js sync --data data/bob --once --timeout-ms 30000 --bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"
```

`reply` imprime `publicado #<seq>`. O segundo `sync` entrega a resposta ao semeador. `--to` é `<64 hex>:<seq>` com `seq` maior ou igual a 1, sem zero à esquerda. Fora isso o uso é `referência inválida`.

Para encerrar: Ctrl-C no semeador (código 0) e Ctrl-C na DHT local.

### 7. Grupos públicos

`group create --name <nome> --join open|approval` cria um grupo público e imprime `grupo criado: <chave>`; a chave é a raiz do grupo. Grupos privados ainda não existem: `--join private` é recusado. Os demais subcomandos recebem a chave logo depois do nome: `group join|leave <chave>`, `group post <chave> --text <texto>`, `group list`, `group info|members|requests <chave>`, `group admit|ban|admin <chave> --member <chave>` (com `--undo` desfaz), `group hide <chave> --to <escritor>:<seq>` (com `--undo` mostra de novo) e `group meta <chave>` com `--name` e `--join`.

`group read <chave>` imprime uma linha por mensagem, das mais novas para as mais antigas: `<at> <nome|@usuário|8 hex>: <texto>`, ou `(mensagem oculta)`. Com `--limit <n>` (até 31) e se há mais antigas, a última linha é `mais antigas: --before <at>,<escritor>,<seq>`. Com `--json`, a última linha é o resultado. Um pedido que altera estado nunca é reenviado: se o resultado for incerto, o erro avisa.

Comunidades juntam grupos públicos. `community create --name <nome>` imprime `comunidade criada: <chave>`. `community link <comunidade> <grupo>` grava o vínculo do lado que você controla (a raiz da comunidade, a do grupo, ou as duas); o vínculo só vale quando os dois lados estão ligados, e `--undo` desfaz. Um grupo fica em uma comunidade por vez. `community admin <comunidade> --member <diário>` (só quem criou a comunidade, `--undo` retira) dá ao membro poder de administrador em todos os grupos vinculados, sem nomear administradores de grupo. `community info <chave>` lista os grupos vinculados dos dois lados. Detalhes em `docs/protocol.md` §10 e checagens em `docs/verification.md` §58.

## Demo automática

```sh
npm run demo
```

O mesmo programa é `node apps/cli/scripts/demo.js`. Ele sobe uma DHT em processo, em `127.0.0.1` (três nós), define `VARANDA_BOOTSTRAP` e `VARANDA_DHT_HOST=127.0.0.1`, e não fala com a DHT pública. Os dados ficam num diretório temporário, apagado no fim (salvo com `--keep`).

O que a demo mostra, nesta ordem:

1. Duas associações de teste.
2. Identidades de A (Ana) e de B.
3. A associação certifica A e B; cada um grava o certificado no bloco 0.
4. `seed key`, `assoc certify-seeder` e `seed cert add`.
5. Ana define o perfil. B segue A ainda fora da rede.
6. O semeador sobe (`seed ready`).
7. Ana publica e faz `sync --once` com o semeador. O processo dela termina: Ana fica offline.
8. O semeador recebe SIGTERM (código 0) e um processo novo abre o mesmo diretório, a partir do disco.
9. B entra com `sync --once` e recebe a publicação só pelo semeador. O feed de B mostra o texto.
10. B responde. Ana volta, segue B, sincroniza e lê a resposta no feed.
11. C confia na primeira associação e tenta gravar um certificado emitido pela segunda. `cert add` sai com código 1 e `untrusted-association` no stderr. O `sync` de C não é admitido.
12. Um segundo semeador que só tem `seed key`, sem certificado, não sobe: `seed` sai com código 1.

No sucesso o processo sai com código 0 e imprime `DEMO OK`. Na primeira falha imprime `DEMO FALHOU: <passo>` e sai com código 1.

`--keep`, ou `VARANDA_DEMO_KEEP=1`, conserva o diretório temporário:

```sh
npm run demo -- --keep
```

## Operar o semeador

Para quem mantém um semeador ligado: comandos de operação, saúde e métricas, serviço supervisionado (Docker Compose ou systemd) e a política de registros. Os arquivos de implantação ficam em `deploy/seeder/`.

### Comandos de operação

`seed status` mostra a associação, a chave pública do semeador, o estado do certificado, quantos diários estão em `admitted.json`, se há uma lista de bloqueio ilegível guardada de lado e nenhuma verificada, caso em que a partida segura admissões (linha `admissões: seguradas…`, só quando é o caso; não prevê a primeira partida depois de um arquivo rasgado sem cópia) e se algum processo segura o diretório. Não pega o lock, não abre o store e não grava nada: funciona com o semeador ligado ou parado, e sai com 0.

```
associação: <64 hex>
chave do semeador: <64 hex>
certificado: válido
diários admitidos: 2
estado: em execução
```

Sem `seeder-key.json` a segunda linha é `chave do semeador: ausente (use seed key)`. Sem certificado: `certificado: ausente (use seed cert add)`; certificado que não confere: `certificado: inválido (<motivo>)`. O estado é `em execução` ou `parado`. Num diretório que não é de semeador: `erro: diretório não é de um semeador`. Com `--json`: `{ "association", "publicKey", "certificate", "admitted", "running" }`, com `certificate` igual a `ok`, `missing` ou o motivo.

`seed list` mostra os diários admitidos, um por linha, na ordem de `admitted.json`: `<chave> <blocos> blocos <bytes> bytes`, e embaixo de cada diário, recuados, os núcleos de fotos vinculados a ele:

```
<64 hex do diário> <blocos> blocos <bytes> bytes
  mídia <64 hex do núcleo> <blocos> blocos <bytes> bytes
```

O tamanho é o assinado, o mesmo que a cota confere. Sem diários: `nenhum diário admitido`. Com `--json`: `{ "admitted": [{ "key", "length", "byteLength", "media": [{ "key", "length", "byteLength" }] }] }`. Uma chave listada sem cópia guardada aparece com 0 e 0.

`seed drop <chave>` apaga a cópia de um diário (e antes os núcleos de fotos dele) e só depois tira a chave de `admitted.json`, a mesma ordem do descarte na partida. A chave pode ser também a de um núcleo de fotos, que sai sozinho (a próxima leitura do diário o vincula de novo). Imprime `diário removido do semeador: <chave>`. Chave que não está no semeador: `erro: diário não está no semeador` (código 1). Sem chave: `uso: informe a chave do diário`; chave malformada: `uso: chave inválida` (código 2).

`seed list` e `seed drop` abrem o store e pegam o lock do diretório. Só funcionam com o semeador parado; com ele no ar saem com `erro: diretório de dados em uso` (código 1) e não mexem em nada. Pare o serviço, rode o comando e suba de novo.

`seed drop` não é bloqueio. No próximo `sync` da autora o semeador confere o bloco 0 e admite o diário outra vez. Para manter um diário fora, bloqueie a conta (veja "Bloquear uma conta").

### Saúde e métricas

`seed --health-port <porta>` (ou `VARANDA_HEALTH_PORT`) abre um endpoint HTTP só de leitura em `127.0.0.1`. Outro endereço só com `--health-host` (ou `VARANDA_HEALTH_HOST`); `0.0.0.0` expõe o endpoint para fora da máquina. Sem a porta, nada escuta. A porta `0` escolhe uma livre, e a primeira linha da saída diz qual: `health http://127.0.0.1:<porta>`. Porta ocupada termina com `erro: porta em uso` (código 1) antes de abrir o diretório.

- `GET /health` devolve `{ "status", "uptimeSeconds", "admitted", "dropping", "activeDay", "activeWeek", "blocks", "bytes", "connections", "peers", "firewalled", "blocked", "blocklistSeq", "blocklistHeld", "mediaCores", "mediaBytes", "indexRecords", "indexSaturated", "topicPosts", "topicSaturated" }`. Código 200 com `status` igual a `ok`; 503 com `starting` (antes de `seed ready`) ou `closing` (encerrando).
- `GET /metrics` devolve as mesmas contagens no formato de texto do Prometheus: `varanda_seeder_ready`, `varanda_seeder_admitted_diaries`, `varanda_seeder_dropping_diaries`, `varanda_seeder_active_diaries_day`, `varanda_seeder_active_diaries_week`, `varanda_seeder_blocks`, `varanda_seeder_bytes`, `varanda_seeder_connections`, `varanda_seeder_peers`, `varanda_seeder_firewalled`, `varanda_seeder_blocked`, `varanda_seeder_blocklist_seq`, `varanda_seeder_blocklist_held`, `varanda_seeder_media_cores`, `varanda_seeder_media_bytes`, `varanda_seeder_index_records`, `varanda_seeder_index_saturated`, `varanda_seeder_topic_posts`, `varanda_seeder_topic_saturated` e `varanda_seeder_uptime_seconds`.

```sh
curl -s http://127.0.0.1:8788/health
```

```json
{"status":"ok","uptimeSeconds":42,"admitted":2,"dropping":0,"activeDay":1,"activeWeek":2,"blocks":6,"bytes":1418,"connections":3,"peers":3,"firewalled":false}
```

`admitted` são os diários servidos e `dropping` os que estão sendo apagados. `activeDay` são os diários servidos cujo tamanho assinado cresceu no dia de Brasília (UTC−3) de hoje, e `activeWeek` os que cresceram nos últimos 7 dias de Brasília (UTC−3), hoje incluído. As duas são aproximadas, ficam só na memória do semeador e zeram quando ele reinicia; um diário admitido pela primeira vez nesta execução conta, e as contagens nunca dizem quais diários. `blocks` e `bytes` somam os diários servidos; `connections` são as conexões abertas e `peers` as que já abriram o canal de admissão. `firewalled: true` quer dizer que a DHT se vê atrás de firewall ou NAT: os membros só chegam ao semeador por hole punching. `mediaCores` são os núcleos de fotos vinculados a diários admitidos e `mediaBytes` o tamanho assinado deles. `indexRecords` são os registros no índice de engajamento (em memória) e `indexSaturated: true` quer dizer que ele chegou ao limite e há diários pausados (as respostas de `/index` dizem `complete: false`). `topicPosts` são as publicações no índice de busca por assunto (em memória) e `topicSaturated: true` quer dizer que ele atingiu um limite e há diários pausados (as respostas de `/index/topic` dizem `complete: false`); só contagens, nunca as palavras pesquisadas.

As fotos saem pela mesma porta da entrada WebSocket (`--ws-port`), em `GET` ou `HEAD /media/<diário>/<núcleo>/<início>/<blocos>`, que o Caddy da versão web encaminha. Só um núcleo vinculado a um diário admitido e não bloqueado, com todos os blocos já guardados, é servido; qualquer outra coisa é o mesmo `404` (`não encontrado`), sem dizer o motivo. No máximo 16 respostas ao mesmo tempo e 64 pedidos por segundo no total (senão `503 ocupado`), 256 blocos por pedido e 120 s por resposta. Nada é registrado. Detalhes em `docs/protocol.md` seção 7.

O endpoint só tem contagens. Nenhuma chave, certificado, endereço ou conteúdo, e nenhuma requisição é registrada. Aceita só GET e HEAD (senão 405) em `/health` e `/metrics` (senão 404), sem cabeçalhos CORS.

### Entrada WebSocket

`seed --ws-port <porta>` (ou `VARANDA_WS_PORT`) abre uma entrada WebSocket em `ws://127.0.0.1:<porta>/seeder`, para um membro que roda no navegador. É um experimento da fase 0. Outro endereço só com `--ws-host` (ou `VARANDA_WS_HOST`); o padrão é `127.0.0.1`. Sem a porta, nada escuta. A porta `0` escolhe uma livre, e a saída diz qual: `ws ws://127.0.0.1:<porta>/seeder`. Porta ocupada termina com `erro: porta em uso` (código 1) antes de abrir o diretório.

Os bytes do WebSocket são um fluxo Noise com a chave do semeador, o mesmo que o membro vê pela DHT. Um proxy TLS pode repassá-los, mas não pode terminar o Noise. Essas conexões entram em `connections` do `/health`. Só o caminho `/seeder` aceita o upgrade; qualquer outro devolve 404, e um `GET /seeder` sem upgrade devolve 426. O cabeçalho `Host` precisa nomear a própria entrada (`127.0.0.1:<porta>`, `localhost:<porta>` ou `[::1]:<porta>` no loopback); outro devolve 421, o que barra o DNS rebinding. Clientes sem `Origin` (a CLI, apps nativos) entram normalmente; um navegador só entra se a origem estiver na lista permitida, que por padrão aceita apenas páginas `http` em loopback (qualquer outra devolve 403). `--ws-origin <origem>` (repetível, ou `VARANDA_WS_ORIGIN`) troca esse padrão pelas origens dadas, como a do PWA publicado (seção "Pôr a versão web no ar"). As conexões externas têm um limite próprio, independente do limite de conexões do enxame, definido por `VARANDA_MAX_EXTERNAL` (padrão 32), para que abas abertas não deixem os membros do enxame sem vaga.

### Docker Compose

`deploy/seeder/compose.yaml` sobe a imagem de `deploy/seeder/Dockerfile`: Node 24, só as dependências de produção da CLI, o `LICENSE` do repositório em `/app/LICENSE`, usuário `node`, sistema de arquivos só de leitura e os dados no volume `seeder-data` (em `/data`). O serviço usa a rede do host, reinicia sozinho (`unless-stopped`), recebe SIGTERM com 30 s para fechar e deixa o endpoint de saúde em `127.0.0.1:8788`, onde o healthcheck da imagem o consulta. É para um servidor Linux: no Docker Desktop a rede do host não funciona do mesmo jeito.

Configuração, uma vez, a partir da raiz do repositório (`ASSOC` é a chave pública da associação):

```sh
docker compose -f deploy/seeder/compose.yaml build
docker compose -f deploy/seeder/compose.yaml run --rm seeder seed key --association "$ASSOC"
```

A associação certifica a chave impressa, na máquina dela (`assoc certify-seeder --seeder <chave> --out seeder-cert.json`). Com o arquivo no diretório atual:

```sh
docker compose -f deploy/seeder/compose.yaml run --rm -v "$PWD/seeder-cert.json:/cert/seeder-cert.json:ro" seeder seed cert add --cert-file /cert/seeder-cert.json
```

Daí em diante, um comando sobe o semeador e outro mostra a saúde:

```sh
docker compose -f deploy/seeder/compose.yaml up -d
curl -s http://127.0.0.1:8788/health
```

`docker compose -f deploy/seeder/compose.yaml ps` mostra `(healthy)` depois de `seed ready`. Registros: `docker compose -f deploy/seeder/compose.yaml logs -f seeder`. Estado sem parar: `docker compose -f deploy/seeder/compose.yaml exec seeder node apps/cli/bin/varanda.js seed status`. Para `seed list` ou `seed drop`, pare antes (`stop`), rode com `run --rm seeder seed list` e suba de novo (`start`). Não use `run` com o serviço no ar: cada contêiner tem os próprios pids, e o lock do diretório não enxerga o processo do outro. O lock do RocksDB em `store/` ainda barra o segundo processo (`erro: File descriptor could not be locked`, nada é apagado), mas o `run` remove o `.varanda-lock` do semeador no ar, e `seed status` passa a dizer `parado` até ele reiniciar.

### Pôr a versão web no ar

A versão web (o PWA: o app com o nó no navegador, a identidade derivada de uma passkey) fica no mesmo servidor do semeador. `deploy/seeder/compose.web.yaml` complementa o `compose.yaml`: liga a entrada WebSocket do semeador só em `127.0.0.1:8789`, aceitando apenas a origem `https://<domínio>`, e sobe um Caddy (`deploy/seeder/Caddyfile`) que pede o certificado TLS sozinho, serve o app publicado em `deploy/seeder/www` e repassa `wss://<domínio>/seeder` ao semeador. O Caddy só termina o TLS: o Noise vai do navegador ao semeador, que o membro verifica pelo certificado do semeador.

Antes: o semeador configurado como na seção anterior; um registro DNS (A e/ou AAAA) do domínio apontando para o servidor; as portas 80 e 443 abertas (o semeador usa a DHT por UDP, como antes). Da raiz do repositório:

```sh
cp deploy/seeder/.env.example deploy/seeder/.env    # e ponha o domínio em VARANDA_DOMAIN e a associação em VARANDA_ASSOCIATION
bash deploy/seeder/build-web.sh                     # gera o app num contêiner Node e o publica em deploy/seeder/www
docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --build
```

`VARANDA_ASSOCIATION` é a chave pública da associação (64 dígitos hexadecimais, a mesma em que o semeador confia: `seed status` a mostra), e precisa estar em `deploy/seeder/.env` antes do `up`: o compose recusa subir sem ela. O Caddy a serve em `https://<domínio>/varanda.json` (`{"v":1,"association":"..."}`, sem endereço: a página usa `wss://<domínio>/seeder`), e é daí que o app se configura sozinho.

Depois abra `https://<domínio>/` (confira também `curl https://<domínio>/varanda.json`). Os membros não preenchem mais a tela Conectar: a página só mostra "Entrar". Cada pessoa cria uma passkey (de preferência no Gerenciador de Senhas do Google) e, depois da cerimônia do emissor (seção seguinte), vincula a conta Google na etapa Identidade e recebe o certificado de membro sozinha, sem colar nada; antes dessa cerimônia o vínculo responde "serviço indisponível". No app com configuração manual (tela Conectar, Avançado), na CLI e no `varanda-serve` o certificado ainda vem da associação (`assoc certify --member <chave>`) e é colado (ou gravado com `cert add`). A cada atualização do código, sem a implantação automática da próxima seção: `git pull`, `bash deploy/seeder/build-web.sh` e o mesmo `up -d --build`.

Depois de uma visita com rede que guarde o app no aparelho, o PWA também abre sem rede, instalado (pela sugestão do próprio app ou pelo menu do navegador) ou numa aba. Entrar funciona se o autenticador da passkey funcionar sem rede; A Rua, Seguindo e Diário mostram o que já está no aparelho. Publicações e respostas ficam na fila de saída, no Diário, e saem uma a uma quando a conexão volta, com a página aberta, a identidade desbloqueada e nenhuma sincronização em andamento. Só sai sozinho o que foi escrito com a página aberta; o que ficou de uma visita anterior espera a pessoa tocar em "enviar" no Diário, para que uma publicação plantada no aparelho enquanto a identidade estava bloqueada não saia com a chave do membro. A data é a de quando a publicação entra no diário, não a de quando foi escrita; envios incertos pedem uma decisão da pessoa. Apagar os dados do site perde a fila ainda não enviada. Detalhes e limites em [docs/app.md](docs/app.md).

A exportação gera `sw.js` com os arquivos desta versão conferidos por SHA-256 e a marca `varanda-release` no `index.html`. O worker só é registrado na página hospedada em HTTPS com o nó no navegador, nunca em `localhost` nem com `varanda-serve`; ele não guarda respostas durante o uso e confere de novo o SHA-256 de cada arquivo guardado a cada leitura, antes de entregá-lo. Navegações e `varanda-node.js` buscam a rede primeiro e usam a cópia guardada desta versão se a rede falhar ou responder 404/5xx; arquivos com hash usam primeiro essa cópia. HTML no endereço de um script ou de outro recurso é recusado. No Caddy, todos os arquivos de `/srv/web` usam `Cache-Control: no-cache`, revalidado por ETag, para que uma cópia incompleta durante a implantação se corrija na carga seguinte. Um caminho com extensão que não existe recebe 404, e todo 404 recebe `no-store`; só caminhos sem extensão recebem `index.html`. `/varanda.json` continua com `no-store`.

Para o app instalado (iOS e Android) entrar com a mesma passkey do site, o domínio publica `/.well-known/assetlinks.json` e `/.well-known/apple-app-site-association`, gerados por `deploy/seeder/well-known.sh` a partir de duas variáveis opcionais de `deploy/seeder/.env`:

- `VARANDA_ANDROID_CERT_SHA256`: a impressão digital SHA-256 do certificado de assinatura da versão de lançamento do app Android, em 64 hexadecimais maiúsculos separados por dois-pontos. Vem de `eas credentials -p android` (o certificado de assinatura do build de lançamento), nunca da chave de depuração.
- `VARANDA_IOS_APP_ID`: o identificador do app no iOS, no formato `TEAMID.app.varanda` (o Team ID da conta Apple Developer mais o identificador do pacote).

O `assetlinks.json` declara `get_login_creds` (a passkey) e `handle_all_urls`: o Auth Tab do Chrome só entrega ao app a volta `https://<domínio>/account/app/conta` do vínculo da conta depois de conferir essa declaração; sem ela, o vínculo pelo app não termina e a pessoa liga a conta pelo site. O app não declara nenhum link https do site como seu, então nenhum outro link do domínio passa a abrir no app. Vazio desliga a entrada nativa naquela plataforma (a implantação avisa e segue); um valor fora da forma recusa a implantação. `deploy/seeder/well-known.sh` é lido por `deploy.sh` e `build-web.sh` como root: ele precisa ser de root e sem escrita para grupo ou outros, como o `deploy.sh`. Depois de mudar o `deploy/seeder/Caddyfile`, rode `caddy validate --config deploy/seeder/Caddyfile --adapter caddyfile` antes de subir. O fluxo do app com a conta Google está em "Vínculo pelo app nativo", mais abaixo.

Limites desta fase: a chave do membro é derivada da passkey (extensão PRF) e nunca é gravada: ela só existe na memória da página enquanto a identidade está desbloqueada, perder a passkey perde a identidade e um navegador sem PRF não entra (ver `docs/verification.md` seção 10); a passkey vale para o endereço exato da página; a página continua tão confiável quanto o código que o servidor entrega. Com rede, uma nova carga busca código fresco e instala a nova versão do worker; ela assume depois que todas as janelas do app são fechadas, sem forçar a troca numa janela aberta. Sem rede, o aparelho roda a última versão que recebeu e guardou por inteiro. A entrada WebSocket ainda não tem os limites para a internet aberta previstos no PR de endurecimento. Use com um grupo pequeno de pessoas de confiança. O Caddy não grava registro de acesso; os erros que ele registra podem incluir o endereço do cliente (mesma rotação do semeador).

#### Vínculo de conta Google e @nome (serviço `account`)

O `compose.web.yaml` também sobe o serviço `account`, que liga a passkey de um membro a uma conta Google e dá a ele um @nome e um certificado de membro automático. O app instalado usa o mesmo serviço (veja "Vínculo pelo app nativo"). O Caddy repassa `/account/*` a ele. Dois valores novos em `deploy/seeder/.env` (veja `.env.example`):

- `VARANDA_GOOGLE_CLIENT_ID` e `VARANDA_GOOGLE_CLIENT_SECRET`: um cliente OAuth do Google Cloud. No console (APIs e serviços, Credenciais), crie um "ID do cliente OAuth" do tipo "Aplicativo da Web"; em "URIs de redirecionamento autorizados" ponha `https://<domínio>/account/callback`; na tela de consentimento use os escopos `openid` e `email`. Copie o ID e o segredo para o `.env`. O segredo nunca vai para o repositório nem para registros.

O serviço sobe sem emissor: até a cerimônia abaixo, `/account/health` responde `{"status":"ok"}` e as rotas de vínculo respondem 503 `indisponivel`. A cerimônia roda DEPOIS da primeira implantação com o serviço (a imagem `varanda-seeder:local` só passa a ter o comando `account` depois do `up -d --build`). Da raiz do repositório no servidor, com o serviço `account` parado se já estiver rodando (`docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml stop account`):

1. Gere a chave do emissor dentro do volume do serviço; o comando imprime só a chave pública:

   ```sh
   docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml run --rm account account key
   ```

2. Na máquina do operador (onde está a associação), certifique essa chave pública:

   ```sh
   node bin/varanda.js assoc certify-issuer --data <assocDir> --issuer <hex> --out issuer-cert.json
   ```

3. Copie só esse arquivo público (`issuer-cert.json`) para o servidor e grave-o no serviço:

   ```sh
   docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml run --rm -v $PWD/issuer-cert.json:/cert/issuer-cert.json:ro account account cert add --cert-file /cert/issuer-cert.json
   ```

4. Reinicie o serviço: `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml restart account`. Depois disso `account status` deixa de dizer `emissor não certificado`.

O `association.json` nunca sai da máquina do operador, e o segredo do emissor nunca sai do volume do serviço `account`. O `account cert add` recusa um certificado de outra associação ou de outra chave.

Com `VARANDA_MAX_MEMBERS` definido, quando o número de contas vinculadas chega ao teto, um vínculo que criaria um membro novo recebe "lista de espera" (HTTP 503) e o app mostra uma tela calma com essa resposta. Nada sobre a pessoa fica guardado: o serviço não grava a tentativa, nem o @nome escolhido, nem o e-mail, e a linha pendente é apagada se a recusa vier na conclusão do vínculo. Se o teto se completar enquanto a pessoa está no Google, a volta do Google é recusada antes de o código do Google ser trocado, então nenhum dado do Google é coletado para um vínculo recusado. Quem já é membro segue normalmente: renomear, ver o status, denunciar e concluir um segundo vínculo começado antes de o primeiro terminar (vale como atualização de e-mail) continuam funcionando. Uma chave nova para uma conta já vinculada conta como membro novo e também espera. Baixar o teto abaixo do número atual não remove ninguém. O semeador tem o próprio limite de 4096 diários, que continua valendo: mantenha `VARANDA_MAX_MEMBERS` igual ou abaixo dele.

##### Convites

Com `VARANDA_INVITES_PER_WEEK` definido, um vínculo Google que criaria um membro novo só termina com um convite válido. Quem já é membro não precisa de convite: renomear, ver o status, denunciar e atualizar o e-mail continuam como antes. Sem a variável (ausente ou vazia), nada disso existe e o cadastro é o aberto de sempre: `GET /account/invites/policy` ainda responde `{ "required": false }` e as rotas `POST` de convite não existem.

- **O link.** `https://<origem>/convite/<código>`. O código tem 32 bytes aleatórios em base64url, é mostrado uma única vez ao membro que o cria e o serviço guarda só o SHA-256 dele, e só enquanto o convite não foi usado. Cada link vale para uma pessoa só e por 7 dias depois de criado.
- **Quanto cada membro pode convidar.** Cada membro vinculado ganha N convites por semana civil de Brasília (UTC-3, sem horário de verão), de segunda 00:00 até a segunda seguinte. Um convite criado conta na semana em que foi criado, mesmo sem uso; o que sobra não acumula; não há revogação nem devolução. Todos seguem N, o operador também, e não existe comando de emissão. Baixar N não apaga os links já criados na semana. A semana segue o relógio do servidor.
- **A primeira pessoa.** Numa rede vazia ninguém pode emitir convite. A primeira pessoa precisa vincular com a variável vazia e só depois o operador a define. Não há exceção.
- **`varanda assoc certify` fica fora do portão.** Um membro só certificado não é vinculado, logo não emite convite.
- **O que o serviço guarda.** No `invites.json` (modo 0600, ao lado do `directory.json`): um identificador aleatório de cada convite, a chave de quem o criou, a data de criação, se foi usado e, enquanto não foi usado, o hash do código. Nunca e-mail, nome, `sub` ou chave de quem entrou. O uso único é decidido pelo diretório: o registro do vínculo de quem entrou guarda o hash do convite usado, e um segundo vínculo com o mesmo convite é recusado na hora, sem depender do `invites.json`. Por isso o `invites.json` apaga o hash quando o convite é usado e não guarda quando. Quem convidou quem pode ser reconstruído a partir de uma cópia antiga do `invites.json` (de antes do uso) e, de forma aproximada, pelas datas.
- **O caminho.** No app, o membro vinculado abre Ajustes › Convidar pessoas, vê quantos convites pode criar por semana e cria o link; depois de criar, vê quantos restam. Quem recebe abre o link, e o app guarda o código só na aba (`sessionStorage`, chave `varanda-signup-invite`) e o envia ao serviço no início do vínculo; o código não vai para o Google. A volta do Google recusa um convite inválido antes de trocar o código do Google, como a lista de espera, e a linha pendente é apagada. Uma recusa na conclusão deixa o convite utilizável. Uma recusa na conclusão por @nome em uso ou conta já vinculada também apaga a linha pendente e libera o convite na hora, para a pessoa recomeçar.
- **Rotas.** `GET /account/invites/policy` (`{ required, perWeek }`), `POST /account/invites/start` e `POST /account/invites/finish` (o membro assina com `invite.sign`, ver `docs/rpc.md` 5.30; a resposta traz o código uma vez e quantos convites o membro já usou e ainda tem na semana). `GET /account/status` não traz contagens de convite: a chave de um membro é pública. Recusas: `convite-obrigatorio` (403), `convite-invalido` (404), `limite-convites` (429), e `indisponivel` se o `invites.json` não puder ser lido.
- **`varanda account status`.** Mostra só contagens: `convites: <total> (<usados> usados)`, nunca um código ou uma chave.

Limites conhecidos (detalhes em `docs/verification.md`, seção 37): uma queda ou perda do lock do serviço no meio da criação pode gastar o convite da semana sem entregar o link; um erro passageiro de leitura do `invites.json` deixa os convites indisponíveis até reiniciar o serviço (como o `terms.json`); o `invites.json` e o diretório são arquivos separados, então uma gravação atrasada de um processo que perdeu o lock pode desfazer a contagem da semana, sem afetar o uso único; em navegação privada que recusa o armazenamento da aba, o código fica só na memória da página e não sobrevive à ida ao Google, e a pessoa abre o link de novo se o vínculo não terminar; uma nova tentativa de início sem assinatura nunca apaga um vínculo pendente que já passou pela assinatura ou pelo Google, a menos que venha do mesmo navegador com o cookie desse vínculo ("começar de novo", "usar outra conta Google"); sem o cookie, o código fica reservado até esse pendente vencer (10 minutos) ou terminar.

O diretório de contas fica no volume `account-data` em três arquivos: `directory.json` (o retrato, com `seq`), `directory.journal.<id>` (o diário de mudanças, uma linha por vínculo, troca de e-mail ou troca de @nome; `<id>` é o identificador que o retrato guarda) e `directory.hwm` (a marca d'água: o maior `seq` já confirmado, com o número de vínculos e de @nomes naquele ponto). Cada mudança grava uma linha no diário e a confirma com `fsync`, sem reescrever o diretório inteiro. Ao chegar a 256 linhas, ao passar de 1 MiB e a cada abertura do serviço (mesmo com o diário vazio), o serviço compacta: cria um diário novo (com identificador novo), reescreve o retrato apontando para ele e só então apaga o diário anterior; um diário nunca é truncado nem reescrito. Um corte de energia no meio de uma linha deixa uma linha incompleta, que o serviço ignora e a próxima abertura para escrita descarta; um corte no meio de uma compactação deixa um diário órfão (que nenhum retrato nomeia), que uma abertura para escrita remove depois de 40 segundos sem gravação nele (antes disso ele pode ser de um serviço que ainda não percebeu que perdeu o lock) e depois de conferir de novo que o retrato não o nomeia. Os três arquivos têm modo 0600.

O retrato e o diário andam juntos: o retrato na versão 2 guarda o identificador do seu diário, e a primeira linha do diário traz esse identificador. Se o diário sumir, ficar vazio ou trouxer outro identificador, ou se um diário órfão trouxer uma mudança além do retrato, o serviço (e `account status`, `account export` e `account reports`) recusa o diretório com `diretório de contas inválido`, em vez de esquecer vínculos e entregar de novo um @nome ou uma conta Google. Enquanto roda, o serviço confere antes e depois de cada gravação que o diário é o mesmo arquivo, com o tamanho esperado, e que o `directory.json` é o mesmo arquivo que ele leu ou gravou por último; se alguém mexeu neles, ou se o serviço perdeu o lock e outro serviço assumiu o diretório (toda abertura do novo serviço troca o `directory.json` e apaga o diário antigo, mesmo vazio), o serviço para de gravar e responde "indisponível" até ser reiniciado; uma linha gravada bem na troca não é confirmada a quem pediu. Um diário órfão com uma mudança além do retrato só abre quando o diário nomeado traz a mesma linha (uma queda bem no fim de uma compactação). Uma falha do disco ao confirmar uma linha (`fsync`) tem o mesmo efeito. Nunca gire (rotacione), apague ou esvazie um `directory.journal.*`: ele não é um log. O backup do volume leva os três arquivos juntos, com o serviço parado.

**Restaurar um backup é um evento de segurança.** O backup copia os três arquivos juntos, com o serviço parado; ao restaurar, restaure só o `directory.json` e o `directory.journal.*` que ele nomeia, sempre da cópia MAIS RECENTE, e MANTENHA o `directory.hwm` que já está no volume (restaure o `directory.hwm` do backup apenas se o volume o perdeu): sobrescrever a marca atual pela do backup a baixaria e a recusa de cópia restaurada nunca dispararia. uma cópia mais antiga faz o diretório esquecer os @nomes e as contas Google vinculados depois dela, que poderiam ser entregues de novo a outra pessoa. Por isso o `directory.hwm` guarda o maior `seq` confirmado e o número de vínculos e de @nomes naquele ponto (atualizado a cada compactação e na parada limpa, nunca para trás) fora do par retrato+diário: se o par restaurado termina abaixo dessa marca, o serviço recusa abrir com `diretório de contas restaurado de uma cópia antiga; confira o backup` (e registra `store restaurado`), e `account status`, `account export` e `account reports` ainda leem, mas avisam. Um `directory.json` com `seq` é julgado pelo `seq`; um sem `seq` (gravado por uma versão anterior, ver abaixo) é julgado só pelas contagens: recusado quando tem menos vínculos ou menos @nomes que a marca. Confira primeiro se não há um backup mais recente. Se a restauração de uma cópia antiga for mesmo intencional, o operador a reconhece apagando o `directory.hwm` depois de confirmar que nenhum @nome e nenhuma conta Google foram emitidos desde aquela cópia; o próximo serviço grava uma marca nova a partir dela. Mudanças feitas depois da última compactação ou parada limpa e perdidas numa queda não entram na marca.

Antes de voltar a uma versão anterior a esta, pare o serviço com a parada limpa: `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml stop account`. Confira que o `directory.json` traz `"v":1` e que não há nenhum arquivo `directory.journal.*`; só então suba a versão anterior (ela ignora o `directory.hwm`). Se a parada registrar `close falhou` (e o serviço sair com código 1), ou se o serviço foi morto à força (ou saiu com `lock perdido`), o `directory.json` fica na versão 2 (toda abertura desta versão o grava assim), que a versão anterior recusa com `diretório de contas inválido`. Nesse caso, suba esta versão, deixe-a abrir o diretório, pare-a com a parada limpa e só então volte. Para voltar a esta versão depois, não é preciso mexer no `directory.hwm`: a versão anterior grava o `directory.json` sem `seq`, e esta versão o compara pelas contagens com a marca, abre se nenhum vínculo nem @nome se perdeu e segue a numeração a partir da marca. Só apague o `directory.hwm` se a volta for recusada com `restaurado de uma cópia antiga` e a perda de vínculos ou @nomes for mesmo intencional.

Os aceites dos Termos de Uso e da Política de Privacidade ficam num arquivo à parte no mesmo volume, `terms.json` (modo `0600`): para cada chave de membro, a versão aceita, a data (do relógio do serviço), o nonce e a assinatura que provaram o aceite; nunca o e-mail. Só um membro já vinculado registra aceite (`POST /account/terms/start` e `/account/terms/finish`, com uma prova da chave do diário). Inclua `terms.json` no backup do volume `account-data`, junto do diretório de contas. Restaurar uma cópia mais antiga perde os aceites feitos depois dela, e os aparelhos que já sincronizaram o aceite não o reenviam. `account export` traz em cada linha o campo `terms`, a lista `[{ "version", "acceptedAt" }]` dos aceites daquele membro (`[]` sem aceite; nunca o nonce nem a assinatura), e sai com `terms.json inválido` (código 1) se o arquivo estiver corrompido; `account status` mostra `aceites dos termos: <n>` ou `aceites dos termos: indisponível (terms.json inválido)`. Com o arquivo inválido o serviço continua no ar, registra `terms indisponivel` e responde "indisponível" (HTTP 503) só nessas duas rotas. Uma versão anterior a esta ignora o `terms.json` e responde 404 nas duas rotas: voltar a ela não perde os aceites gravados, que reaparecem quando esta versão volta.

Se houver um `directory.journal.*` antes de voltar (um diário órfão), suba esta versão de novo, espere mais de 40 segundos para que a limpeza de órfãos o remova, pare-a com a parada limpa e confira de novo. O `deploy.sh` desfaz o deploy sozinho recriando o contêiner `account` com um fechamento por SIGTERM, que deixa a versão 1 só se esse fechamento der certo; se o contêiner `account` estava parado ou reiniciando naquele momento, o diretório continua na versão 2 e a imagem anterior o recusa até que os passos manuais acima sejam seguidos.

##### Vínculo pelo app nativo

O app nativo faz o mesmo vínculo, mas o passo do Google roda no navegador do sistema, que não divide cookies com o app. Por isso o app segue o padrão de apps nativos do OAuth (RFC 8252) no lugar do cookie `__Host-varanda-link`, sem nada novo para configurar no Google (o retorno continua sendo `https://<domínio>/account/callback`):

- **Cabeçalho.** Os pedidos do app trazem `x-varanda-client: app`. Um `POST` sem cabeçalho `Origin` só é aceito com esse cabeçalho e com corpo JSON (uma página de outro site não envia nenhum dos dois sem uma consulta prévia de CORS, que o serviço nunca responde). Um `Origin` presente continua tendo de ser exatamente a origem pública; `null` é recusado.
- **Segredo V.** O app sorteia 32 bytes (V) e os guarda só na memória. No início envia apenas `appProof`, o SHA-256 de V em base64url (43 caracteres), e não recebe cookie. Autorizar, ler o pendente e concluir trazem V no cabeçalho `x-varanda-link`; o serviço guarda só o `appProof` e compara em tempo constante. Recomeçar um vínculo com convite já assinado ou já no Google vale, como o cookie na web, para quem apresenta V. Um recomeço com V abandona a linha anterior: a página do Google aberta para ela não conclui mais e volta para `https://<domínio>/account/app/conta?conta=erro`.
- **Código de resgate R.** A volta do Google de um vínculo do app é reconhecida só pelo `state` de uso único e termina em `https://<domínio>/account/app/conta?conta=ok&codigo=<R>`, com R aleatório de uso único; o serviço guarda só o hash de R. As recusas voltam para `https://<domínio>/account/app/conta?conta=<erro|cancelado|lista-de-espera|convite-invalido>`, sem código. R chega ao app só pela sessão de autenticação que o próprio app abriu (Auth Tab no Android, `ASWebAuthenticationSession` no iOS), que captura essa volta. Não há outro caminho: o app ignora qualquer código que chegue por link (`varanda://conta?...`), e a página `https://<domínio>/account/app/conta`, se um navegador a carregar, é estática, sem script e sem link, e nunca repete a consulta. Num aparelho sem navegador com Auth Tab (ou em que a conferência falhe), o app pede para ligar a conta Google pelo site, entrando com a mesma passkey: é a mesma conta. Ler o pendente exige V e R (`x-varanda-redeem`); concluir exige os dois e gasta R, mesmo se a conclusão for recusada (aí o app recomeça). R vale por 3 minutos depois da volta do Google, e o app esquece V quando a sessão falha: um R que um navegador tenha guardado no histórico não serve para nada. A conta Google só é associada à linha pendente quando R é apresentado.
- **Idade.** Com o cabeçalho do app, a sessão do Didit volta para `https://<domínio>/account/age/app-return`, que ignora qualquer parâmetro e redireciona para `varanda://idade?volta=1`; o app pergunta o resultado com a assinatura, como a web. O domínio permitido no Didit continua o mesmo. Uma sessão aberta pela web só é reaproveitada pela web, e a do app só pelo app: quem usa os dois na mesma hora abre duas sessões pagas.

Por que dois segredos: quem compartilha o link do Google com outra pessoa tem V, mas nunca vê R, porque a volta com R chega ao aparelho de quem entrou no Google. Outro app no mesmo aparelho pode registrar o esquema `varanda://`, mas R não passa mais por ele; e, mesmo com R, nada se conclui sem V, que nunca sai da memória do app. Os registros nunca trazem V, `appProof`, R, `state`, `sub` nem e-mail. Verificação manual em `docs/verification.md`, seção 50.

#### Verificação de idade (Didit, serviço `account`)

Na web hospedada, todo membro, novo ou já vinculado, confirma a idade antes de usar o app. A idade mínima é 16 (decisão do produto com base no ECA Digital, sujeita a parecer jurídico). A pessoa é enviada à página do Didit, por navegação de página inteira como no passo do Google (por isso o CSP do `Caddyfile` não muda), e volta para `https://<domínio>/?idade=volta`. O serviço `account` pergunta a decisão ao Didit por conta própria e nunca confia na URL de volta.

Configuração do operador:

- Crie a aplicação no Didit e um workflow com estimativa de idade por rosto e documento de reserva.
- Defina o domínio permitido como a origem pública. O callback é `https://<domínio>/?idade=volta`.
- A chave da API precisa dos privilégios `read:sessions` e `delete:sessions` e não pode ser restrita a um workflow ou a um status: o Didit responde 404 a uma chave restrita, e o serviço trata 404 como sessão já apagada, então uma chave restrita deixaria imagens guardadas sem aviso.
- Ponha `VARANDA_DIDIT_API_KEY` e `VARANDA_DIDIT_WORKFLOW_ID` no `.env`. O teto diário opcional é `VARANDA_DIDIT_DAILY_LIMIT` (padrão: 200 sessões por dia).
- Em produção, defina as duas variáveis. Sem elas ninguém é consultado (útil só no desenvolvimento e na demo) e o serviço registra isso na partida. Para desligar, remova as duas.

O que fica guardado: o `age.json` no volume `account-data` (modo `0600`), com a chave do membro, a faixa (`16-17` ou `18+`), o método `didit` e a data. Nada além disso. Faça o backup junto com o resto do `account-data`. A imagem do rosto e o documento nunca chegam ao Varanda.

Retenção no Didit: depois de cada decisão final o serviço pede ao Didit que apague a sessão (`DELETE` com `retain_face_embeddings` falso). Se falhar, tenta de novo algumas vezes, em memória. Como reserva, defina a retenção mínima no console do Didit e recuse ali qualquer uso para treinamento ou reaproveitamento.

Limites: 3 sessões por membro em 24 h e, para quem ainda não tem vínculo, 3 por código de convite em 24 h (com convites ligados). O teto diário conta à parte as chaves novas e os membros já vinculados, então chaves descartáveis não tiram a vez de quem já é membro. Com o cadastro aberto (sem convites), só o teto diário segura chaves descartáveis: acompanhe o registro `idade`/`sessao` e use convites se o teto encher. As sessões pendentes ficam só na memória, então um reinício pede que a pessoa recomece e a sessão aberta não é apagada no Didit (a retenção mínima do console cobre esse caso). Uma estimativa por rosto abaixo de 21 anos pede o documento, e só o documento pode recusar (menos de 16).

Teste de fumaça no sandbox, ANTES de ligar em produção. O serviço falha fechado (todos continuam bloqueados) se o formato das respostas do Didit for diferente do esperado. Com uma chave de sandbox e o id do seu workflow:

```sh
curl -sS -X POST https://verification.didit.me/v3/session/ \
  -H "x-api-key: $VARANDA_DIDIT_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"workflow_id\": \"$VARANDA_DIDIT_WORKFLOW_ID\", \"callback\": \"https://<domínio>/?idade=volta\"}"
curl -sS https://verification.didit.me/v3/session/<id>/decision/ \
  -H "x-api-key: $VARANDA_DIDIT_API_KEY"
```

Confira que as respostas trazem `session_id`, `url` e um campo `status`.

Diagnóstico: quando o app mostra "A verificação de idade está fora do ar agora", o serviço registra o motivo, só com palavras fixas (nunca a chave, a sessão ou o que o Didit respondeu). Veja com `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml logs account | grep '"idade"'`:

| Registro (`reason`) | O que fazer |
| --- | --- |
| `didit-sessao-http-401` ou `didit-sessao-http-403` | Chave recusada: confira `VARANDA_DIDIT_API_KEY` (de produção, não de sandbox), os privilégios e se há crédito na conta do Didit. |
| `didit-sessao-http-400` com `didit-sessao-campo-callback` | O domínio do callback não está liberado no Didit: ponha a origem pública nos domínios permitidos da aplicação. |
| `didit-sessao-http-400` ou `-404` com `didit-sessao-campo-workflow_id` | O `VARANDA_DIDIT_WORKFLOW_ID` não existe para essa chave. |
| `didit-sessao-tempo` ou `didit-sessao-rede` | O servidor não alcançou `verification.didit.me` (rede, DNS, firewall de saída). |
| `didit-sessao-formato` | O Didit respondeu num formato inesperado: rode o teste de fumaça acima e compare. |
| `armazenamento-indisponivel` | O `age.json` não pôde ser lido ou gravado no volume `account-data`. |
| `teto-diario` | O teto `VARANDA_DIDIT_DAILY_LIMIT` encheu; volta no dia seguinte. |

Os mesmos motivos, com `didit-decisao-` no lugar de `didit-sessao-`, valem para a leitura do resultado.

Antes do lançamento é preciso existir um canal privado de contato para contestação da decisão. Defina-o com os mantenedores; este documento não inventa um.

#### Conta de pagamentos (Hodle, serviço `account`)

É uma conta opcional de Pix e reais digitais (BRLA) dentro do Varanda, feita com o Hodle. Sem `VARANDA_HODLE_API_KEY` nada muda: o recurso não existe e a política responde `{ available:false }`. Ligá-lo não é necessário para usar a rede.

Pré-requisitos no Hodle, antes de ligar:

- Conta com subcontas, verificação de identidade (KYC) e carteiras habilitadas.
- Peça ao suporte para habilitar operações de terceiros e saques por API.
- Confirme por escrito que cada membro pode ter o próprio PIN de carteira. A página de chaves de carteira do Hodle diz que carteiras de subcontas usam o PIN da plataforma, a menos que a subconta tenha usuário próprio. Até essa confirmação, não use produção com `carteira`.

Modos (`VARANDA_HODLE_MODE`), em ordem: `cadastro` (padrão: subconta e verificação) < `carteira` (acrescenta criar a carteira com o PIN do membro) < `pix` (acrescenta saldo, receber e pagar por Pix e a taxa da Varanda); `completo` vem no próximo PR. Em `cadastro`, criar a carteira responde 404 e o app mostra "Verificação aprovada. A carteira será liberada em breve.". Defina `carteira` só depois da confirmação do Hodle acima (no sandbox, a primeira carteira protegida pode fixar o PIN enviado).

Registrar webhooks (opcional, só para acelerar o estado). O Hodle manda um `WEBHOOK_TEST` assinado antes de mostrar o segredo e só salva o webhook se a resposta for 2xx. Por isso, em dois passos:

1. Coloque `EVENTO:registrar` em `VARANDA_HODLE_WEBHOOK_SECRETS`, reinicie o serviço `account` e cadastre `https://<domínio>/account/wallet/webhook/<EVENTO>` no Hodle. Nesse caminho o serviço responde 200 `{}` a um corpo cujo evento é exatamente `WEBHOOK_TEST`, sem verificar e sem tocar em nenhum armazenamento, e 401 a qualquer outro corpo. Esse passo tem janela própria de 30 respostas por minuto (acima disso, 429 e `webhook-limite`), separada da janela das entregas verificadas.
2. Copie o segredo mostrado pelo Hodle, troque `registrar` pelo hex de 64 caracteres (`EVENTO:<hex64>`) e reinicie. Dali em diante o caminho verifica toda entrega, `WEBHOOK_TEST` inclusive.

Um evento `DISPUTE_*` só marca uma contestação ao lado do estado da operação. Esta versão não tem tela de contestação: o operador a resolve no painel do Hodle.

##### Operação do Pix e da taxa

- Taxa do Hodle: segundo a documentação da Hodle, o padrão é R$ 1,50 mais 2,5%, mostrada pela cotação e somada ao valor (o membro paga valor mais taxa). O Hodle manda na taxa dele; a da Varanda é só a das variáveis `VARANDA_FEE_*`.
- Limites: o Hodle aceita até R$ 3.000 por transação. A Varanda limita ainda 20 depósitos por dia, 10 saques por dia e 30 leituras a cada 10 minutos por membro. O teto diário `VARANDA_HODLE_DAILY_LIMIT` também conta os saques. Cada membro usa no máximo um quarto desse teto (mínimo de 10 chamadas); quem passa da própria parte recebe `limite-carteira`, e os outros membros seguem.
- Operações de terceiros: peça ao suporte do Hodle para habilitar Pix para o CPF de outra pessoa. Sem isso, o Pix para terceiros falha na conferência do Hodle.
- Conciliação: cada operação leva no Hodle um `externalId` que começa com `var-`. A parte da Varanda de uma transferência usa a mesma referência com o sufixo `:taxa`. Procure os dois no painel do Hodle.
- Taxa em duas pernas: primeiro a perna principal; a perna da taxa da Varanda só sai quando a resposta da principal já diz que o Pix foi concluído (senão a taxa fica `pendente`); e, só se as pernas anteriores responderam 2xx em menos de 45 s, no máximo UMA taxa pendente de antes, só de um Pix já concluído, mostrada de novo com a mesma referência. Como um Pix de saída costuma levar de 30 a 90 s, a taxa em geral é cobrada no próximo envio da pessoa. Se o Pix falha ou volta antes de concluir, a taxa dele nunca é cobrada. Reserva: para enviar, o saldo precisa cobrir o valor, a taxa do Hodle, a taxa nova e todas as taxas pendentes; esse dinheiro fica na carteira da pessoa até ser cobrado. Nenhuma taxa pendente sai antes da principal. Cada perna é escrita no `wallet-ops.json` antes de sair (taxa `enviada`). O prazo de cada perna é 30 s, acima dos 25 s da fila do Hodle; uma chamada abortada não prova que o Hodle recusou. Um PIN errado ou bloqueado na primeira perna aborta as demais, então um toque custa uma tentativa de PIN. Um 409 de referência já usada conta como `cobrada` só se o corpo traz estado `completed` ou um `txHash`; senão a taxa fica `pendente` até uma leitura do extrato. Estados da taxa: `cobrada`, `pendente`, `incerta`. Taxa pendente só é apresentada de novo dentro do próximo envio que a pessoa assina com o PIN, nunca por relógio.
- Estado `incerto`: uma chamada que muda estado perdeu a resposta. Nada é refeito sozinho. Confira no painel do Hodle pelo `externalId` e, se preciso, no `wallet-ops.json`.
- `wallet-ops.json` (modo 0600, volume `account-data`): para cada operação, tipo, estado, valor, taxas, id do Hodle, destino mascarado e a marca de contestação. Nunca a chave Pix inteira nem o CPF. Linhas finais são apagadas depois de 90 dias, exceto enquanto uma taxa da Varanda ainda puder ser cobrada, uma contestação estiver aberta ou uma revisão de suporte estiver aberta; um Pix de entrada que falhou e ainda está sendo devolvido não conta como finalizado. O arquivo guarda no máximo 20000 operações: acima disso, as finalizadas mais antigas são apagadas antes dos 90 dias, com as mesmas exceções. Para inspecionar, abra o arquivo no volume `account-data` (por exemplo com `docker compose ... exec account cat`, no caminho de dados do serviço), sem copiá-lo para fora do servidor.
- Código de Defesa do Consumidor: a taxa do Hodle e a da Varanda aparecem em reais, com o total, antes de cada confirmação. Peça parecer jurídico sobre a informação adequada no contrato e na tela antes de ligar em produção.
- Os Termos (versão 8) já contam essas cobranças. Aviso: um Pix já concluído e depois devolvido pelo banco de quem recebeu não devolve sozinho uma taxa da Varanda já cobrada.

O que fica guardado: o `wallet.json` no volume `account-data`, com o vínculo do membro à subconta, o estado da verificação e a carteira. O que nunca fica: o PIN, o CPF, as imagens de documento e o endereço postal.

CSP: o `Caddyfile` agora libera `https://uploads.hodle.com.br` em `connect-src`. As imagens de documento vão do navegador direto ao Hodle por URLs de uso único e nunca passam pelo Varanda. O `img-src` não muda (o código Pix aparece como texto).

Diagnóstico: o serviço registra `{ event: 'carteira', reason }` só com palavras fixas, nunca a chave, o PIN ou o que o Hodle respondeu. Veja com `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml logs account | grep '"carteira"'`.

| Registro (`reason`) | O que fazer |
| --- | --- |
| `teto-diario` | O teto `VARANDA_HODLE_DAILY_LIMIT` encheu; volta no dia seguinte. |
| `armazenamento-indisponivel` | O `wallet.json` não pôde ser lido ou gravado no volume `account-data`. Se aparecer logo depois de uma chamada aceita pela Hodle, a pessoa recebe "resultado incerto" e nada é refeito sozinho. |
| `ligada` / `desligada` / `indisponivel` | Estado da conta de pagamentos na partida do serviço (`indisponivel`: o `wallet.json` existe mas não pôde ser aberto). |
| `carteira-incerta` | A criação da subconta ou da carteira perdeu a resposta e não foi confirmada por leitura. A pessoa fica parada até uma leitura confirmar ou o operador resolver; o serviço nunca cria de novo sozinho. |
| `conflito` | A Hodle devolveu uma subconta ou carteira que já está guardada para outra pessoa. Nada foi gravado; confira na Hodle. |
| `kyc-incerto` | Um envio de KYC perdeu a resposta e a consulta só achou o id de uma tentativa que a pessoa já teve (ou, num registro antigo sem a lista `previousAttemptIds`, uma tentativa já encerrada). Uma tentativa nova é adotada mesmo já encerrada. A pessoa fica em "verificação em andamento" até uma leitura achar a tentativa nova ou o operador conferir na Hodle. |
| `rede-divergente` | `VARANDA_HODLE_NETWORK` mudou depois que a pessoa abriu a conta e antes da carteira. A carteira não é criada; volte a variável para a rede da conta. |
| `terceiros-desligado` | O Hodle recusou um Pix de entrada de CPF de outra pessoa porque a chave não tem operações de terceiros. Peça ao suporte do Hodle para habilitar. |
| `contestacao` | Chegou um evento `DISPUTE_*` pelo webhook: a operação ganhou a marca de contestação. Resolva no painel do Hodle pelo `externalId`. |
| `consulta-antiga` | Uma operação em aberto tem mais de 89 dias, além da janela do extrato do Hodle, e o serviço parou de procurá-la sozinho. Resolva à mão no painel do Hodle pelo `externalId`. |
| `reparado` (evento `carteira`) | O reparo periódico regravou o `wallet.json` ou o `wallet-ops.json`, que estava sem algo já gravado pelo serviço. Se repetir, confira o registro do operador e se alguém mexeu no arquivo no volume `account-data`. |
| `extrato-cursor-longo` | O cursor do extrato passou de 512 caracteres e a página seguinte foi cortada. Confira o extrato no painel do Hodle se uma pessoa reclamar de operação que não aparece. |
| `webhook-recusado` | Uma entrega no webhook falhou na verificação (assinatura, origem ou corpo inválido) e recebeu 401. Se persistir com entregas legítimas, confira o segredo em `VARANDA_HODLE_WEBHOOK_SECRETS`. |
| `webhook-registro` | O webhook respondeu 200 a um `WEBHOOK_TEST` no passo `EVENTO:registrar`. Copie o segredo do Hodle e troque `registrar` pelo hex. |
| `webhook-ignorado` | Entrega verificada, mas sem efeito: sem dados, de outro provedor, de operação ou verificação que a Varanda não conhece. Nada a fazer. |
| `webhook-repetido` | Entrega verificada já aplicada antes (reenvio do Hodle). Nada a fazer. |
| `webhook-aplicado` | Entrega verificada que atualizou o estado de uma operação ou de uma verificação. Num Pix de entrada ou de saída, o estado gravado vem da consulta ao Hodle que a entrega disparou, nunca do corpo da entrega. Nada a fazer. |
| `webhook-leitura` | Uma entrega que encerraria um Pix (concluído, falhou, devolvido) não pôde ser confirmada pela consulta ao Hodle e recebeu 503, para o Hodle reenviar. Se repetir, confira se o Hodle responde e se aparecem linhas `hodle-consulta-*`; a consulta da operação e o extrato acertam o estado depois. |
| `webhook-limite` | O webhook passou de 300 entregas verificadas por minuto e respondeu 429. Só entregas que passaram na verificação contam (uma enxurrada sem assinatura recebe 401 e nunca esgota a janela); no passo `EVENTO:registrar`, também aparece quando o caminho passou de 30 `WEBHOOK_TEST` por minuto, numa janela separada que nunca esgota a das entregas verificadas; antes do serviço, o Caddy limita o caminho a 20 pedidos a cada 10 s por endereço de cliente. Isso fica muito acima do ritmo real do Hodle: procure um remetente com defeito ou um segredo vazado em `/account/wallet/webhook/`. |
| `taxa-ligada` / `taxa-desligada` | Na partida, diz se alguma taxa da Varanda (`VARANDA_FEE_*`) está ativa. Confira se é o que você quis. |
| `pin-plataforma` | A Hodle recusou a criação da carteira com o PIN da pessoa (403). Sinal de que a conta da chave usa o PIN da plataforma: mantenha `VARANDA_HODLE_MODE` em `cadastro` e fale com o suporte da Hodle. |

Os motivos de falha da chamada ao Hodle seguem o padrão `hodle-<passo>-<causa>`, com `<passo>` em `subconta`, `documento`, `kyc`, `carteira`, `chaves`, `leitura`, `deposito`, `saldo`, `extrato`, `cotacao`, `pagamento`, `taxa` ou `consulta` e `<causa>` como `http-401`, `tempo`, `rede`, `formato`, `entrada` (pedido recusado antes de sair) ou `falha` (erro inesperado); confira o código em `apps/cli/lib/account/hodle.js` e `apps/cli/lib/account/wallet-routes.js`. Em `http-401` ou `http-403` confira a chave de API; em `tempo` ou `rede` espere e veja o status do Hodle; em `formato`, `entrada` ou `falha` guarde o horário e abra uma issue sem o corpo da resposta.

Sandbox: os fluxos de dinheiro de subconta não estão disponíveis nele, então o teste de fumaça dessas operações só vale com a conta principal.

### Implantação automática pelo GitHub Actions

O fluxo `deploy` (`.github/workflows/deploy.yml`) implanta `main` no servidor a cada push. Ele repete as checagens do CI (`npm ci`, lint, testes e demo) como os mesmos seis jobs em paralelo, no Node 24. O job `check` reúne os seis e só passa se todos passaram. Se `check` passar, o fluxo entra no servidor por SSH como `varanda-deploy` e roda `deploy/seeder/deploy.sh`. O SHA testado vai pela entrada padrão do SSH, nunca por argumento.

O script só implanta se esse SHA for a ponta de `origin/main`. Se `main` já avançou, sai com 3 e o fluxo termina verde com um aviso: a execução mais nova de `main` implanta (se nenhuma estiver na fila, use Run workflow). Ele recusa, sem mudar nada, um checkout com alterações locais ou com commits que não estão em `origin/main`, e um `VARANDA_DOMAIN` que não seja um nome em minúsculas sem ponto final. Depois ele:

- guarda a imagem que o semeador está rodando (etiquetada `varanda-seeder:anterior`) e uma cópia do `deploy/seeder/www` em `/var/lib/varanda-deploy`; o commit que está no ar fica anotado em `/var/lib/varanda-deploy/implantado` desde a última implantação;
- atualiza o checkout e gera o app web (`build-web.sh`) numa cópia exportada do commit (`.deploy-build/`, nunca no checkout, e como o usuário `nobody`, nunca como root: os scripts de instalação das dependências não podem reescrever os compose, o Caddyfile nem deixar nada com poder de root no servidor); o build e o `deploy.sh` conferem que `sw.js` foi gerado;
- constrói a imagem do semeador e a do Caddy (`deploy/seeder/Dockerfile.caddy`: o Caddy oficial por digest mais o módulo `caddy-ratelimit` em versão fixa, que limita `/index/*` e `/media/*` por cliente; a anterior fica guardada como `varanda-caddy:anterior`), copia o app para `www` (só arquivos e diretórios comuns: um link simbólico deixado pelo build é recusado) e sobe o semeador e o Caddy;
- confere a saúde: `/health` do semeador com 200 em até 180 s, o `index.html` e o `varanda-node.js` servidos pelo domínio byte a byte iguais aos de `www` em até 60 s, também `sw.js` quando existe em `www` e o bundle com hash citado no `index.html`, `/varanda.json` com o corpo exato `{"v":1,"association":"<VARANDA_ASSOCIATION>"}` e um WebSocket de verdade aberto em `wss://<domínio>/seeder` com o Origin de produção; a primeira implantação depois desta mudança ainda executa o `deploy.sh` anterior, então a sonda de `sw.js` só roda a partir da segunda;
- se algo falhar (ou se receber Ctrl-C ou SIGTERM no meio), volta sozinho para o commit, as imagens (semeador e Caddy) e o `www` anteriores, sem reconstruir nada, e sai com 1. Só reinicia o semeador e o Caddy se eles já tinham sido trocados: uma falha no build não derruba nada. Os últimos registros do semeador e do Caddy ficam em `/var/lib/varanda-deploy/deploy.log`.

**Antes de aplicar a mudança que traz o `/varanda.json`:** acrescente `VARANDA_ASSOCIATION=<64 hex>` ao `deploy/seeder/.env` do servidor. A primeira implantação com essa mudança roda o `deploy.sh` anterior (o bash já leu o arquivo inteiro antes do `git reset`), sem a sonda do `/varanda.json`; sem o valor no `.env`, o compose recusa subir, a implantação falha e volta sozinha. O `deploy.sh` novo também recusa, antes de mudar qualquer coisa, um `VARANDA_ASSOCIATION` ausente ou que não tenha 64 dígitos hexadecimais. Depois da primeira vez, confira à mão com `curl https://<domínio>/varanda.json`.

O semeador e o Caddy ficam fora do ar por alguns instantes a cada implantação. A volta não desfaz mudanças de formato dos dados que a versão nova já tenha gravado. O registro fica em `/var/lib/varanda-deploy/deploy.log`. O log do fluxo mostra só as mensagens do script; a saída do build e do docker fica no servidor, porque o log do GitHub Actions de um repositório público é público. O `deploy/seeder/.env` não faz parte da implantação nem da volta: a volta sobe a versão anterior com o `.env` que estiver no servidor. Para trocar o domínio, faça como na seção anterior, à mão, e confira o site antes da próxima implantação. Se a ponta de `main` já estiver no ar e saudável, o script só confere a saúde e sai com 0 sem reiniciar nada; para forçar uma nova implantação, apague `/var/lib/varanda-deploy/implantado`. O checkout (`/opt/varanda`, `deploy/`, `deploy/seeder/`, o `deploy.sh`, o `.git` e o `.git/config`) precisa ser de root e sem escrita para grupo ou outros, porque o sudoers dá root a esse arquivo e root roda `git` ali; senão o script recusa. Códigos de saída: 0 implantado, 1 falha (nada mudou ou voltou), 2 uso errado, 3 `main` já avançou.

Antes: o semeador e a versão web no ar à mão, como nas seções anteriores (o script exige `deploy/seeder/.env`, o semeador rodando e o app publicado em `deploy/seeder/www`). Os passos abaixo são todos seus (do usuário); o fluxo fica pulado até o passo 9. Troque `<ip>` pelo endereço do servidor e `AAAA…` pela chave pública gerada no passo 3.

1. Faça o merge do pull request. Sem a variável `VARANDA_DEPLOY` (passo 9), o fluxo não faz nada.

2. Como root no servidor, atualize o checkout e crie o usuário:

   ```sh
   git -C /opt/varanda pull
   useradd --system --create-home --shell /bin/bash varanda-deploy
   install -d -o varanda-deploy -g varanda-deploy -m 0700 /home/varanda-deploy/.ssh
   ```

   Se o `sshd` usa `AllowUsers`, acrescente `varanda-deploy` a ele e recarregue o serviço. Confira que o checkout é de root e sem escrita para grupo ou outros (cada linha deve mostrar `root` e um modo como `755`; o script recusa rodar senão):

   ```sh
   stat -c '%U %a %n' /opt/varanda /opt/varanda/deploy /opt/varanda/deploy/seeder /opt/varanda/deploy/seeder/deploy.sh /opt/varanda/.git /opt/varanda/.git/config
   ```

3. Na sua máquina, gere um par de chaves só para isso:

   ```sh
   ssh-keygen -t ed25519 -N '' -C varanda-deploy -f varanda-deploy-key
   cat varanda-deploy-key.pub
   ```

4. No servidor, grave em `/home/varanda-deploy/.ssh/authorized_keys` (modo 0600, dono `varanda-deploy`) esta linha, com a chave pública do passo 3:

   ```
   restrict,command="sudo -n /opt/varanda/deploy/seeder/deploy.sh" ssh-ed25519 AAAA… varanda-deploy
   ```

   O `command=` faz essa chave rodar só o script, e o `restrict` desliga encaminhamentos e pty.

5. No servidor, crie `/etc/sudoers.d/varanda-deploy` (modo 0440) com esta linha e confira com `visudo -c`:

   ```
   varanda-deploy ALL=(root) NOPASSWD: /opt/varanda/deploy/seeder/deploy.sh ""
   ```

   O `""` proíbe qualquer argumento.

6. Monte a linha de `known_hosts` com a chave do próprio servidor, lida numa sessão em que você já confia (nunca de um `ssh-keyscan` sem conferência):

   ```sh
   echo "varanda-producao $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
   ```

   O resultado tem a forma `varanda-producao ssh-ed25519 <chave>`. Guarde essa linha para o passo 8.

7. Teste à mão, da sua máquina (use um `known_hosts` seu, com a mesma chave conferida). A entrada vazia implanta a ponta de `main`:

   ```sh
   ssh -T -i varanda-deploy-key varanda-deploy@<ip> </dev/null
   ```

   Deve terminar com `implantado <sha>`. Este teste também cria o registro da versão em produção: sem ele, a primeira implantação automática logo depois de um `git pull` manual não tem como saber o que está no ar, loga `sem registro da versão em produção` e usa o HEAD do checkout como ponto de volta.

8. No GitHub, Settings > Environments > New environment `producao`:
   - Deployment branches and tags: só `main`;
   - Secret `DEPLOY_SSH_KEY`: o conteúdo de `varanda-deploy-key`;
   - Variable `DEPLOY_HOST`: o endereço do servidor (só letras, números, `.` e `-`);
   - Variable `DEPLOY_KNOWN_HOSTS`: a linha do passo 6.

   Depois apague a chave privada da sua máquina (o macOS não tem `shred`):

   ```sh
   rm -f varanda-deploy-key
   ```

9. Em Settings > Secrets and variables > Actions > Variables, crie `VARANDA_DEPLOY` com o valor `true`. Qualquer outro valor pausa as implantações.

10. Em Actions > deploy > Run workflow, na branch `main`, rode a primeira implantação e acompanhe o log.

Uma chave vazada só consegue pedir a implantação da ponta de `main`: se ela já estiver no ar e saudável, nada é reiniciado. Não escolhe o commit nem lê a chave do semeador, o volume, o `.env` ou a chave da associação. Para trocar a chave, substitua o `authorized_keys` e o segredo `DEPLOY_SSH_KEY`.

Quem tem o servidor de fato é quem faz merge em `main`: os compose, o Dockerfile e o `build-web.sh` vêm do checkout e rodam como root. A proteção é a regra de `main` (revisão, code owners e os checks `test (20)` e `test (24)`).

Se a conexão SSH cair, o script termina sozinho; leia `/var/lib/varanda-deploy/deploy.log`. Alterações locais em `/opt/varanda` barram a implantação (`alterações locais`): guarde-as ou descarte-as. Para repetir, use Run workflow, não Re-run de uma execução antiga: um Re-run pode deslocar uma execução mais nova que está esperando, e ela sai com 3. Recuperação à mão, como root no servidor: `bash deploy/seeder/deploy.sh </dev/null` (da raiz do repositório), e `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml logs`.

### systemd

`deploy/seeder/varanda-seeder.service` roda `seed --json` como o usuário de sistema `varanda`, com os dados em `/var/lib/varanda/seeder` e o endpoint de saúde em `127.0.0.1:8788`. Reinicia 5 s depois de uma falha (código 1), mas não depois de um erro de uso (código 2, configuração errada). Para com SIGTERM e espera até 30 s. Instalação, como root (Node 20 ou mais novo em `/usr/bin/node`; ajuste o `ExecStart` se não for o caso):

```sh
useradd --system --home-dir /var/lib/varanda --shell /usr/sbin/nologin varanda
git clone https://github.com/Varanda-org/varanda.git /opt/varanda
cd /opt/varanda && npm ci --omit=dev --workspace apps/cli --ignore-scripts
install -d -o varanda -g varanda -m 0700 /var/lib/varanda
install -m 0644 deploy/seeder/varanda-seeder.service /etc/systemd/system/
install -D -m 0600 deploy/seeder/seeder.env.example /etc/varanda/seeder.env
```

Chave e certificado, como o usuário `varanda` (o arquivo do certificado precisa ser legível por ele):

```sh
sudo -u varanda env VARANDA_DATA=/var/lib/varanda/seeder node /opt/varanda/bin/varanda.js seed key --association "$ASSOC"
sudo -u varanda env VARANDA_DATA=/var/lib/varanda/seeder node /opt/varanda/bin/varanda.js seed cert add --cert-file /caminho/seeder-cert.json
```

Subir e ver a saúde:

```sh
systemctl daemon-reload
systemctl enable --now varanda-seeder
curl -s http://127.0.0.1:8788/health
```

Registros: `journalctl -u varanda-seeder -f`. `seed list` e `seed drop`: `systemctl stop varanda-seeder`, o comando como o usuário `varanda` (como acima), `systemctl start varanda-seeder`.

### Política de registros

Provisória até o parecer jurídico sobre registros de acesso (issue #38).

- **Formato.** Uma linha por evento na saída padrão. No serviço, `--json`: JSON Lines com os eventos `health`, `ws`, `ready`, `peer`, `admitted`, `rejected`, `have`, `peer-dropped`, `warning` e `fatal` (o mais frequente é `have`, a cada crescimento de um diário). Erros vão para a saída de erro como `erro: <mensagem>`. A linha não traz data e hora: o journal e o Docker carimbam cada uma.
- **O que entra.** Chaves públicas de diários (64 hex), com tamanho ou motivo de recusa; a chave Noise dos pares (`peer`, `peer-dropped`); o tópico da associação (`ready`). São pseudônimos, e contam como dado pessoal quando alguém consegue ligá-los a uma pessoa.
- **O que nunca entra.** Endereço IP ou porta de par (a entrada WebSocket nunca registra o endereço do cliente), conteúdo de publicação ou de perfil, certificados, chaves secretas e as requisições ao endpoint de saúde.
- **Estatísticas de uso (serviço de conta).** O serviço de conta acrescenta só `{ event: 'usage', reason }`, com `reason` igual a `ligada`, `desligada`, `invalido` ou `falhou`. A linha não traz e-mail, chave, @nome nem endereço.
- **Rotação.** Pelo supervisor. Docker: driver `json-file` com até 5 arquivos de 10 MB (`compose.yaml`). systemd: o journal rotaciona sozinho.
- **Retenção provisória: 30 dias.** No systemd, `deploy/seeder/journald-varanda.conf` vai para `/etc/systemd/journald.conf.d/varanda.conf` (`MaxRetentionSec=30day`). Vale para o journal inteiro da máquina, então use numa máquina dedicada. No Docker o limite é de volume (50 MB), não de tempo; para limitar por tempo, troque o driver para `journald` no `compose.yaml` e use a mesma configuração.
- **Registros de acesso (Marco Civil, Art. 15).** O semeador não registra endereço IP, então hoje não guarda registro de acesso. Se o parecer concluir que o Art. 15 se aplica à associação, a guarda por 6 meses vai exigir registrar endereço e horário das conexões (mudança de código, ainda não feita) e ajustar a retenção acima. A retenção é configuração do supervisor (`MaxRetentionSec`, `max-size` e `max-file`), não do código: muda sem nova versão.

### Bloquear uma conta

A associação mantém uma lista de bloqueio assinada pela chave da moderação. Cada nó (semeador, membro de linha de comando e versão web) troca a lista com os pares no canal `varanda/blocklist/1`, guarda a mais nova que confere e deixa de guardar, servir e mostrar os diários bloqueados. A lista traz só chaves públicas (contas bloqueadas e emissores revogados), um número de sequência e a data: nunca o motivo, um nome ou um e-mail.

Tudo roda na máquina do operador, num diretório só da moderação (`--data <modDir>`, separado do da associação, de membro, de semeador e do serviço de conta). A chave secreta da moderação nunca vai para o servidor: só a lista assinada sai da máquina.

1. Crie a chave da moderação e grave a chave pública Noise do semeador da associação (`seed status` a mostra); o comando imprime só a chave pública da moderação e nunca troca uma chave existente:

   ```sh
   node bin/varanda.js mod init --data <modDir> --association <hex> --seeder <chave do semeador>
   ```

   `--seeder` é opcional aqui: rodar `mod init --seeder <chave>` de novo num diretório que já existe só grava ou troca a chave do semeador. Sem ela gravada, cada comando que publica precisa de `--seeder <chave>`; sem nenhuma das duas, o comando sai com `erro: informe --seeder <chave do semeador> (seed status a mostra) ou use --no-publish` (código 1) antes de assinar qualquer coisa.

2. Com a associação, certifique essa chave e grave o certificado na moderação:

   ```sh
   node bin/varanda.js assoc certify-moderator --data <assocDir> --moderator <hex> --out moderator-cert.json
   node bin/varanda.js mod cert add --data <modDir> --cert-file moderator-cert.json
   ```

3. Bloqueie ou desbloqueie uma conta pela chave pública do diário (64 hex). A primeira lista da associação precisa de `--new-list`:

   ```sh
   node bin/varanda.js mod block <chave> --data <modDir> --new-list
   node bin/varanda.js mod block <outra chave> --data <modDir>
   node bin/varanda.js mod unblock <chave> --data <modDir>
   ```

Cada comando grava a próxima lista (`seq` + 1) em `blocklist.json`, anota a mudança em `moderation.jsonl` e publica a lista (as mesmas opções `--bootstrap` e `--dht-host` de `sync`). Num diretório sem `blocklist.json`, um comando que muda a lista recusa sem `--new-list` (`erro: este diretório não tem lista anterior; ...`, código 1, nada assinado): uma lista começada do zero por engano desfaria, em todos os nós, todos os bloqueios e revogações anteriores. Com uma lista já gravada, `--new-list` é recusado (`erro: este diretório já tem uma lista`).

A lista vai só para o semeador da associação: o publicador o chama direto pela chave Noise dele, com uma chave Noise descartável (nunca a da moderação nem a da associação), sem entrar no tópico público da associação. A entrega só conta quando esse par se prova semeador da associação (o hello traz um certificado de semeador da associação para a chave Noise da própria conexão) e responde que guardou exatamente essa lista (o `have` dele traz o início da assinatura da lista): `lista publicada`, código 0. Se o semeador já tem outra lista com o mesmo número (acontece ao restaurar uma cópia antiga do diretório da moderação), o comando sai na hora com `erro: o semeador já tem outra lista com o mesmo número (seq N); isto acontece ao restaurar uma cópia antiga da moderação` e `faça uma nova alteração (ela recebe um número maior) ou rode mod publish depois de recuperar a lista mais recente` (código 1). De lá os nós a repassam entre si. O semeador precisa estar no ar. Sem confirmação em `--timeout-ms` (padrão 30000), o comando sai com `erro: não foi possível publicar a lista` e `a lista ficou gravada; rode mod publish quando o semeador estiver no ar` (código 1). `mod publish` reenvia a lista gravada sem mudar nada (mesmo `seq`, nenhuma linha nova em `moderation.jsonl`); sem lista gravada, `erro: nenhuma lista para publicar`. `--no-publish` só grava. Desbloquear uma chave que não estava na lista também gera uma lista nova e diz `não estava bloqueada`.

Quem vê o endereço IP da máquina do operador ao publicar: o semeador (infraestrutura da associação) e os nós da DHT que encaminham a busca e a conexão até a chave dele. Os pares do tópico da associação não veem.

`mod show` mostra a associação, a chave pública da moderação, o estado do certificado e a lista (`lista seq <n> de <data>: <k> contas bloqueadas, <r> emissores revogados`, ou `lista vazia`). Com `--json`, os comandos imprimem a lista pública; nenhum imprime a chave secreta.

Se a chave do emissor do serviço de conta vazar, `mod revoke-issuer <chave>` põe essa chave na lista de emissores revogados: os certificados de membro v2 e os @nomes que ela assinou deixam de valer em todos os nós. `mod unrevoke-issuer <chave>` desfaz. As duas publicam a lista como `block`.

Uma chave da moderação nova (outro `mod init` em outro diretório, certificada depois da atual) substitui a anterior: os nós aceitam a lista dela como mais nova mesmo começando de `seq` 1. Para trocar a chave sem perder nada, copie o `blocklist.json` da moderação anterior para o diretório novo antes do primeiro comando: o código continua dessa lista (mantém todos os bloqueios e emissores revogados) e assina a próxima com a chave nova. Sem a cópia, o diretório novo recusa sem `--new-list`, que só serve para a primeira lista da associação.

#### Ligar o painel de moderação e as denúncias (serviço `account`)

As denúncias dos membros e o painel dos moderadores rodam no mesmo serviço `account`. As denúncias não pedem configuração nova (só quem tem a conta Google vinculada pode denunciar, pela versão web hospedada); o painel só liga se houver moderadores configurados:

1. No cliente OAuth do Google Cloud, em "URIs de redirecionamento autorizados", acrescente um SEGUNDO URI, `https://<domínio>/account/mod/callback`, sem tirar o `https://<domínio>/account/callback` do vínculo. O mesmo `VARANDA_GOOGLE_CLIENT_ID` e o mesmo segredo servem aos dois.
2. Em `deploy/seeder/.env`, ponha em `VARANDA_MODERATOR_EMAILS` os e-mails Google dos moderadores, separados por vírgula, em minúsculas (no máximo 32). Só esses e-mails entram no painel; vazio mantém o painel desligado e o vínculo e as denúncias seguem funcionando. O `deploy.sh` confere o formato sem imprimir os valores.
3. O contêiner lê o `.env` só ao ser criado: depois de editar a lista, recrie o serviço (`docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`). Reiniciar não basta.
4. O painel fica em `https://<domínio>/account/mod/`. A sessão do moderador é guardada só na memória do serviço (8 horas): reiniciar ou recriar o contêiner desconecta todos, e basta entrar de novo.

Os moderadores marcam cada denúncia como bloquear ou descartar, e desbloqueiam em "Bloqueadas". Descartar vale na hora e não muda a lista; bloquear e desbloquear só viram lista depois do `mod apply` abaixo. O painel mostra chaves e @nomes, nunca e-mails; um moderador não vê, decide nem desbloqueia nada sobre a própria conta vinculada. O arquivo `moderation.json` (denúncias, decisões e mudanças pendentes, modo `0600`) fica no volume `account-data`, junto do diretório de contas: inclua-o no backup do volume.

Para um pedido legal, `account reports [--member <chave>]` (rodado no servidor, como `account status`, por exemplo `docker compose ... run --rm account account reports --member <hex>`) imprime uma linha JSON por denúncia, com `reporterContact` e `targetContact` (`{ email, username }` ou `null`). É o único caminho pelo qual o e-mail do vínculo sai do serviço: não rode em outra máquina nem cole a saída em chamados, e não está nos registros. Sem `--member` lista todas; com ele, as feitas contra aquela chave.

##### Estatísticas de uso (opcional)

A aba "Estatísticas" do painel mostra só contagens anônimas. Sem `VARANDA_STATS_EMAILS` ela fica desligada, junto com a amostragem e o `usage.json`.

- `VARANDA_STATS_EMAILS`: e-mails Google de quem pode ver a aba, separados por vírgula, em minúsculas (no máximo 32). É um subconjunto de `VARANDA_MODERATOR_EMAILS`: cada endereço precisa estar também na lista de moderadores. Vazio ou ausente desliga a aba. O `deploy.sh` e o serviço conferem o formato e o subconjunto sem imprimir os valores. O contêiner lê o `.env` só ao ser criado: depois de editar, recrie o serviço `account`, como no passo 3. Reiniciar não basta.
- `VARANDA_SEEDER_HEALTH`: de onde o serviço lê o `GET /health` do semeador. O padrão é `http://127.0.0.1:8788`. Só HTTP em loopback (`127.0.0.1`, `localhost` ou `[::1]`), com porta explícita. Só é lido quando as estatísticas estão ligadas.

A aba mostra os membros vinculados e o teto, os diários no semeador, os ativos hoje e nos últimos 7 dias (dia de Brasília, UTC−3), as conexões, as publicações indexadas, o armazenamento, os cadastros por semana (12) e por mês (12, cada mês com o total acumulado) a partir de `linkedAt`, e uma tabela dos últimos 30 dias. Não mostra contagem de denúncias. Se o semeador reiniciou há menos de 7 dias, a aba avisa que os ativos ainda estão parciais ("O semeador reiniciou há menos de 7 dias: os ativos ainda estão parciais.") e eles recomeçam em 0.

O histórico fica em `usage.json`, no volume `account-data`. Uma linha por dia de Brasília (UTC−3), no máximo 400, modo `0600`. Um arquivo inválido nunca é regravado: o painel avisa "Histórico indisponível (usage.json inválido): avise a operação." e a operação pode olhar o arquivo. Apagá-lo só perde o histórico.

A amostragem grava a cada 15 minutos (a primeira cerca de um minuto depois de subir) e, com a aba aberta, faz no máximo uma leitura ao vivo a cada 5 minutos. Os ativos (`activeDay`, `activeWeek`) e as conexões (`connections`, `external`) guardam o pico do dia; os totais (membros, diários, blocos, bytes, mídia e publicações indexadas) guardam o valor mais recente. Uma leitura que falta não apaga o que já estava na linha.

Privacidade: só contagens, sem chave, e-mail ou @nome. A data de cadastro já aparece no certificado público de cada membro (`linkedAt` é a data desse certificado), então as células de cadastro não são suprimidas. Os dias dos cadastros por semana e por mês são o dia de Brasília (UTC−3).

##### Triagem com IA (opcional)

A triagem lê a publicação denunciada no semeador e compara com decisões humanas já tomadas. Comece em `sombra` e só passe a `1` quando as sugestões coincidirem com o que os moderadores decidem.

No `deploy/seeder/.env` (o contêiner só lê o arquivo ao ser criado: depois de gravar estas linhas, recrie `account` e o `seeder`, como no passo 3):

- `VARANDA_AI`: vazio ou ausente desliga (padrão). `sombra` só registra o que a IA faria e mostra a sugestão no painel. `1` deixa a IA decidir. Outro valor é erro de uso antes de abrir a porta. Sem o modelo o serviço sobe sem triagem (`sem-modelo`) e a checagem de saúde continua verde.
- `VARANDA_TRIAGE_TOKEN`: 64 hex minúsculos, o mesmo valor no semeador e no serviço de conta (`openssl rand -hex 32`). Sem ele as rotas de leitura (`/moderation-post/` e `/moderation-group-post/`) não existem no semeador; com `VARANDA_AI` ligado e o token vazio ou inválido, o serviço de conta recusa subir (erro de uso), e no Compose o contêiner fica reiniciando. Um token malformado é erro de partida mesmo com a IA desligada. Para bloquear uma denúncia de grupo (conta ou grupo) o serviço de conta lê a mensagem em `/moderation-group-post/` e confere grupo e diário; sem o token os dois bloqueios de uma denúncia de grupo são recusados, mesmo com a IA desligada, e o painel mostra o texto conferido ("Texto conferido no semeador:"). Defina o mesmo token nos dois serviços para moderar grupos. Com o token configurado, o serviço de conta também o envia nas leituras `/index/group` e `/index/groups` do semeador, que as cobra do orçamento de moderação e não do balde público do índice (a resposta é a mesma; token ausente ou errado cai no balde público).
- `VARANDA_SEEDER_HTTP`: onde a conta alcança o HTTP do semeador. Padrão `http://127.0.0.1:8789`. É lido e validado mesmo com a triagem desligada: o painel só decide `Bloquear grupo` depois de confirmar o grupo, o escritor e a existência da mensagem (o comprimento do escritor passa da posição; senão `sem-mensagem`) na rota pública `/index/group/<chave>` desse endereço (no máximo 8 páginas, 5 s, sem nova tentativa). Numa denúncia de grupo, tanto `Bloquear conta` quanto `Bloquear grupo` exigem essa confirmação; qualquer falha, inclusive um semeador fora do ar ou não configurado, recusa a decisão (`grupo-nao-confirmado`). Sem um semeador alcançável, uma denúncia de grupo só pode ser descartada (`Descartar` sempre funciona). O mesmo vale para toda denúncia sem grupo, com ou sem conta vinculada no alvo: `Bloquear` exige que o semeador confirme um diário servido (`GET /index/groups/<chave>` responde 200; senão `alvo-nao-confirmado`). Sem um semeador alcançável, nenhuma conta pode ser bloqueada pelo painel: todas as denúncias só podem ser descartadas.
- `VARANDA_AI_MODEL_DIR`: diretório dos pesos, só fora do Compose. Padrão `<dataDir>/ai-model`. No Compose ele é fixo em `/data/ai-model`, dentro do volume `account-data`: não o defina no `.env`.

Baixe os pesos uma vez. O script confere o sha256 dos cinco arquivos e recusa um diretório dentro do repositório. No Compose, grave direto no volume do serviço de conta, com a própria imagem:

```sh
docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml run --rm --entrypoint node account apps/cli/scripts/fetch-ai-model.js --dir /data/ai-model
```

Fora do Compose:

```sh
node apps/cli/scripts/fetch-ai-model.js --dir <dataDir>/ai-model
```

Numa instalação local, prefira `npm ci --ignore-scripts` (ou defina `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`, que evita o download de artefatos CUDA no linux x64). O CI, o fluxo de deploy, `deploy/seeder/build-web.sh` e a imagem Docker instalam com `--ignore-scripts`: nenhum script de instalação de dependência roda, e os binários nativos usados já vêm nos pacotes.

`account status` mostra `Triagem IA: desligada`, `Triagem IA: <n> precedentes` ou `Triagem IA: indisponível (exemplars.json inválido)`. Inclua `exemplars.json` e `triage.json` no backup do volume `account-data`, junto de `moderation.json` (modo `0600`).

##### Avisos push (opcional)

Avisos do sistema na versão web hospedada, para quem ligar em Ajustes ("Avisos no aparelho"). São quatro eventos: alguém começou a seguir, respondeu, curtiu ou republicou. Citação, menção e o crescimento de um diário seguido não entram aqui. A lista de Avisos do app (resposta, citação e menção inclusive) continua sem usar este caminho.

O serviço de conta precisa estar parado na primeira vez. No diretório de dados da conta:

```sh
node bin/varanda.js account push-key --data <dataDir>
```

O comando grava `push-vapid.json` (modo `0600`, `{ v: 1, publicKey, privateKey }`) no volume `account-data` e imprime só a chave pública (`chave pública de push: ...`). Recusa com `serviço de conta em execução` se o lock está preso, e com `chave de push já existe` se o arquivo já está lá. Para girar a chave: apague `push-vapid.json` com o serviço parado, rode `account push-key` outra vez e peça que cada pessoa ligue os avisos de novo neste navegador. A chave nova deixa as inscrições antigas órfãs.

No `deploy/seeder/.env` (o contêiner só lê o arquivo ao ser criado; depois de gravar, recrie o semeador e o serviço `account`):

- `VARANDA_PUSH_TOKEN`: 64 hex minúsculos, o mesmo valor no semeador e no serviço de conta. Gere com `openssl rand -hex 32`. Vazio ou ausente desliga: o semeador não faz o repasse e `POST /push-event` responde 404.
- `VARANDA_ACCOUNT_HTTP`: onde o semeador alcança o HTTP do serviço de conta. Padrão `http://127.0.0.1:8790`. Só HTTP em loopback (`127.0.0.1`, `localhost` ou `[::1]`), com porta explícita.

O que fica guardado: `push-vapid.json` (o par VAPID) e `push.json` (a inscrição de cada aparelho: `endpoint`, `p256dh`, `auth` e `createdAt`), os dois modo `0600` no volume `account-data`. No máximo 4 aparelhos por membro. `account export` soma `pushDevices` e nunca o endereço. `account status` mostra `avisos push: ligados (N aparelhos)`, `avisos push: desligados` ou `avisos push: indisponível (push.json inválido)`.

Nada de inscrição, chave, nome ou texto do aviso entra no registro. As linhas são só `{ event: 'push', reason }`.

O `endpoint` tem de ser uma URL `https` canônica, em ASCII imprimível. `isEndpoint` (`packages/core/lib/push-proof.js`) exige `https`, de 1 a 2048 caracteres, ASCII imprimível, sem barra invertida, sem `#` e sem usuário na autoridade. `isPushEndpoint` (`packages/rpc/lib/methods.js`, no `push.sign`) e `endpointParam` (`POST /account/push/finish` e `POST /account/push/check`) exigem o mesmo e ainda `new URL(valor).href === valor`: porta `443` explícita, host em maiúsculas e segmentos `.` ou `..` não entram.

O semeador nunca vê a inscrição. Ele só manda o candidato em loopback (`POST /push-event`, `Authorization: Bearer` com `VARANDA_PUSH_TOKEN`). O Caddy não encaminha essa rota (`apps/cli/test/caddyfile.test.js`). O serviço compara o sha256 do token com `timingSafeEqual`. Sem o token, a rota não existe (404) e o corpo não é lido.

Um aviso que chega com o serviço de conta fora, ou com a fila do repasse cheia (256 no semeador, 512 no serviço), se perde e não é repetido. Um bloco escrito enquanto o semeador estava fora só vira aviso depois que ele volta se o `at` do autor tiver menos de 6 h (`PUSH_MAX_AGE_MS`, só para suprimir). O que já estava guardado quando o diário passou a ser servido não gera aviso, inclusive depois de reiniciar ou de reconstruir o índice.

#### Aplicar as decisões do painel

Os moderadores decidem as denúncias no painel do serviço de conta (`/account/mod/`), mas o painel não assina nada: cada decisão fica pendente até o operador rodar `mod apply` na própria máquina, com o diretório da moderação. A chave secreta da moderação continua só nessa máquina.

```sh
node bin/varanda.js mod apply --server https://<domínio> --data <modDir>
```

`--server` é a origem pública do serviço (`https://<domínio>`, sem caminho nem barra no fim; `http://` só vale para `127.0.0.1`, nos testes; outra coisa é `uso: server inválido`, código 2). O comando faz dois pedidos assinados pela chave da moderação, cada um com um desafio de uso único do servidor e presos a essa origem (uma assinatura para um domínio não vale em outro):

1. busca as decisões pendentes (`api/pull`) e a última lista que o painel confirmou;
2. confere a lista local: se `blocklist.json` está atrás da publicada, sai com `erro: lista local atrás da publicada; restaure o backup da moderação` (código 1) sem gravar nada;
3. aplica as decisões na ordem em que foram tomadas e mostra, antes de assinar, uma linha por chave com o efeito final: `bloquear <chave>`, `desbloquear <chave>`, `já estava bloqueada <chave>` ou `não estava bloqueada <chave>`. Um desbloqueio de chave cujo bloqueio não veio do painel (feito com `mod block`, ou sem registro em `moderation.jsonl`) aparece como `desbloquear <chave> (bloqueada pela operação)`. Um bloqueio pedido só pela IA aparece como `bloquear <chave> (ia)`; com `--yes` ele não é assinado e aparece como `bloquear <chave> (ia) — aguarda revisão no terminal`, até um `mod apply` num terminal. Bloqueios da IA chegam pelo mesmo caminho; o programa do operador tem de ser atualizado junto com o servidor, porque um `mod apply` anterior recusa a resposta nova do pull, `{ changes: [{ id, op, member, at, actor }], published: { snapshot } }` (`actor` é `ia` ou `pessoa`);
4. pede a revisão (abaixo), assina UMA lista nova (`seq` + 1, uma linha por chave em `moderation.jsonl`) e a publica no semeador como `mod block`;
5. só com a lista entregue, confirma ao painel (`api/ack`) as decisões aplicadas e a lista assinada: `aplicado: seq <n>, <k> chaves bloqueadas`.

Nada que o servidor devolve é assinado sem revisão. Num terminal, o comando pergunta `Assinar e publicar estas mudanças? [s/N] ` e só segue com `s` ou `sim`; outra resposta sai com `erro: nada assinado` (código 1), sem assinar, publicar nem confirmar nada. Se houver desbloqueios de chaves bloqueadas pela operação, pergunta de novo, `Desbloquear também as chaves bloqueadas pela operação? [s/N] `; recusando, só essas chaves ficam de fora e seguem pendentes no painel. Sem terminal (cron, pipe) e sem `--yes`, sai com `erro: rode num terminal para revisar, ou use --yes para aplicar só os bloqueios` (código 1) antes de qualquer pedido ao servidor.

`--yes` é para o agendamento: aplica só os bloqueios pedidos por pessoas (os da IA e os desbloqueios ficam para a revisão no terminal), no máximo 100 chaves novas por execução (mais que isso sai com `erro: muitos bloqueios de uma vez; rode no terminal para revisar`, código 1, nada assinado). Toda chave cujo efeito final é um desbloqueio fica retida: nenhuma decisão dela é assinada nem confirmada, e a saída diz `desbloqueios aguardando revisão no terminal: <n>`. As decisões retidas continuam pendentes no painel até a próxima execução num terminal, que as mostra e pede a confirmação. Assim, quem roubar o login Google de um moderador (ou controlar o servidor de conta) pode enfileirar decisões e fazer o cron bloquear até 100 chaves por execução, mas não desbloqueia ninguém sem o operador revisar no terminal; nenhum dos dois publica nada sem a chave da moderação, que fica na máquina do operador.

Se a publicação falhar (`erro: não foi possível publicar a lista`, código 1), nada é confirmado e a lista nova fica gravada; a próxima execução reenvia exatamente a mesma lista antes de confirmar (`confirmado: seq <n>`). Sem decisões pendentes e com a lista já confirmada, imprime `nada a aplicar`. Se o painel já confirmou uma lista mais nova, sai com `erro: o servidor tem uma lista mais nova; restaure o backup`. Uma resposta fora do formato esperado é `erro: resposta inválida do servidor`. Num diretório sem `blocklist.json`, aplicar decisões exige `--new-list`, como em `mod block`. `--no-publish` é recusado (código 2); `--json` imprime na última linha a lista pública, os identificadores das decisões confirmadas e quantos desbloqueios ficaram retidos (`held`); nenhuma saída traz a chave secreta, e-mail ou endereço de par.

O "Pendentes" do painel só esvazia depois de um `mod apply` bem-sucedido, então rode-o com `--yes` num agendamento (por exemplo, a cada hora pelo cron) na máquina do operador, e rode-o num terminal, sem `--yes`, para revisar e aplicar os desbloqueios e os bloqueios da IA retidos. Depois do primeiro deploy do painel, rode-o uma vez sem nenhuma decisão: ele confirma a lista que `mod block` já tinha publicado, e "Bloqueadas" passa a mostrar a mesma lista. Se o diretório da moderação ainda não tem lista (nenhum `mod block` antes), a primeira execução é `node bin/varanda.js mod apply --server https://<domínio> --data <modDir> --new-list`; depois disso, nunca mais com `--new-list`. Faça uma cópia do diretório da moderação (`blocklist.json`, `moderation.jsonl`, a chave e o certificado) antes de cada execução: é dela que vem o `blocklist.json` para "restaurar o backup". `mod apply` segura o mesmo bloqueio do diretório que os outros comandos `mod` (`erro: outra operação de moderação em andamento`).

## Servidor local para a interface web (varanda-serve)

`node bin/varanda-serve.js` roda um nó Varanda (a sessão do núcleo) neste computador e o expõe a uma interface no navegador por um WebSocket local. As chaves ficam nesta máquina. É um programa separado: `node bin/varanda.js` não muda.

```sh
node bin/varanda-serve.js --data ./data --association <hex> \
  --bootstrap 127.0.0.1:49737 --dht-host 127.0.0.1 --ui apps/app/dist
```

Imprime uma vez, depois de começar a escutar:

```
varanda-serve em http://127.0.0.1:<porta>
abra http://127.0.0.1:<porta>/#token=<token>
```

Sem `--ui`, a segunda linha é `token: <token>`. O token só aparece nessa linha. Na URL ele vai depois do `#`, que o navegador não envia ao servidor.

Opções (`--help` imprime a lista):

- `--port <n>`: porta local, padrão 8787. `0` escolhe uma porta livre.
- `--origin <url>`: origem permitida no WebSocket, repetível, escrita exatamente como o navegador a envia (`http://localhost:8081`, sem barra no fim).
- `--ui <dir>`: diretório com a exportação web estática. Com ele, `http://127.0.0.1:<porta>` e `http://localhost:<porta>` também são origens permitidas.
- `--public-dht`: usa a DHT pública. Aqui ela é opt-in: sem `--bootstrap` (ou `VARANDA_BOOTSTRAP`) e sem `--public-dht` o servidor recusa com `uso: informe --bootstrap ou --public-dht`. As duas juntas também são erro de uso. Com `--public-dht`, um `--dht-host` de loopback (`127.x.x.x`, `localhost`, `::1`) é recusado com `uso: dht-host de loopback e DHT pública são exclusivos`.
- `--data`, `--association`, `--bootstrap`, `--dht-host` e as variáveis `VARANDA_*` funcionam como no `varanda`. Sem `--association`, vale a associação do `config.json` de membro já existente.

O token são 32 bytes aleatórios (64 dígitos hexadecimais), gerados a cada início. Não existe opção `--token` (a linha de comando é visível a todo usuário local em `ps`) nem token fixo: `VARANDA_SERVE_TOKEN` é recusado (`uso: VARANDA_SERVE_TOKEN não é aceito: o token é gerado a cada início`). O endereço impresso é uma credencial enquanto o processo roda: a página tira o token da barra de endereço, mas o navegador pode guardar a visita no histórico. Prefira abrir o endereço numa janela anônima e encerre o `varanda-serve` quando terminar; ao reiniciar, abra o endereço novo.

Recusas antes de escutar (código 2, `uso: <mensagem>`): diretório de semeador ou de associação (`uso: diretório não é de um membro`), chave ou bootstrap inválidos, nenhuma origem permitida (`uso: informe --origin ou --ui`), opção desconhecida. Porta ocupada: `erro: porta em uso`, código 1.

Regras de segurança:

- Escuta só em `127.0.0.1`. Não há opção de host.
- Toda requisição HTTP e todo upgrade exigem `Host` igual a `127.0.0.1:<porta>` ou `localhost:<porta>` (defesa contra DNS rebinding), senão 421. Nunca há cabeçalhos CORS.
- HTTP aceita só GET e HEAD (senão 405). Sem `--ui`, tudo fora de `/rpc` é 404. Com `--ui`, só arquivos dentro do diretório (pelo caminho real): `..`, barra invertida, NUL, arquivos com ponto no início e links simbólicos para fora dão 404; um caminho sem extensão que não é arquivo devolve `index.html`. Não há listagem de diretório. Toda resposta leva `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` e `Cache-Control: no-store`.
- O WebSocket fica em `/rpc` e exige `Origin` permitido (senão 403). No máximo 4 conexões abertas (a quinta recebe 503). Mensagens só de texto (binário fecha com 1003), até `MAX_REQUEST` bytes, no máximo 20 por segundo com rajada de 40 (acima disso fecha com 1008). `session.open` com o token tem de chegar em 5 s. Só uma conexão autenticada por vez: a nova fecha a anterior com o código 4000 (`substituída`). Um cliente que não lê e acumula mais de `MAX_OUTBOUND` bytes é desligado.
- `VARANDA_SERVE_OPEN_TIMEOUT_MS` existe só para os testes: encurta o prazo do `session.open` (1 a 5000 ms), nunca o alonga.

Ctrl-C (SIGINT) ou SIGTERM fecha as conexões (código 1001), espera a sessão terminar, libera o diretório de dados e sai com 0. Erros internos aparecem só em stderr como `erro interno: <mensagem>`, nunca para o cliente.

## Testes e lint

Na raiz:

```sh
npm test
npm run lint
```

`npm test` executa `npm test --workspaces --if-present` (os workspaces, um depois do outro). Cada workspace que define script de teste usa `node ../../scripts/run-tests.js`, que roda os `test/*.test.js` desse workspace num pool de processos filhos, `VARANDA_TEST_CONCURRENCY` por vez (com prazo por arquivo: `VARANDA_TEST_TIMEOUT_MS`, padrão 180000). Sem a variável, o pool é a metade inteira dos núcleos da CPU, no máximo 4 (4 num Mac de 12 núcleos, 2 numa máquina de 4 núcleos), porque vários testes medem tempos abaixo de 100 ms que mudam sob carga; `VARANDA_TEST_CONCURRENCY=1` roda um arquivo por vez, com a saída ao vivo. Com mais de um arquivo por vez, a saída de cada um sai num bloco ao terminar (ordem de término, sem intercalação), e o resumo lista `# falha: <arquivo>` para cada falha antes de `# N arquivo(s) de teste, M falha(s)`. `VARANDA_TEST_SHARD=I/N` roda só os arquivos cuja posição i (base 0, na lista ordenada ou na ordem da linha de comando) satisfaz `i % N == I - 1`; um fragmento sem arquivos sai com falha (`# nenhum arquivo neste fragmento`), e um valor inválido também. Se um teste de tempo falhar, rode-o sozinho (`node <arquivo>`) ou com `VARANDA_TEST_CONCURRENCY=1` antes de culpar a sua mudança.

Um workspace:

```sh
npm test -w packages/rpc
npm test -w packages/core
npm test -w apps/cli
npm test -w apps/site
```

Servidor de desenvolvimento do site estático (`apps/site`):

```sh
npm run dev -w apps/site
```

Abre em http://127.0.0.1:4173/. Publicação em GitHub Pages: [docs/site.md](docs/site.md).

Em cada pull request e em cada push para `main`, o workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) roda em `ubuntu-24.04`, no Node 20 e no 24. Em cada versão, seis jobs rodam em paralelo: `packages/core` em dois fragmentos, `apps/cli` em dois fragmentos (`VARANDA_TEST_SHARD` 1/2 e 2/2 nos dois), `packages/web-member` e `others`. O job `others` roda o lint, o `npm test` da raiz para os workspaces que restam e a demo, que deve terminar com `DEMO OK`. `packages/core`, `apps/cli` e `packages/web-member` são pulados nesse `npm test`, porque têm job próprio. Um workspace acrescentado depois roda ali automaticamente. Cada job começa com `npm ci --ignore-scripts` e define `VARANDA_TEST_CONCURRENCY=1`. O paralelismo da CI vem dos jobs. Os checks `test (20)` e `test (24)`, um por versão, são os que a regra da `main` exige. Cada um só passa se os seis jobs daquela versão passaram, e falha se algum falhou, foi cancelado ou pulado. Localmente os quatro passos não mudam: `npm ci` (ou `npm install`), `npm run lint`, `npm test` e `npm run demo`.

Um arquivo, a partir da raiz:

```sh
node apps/cli/test/serve.test.js
```

`npm test -w apps/app` roda `apps/app/test/*.test.js`: `pwa`, `sw`, `outbox`, `discovery`, `recoveryPolicy`, `pwa-boot`, `persist`, `config` e `format`. Em `packages/core`, `test/bare-load.test.js` confere o núcleo no runtime Bare (parte de `npm test -w packages/core`).

Os testes de rede usam uma DHT local em processo (`hyperdht/testnet` por `apps/cli/test/helpers/net.js`), presa a `127.0.0.1`. Nenhum teste usa a DHT pública. `npm run lint` roda o `standard` em todo o repositório. Detalhes em [docs/development.md](docs/development.md).

## Layout de armazenamento

Arquivos JSON de estado são gravados num arquivo temporário e renomeados por cima do destino. `store/` (modo `0700`) contém a chave primária do Corestore; a chave que assina o diário deriva dela. `id show` e `seed key` imprimem só chaves públicas.

### Membro (`data/alice`, `data/bob`)

- `store/` — Corestore do diário e das réplicas seguidas.
- `quarantine/` — Corestore só da busca do bloco 0 de um diário ainda não aceito. O `sync` apaga esse diretório ao abrir (depois do lock de `store/`) e de novo ao fechar. Não é estado.
- `config.json` — `{ "v": 1, "role": "member", "association": "<hex64>" }`, escrito por `id create`.
- `follows.json` — `{ "v": 1, "follows": ["<hex64>"] }`, chaves únicas em ordem. Com o bloco 0 gravado, cada mudança também vira um registro `follow` no diário.
- `blocklist.json` — `{ "v": 1, "snapshot": <lista assinada> }`, modo `0600`: a lista de bloqueio mais nova que este nó aceitou. Só chaves públicas. O arquivo `blocklist.json.prev` guarda a mesma lista: se o principal ficar ilegível, o nó lê a cópia e a repõe.

### Semeador (`data/seeder`)

- `store/` — réplicas admitidas. Todo core aqui está listado em `admitted.json`.
- `quarantine/` — busca do bloco 0 na admissão. Apagado em cada `seed` (depois do lock de `store/`) e de novo ao fechar. Não é estado.
- `config.json` — `{ "v": 1, "role": "seeder", "association": "<hex64>" }`, escrito pelo primeiro de `seed key`, `seed cert add` e `seed`.
- `seeder-key.json` — par Noise do semeador, modo `0600`: `v`, `publicKey` (hex64) e `secretKey`. Criado por `seed key`. O comando não imprime `secretKey`.
- `seeder-cert.json` — certificado do semeador em JSON indentado, escrito por `seed cert add`.
- `blocklist.json` — como no membro: a lista de bloqueio mais nova aceita, com a cópia `blocklist.json.prev`. Um arquivo ilegível é guardado como `blocklist.json.ilegivel-<ms>` e a cópia o substitui; um arquivo ausente com cópia também é reposto. Sem cópia (ou com uma cópia que não verifica), o semeador não admite diários novos (`rejected` com `blocklist-pending`; quem ele já serve continua recebendo `admitted`) até receber uma lista verificada; a trava vale de novo a cada partida enquanto o `blocklist.json.ilegivel-<ms>` guardado estiver lá e nenhuma lista verificada também (`seed status` e `/health` mostram `blocklistHeld`). Se o arquivo não puder ser movido, a partida falha (`erro: lista de bloqueio ilegível`).
- `admitted.json` — único arquivo de estado dos diários servidos: `{ "v": 1, "admitted": { "<hex64>": <certificado de membro> }, "media": { "<hex64 do núcleo>": { "diary": "<hex64>", "seq": <n> } } }`. Um arquivo antigo, sem `media`, continua valendo. A chave entra nesse arquivo antes do core abrir em `store/`. Uma chave em descarte permanece no arquivo até a limpeza do core terminar.

### Associação (`data/assoc`)

- `association.json` — par de chaves da associação, modo `0600`. `assoc show` imprime só a chave pública.
- `members.jsonl` — uma linha JSON por certificado de membro, exatamente `member`, `ageBand`, `method` e `date`.
- `seeders.jsonl` — uma linha JSON por certificado de semeador: `{"seeder":"<hex64>","date":"<ISO>"}`. Sem assinatura e sem segredo.
- `issuers.jsonl` — uma linha JSON por certificado de emissor do serviço de conta: `{"issuer":"<hex64>","date":"<ISO>"}`. Sem assinatura e sem segredo.
- `moderators.jsonl` — uma linha JSON por certificado da moderação: `{"moderator":"<hex64>","date":"<ISO>"}`. Sem assinatura e sem segredo.

### Moderação (`data/mod`)

Fica na máquina do operador, como a associação.

- `config.json` — `{ "v": 1, "role": "moderator", "association": "<hex64>", "seeder": "<hex64>" }`, escrito por `mod init`; `seeder` (a chave Noise do semeador para onde a lista é publicada) só existe depois de `mod init --seeder`.
- `moderator.json` — par de chaves da moderação, modo `0600`. `mod init` imprime só a chave pública.
- `moderator-cert.json` — certificado da moderação assinado pela associação, escrito por `mod cert add`.
- `blocklist.json` — `{ "v": 1, "snapshot": <lista assinada> }`, modo `0600`: a última lista gravada. Ao trocar a chave da moderação, copie este arquivo para o diretório novo.
- `moderation.jsonl` — uma linha JSON por mudança, modo `0600`: `{"op":"block","member":"<hex64>","seq":<n>,"date":"<ISO>","source":"operacao"}` (`op` `block` ou `unblock`; em `revoke-issuer` e `unrevoke-issuer` o campo é `issuer`; `source` é `painel` para as linhas de `mod apply` e `operacao` para os outros comandos `mod`, e uma linha antiga sem o campo conta como `operacao`). Sem assinatura e sem segredo.

Exemplo de linha em `members.jsonl` (a data real é a da emissão):

```json
{"member":"<hex64>","ageBand":"18+","method":"stub","date":"2026-01-01T00:00:00.000Z"}
```

## Formato dos dados

### Bloco 0 e registros

```json
{ "type": "member-cert", "cert": { "v": 1, "member": "<hex64>", "ageBand": "18+", "method": "stub", "date": "2026-01-01T00:00:00.000Z", "association": "<hex64>", "signature": "<128 hex minúsculos>" } }
{ "type": "profile", "name": "Alice", "bio": "protótipo", "at": "2026-01-01T00:00:00.000Z" }
{ "type": "post", "text": "primeira publicação", "at": "2026-01-01T00:00:00.000Z", "replyTo": null }
{ "type": "post", "text": "também li", "at": "2026-01-01T00:00:00.000Z", "replyTo": { "author": "<hex64>", "seq": 2 } }
```

`at` é `new Date().toISOString()` na hora da escrita e tem de ser canônico. Serve para ordenar. Quem lê pula bloco que não é um registro válido e não renumera os outros. A referência de uma publicação é `<hex64>:<seq>`.

O feed ordena por `(at, autor, seq)`. `--limit <n>` fica com as últimas `n` depois de tirar as publicações futuras. Para paginar para trás, `--before <cursor>` devolve só as publicações anteriores ao cursor, `{"at","author","seq"}` em JSON, o mesmo de `feed.read`. Quando a página vem cheia, `feed` imprime o próximo cursor na saída de erro (com `--json`, no campo `next`, que é `null` quando a página não vem cheia; se a última página tiver exatamente `n` itens, ela também traz o cursor e a seguinte volta vazia). Um cursor inválido é erro de uso. Item: autor, nome (ou nulo), @nome (ou nulo), `seq`, `at`, texto, `replyTo` e `media` (as descrições das fotos, ou nulo).

Certificado do semeador (`seeder-cert.json`), também com exatamente estas chaves:

```json
{
  "v": 1,
  "seeder": "<hex64 da chave Noise>",
  "date": "2026-01-01T00:00:00.000Z",
  "association": "<hex64>",
  "signature": "<128 hex minúsculos>"
}
```

### Assinatura

A assinatura cobre bytes UTF-8 de linhas separadas por um único LF, sem LF no final. O texto assinado não é a saída de `JSON.stringify`. O hex entra em minúsculas.

Certificado de membro, seis linhas:

```
varanda-cert-v1
<member hex64>
<faixa etária>
<método>
<data ISO>
<association hex64>
```

Certificado de semeador, quatro linhas:

```
varanda-seeder-v1
<seeder hex64>
<data ISO>
<association hex64>
```

A associação assina esses bytes com a chave secreta Ed25519 dela. A assinatura no JSON é esse resultado em 128 hex minúsculos.

Diante da chave do diário, a verificação devolve o primeiro motivo nesta ordem: `malformed`, `member-mismatch`, `untrusted-association`, `bad-signature`. No semeador a ordem é `malformed`, `seeder-mismatch`, `untrusted-association`, `bad-signature`. `no-cert` é bloco 0 ausente. `not-in-log` é bloco 0 presente que não é um registro `member-cert` válido. `fork` é histórico reescrito. `timeout` é prazo da busca do bloco 0 esgotado, no semeador que responde a um `announce`.

### Chave do diário

O Corestore deriva o par Ed25519 que assina o diário a partir da chave primária do store, criada neste dispositivo, e deriva a chave do core de um manifesto de um único assinante. A chave pública do diário, a que `id create` imprime, é a chave do core. Ela não coincide byte a byte com a chave pública crua do assinante. Só o dispositivo que tem esse `store/` acrescenta blocos.

### Leitura: futuro e fork

Publicação com `Date.parse(at)` mais de 24 horas à frente de quem lê sai do feed e entra na lista `future` (`<hex64>:<seq>`). O aviso é `aviso: publicação <ref> ignorada (future)`. A ordem dos itens que ficam continua determinística para aquele relógio.

Diário com `fork` diferente de zero foi reescrito por quem tem a chave. O semeador deixa de semeá-lo. O `sync` apaga a réplica e avisa em stderr `aviso: diário <8 hex> ignorado (fork)`. O `feed` emite o mesmo aviso e só lê; o próximo `sync` é que apaga a cópia local.

## Limitações e próximos passos

Limites desta fase:

- Um bloco tem no máximo 16 KiB. Um diário tem no máximo 100 000 blocos e 64 MiB. Publicar além disso falha com `erro: limite do diário atingido`, e o semeador descarta um diário acima do limite com motivo `quota`.
- No máximo 64 conexões do enxame por processo. As conexões externas do semeador (WebSocket) têm um limite separado, `VARANDA_MAX_EXTERNAL` (padrão 32).
- No máximo 4096 diários anunciados por par.
- Um par que viola o protocolo é desconectado.
- O semeador aceita até 10 anúncios por segundo de cada par (rajada de 20); um par cujo certificado falha 16 vezes é desconectado.
- No máximo 4095 diários seguidos: `follow` além disso falha com `erro: limite de diários seguidos atingido`.
- `sync --once` espera pares que não são semeadores verificados por no máximo 5 s no total, quantos forem. Sem um semeador verificado que confirme a sua cópia, o resultado é `sync done (sem confirmação de semeador)`: ninguém garantiu guardar o seu diário.
- Cada conexão aceita até 100 mensagens por segundo (rajada de 4160); um par acima disso é desconectado.
- Em `sync --once`, a busca do bloco 0 de um diário seguido dura no máximo 15 s; se ninguém o entregar, o diário aparece como não anunciado e o resultado pode ser `sync done` sem ele.
- `log --author <chave>` exige dados locais do diário (`erro: sem dados locais para este diário` caso contrário).
- O vínculo com a conta Google não verifica idade: o certificado v2 traz `ageBand: unchecked` (a lacuna do ECA Digital continua aberta; `docs/design.md`).
- O app nativo e a CLI ainda colam o certificado v1 emitido pela associação (`assoc certify`); só a versão web hospedada recebe o certificado v2 do serviço de conta. Nós de antes desta mudança rejeitam um certificado v2 como `malformed`, então o semeador e todo membro nativo ou da CLI precisam atualizar antes da primeira emissão v2.
- A identidade piloto da versão web mantém o certificado v1 (um diário não aceita um segundo certificado). Ela pode vincular a conta Google e ganhar um @nome pelo registro de @nome, mas o certificado dela continua v1.
- O @nome troca no máximo uma vez a cada 7 dias e um nome já usado por um membro não vai para outro; um nó antigo ou um seguidor que ainda não sincronizou pode mostrar por um tempo o nome anterior.
- A lista de bloqueio é obedecida só por nós atualizados e honestos: um nó de antes da PR B2 não a aplica, um app modificado ainda pode falar direto com a conta bloqueada, e o app oficial da própria conta bloqueada guarda o diário e pode servi-lo a quem já conhece a chave de descoberta. A versão web sem rede aplica a lista que já guardou e só recebe uma nova pelo semeador. Bloquear não apaga nada do aparelho do autor. Veja `docs/verification.md` seção 13.
- A lista tem no máximo 4096 contas bloqueadas e 64 emissores revogados. Cada conexão troca no máximo uma lista a cada 10 s e é derrubada depois de 5 mensagens inválidas no canal `varanda/blocklist/1`.
- Só a versão web hospedada denuncia: o app nativo e a CLI não têm como assinar ou enviar uma denúncia (a folha avisa), e só quem vinculou a conta Google denuncia, até 20 vezes a cada 24 horas. O trecho citado da publicação é o que quem denuncia enviou e não é conferido pelo serviço, e a pessoa denunciada não vê nada. Veja `docs/verification.md` seção 14.
- As sessões do painel acabam quando o serviço `account` reinicia. A lista que o painel mostra como publicada é o espelho verificado da última lista que o operador confirmou com `mod apply`, e o `blocklist.json` do operador é a que vale; "aplicado" é a palavra do operador, e a propagação segue as regras do `varanda/blocklist/1`.
- Certificados de membro individuais não são revogáveis (bloqueie a chave do diário). A chave do emissor do serviço de conta é revogada com `mod revoke-issuer`; depois disso gere outra (`account key`), certifique (`assoc certify-issuer`), `account cert add`, reinicie o serviço e peça que os membros vinculem de novo, porque os certificados v2 antigos deixam de valer. A reemissão automática fica para uma PR futura.
- O app pagina para trás por cursor (`before` em `feed.read` e `log.read`: 30 e depois páginas de 31 publicações, páginas de 36 blocos no diário), e os comandos `feed` e `log` da CLI paginam do mesmo jeito com `--limit` e `--before`. Não há paginação para a frente (`since`); dados novos pedem recarregar a página mais nova.
- A Espiadinha (quarta aba) só existe na versão web hospedada: o app nativo e o `varanda-serve` avisam disso. Cada página abre uma conexão curta com o semeador (uma conexão externa a mais, entre as conexões externas que ele aceita, `VARANDA_MAX_EXTERNAL`, padrão 32; com muitos membros online o semeador responde lotado (a mensagem do nó, "Semeador ocupado; tente novamente em instantes.", não muda) e a tela mostra "Muitas pessoas conectadas agora. Tente de novo em instantes."; medido em laço local, 40 membros conectados com o padrão de 32 dão 32 vagas ocupadas e 8 recusas, e cada leitura segura uma vaga por cerca de 10 a 20 ms. Quadros grandes demais vindos do semeador cortam a ligação), o custo cresce de forma linear com o número de diários do semeador (páginas cortadas em 25 s ou 16 MiB aparecem como incompletas), nada é guardado no aparelho além da memória da página, nomes são o melhor possível, mostra até 3 publicações por diário (respostas, citações e republicações incluídas) e a data é a que o autor escreveu. Regra e detalhes em `docs/rpc.md` (5.22) e `docs/verification.md` seção 17. A pesquisa por assunto da Espiadinha acha só palavras inteiras (sem prefixo, sem acentos nem alfabetos fora de a-z depois de tirar os acentos), em ordem de data e sem pesos, apenas no que o semeador indexou na memória (pode estar incompleto), sem "assuntos do momento"; uma publicação ainda não pode ser apagada, então continua pesquisável até o diário sair do semeador (`docs/protocol.md` seção 5).
- Os Avisos (a quarta das cinco abas, com o sino, antes do Diário) só existem na versão web hospedada: o app nativo, o `varanda-serve` e a CLI mostram "só na versão web". Quem começou a seguir você aparece numa linha que abre o perfil da pessoa, onde fica o "Seguir", e quem responde, cita ou menciona (`@nome` no texto) você aparece numa linha que abre a conversa; sem contagem, sem lista de seguidores e sem rota HTTP nova; o semeador guarda os índices só em memória (canais `varanda/notices/1`, só de seguir, e `varanda/notices/2`, com os quatro tipos, [docs/protocol.md](docs/protocol.md)) e cada leitura usa uma conexão externa curta a mais, como a Espiadinha. Detalhes em `docs/rpc.md` (5.28) e `docs/verification.md` seções 20 e 35. O push da versão web hospedada (seguir, resposta, curtida e republicação) é outro caminho e entra nesta fase: "Avisos push" acima e `docs/verification.md` seção 38.
- O app sincroniza sozinho sempre que está aberto e com rede, também com dados móveis; a preferência por Wi-Fi não existe (issue #48). Toda leitura de membro ainda interrompe e reinicia a rodada contínua (issue #66); o app reduz o efeito com leituras em lote (`profile.read` com até 100 chaves, no máximo um pedido por segundo), uma janela de 5 s antes das buscas de fundo e a pílula "ver novidades" no lugar de recarregar sozinho. A pílula é só uma dica das linhas `downloaded`, nunca uma contagem. Veja [docs/app.md](docs/app.md).

Fora desta fase:

- Verificação de idade real. Hoje o operador de `assoc certify` afirma `--age-band`. Comentário `TODO(phase1): the real age-check vendor decides here; today the operator asserts the age band.` em `packages/core/lib/assoc.js`. O mesmo limite está em `docs/protocol.md` (certificados).
- Notificações push quando um diário seguido cresce. Comentário `TODO(phase1): push notifications when a followed log grows.` em `packages/core/lib/sync.js` e em `docs/protocol.md` (sync). Esse caso, um aviso quando um diário seguido cresce, continua fora. Os quatro eventos (seguir, resposta, curtida e republicação) já têm push na versão web hospedada, com adesão em Ajustes. Citação e menção ficam só na aba Avisos, dentro do app, junto com o aviso de seguir. Sem contagem de seguidores e sem lista de seguidores. O app nativo, o `varanda-serve` e a CLI não têm push.
- Recuperação da chave do diário com chaves limiar FROST. Comentário `TODO(phase2): threshold-key (FROST) recovery of this key.` em `docs/protocol.md` (identidade). A chave fica no `store/` deste dispositivo.
- Denúncias pelo app nativo e pela CLI (a denúncia pela versão web, inclusive do perfil de outro membro, o painel e a lista de bloqueio assinada já existem). Conversas completas e perfis de quem a pessoa não segue só pela versão web hospedada (índice de engajamento do semeador e leitura sob demanda; `docs/protocol.md` seções 5 e 7). Prazos e retenção das denúncias seguem em aberto (issue #38). Certificado de membro e certificado de semeador não expiram e não são revogados individualmente; só a chave de emissor é revogada, pela lista.
- Vídeo e a comparação de fotos com listas de hashes de material ilegal (`docs/design.md`, Moderação). Hoje só a versão web hospedada publica fotos e GIFs (até 4 por publicação, 8 MiB cada, 256 MiB por núcleo de fotos, um núcleo por aparelho sem troca); a CLI, o app nativo e o `varanda-serve` só mostram que a publicação tem fotos. Veja `docs/verification.md` seção 16.
- Empacotamento Pear e distribuição fora das lojas. O aplicativo Expo (`apps/app`) já roda o núcleo no Bare (iOS e Android), e a versão web roda o nó no próprio navegador (sincronizando pelo semeador) ou usa o `varanda-serve` na máquina local; ver [docs/app.md](docs/app.md), [docs/verification.md](docs/verification.md) e [docs/development.md](docs/development.md). O CLI continua sendo um programa Node sem etapa de compilação.
- Relay de certificados por seguidores. O `sync` anuncia só o próprio diário (`packages/core/lib/sync.js` envia `announce` da chave local e ignora `announce` recebido). Um seguidor não apresenta ao semeador o certificado de outra pessoa. Se a autora nunca sincronizou, o semeador não tem a cópia, mesmo que um seguidor já a tenha. Não há comentário `TODO` no código para esse relay. `docs/protocol.md` registra que o `announce` permanece sem autenticação de propósito: qualquer par pode pedir a admissão, e só entra o diário cujo bloco 0 passa na verificação.

## Códigos de saída

| Código | Quando |
| --- | --- |
| 0 | Sucesso. `sync --once` imprime `sync done` (ou `sync done (sem confirmação de semeador)` quando nenhum semeador verificado confirmou a cópia do seu diário). `seed` e a DHT local saem com 0 depois de SIGINT ou SIGTERM. A demo imprime `DEMO OK`. |
| 1 | Falha. Mensagem em stderr: `erro: <mensagem>`. Exemplos: `erro: certificado inválido (untrusted-association)`, `erro: certificado do semeador não encontrado (use seed cert add)`, `erro: associação diferente da configurada`, `erro: diretório de dados em uso`, `erro: porta em uso`. `sync` com metas não cumpridas também sai 1 e escreve `sync failed: <erros>` na saída padrão. |
| 2 | Uso. O analisador escreve `uso: <mensagem>` e em seguida a ajuda. Exemplos: `uso: bootstrap inválido <valor>`, `uso: bootstrap inválido (vazio)`, `uso: dht-host inválido`, `uso: falta o valor de --text`, `uso: opção desconhecida <flag>`. Um comando que recusa a própria linha escreve só `uso: <mensagem>`, sem repetir a ajuda: `uso: informe --text <texto>`, `uso: informe --seeder <hex>`, `uso: informe --cert-file <arquivo>`, `uso: informe a chave do diário`, `uso: node bin/varanda.js seed [key|cert add|list|drop <chave>|status]`. Comando desconhecido sai 2 com `erro: comando desconhecido: <nome>`. |
