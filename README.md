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
  id create|show             identidade (chave pública do diário)
  cert add                   grava o certificado como bloco 0 do diário
  profile set                define nome e bio
  post                       publica um texto (--text)
  reply                      responde a uma publicação (--to <chave>:<seq> --text)
  follow|unfollow|follows    segue ou deixa de seguir uma chave pública
  log                        mostra os blocos locais de um diário
  feed                       feed com as publicações dos diários seguidos
  sync                       sincroniza com pares e com o semeador (--once, --timeout-ms)
  seed                       semeador sempre ligado (--health-port, --ws-port)
  seed key|cert add          chave do semeador e seu certificado (--cert-file)
  seed list|status           diários admitidos e estado do semeador
  seed drop <chave>          apaga um diário do semeador parado
  help                       esta ajuda
Opções globais:
  --data <dir>               diretório de dados (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --json                     saída JSON na última linha
Opções dos comandos:
  --member --seeder --age-band --method --out --cert-file --name --bio --text
  --to --author --limit --once --timeout-ms --health-port --health-host --ws-port --ws-host
```

`--json` coloca um objeto JSON na última linha da saída padrão. Em `sync` e `seed`, cada evento é uma linha JSON e o resultado fecha a saída. Nenhum comando imprime chave secreta. `seed key` imprime só a chave pública Noise do semeador.

### Registros

O diário é uma sequência de blocos JSON. O índice do bloco é o `seq`, a partir de 0.

- Bloco 0: `{ "type": "member-cert", "cert": <certificado> }`. O campo `cert.member` é a chave pública do diário. Sem esse bloco o diário não recebe perfil, publicação nem resposta.
- `profile`: nome (1 a 80 caracteres) e bio (0 a 280).
- `post`: texto (1 a 1000 caracteres). Uma resposta é um `post` com `replyTo` apontando para `<chave>:<seq>` de outra publicação. O `seq` do alvo é um inteiro maior ou igual a 1, porque o bloco 0 é o certificado.

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

`sync --once` sai com código 0 quando ao menos um par enviou `hello`, nenhum diário seguido ficou atrás do tamanho que um par anunciou, os pares interessados no próprio diário alcançaram o tamanho dele e, se há semeador verificado e o bloco 0 local é um certificado válido, um semeador verificado enviou `admitted` até esse tamanho. O prazo padrão é 30000 ms (`--timeout-ms`).

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

`--bootstrap` pode repetir. Se algum `--bootstrap` aparece na linha, ele prevalece sobre `VARANDA_BOOTSTRAP`. `--dht-host` prevalece sobre `VARANDA_DHT_HOST`.

Um `VARANDA_BOOTSTRAP` vazio ou malformado é erro de uso e não cai na DHT pública. Exemplos: `uso: bootstrap inválido (vazio)`, `uso: bootstrap inválido localhost`. A porta não leva zero à esquerda; o formato é `host:porta` com porta de 1 a 65535.

`VARANDA_DHT_HOST` e `--dht-host` aceitam uma string não vazia e sem espaço. Qualquer outro valor termina com `uso: dht-host inválido`.

`VARANDA_HEALTH_PORT` e `--health-port` aceitam um número de 0 a 65535, sem zero à esquerda (`0` deixa o sistema escolher a porta); senão `uso: health-port inválido`. `VARANDA_HEALTH_HOST` e `--health-host` seguem a regra do `--dht-host` (`uso: health-host inválido`). A opção prevalece sobre a variável. Detalhes em "Operar o semeador".

`VARANDA_WS_PORT` e `--ws-port` seguem a regra do `--health-port` (`uso: ws-port inválido`); `VARANDA_WS_HOST` e `--ws-host` seguem a do `--dht-host` (`uso: ws-host inválido`).

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
- `data/certs` — JSON dos certificados (`--out` / `--cert-file`); não é um diretório de papel

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

`follow` imprime `seguindo ` e a chave da Alice. O `sync` do Bob baixa o diário dela pelo semeador (`downloaded <chave da Alice> <tamanho>`) e termina com `sync done`. `feed` lista a publicação, no formato `[<data>] Alice (<8 hex>) #<seq>` e o texto na linha seguinte. `feed` não abre a rede.

```sh
node bin/varanda.js reply --data data/bob --to "$ALICE:$SEQ" --text 'também li'
node bin/varanda.js sync --data data/bob --once --timeout-ms 30000 --bootstrap "$VARANDA_BOOTSTRAP" --dht-host "$VARANDA_DHT_HOST"
```

`reply` imprime `publicado #<seq>`. O segundo `sync` entrega a resposta ao semeador. `--to` é `<64 hex>:<seq>` com `seq` maior ou igual a 1, sem zero à esquerda. Fora isso o uso é `referência inválida`.

Para encerrar: Ctrl-C no semeador (código 0) e Ctrl-C na DHT local.

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

`seed status` mostra a associação, a chave pública do semeador, o estado do certificado, quantos diários estão em `admitted.json` e se algum processo segura o diretório. Não pega o lock, não abre o store e não grava nada: funciona com o semeador ligado ou parado, e sai com 0.

```
associação: <64 hex>
chave do semeador: <64 hex>
certificado: válido
diários admitidos: 2
estado: em execução
```

Sem `seeder-key.json` a segunda linha é `chave do semeador: ausente (use seed key)`. Sem certificado: `certificado: ausente (use seed cert add)`; certificado que não confere: `certificado: inválido (<motivo>)`. O estado é `em execução` ou `parado`. Num diretório que não é de semeador: `erro: diretório não é de um semeador`. Com `--json`: `{ "association", "publicKey", "certificate", "admitted", "running" }`, com `certificate` igual a `ok`, `missing` ou o motivo.

`seed list` mostra os diários admitidos, um por linha, na ordem de `admitted.json`: `<chave> <blocos> blocos <bytes> bytes`. O tamanho é o assinado, o mesmo que a cota confere. Sem diários: `nenhum diário admitido`. Com `--json`: `{ "admitted": [{ "key", "length", "byteLength" }] }`. Uma chave listada sem cópia guardada aparece com 0 e 0.

`seed drop <chave>` apaga a cópia de um diário e só depois tira a chave de `admitted.json`, a mesma ordem do descarte na partida. Imprime `diário removido do semeador: <chave>`. Chave que não está no semeador: `erro: diário não está no semeador` (código 1). Sem chave: `uso: informe a chave do diário`; chave malformada: `uso: chave inválida` (código 2).

`seed list` e `seed drop` abrem o store e pegam o lock do diretório. Só funcionam com o semeador parado; com ele no ar saem com `erro: diretório de dados em uso` (código 1) e não mexem em nada. Pare o serviço, rode o comando e suba de novo.

`seed drop` não é bloqueio. No próximo `sync` da autora o semeador confere o bloco 0 e admite o diário outra vez. Manter um diário fora depende das listas de moderação, previstas para a fase 2.

### Saúde e métricas

`seed --health-port <porta>` (ou `VARANDA_HEALTH_PORT`) abre um endpoint HTTP só de leitura em `127.0.0.1`. Outro endereço só com `--health-host` (ou `VARANDA_HEALTH_HOST`); `0.0.0.0` expõe o endpoint para fora da máquina. Sem a porta, nada escuta. A porta `0` escolhe uma livre, e a primeira linha da saída diz qual: `health http://127.0.0.1:<porta>`. Porta ocupada termina com `erro: porta em uso` (código 1) antes de abrir o diretório.

- `GET /health` devolve `{ "status", "uptimeSeconds", "admitted", "dropping", "blocks", "bytes", "connections", "peers", "firewalled" }`. Código 200 com `status` igual a `ok`; 503 com `starting` (antes de `seed ready`) ou `closing` (encerrando).
- `GET /metrics` devolve as mesmas contagens no formato de texto do Prometheus: `varanda_seeder_ready`, `varanda_seeder_admitted_diaries`, `varanda_seeder_dropping_diaries`, `varanda_seeder_blocks`, `varanda_seeder_bytes`, `varanda_seeder_connections`, `varanda_seeder_peers`, `varanda_seeder_firewalled` e `varanda_seeder_uptime_seconds`.

```sh
curl -s http://127.0.0.1:8788/health
```

```json
{"status":"ok","uptimeSeconds":42,"admitted":2,"dropping":0,"blocks":6,"bytes":1418,"connections":3,"peers":3,"firewalled":false}
```

`admitted` são os diários servidos e `dropping` os que estão sendo apagados; `blocks` e `bytes` somam os diários servidos; `connections` são as conexões abertas e `peers` as que já abriram o canal de admissão. `firewalled: true` quer dizer que a DHT se vê atrás de firewall ou NAT: os membros só chegam ao semeador por hole punching.

O endpoint só tem contagens. Nenhuma chave, certificado, endereço ou conteúdo, e nenhuma requisição é registrada. Aceita só GET e HEAD (senão 405) em `/health` e `/metrics` (senão 404), sem cabeçalhos CORS.

### Entrada WebSocket

`seed --ws-port <porta>` (ou `VARANDA_WS_PORT`) abre uma entrada WebSocket em `ws://127.0.0.1:<porta>/seeder`, para um membro que roda no navegador. É um experimento da fase 0. Outro endereço só com `--ws-host` (ou `VARANDA_WS_HOST`); o padrão é `127.0.0.1`. Sem a porta, nada escuta. A porta `0` escolhe uma livre, e a saída diz qual: `ws ws://127.0.0.1:<porta>/seeder`. Porta ocupada termina com `erro: porta em uso` (código 1) antes de abrir o diretório.

Os bytes do WebSocket são um fluxo Noise com a chave do semeador, o mesmo que o membro vê pela DHT. Um proxy TLS pode repassá-los, mas não pode terminar o Noise. Essas conexões entram em `connections` do `/health`. Só o caminho `/seeder` aceita o upgrade; qualquer outro devolve 404, e um `GET /seeder` sem upgrade devolve 426. O cabeçalho `Host` precisa nomear a própria entrada (`127.0.0.1:<porta>`, `localhost:<porta>` ou `[::1]:<porta>` no loopback); outro devolve 421, o que barra o DNS rebinding. Clientes sem `Origin` (a CLI, apps nativos) entram normalmente; um navegador só entra se a origem estiver na lista permitida, que por padrão aceita apenas páginas `http` em loopback (qualquer outra devolve 403; a implantação pública vai configurar a origem do PWA). As conexões externas ocupam no máximo metade do limite de conexões do semeador, para que uma aba aberta não deixe os membros do enxame sem vaga.

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
- **Rotação.** Pelo supervisor. Docker: driver `json-file` com até 5 arquivos de 10 MB (`compose.yaml`). systemd: o journal rotaciona sozinho.
- **Retenção provisória: 30 dias.** No systemd, `deploy/seeder/journald-varanda.conf` vai para `/etc/systemd/journald.conf.d/varanda.conf` (`MaxRetentionSec=30day`). Vale para o journal inteiro da máquina, então use numa máquina dedicada. No Docker o limite é de volume (50 MB), não de tempo; para limitar por tempo, troque o driver para `journald` no `compose.yaml` e use a mesma configuração.
- **Registros de acesso (Marco Civil, Art. 15).** O semeador não registra endereço IP, então hoje não guarda registro de acesso. Se o parecer concluir que o Art. 15 se aplica à associação, a guarda por 6 meses vai exigir registrar endereço e horário das conexões (mudança de código, ainda não feita) e ajustar a retenção acima. A retenção é configuração do supervisor (`MaxRetentionSec`, `max-size` e `max-file`), não do código: muda sem nova versão.

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

`npm test` executa `npm test --workspaces --if-present`. Cada workspace que define script de teste usa `node ../../scripts/run-tests.js`, que roda cada `test/*.test.js` desse workspace em sequência (com prazo por arquivo: `VARANDA_TEST_TIMEOUT_MS`, padrão 180000).

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

Em cada pull request e em cada push para `main`, o workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) roda em `ubuntu-24.04` com Node 20 e 24 (matriz): `npm ci`, `npm run lint`, `npm test` e `npm run demo` (a demo deve terminar com `DEMO OK`).

