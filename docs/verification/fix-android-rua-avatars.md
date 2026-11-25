# Fotos de perfil que faltam em A Rua no Android: diagnóstico e correção

Diagnóstico no aparelho e uma correção em `apps/app/src` (seção "Correção"). As edições de depuração do diagnóstico foram temporárias e já foram desfeitas; a correção não vem delas.

## Variantes investigadas

- V1a: uma resposta parcial de `profile.read` (nome, bio e foto nulos) troca um descritor guardado no cache de nomes por foto nula, e `pickAvatar` prefere a foto definida do cache à da linha.
- V1b: uma resposta com nome e foto nula vem de um diário atrasado.
- V2: arquivo temporário morto depois de `cache.clear` ou de expulsão do LRU, com `onError` deixando as iniciais; `keepOnlyAuthors` na abertura limpa os caches.
- V3: erro de transporte tratado como resposta final (`incompleto`, erro do leitor).
- V4: corrida de geração no armazenamento guardado (efeito visível: só uma nova busca).

## Reproduções isoladas (node, módulos reais do app)

Scripts fora do repositório, importando `namesCache.js`, `namesPeek.js`, `avatar.js`, `cache.js`, `keptLoad.js` e `localCaches.js` com um armazenamento falso.

| Caso | Entrada | Resultado |
|---|---|---|
| a | descritor no cache, depois `profile.read` parcial com @nome | cache fica com foto nula e `loaded`; `pickAvatar` dá nula; o peek não entra na fila (a fila só cobre chaves sem nome nem @nome) |
| a2 | igual, sem @nome | `pickAvatar` nula; peek entra na fila |
| b | perfil com nome e descritor, depois resposta parcial com @nome | `pickAvatar` nula, sem peek |
| b2 | b com um peek verificado guardado | preenche o descritor |
| V1b | resposta com nome e foto nula | nula (também sem a chave `avatar`) |
| c1 | `keepOnlyAuthors` durante a busca | 2 buscas, nada guardado, fica arquivo temporário, 1 temporário liberado, sem acerto guardado na abertura seguinte |
| c2 | limpeza entre a leitura da geração e a carga | 1 busca, nada guardado |
| c3 | controle | 1 busca, guardado, acerto guardado na abertura seguinte |

Conclusão isolada: o mecanismo V1a existe no código (a e b). O caso c mostra que uma limpeza no meio de uma carga só custa uma nova busca e um temporário, sem deixar a linha nas iniciais.

## Aparelho

Emulador `varanda-api36` (Android 16, API 36, arm64), build de debug `app.varanda.debug`, modo Vitrine:

```sh
npm run prepare:native -w apps/app -- android
cd apps/app/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
EXPO_PUBLIC_VARANDA_VITRINE=1 npx expo start --port 8081 --clear
```

Edições temporárias, todas desfeitas com `git checkout`:

- fixtures da Vitrine com 8 autores com foto real (4 seguidos: rótulos A2, A3, A4, A7; 4 não seguidos, originais de republicação ou citação: A5, A6, A8, A9);
- um nono autor (A11) com resposta parcial de `profile.read`, só para conferir o mecanismo;
- o registro de perfil do diário da Vitrine passou a levar a foto;
- logs `[DA]` só com rótulos em `Avatar.js`, `ARua.js` e `keptLoad.js`.

Cada abertura a frio: `am force-stop`, abrir, esperar 60 s, foto da tela, rolar além da janela de renderização (12 gestos), voltar ao topo (16 gestos), foto da tela. Cada retomada: HOME, 10 s, abrir, mesma rolagem.

### Resultado por linha

F = foto na primeira pintura; V = foto depois de rolar e voltar. "foto" em todas as células: nenhuma linha ficou nas iniciais.

| Rótulo | Situação | Carga (todas as aberturas a frio) | frio 2 | frio 3 | frio 4 | retomada 1 | retomada 2 | retomada 3 |
|---|---|---|---|---|---|---|---|---|
| A2 | seguido | guardada (acerto) | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A3 | seguido | guardada (acerto) | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A4 | seguido | guardada (acerto) | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A7 | seguido (Página) | guardada (acerto) | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A5 | não seguido, original de republicação | busca, temporário | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A6 | não seguido, original de citação | busca, temporário | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A8 | não seguido, original de republicação | busca, temporário | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |
| A9 | não seguido, original de citação | busca, temporário | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto | foto / foto |

Contagem dos logs nas três aberturas a frio: rótulo (a) nunca para A2 a A9, nenhum (d) (recusa do cache), nenhum (e) (`onError`), nenhuma liberação de cache e nenhum `wipe`, `dropAuthors` ou `keepOnlyAuthors`. Na retomada nada é recarregado: as linhas montam de novo e usam o que já está em memória.

### Conferência de mecanismo (com injeção, não conta para o veredito)

