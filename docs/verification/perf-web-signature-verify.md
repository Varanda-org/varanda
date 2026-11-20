# Assinaturas na partida do nó do navegador (branch perf/web-signature-verify, parte da #353)

Item da #353 vindo do #407: cerca de 122 assinaturas de certificado eram verificadas em JavaScript puro na partida (cerca de 2,2 s com CPU 4x, §129), e a issue pedia uma decisão entre WebCrypto Ed25519 e um cache. Decisão do dono do produto na rodada de perguntas da #353: os dois.

## O que muda

- **Resumos guardados (`packages/core/lib/verified.js`, `packages/web-member/lib/sig-store.js`).** Cada assinatura que o aparelho achou válida deixa um resumo BLAKE2b-256 sobre `'varanda verified v1'`, a chave, a assinatura e a mensagem assinada (no máximo 4096, os mais antigos saem primeiro). O nó do navegador e o worklet do app nativo (só depois de obter o LOCK do armazenamento, `apps/app/worklet/web-node.js`) guardam a lista no kv `'verifiedSigs'` (`docs/protocol.md`, "Web member storage") alguns segundos depois do último resumo novo e ao fechar. Na visita seguinte, uma checagem recalcula o resumo da chave, da assinatura e da mensagem exatas e, se ele está na lista, não verifica de novo. Só uma checagem bem-sucedida grava. O resumo só diz que aquela assinatura é válida: revogação, bloqueio, datas e as outras regras continuam sendo conferidas em toda leitura. Um valor rasgado ou estranho vale como nenhum. A lista fica depois de `identity.reset`, como `'follows'`: ela não tem chave, nome nem texto.
- **WebCrypto antes da checagem síncrona (`verified.warm`, `packages/web-member/lib/warm-sigs.js`).** Antes do portão de cada diário na partida (`localGate` em `sync.js`), de `feed.read` e de `profile.read`, o certificado do bloco 0 e o registro de nome de usuário mais novo de cada diário são verificados com `crypto.subtle` Ed25519, elo por elo, e o resultado entra na mesma memória que as checagens síncronas já consultam. A resposta de cada leitura continua vindo do código de sempre.

## Por que o WebCrypto não muda nenhuma resposta

- Só cadeias cuja raiz é a chave da associação configurada são aquecidas: a delegação assinada pela associação e, depois, a assinatura do emissor que ela delegou. Assinaturas de outras pessoas (posts, curtidas, a lista de bloqueio) continuam só no caminho de sempre.
- Antes de chamar o WebCrypto, a assinatura passa pelas mesmas recusas de codificação do libsodium: S menor que a ordem do grupo, R e a chave com y menor que p e fora da lista de pontos de ordem pequena. Isso tira a maleabilidade que um terceiro poderia usar.
- O WebCrypto só entra depois de uma sonda com o vetor 1 da RFC 8032: a assinatura certa tem de passar e uma cópia com um bit trocado tem de falhar. Uma implementação que aceita tudo é recusada.
- Uma divergência entre o WebCrypto e o libsodium só seria possível com uma assinatura feita de propósito pelas chaves da própria associação ou de um emissor que ela delegou.
- `warm` nunca lança erro e só adiciona entradas que a checagem síncrona também aceitaria. Sem WebCrypto Ed25519 (um navegador antigo), ou se a sonda falhar, nada acontece e tudo segue como antes. No worklet do app nativo, o `crypto.subtle` vem do `bare-crypto/global` (1.15.4), que tem Ed25519 com importação `raw`; a mesma sonda decide se ele é usado.

## Testes

- `node packages/core/test/verified.test.js`: 11/11. Os novos: o resumo guardado responde depois de limpar a memória e outra mensagem continua sendo verificada; carga inválida, limite de 4096 e `onDigest`; a sonda recusa um WebCrypto que aceita tudo; a cadeia aquecida pelo WebCrypto real do Node responde sem nenhuma checagem síncrona e um primeiro elo falso não aquece o segundo; S + L, R de ordem pequena, R com y maior ou igual a p e chave de ordem pequena nunca chegam ao WebCrypto. Sem as recusas de codificação, o último teste falha (conferido trocando `encodingOk` por `true`).
- `node packages/core/test/cert.test.js`: 27/27 (`certChain` e `usernameChain`).
- `node packages/web-member/test/sig-store.test.js`: 6/6. Os resumos sobrevivem a um reinício e são gravados ao fechar; a gravação adiada; valores rasgados ou de outra versão; dois nós no mesmo processo (os resumos ficam até o último fechar); uma checagem feita enquanto a lista guardada carrega entra na lista, e nada é gravado antes de a lista guardada entrar; `warmLogs` e `warmBlock0` aquecem o certificado e o nome de usuário mais novo do próprio diário, e só eles.
- `node apps/app/test/identityInstall.test.js`: o encerramento do worklet grava os resumos depois de fechar a sessão e antes de soltar o armazenamento, solta o armazenamento mesmo se a gravação falhar, e não toca neles quando o LOCK foi recusado.
- Na raiz, no Node 24: `npm run lint` e `npm run demo` (`DEMO OK`) passaram. No `npm test -- --affected=origin/main`, 41 de 797 arquivos estouraram o tempo com a máquina carregada por suítes de outras branches (arquivos de rede de `packages/core`, de `packages/web-member` e de `apps/cli`). Cada um passou rodando sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), 41 de 41. Node 20 só na CI.

## Medida (`packages/web-member/scripts/startup-bench.js`)

Node no Mac, carga média perto de 7, 50 seguidos de 20 blocos, certificados v2 com nome de usuário, verificação em sodium-javascript como no bundle web (`--issued --js-verify --reads`), mediana de 3 execuções. Flags novas: `--no-subtle` (sem WebCrypto, como antes desta branch) e `--saved-sigs` (a visita seguinte, com os resumos da anterior).

| Caso | Checagens em JS | Tempo em JS | Pelo WebCrypto | `profile.read` |
|---|---|---|---|---|
| sem WebCrypto, sem resumos (antes) | 102 | 260,2 ms | 0 | 132,4 ms |
| com WebCrypto | 2 | 5,6 ms | 100 | 8 ms |
| com WebCrypto e resumos guardados | 0 | 0 ms | 0 | 8,2 ms |

`feed.read` e `engagement.read` ficaram iguais (cerca de 6 ms e 0,5 ms). Números de Node, não de celular: o tempo de JS no celular é maior, a proporção é o que compara.

## Fora desta branch

- Nenhum número de celular nem de navegador real foi medido. O que exige conta fica no checklist da #224.