Um arquivo, a partir da raiz:

```sh
node apps/cli/test/serve.test.js
```

`apps/app` não tem script de teste. Em `packages/core`, `test/bare-load.test.js` confere o núcleo no runtime Bare (parte de `npm test -w packages/core`).

Os testes de rede usam uma DHT local em processo (`hyperdht/testnet` por `apps/cli/test/helpers/net.js`), presa a `127.0.0.1`. Nenhum teste usa a DHT pública. `npm run lint` roda o `standard` em todo o repositório. Detalhes em [docs/development.md](docs/development.md).

## Layout de armazenamento

Arquivos JSON de estado são gravados num arquivo temporário e renomeados por cima do destino. `store/` (modo `0700`) contém a chave primária do Corestore; a chave que assina o diário deriva dela. `id show` e `seed key` imprimem só chaves públicas.

### Membro (`data/alice`, `data/bob`)

- `store/` — Corestore do diário e das réplicas seguidas.
- `quarantine/` — Corestore só da busca do bloco 0 de um diário ainda não aceito. O `sync` apaga esse diretório ao abrir (depois do lock de `store/`) e de novo ao fechar. Não é estado.
- `config.json` — `{ "v": 1, "role": "member", "association": "<hex64>" }`, escrito por `id create`.
- `follows.json` — `{ "v": 1, "follows": ["<hex64>"] }`, chaves únicas em ordem.