A11 recebe sempre a resposta parcial. Nas três aberturas a frio aparece `(a) picture null row A11 cache=null row=descriptor`: a linha tinha descritor e o cache de nomes, com foto nula, venceu. É o V1a observado no aparelho, mas só porque a resposta parcial foi forçada. Só um autor parcial foi usado porque a própria pessoa como parcial abria a tela de configuração do perfil a cada abertura.

### Observações

- Antes de o registro de perfil da Vitrine levar a foto, os originais não seguidos apareciam com iniciais. No app real o original de uma republicação ou citação recebe a foto só pelo `profile` do peek do diário (`thread.js`, `identity()`); quando a busca do membro falha, a linha fica sem nome e sem foto. Isso é uma lacuna de dados, não uma das variantes V1 a V4, e pode valer conferir num aparelho com conta real.
- Na Vitrine o `onFollows` de `ARua.js` retorna cedo porque não há vínculo (`config` nulo), então `keepOnlyAuthors` nunca roda e as limpezas de cache da abertura não acontecem. V2 e V4 não podem ser exercitados no aparelho nesse modo.

## Veredito

Não reproduzido. Sem injeção, nenhuma das 8 linhas perdeu a foto em 3 aberturas a frio e 3 retomadas, na primeira pintura ou depois de rolar e voltar.

- V1a: mecanismo confirmado na reprodução isolada (a, b) e no aparelho, só com resposta parcial injetada; nenhuma ocorrência espontânea.
- V1b: confirmado só na reprodução isolada; a Vitrine não tem diário atrasado.
- V2 e V4: não exercitados no aparelho, porque `keepOnlyAuthors` não roda na Vitrine; o caso c mostra que V4 custa só uma nova busca.
- V3: nenhum erro de leitura nem recusa do cache nas aberturas.

## Correção (V2; V1a ficou de fora)

Como o problema não se reproduziu sem injeção, a correção cobre só o defeito que os testes provam e que pode mudar sem risco. V1b, V3 e V4 ficaram de fora (sem mudança de RPC, de `fetch.js` nem da geração do armazenamento guardado).

O primeiro desenho foi trocado depois da revisão: uma resposta de perfil vazia também pode ser um perfil apagado, e manter o nome e a foto anteriores (ou pedir o peek com @nome) traria o perfil apagado de volta.

### V1a: não corrigido, por segurança

`profile.read` responde nome, bio e foto nulos tanto para um diário que ainda está baixando quanto depois de `profile.delete` apagar a última versão do perfil, e a resposta não diz qual é o caso. As três saídas avaliadas:

- (a) o peek de nomes preencher a entrada vazia: o peek lê o bloco que o índice do semeador indica (`profileSeq`). O índice esquece um perfil apagado (`name-index.js`, `forget`) e o semeador limpa o bloco, mas só depois de receber a lápide; até lá o peek ainda devolve a versão apagada. Por isso uma resposta vazia com @nome não entra na fila do peek (comentário em `namesPeek.js`, `foldRead`).
- (b) `pickAvatar` deixar o descritor da linha vencer uma entrada vazia: `feed.read` aplica as lápides antes de `latestProfileOfCopies` (`packages/core/lib/feed.js`), mas as linhas de `peek.read`, os originais de republicação e citação (`thread.js`, `identity()`), Avisos e Busca vêm do mesmo peek, e uma linha antiga de A Rua guarda o descritor de antes da exclusão. Não é seguro.
- (c) adotada: nenhuma mudança em `names.js`, `namesCache.js` e `namesPeek.js` além de comentários que explicam o porquê (`settleProfile` e `foldRead`). Uma resposta vazia continua apagando nome, bio e foto no cache de nomes.

Testes:

- `namesCache.test.js`, "a blank profile.read answer clears the name, bio and photo shown: it may be a deleted profile": depois de `invalidate` (valores antigos como semente), de uma resposta anterior ou de uma semente da linha, a resposta vazia fica como veio e `pickAvatar` dá nula mesmo com descritor na linha. O teste "names.js settles a profile.read answer through settleProfile" confere que `names.js` não passa mais a entrada anterior.
- `namesPeek.test.js`, "a blank answer with an @nome is not queued for the peek, which may still read a deleted profile": a resposta vazia com @nome não entra na fila, nada é lido, e um peek em andamento não cai nela.
- `namesPeek.test.js`, "the entry names.js stores for a blank answer lets the peek fill it": a entrada que `names.js` guarda (`foldRead` e depois `settleProfile`, com a entrada anterior) recebe o peek de uma chave sem nome nem @nome; antes, o nome mantido bloqueava o peek.

### V2: foto que não desenha é carregada uma vez de novo

