# feat/data-export

Issue #25: exportar os dados da conta num arquivo (acesso e portabilidade, LGPD Art. 18).

## O que mudou

- `export.read` (`docs/rpc.md` 5.180), método de leitura nos dois nós (`packages/core/lib/session.js` e `packages/web-member/lib/session.js`). Sem estado: o cursor `{ part, offset, until }` volta inteiro do cliente, e cancelar é não mandar a próxima chamada. Partes: `head` (formato, versão, associação, comprimento assinado do diário, total de seguidos, perfil `{ name, bio }`, bloqueados e silenciados no nó do navegador), `follows` (500 por página) e `diary` (até 500 blocos ou 196608 bytes por página, sempre pelo menos um bloco).
- Recorte: `until` é o comprimento assinado do diário na resposta do `head`. Blocos escritos depois ficam fora, e só os apagamentos abaixo de `until` são aplicados, então um apagamento escrito depois do início não some com um bloco já contado. Se esse apagamento já limpou os bytes, o bloco sai como `deleted`, nunca como `malformed`.
- `packages/core/lib/export.js` (paginação pura, `mergeHeld`) e `packages/rpc/lib/export.js` (texto do arquivo, `checkExport`, nome do arquivo, preferências por lista de permissão, `followsDigest`). `exportBlocks` nos dois módulos de membro lê todo bloco guardado no aparelho, mesmo depois de um buraco (um aparelho que ainda está baixando o próprio diário exporta o que já tem), sem aplicar apagamentos, com o comprimento assinado. `readHeld` novo em `packages/core/lib/store.js`, como o do nó do navegador.
- Documento versão 1 (`docs/protocol.md` seção 17): JSON UTF-8, chaves em ordem fixa, uma linha por registro do diário. Nunca leva segredo, mensagem privada, grupo, Página, bytes de mídia nem perfil de outra pessoa.
- App: Ajustes > Exportar meus dados (`apps/app/src/screens/ExportarDados.js`, lógica pura em `apps/app/src/dataExport.js`). Explicação atrás do (i). Na web, o arquivo é baixado; no celular, salvo numa pasta escolhida (`expo-file-system`, já dependência) e, no iOS, também compartilhado (`Share` do React Native anexa arquivo só no iOS). Nenhuma dependência nova.
- `collectExport` confere cada página (seis chaves, mesma chave, cursor que avança, mesmo `until`) e recusa o arquivo se o total ou o `followsDigest` dos seguidos não bate com o `head` (lista mudou entre páginas, inclusive uma troca que mantém o total). Nunca repete um pedido que falhou.
- Celular: salvar de novo no mesmo dia, na mesma pasta, usa `-2` a `-9` no nome (o iOS recusa nome existente), e um arquivo vazio ou parcial é apagado se a escrita falhar. No iOS, a cópia para compartilhar fica numa pasta própria do cache; se a pessoa escolhe um app e cancela lá dentro, o `Share` do React Native nunca responde, então depois de 60 s os botões voltam e a cópia é apagada na próxima entrega, ao sair da tela ou na próxima abertura do app (`apps/app/index.js`, antes da primeira tela), mesmo que o sistema tenha encerrado o app no meio.

## Testes

- `packages/core/test/export.test.js`: paginação de 1200 blocos, teto de blocos e de bytes, inválidos só com motivo, `until` e lacunas, seguidos em 1201 chaves, `head.next`, `followsDigest`, perfil sem avatar, apagamento depois do recorte (lógico e com bytes limpos), `mergeHeld` com blocos depois de um buraco.
- `packages/core/test/export-session.test.js`: sessão real com DHT local; caminhada completa, formato exato, mais registros que uma página de `log.read`, igualdade com `log.read`, respostas abaixo de `MAX_MESSAGE`, post depois do `head` fora, apagamento depois do `head` sai como `deleted`, nenhuma forma da chave secreta nem do diretório de dados.
- `packages/web-member/test/export.test.js`: nó do navegador, caminhada completa com páginas em ordem, bloqueados e silenciados, nó reaberto sem chave (bloqueado) exporta todos os blocos, sem identidade dá `NOT_FOUND`, sem segredo.
- `packages/rpc/test/export.test.js`, `methods.test.js`, `sizes.test.js`, `leak.test.js`: documento, `checkExport` (inclui seq fora do comprimento e seq repetido), parâmetros e limites.
- `apps/app/test/dataExport.test.js`: 1300 registros e 1201 seguidos, cancelamento, cursor que não avança, chave trocada, seguidos que mudam entre páginas (inclusive troca com o mesmo total, que falha sem o digest), rejeição sem nova tentativa, preferências, nome do arquivo, textos sem travessão, download na web, os dois módulos de entrega exportam os mesmos nomes, a abertura do app apaga a cópia deixada no cache antes da primeira tela.
- `apps/app/test/composePolish.test.js`: a tela cancela e descarta resultado tardio, entrega no toque, e limpa a cópia do cache ao sair.
- `apps/app/test/vitrine.test.js`, `platformGate.test.js`, `help.test.js`.
- Regressões conferidas sem a correção: o caso do apagamento depois do `head` (saía `malformed`) a troca de seguidos com o mesmo total (passava sem o digest) e a limpeza na abertura do app falham sem a correção e passam com ela.

## Comandos

```sh
npm run lint
node packages/core/test/export.test.js
node packages/core/test/export-session.test.js
node packages/web-member/test/export.test.js
node packages/rpc/test/export.test.js
node packages/rpc/test/methods.test.js
node packages/rpc/test/sizes.test.js
node packages/rpc/test/leak.test.js
node apps/app/test/dataExport.test.js
node apps/app/test/vitrine.test.js
node apps/app/test/composePolish.test.js
node apps/app/test/platformGate.test.js
npm run demo
```

## Não feito

- Conferência em aparelho (Android, iOS) e no PWA não foi executada: seletor de pasta, nomes `-2`, folha de compartilhamento do iOS, o tempo de 60 s e o download na web estão cobertos só por testes de fonte e de stub.
- Um buraco no próprio diário não foi reproduzido numa sessão real; `exportBlocks` e `mergeHeld` têm teste de unidade.
- Custo: sem estado no nó, cada página relê o diário inteiro (duas leituras, prefixo e blocos guardados) para aplicar só os apagamentos do recorte. Um diário de milhares de blocos exporta em segundos; perto do teto de 100 mil blocos, a exportação fica lenta.
- A Política de Privacidade não foi alterada (caminho protegido); `docs/design.md` aponta para a seção 17.
- Fora do escopo do arquivo: mensagens privadas, grupos, Páginas, bytes de mídia e dados do serviço de conta (`account export` continua sendo o caminho desses).