### Semeador (`data/seeder`)

- `store/` — réplicas admitidas. Todo core aqui está listado em `admitted.json`.
- `quarantine/` — busca do bloco 0 na admissão. Apagado em cada `seed` (depois do lock de `store/`) e de novo ao fechar. Não é estado.
- `config.json` — `{ "v": 1, "role": "seeder", "association": "<hex64>" }`, escrito pelo primeiro de `seed key`, `seed cert add` e `seed`.
- `seeder-key.json` — par Noise do semeador, modo `0600`: `v`, `publicKey` (hex64) e `secretKey`. Criado por `seed key`. O comando não imprime `secretKey`.
- `seeder-cert.json` — certificado do semeador em JSON indentado, escrito por `seed cert add`.
- `admitted.json` — único arquivo de estado: `{ "v": 1, "admitted": { "<hex64>": <certificado de membro> } }`. A chave entra nesse arquivo antes do core abrir em `store/`. Uma chave em descarte permanece no arquivo até a limpeza do core terminar.

### Associação (`data/assoc`)

- `association.json` — par de chaves da associação, modo `0600`. `assoc show` imprime só a chave pública.
- `members.jsonl` — uma linha JSON por certificado de membro, exatamente `member`, `ageBand`, `method` e `date`.
- `seeders.jsonl` — uma linha JSON por certificado de semeador: `{"seeder":"<hex64>","date":"<ISO>"}`. Sem assinatura e sem segredo.

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

