# Fotos de perfil que faltam em A Rua no Android: diagnóstico

Diagnóstico, sem correção. As edições de depuração descritas abaixo foram temporárias e já foram desfeitas; nada em `apps/app/src` mudou.

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
- `media/keep.native.js`: `dropKept(uri)` apaga um arquivo guardado, com a mesma validação de caminho de `releaseKept` (numa função só, `keptKeyOf`), tira o arquivo da contagem e responde se ele sumiu: `false` quando o apagamento falha ou o URI não bate com o arquivo, `true` quando não sobra arquivo guardado ou o URI nunca foi de um. `keep.web.js`: `dropKept` responde `true`.
- `ui/Avatar.js`: no `onError` de uma URL vinda do cache, `avatarErrorStep` decide: o primeiro erro de cada chave por montagem chama `forget` e `dropKept`, mostra as iniciais enquanto recarrega e desenha o resultado num `Image` novo (contador de recargas na `key`, porque a cópia guardada de novo tem o mesmo URI); o segundo erro deixa as iniciais. Se o arquivo guardado não sumiu, a chave entra em `unkept`: até o fim da execução ela é baixada e conferida sem passar pelo armazenamento guardado (nada é lido dele nem guardado), então o arquivo que falhou não é desenhado de novo; outro erro dessa chave, em qualquer linha, tenta apagar de novo, e a próxima abertura também. Só um apagamento que deu certo põe a chave em `letGo`, que impede outra linha de apagar a cópia nova. Foto local, foto privada e modo só guardado continuam indo direto para as iniciais.
- `MediaView.js` não usa o caminho de `onError` do avatar e não mudou.

Testes:

- `mediaCache.test.js`, "forget lets go of the URL a key still holds...": outra URL ou chave não sai; a certa sai, é liberada e avisada uma vez; o próximo `get` carrega de novo.
- `mediaKeep.test.js`, "dropKept deletes the one kept file of a URI and the tally counts it" (agora também confere o `true`). "dropKept says false while the kept file is still there": apagamento que falha dá `false` e o arquivo fica; uma nova tentativa apaga e dá `true`; URI que não é de arquivo guardado dá `true`. "dropKept never deletes anything outside the kept directories": `..`, `./`, `//`, `.tmp`, `?`, `#`, outro tipo de diretório, a raiz, o diretório temporário de mídia, Documents, caminho absoluto sem esquema, outros esquemas e maiúsculas não apagam nada; só o URI exato apaga. `keep.web` tem os mesmos nomes.
- `mediaAvatar.test.js`, "avatarErrorStep reloads a cached URL once per key, then breaks" e "Avatar reloads a photo that does not render once, on a new Image, then leaves the initials" (como antes). "Avatar reloads around the kept store when the failed kept file could not be deleted": com o apagamento falhando, a recarga busca com `fresh`, não pergunta de novo ao armazenamento guardado, não guarda nada e desenha outro URI; numa nova montagem o erro tenta apagar de novo. "Avatar: another row showing a kept file whose delete failed tries the delete again": duas linhas com o mesmo arquivo guardado; a segunda tenta apagar de novo mesmo com o cache já sem o URI. "Avatar breaks at once for a kept-only or private photo that does not render".
- `mediaKeptLoad.test.js`: a conferência de texto do modo só guardado espera `if (keptOnly) return { url: kept, key: keptKey, reload: null }`.

### Falha sem a correção

Os testes novos rodaram contra cópias de `apps/app/src` do commit ff68cd505 (o primeiro desenho), com os arquivos restaurados depois:

| Teste | Falha em ff68cd505 |
|---|---|
| `namesCache.test.js`, resposta vazia que pode ser perfil apagado | nome, bio e foto anteriores voltam |
| `namesCache.test.js`, `names.js` chama `settleProfile` | `names.js` passa a entrada anterior |
| `namesPeek.test.js`, resposta vazia com @nome fora da fila | a chave entra na fila e o peek cai nela |
| `namesPeek.test.js`, a entrada guardada recebe o peek | o nome mantido bloqueia o peek |
| `mediaAvatar.test.js`, recarga sem o armazenamento guardado | o mesmo arquivo guardado é desenhado de novo, sem busca |
| `mediaAvatar.test.js`, outra linha tenta apagar de novo | nenhuma nova tentativa |
| `mediaKeep.test.js`, `dropKept` responde se o arquivo sumiu | `dropKept` não responde nada |

Também conferido no código final: sem `persist: persist && !unkept.has(key)` falha "reloads around the kept store"; sem a nova tentativa de `unkept` falha "another row ... tries the delete again". Os testes do primeiro desenho para `cache.js`, `dropKept` (caminhos) e `avatarErrorStep` continuam valendo.

Rodados com `node`, todos passando: `namesCache`, `namesPeek`, `feedSeeds`, `mediaAvatar`, `mediaCache`, `mediaKeep`, `mediaFetch`, `mediaKeptLoad`, `localCaches`, `feedRender`, `profileBar`, `ruaSnapshot`, `platformGate`, `diarioSnapshot`, `escapeLayer`, `feedPreviews`, `group-flow`, `mediaCrop`, `nodeHandle`, `postShareRow`, `threadRows`, `uiKit`. `npx standard` nos arquivos mudados sem erro.

## Pendências

- O relato não se reproduziu na Vitrine; falta conferir a correção num aparelho.
- V1a continua aberto: uma resposta vazia de um diário parcial ainda tira a foto que a linha tem. Corrigir sem trazer de volta um perfil apagado exige que a resposta diga se o perfil foi apagado ou ainda não chegou (mudança de RPC, fora deste PR).
- A pista do diagnóstico sobre originais de republicação e citação depois de uma falha na busca do membro no índice (`ARua.js`, `memberMiss`, perto das linhas 745 a 830) não é um defeito confirmado: o peek de nomes normalmente preenche essas linhas. Falta uma captura com conta real.