- `media/cache.js`: `forget(key, url)` tira a entrada só se ela ainda guarda essa URL, libera a URL e avisa os ouvintes de expulsão como uma expulsão; a chave não fica bloqueada (o próximo `get` carrega de novo).
- `media/keep.native.js`: `keep(..., { replace: true })` troca um arquivo guardado de mesmo nome. O `move` do expo-file-system não sobrescreve, então os bytes novos vão primeiro para o `.tmp`, o arquivo antigo vai para `<nome>.old`, o `.tmp` vai para o lugar e só então o `.old` é apagado. Se um passo falha, o antigo volta para o nome e a resposta é `null`; proteção e contagem do nome não mudam. Um `.old` que não se apagou sai na próxima limpeza; um `.old` sem arquivo no nome (o processo morreu entre os dois `move`) volta para o nome no próximo `trimKept`, que não o apaga pela idade na mesma passagem; se esse `move` falha, o `.old` fica para a limpeza seguinte. Num apagamento (expurgo ou tamanho errado), a proteção de arquivo em uso ou liberado há pouco só sai depois que o arquivo sumiu.
- `ui/Avatar.js`: no `onError` de uma URL vinda do cache, `avatarErrorStep` decide: o primeiro erro de cada chave por montagem recarrega; o segundo deixa as iniciais. Se o cache guarda outra URL para a chave, outra linha já recarregou: ela é desenhada sem busca. Se guarda a mesma URL, ou nada (o cache foi limpo ou expulsou a entrada), a entrada sai e a carga seguinte não lê a cópia guardada: busca com `fresh`, confere hash, tamanho, formato e 512x512, e guarda com `replace`. Uma busca que falha não apaga nada; a escada de novas tentativas continua sem ler a cópia guardada. O resultado é desenhado num `Image` novo (contador na `key`, porque a cópia trocada tem o mesmo URI). Enquanto a recarga está pendente, a URL que falhou não é desenhada da memória (outra montagem pode tê-la lido de novo da cópia guardada): ela sai e a carga segue sem a cópia guardada. Até o fim da execução, cada chave lembra a URL em que a última recarga terminou (até 256 chaves): um erro nessa URL, nesta linha ou em outra que ainda desenhava os bytes antigos, só desenha de novo, sem `forget` e sem busca, então uma foto que o decodificador sempre recusa custa uma busca por execução. Outra URL da chave recarrega. Foto local, foto privada e modo só guardado continuam indo direto para as iniciais.
- `MediaView.js` não usa o caminho de `onError` do avatar e não mudou.

Testes:

- `mediaCache.test.js`, "forget lets go of the URL a key still holds...": outra URL ou chave não sai; a certa sai, é liberada e avisada uma vez; o próximo `get` carrega de novo.
- `mediaKeep.test.js`: "keep with replace swaps a kept file for new bytes under the same name"; "a replace that cannot move the old file aside, or write the new one, leaves the old file protected" (o arquivo antigo de 40 dias resiste ao `trimKept`); "a replace whose move into place fails puts the old file back, protected and counted" (com o armazenamento no teto, o arquivo continua na contagem); "a .old left by a replace is moved back when its name is empty, deleted otherwise"; "trim keeps a .old it cannot move back, and does not age out the file it restores" (cópia de 40 dias); "a purge whose delete fails keeps the file protected" (em uso e na carência depois de liberado); "releaseKept ignores every URI that is not exactly a kept file" (`..`, `./`, `//`, `.tmp`, `?`, `#`, outro diretório, maiúsculas, outros esquemas).
- `mediaAvatar.test.js`: "avatarErrorStep reloads a cached URL once per key, then breaks"; "Avatar reloads a photo that does not render once, on a new Image, then leaves the initials"; "Avatar reloads a kept photo that does not render around the kept store and replaces it"; "Avatar: a kept photo that fails after the cache was cleared is fetched, not drawn again"; "Avatar: a key reloaded once is let go of again when another URL of it fails while held"; "Avatar: a photo the decoder always refuses is fetched once per run, not once per mount"; "Avatar: a reload whose fetch fails leaves the kept file in place and protected"; "Avatar: during a pending reload the failed URI put back in memory is not drawn"; "Avatar: another row still drawing a replaced kept file draws the repaired file with no fetch"; "Avatar breaks at once for a kept-only or private photo that does not render".
- `mediaKeptLoad.test.js`: a conferência de texto do modo só guardado espera `if (keptOnly) return { url: kept, key: keptKey, reload: null }`.

Removidos do commit 20c24d0af, porque fixavam o apagamento antes da busca: os três testes de `dropKept` (o de caminhos virou o teste de `releaseKept` acima, que ainda usa a mesma validação), "Avatar reloads around the kept store when the failed kept file could not be deleted" e "Avatar: another row showing a kept file whose delete failed tries the delete again" (trocados pelos testes de substituição e de outra linha). `dropKept`, `letGo` e `unkept` saíram do código. O `keep` falso dos testes do avatar agora é síncrono e devolve o mesmo URI do arquivo guardado, como o real: os testes de recarga conferem o mesmo URI num `Image` novo, e o primeiro teste do arquivo espera o URI guardado em vez de `blob:`.