O feed ordena por `(at, autor, seq)`. `--limit <n>` fica com as últimas `n` depois de tirar as publicações futuras. Item: autor, nome (ou nulo), `seq`, `at`, texto e `replyTo`.

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
- No máximo 64 conexões por processo.
- No máximo 4096 diários anunciados por par.
- Um par que viola o protocolo é desconectado.
- O semeador aceita até 10 anúncios por segundo de cada par (rajada de 20); um par cujo certificado falha 16 vezes é desconectado.
- No máximo 4095 diários seguidos: `follow` além disso falha com `erro: limite de diários seguidos atingido`.
- `sync --once` espera pares que não são semeadores verificados por no máximo 5 s no total, quantos forem. Sem um semeador verificado que confirme a sua cópia, o resultado é `sync done (sem confirmação de semeador)`: ninguém garantiu guardar o seu diário.
- Cada conexão aceita até 100 mensagens por segundo (rajada de 4160); um par acima disso é desconectado.
- Em `sync --once`, a busca do bloco 0 de um diário seguido dura no máximo 15 s; se ninguém o entregar, o diário aparece como não anunciado e o resultado pode ser `sync done` sem ele.
- `log --author <chave>` exige dados locais do diário (`erro: sem dados locais para este diário` caso contrário).

Fora desta fase:

- Verificação de idade real. Hoje o operador de `assoc certify` afirma `--age-band`. Comentário `TODO(phase1): the real age-check vendor decides here; today the operator asserts the age band.` em `packages/core/lib/assoc.js`. O mesmo limite está em `docs/protocol.md` (certificados).
- Notificações push quando um diário seguido cresce. Comentário `TODO(phase1): push notifications when a followed log grows.` em `packages/core/lib/sync.js` e em `docs/protocol.md` (sync).
- Recuperação da chave do diário com chaves limiar FROST. Comentário `TODO(phase2): threshold-key (FROST) recovery of this key.` em `docs/protocol.md` (identidade). A chave fica no `store/` deste dispositivo.
- Listas de moderação e revogação. Certificado de membro e certificado de semeador não expiram e não são revogados nesta fase. Comentários `TODO(phase2): moderation lists — consult a block list before admitting.` e `TODO(phase2): certificate revocation list.` em `packages/core/lib/seeder.js`. Também `TODO(later): media attachments and moderation lists are out of scope for phase 0.` em `packages/core/lib/records.js`, e os `TODO(phase2)` / `TODO(later phases)` correspondentes em `docs/protocol.md` (registros, certificados e admissão).
- Mídia. Publicação é só texto, até 1000 caracteres. O comentário de `packages/core/lib/records.js` citado acima, e `docs/protocol.md` (registros), deixam anexos para uma fase posterior.
- Empacotamento Pear e distribuição fora das lojas. O aplicativo Expo (`apps/app`) já roda o núcleo no Bare (iOS e Android), e a versão web roda o nó no próprio navegador (sincronizando pelo semeador) ou usa o `varanda-serve` na máquina local; ver [docs/app.md](docs/app.md), [docs/verification.md](docs/verification.md) e [docs/development.md](docs/development.md). O CLI continua sendo um programa Node sem etapa de compilação.
- Relay de certificados por seguidores. O `sync` anuncia só o próprio diário (`packages/core/lib/sync.js` envia `announce` da chave local e ignora `announce` recebido). Um seguidor não apresenta ao semeador o certificado de outra pessoa. Se a autora nunca sincronizou, o semeador não tem a cópia, mesmo que um seguidor já a tenha. Não há comentário `TODO` no código para esse relay. `docs/protocol.md` registra que o `announce` permanece sem autenticação de propósito: qualquer par pode pedir a admissão, e só entra o diário cujo bloco 0 passa na verificação.

## Códigos de saída

| Código | Quando |
| --- | --- |
| 0 | Sucesso. `sync --once` imprime `sync done` (ou `sync done (sem confirmação de semeador)` quando nenhum semeador verificado confirmou a cópia do seu diário). `seed` e a DHT local saem com 0 depois de SIGINT ou SIGTERM. A demo imprime `DEMO OK`. |
| 1 | Falha. Mensagem em stderr: `erro: <mensagem>`. Exemplos: `erro: certificado inválido (untrusted-association)`, `erro: certificado do semeador não encontrado (use seed cert add)`, `erro: associação diferente da configurada`, `erro: diretório de dados em uso`, `erro: porta em uso`. `sync` com metas não cumpridas também sai 1 e escreve `sync failed: <erros>` na saída padrão. |
| 2 | Uso. O analisador escreve `uso: <mensagem>` e em seguida a ajuda. Exemplos: `uso: bootstrap inválido <valor>`, `uso: bootstrap inválido (vazio)`, `uso: dht-host inválido`, `uso: falta o valor de --text`, `uso: opção desconhecida <flag>`. Um comando que recusa a própria linha escreve só `uso: <mensagem>`, sem repetir a ajuda: `uso: informe --text <texto>`, `uso: informe --seeder <hex>`, `uso: informe --cert-file <arquivo>`, `uso: informe a chave do diário`, `uso: node bin/varanda.js seed [key|cert add|list|drop <chave>|status]`. Comando desconhecido sai 2 com `erro: comando desconhecido: <nome>`. |