### Falha sem a correção

Primeiro desenho: os testes rodaram contra cópias de `apps/app/src` do commit ff68cd505, com os arquivos restaurados depois:

| Teste | Falha em ff68cd505 |
|---|---|
| `namesCache.test.js`, resposta vazia que pode ser perfil apagado | nome, bio e foto anteriores voltam |
| `namesCache.test.js`, `names.js` chama `settleProfile` | `names.js` passa a entrada anterior |
| `namesPeek.test.js`, resposta vazia com @nome fora da fila | a chave entra na fila e o peek cai nela |
| `namesPeek.test.js`, a entrada guardada recebe o peek | o nome mantido bloqueia o peek |

Segundo desenho (apagar antes de buscar): `ui/Avatar.js` e `media/keep.native.js` do commit 20c24d0af postos no lugar, um de cada vez, e restaurados depois:

| Teste | Falha em 20c24d0af |
|---|---|
| `mediaAvatar.test.js`, cache limpo antes do `onError` | o mesmo arquivo guardado é desenhado de novo, sem busca |
| `mediaAvatar.test.js`, chave já recarregada com outra URL que falha | a URL não sai do cache e é desenhada de novo, sem busca |
| `mediaAvatar.test.js`, busca da recarga que falha | o arquivo guardado foi apagado antes da busca e some da abertura seguinte |
| `mediaAvatar.test.js`, recarga de cópia guardada e outra linha | o arquivo guardado é apagado; a recarga lê o armazenamento de novo |
| `mediaKeep.test.js`, `replace` troca o arquivo | os bytes antigos ficam |
| `mediaKeep.test.js`, `replace` que não apaga ou não escreve | responde o URI antigo em vez de `null` |
| `mediaKeep.test.js`, expurgo cujo apagamento falha | a proteção sai antes e `trimKept` apaga o arquivo |

Terceiro desenho: `ui/Avatar.js` e `media/keep.native.js` da rodada anterior (apagar o antigo antes do `move`, sem memória da recarga) postos no lugar e restaurados depois:

| Teste | Falha na rodada anterior |
|---|---|
| `mediaKeep.test.js`, `move` para o lugar que falha | os dois arquivos somem (o teste também falha em 20c24d0af, que não troca nada) |
| `mediaKeep.test.js`, `.old` que sobrou | não há `.old`; um `.old` sem arquivo no nome não volta |
| `mediaKeep.test.js`, `move` do antigo que falha | o antigo é apagado e trocado |
| `mediaAvatar.test.js`, foto que o decodificador sempre recusa | a segunda montagem busca e regrava de novo |
| `mediaAvatar.test.js`, URL que falhou de volta na memória | a nova tentativa desenha o arquivo quebrado, sem busca |
| `mediaAvatar.test.js`, outra linha com o arquivo já trocado | ela faz `forget` do arquivo bom e busca de novo |

Quarta rodada: `media/keep.native.js` da rodada anterior posto no lugar e restaurado depois:

| Teste | Falha na rodada anterior |
|---|---|
| `mediaKeep.test.js`, `.old` que não volta para o nome | o `.old`, única cópia, é apagado; com só a guarda da volta, o arquivo de 40 dias que voltou é apagado pela idade |

Rodados com `node`, todos passando: `mediaAvatar`, `mediaCache`, `mediaKeep`, `mediaKeptLoad`, `mediaFetch`, `localCaches`, `feedRender`, `profileBar`, `ruaSnapshot`, `platformGate`, `uiKit`, `escapeLayer`, `group-flow`, `mediaCrop`, `nodeHandle` e `apps/cli/test/changelog.test.js`. Na rodada anterior também `namesCache`, `namesPeek`, `feedSeeds`, `diarioSnapshot`, `feedPreviews`, `postShareRow` e `threadRows`. `npx standard` nos arquivos mudados sem erro.

## Pendências

- O relato não se reproduziu na Vitrine; falta conferir a correção num aparelho.
- V1a continua aberto: uma resposta vazia de um diário parcial ainda tira a foto que a linha tem. Corrigir sem trazer de volta um perfil apagado exige que a resposta diga se o perfil foi apagado ou ainda não chegou (mudança de RPC, fora deste PR).
- A pista do diagnóstico sobre originais de republicação e citação depois de uma falha na busca do membro no índice (`ARua.js`, `memberMiss`, perto das linhas 745 a 830) não é um defeito confirmado: o peek de nomes normalmente preenche essas linhas. Falta uma captura com conta real.
