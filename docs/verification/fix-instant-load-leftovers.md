# Sobras do carregamento instantâneo no app (branch fix/instant-load-leftovers, fecha a #539)

A #539 junta os limites que os PRs #458 a #476 e #478 deixaram. Esta parte cuida do app e fecha a issue. As outras partes, cada uma no seu PR com "Parte da #539": a janela de deploy do service worker (`fix/sw-node-release-pair`), os blocos em voo da Espiadinha e dos Avisos, as páginas vazias e a medida com o semeador (`perf/peek-leftovers`), e o motor de conversas e o desbloqueio (`fix/dm-unlock-leftovers`).

## O que muda

- **Bloqueio feito em outro aparelho (#463).** Até a primeira resposta de `block.list`, as linhas guardadas de outras pessoas não aparecem. A Rua e a prévia no lugar do splash mostram as linhas próprias que não citam ninguém e até 3 marcadores no lugar das outras (`heldPlaceholders`, `apps/app/src/screens/ARua.js`). Quando a lista chega, as outras entram sem os bloqueados; se ela falhar, ficam só as próprias (falha fechada, como antes). O Diário segue a mesma regra para as republicações guardadas, e Membro só semeia depois da resposta (`membroSeedStep`). Decisão do dono do produto na #539: esconder as dos outros até a lista chegar.
- **Regra das linhas guardadas no Diário (#472).** A regra de bloqueio das linhas guardadas vale só para as seqs que vieram do instantâneo (`hiddenStoredSeqs`). Páginas mais antigas lidas ao vivo depois de uma leitura inicial que falhou não são mais filtradas por ela: o nó já aplicou a lista.
- **Apagar uma publicação própria republicada no próprio Diário (#472).** Só a seq da publicação apagada entra no conjunto de apagadas (`ownDeletedSeq`). Antes, a republicação própria também entrava, e o Diário deixava de guardar a primeira página pelo resto da sessão.
- **Troca de instalação com a mesma chave (#472).** Diário, Membro, as linhas de grupo de Conversas e Comunidades guardam a instalação, a associação e o dono das linhas semeadas (`sameSnapshotBinding`, `bindingKeyOf`, `seedsFor`). Se qualquer um muda, as linhas guardadas saem da tela na hora, e em Membro o cabeçalho guardado volta ao que veio da lista até o perfil ao vivo chegar.
- **Hash nativo em todo download de foto (#473).** Anúncio, mídia de conversa, cartão de link, encaminhamento e denúncia passam `mediaHashDeps()` ao `fetchMedia`, como A Rua. Um teste varre `apps/app/src` e falha se um download novo esquecer.
- **Foto guardada lida logo antes de uma poda (#462).** O cache de memória (`apps/app/src/media/cache.js`) conta as limpezas. Uma leitura que já rodava quando o cache foi limpo (sair, deixar de seguir, bloquear) pode ter devolvido o endereço de um arquivo que a poda acabou de apagar: ela não é guardada, o endereço é liberado e a leitura roda mais uma vez. Uma segunda limpeza no meio dá um erro com nova tentativa automática.
- **Tarefa de segundo plano sem nada a atualizar (#475).** Se `unregisterTaskAsync` falhou na limpeza, a própria tarefa, ao rodar sem configuração lembrada ou com um instantâneo de outra instalação, se desregistra e termina (`nothingToRefresh`). A seção LGPD de `docs/design.md` diz isso.
- **`project.pbxproj` (#475).** As duas linhas de `ExpoTaskManager_privacy.bundle` que o `pod install` acrescenta à fase de cópia foram commitadas. Decisão do dono do produto na #539.
- `docs/verification.md`: as linhas de limite das seções 156, 157, 166, 167 e 169 que esta branch resolve foram atualizadas no lugar.

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>`) nesta branch e, com os mesmos testes, sobre as fontes de `apps/app/src` e `apps/app/ios` da `main` (`git checkout` das fontes, testes desta branch).

| Arquivo | Branch | Fontes da `main` |
|---|---|---|
| `mediaHash.test.js` | 7/7, 35/35 | 6/7, 30/35 |
| `backgroundRefresh.test.js` | 21/21, 116/116 | quebra (`nothingToRefresh is not a function`) |
| `backgroundTask.test.js` | 16/16, 83/83 | 14/16 (desregistro e linhas do `pbxproj`) |
| `mediaCache.test.js` | 28/28, 174/174 | 26/28, 166/174 |
| `snapshotSafety.test.js` | 14/14, 89/89 | 1 falha, depois quebra (`heldPlaceholders`) |
| `diarioSnapshot.test.js` | 20/20, 110/110 | 1 falha, depois quebra (`stored`) |
| `gruposSnapshot.test.js` | 13/13, 68/68 | quebra (`seedsFor`) |
| `membroSnapshot.test.js` | 8/8, 66/66 | quebra (`membroSeedStep`) |

O terceiro teste novo de `mediaCache.test.js` (uma leitura ainda na fila quando o cache é limpo roda uma vez só) passa nas duas: ele guarda que a correção não busca duas vezes sem motivo.

Também passam, sem mudança: `mediaKeptLoad`, `mediaKeep`, `localCaches`, `mediaAvatar`, `chatMedia` e `platformGate`.

## Conferência em aparelho

PENDENTE

## Caixas das seções 152 a 170 de `docs/verification.md`

Nenhuma caixa foi marcada. As caminhadas dessas seções pedem uma conta em produção, e o build de debug não entra com passkey em produção; o modo Vitrine não usa instantâneos. Ficam na lista de conferências pós-deploy da #224, com as medidas no celular e no Chrome com CPU 4x:

| Seção | Caixas | O que esta branch muda nelas |
|---|---|---|
| 152 a 155 | 5, 5, 3, 2 | nada |
| 156 (fotos guardadas) | 8 | a caixa de deixar de seguir também confere que nenhuma foto apagada fica quebrada na tela |
| 157 e 158 (A Rua e prévia) | 7, 8 | a caixa "bloquear um autor e reabrir" vale também para o bloqueio feito em outro aparelho, com marcadores até a lista chegar |
| 159 a 165 | 2, 4, 5, 2, 3, 5, 3 | nada (160, 161 e 164 dependem das outras partes) |
| 166 (Diário, Membro, grupos) | 7 | trocar de instalação tira as linhas guardadas da tela |
| 167 (hash nativo) | 4 | anúncios e conversas agora no hash nativo |
| 168 | 2 | nada |
| 169 (tarefa de segundo plano) | 12 | a caixa de sair também confere que a tarefa some mesmo se o desregistro falhar |
| 170 (rodada M4) | 4 | medidas no celular e no Chrome, na #224 |

## Limites

- O texto de privacidade da tarefa de segundo plano em `docs/design.md` continua dependendo de parecer jurídico, registrado na #44.
- Os marcadores de A Rua e da prévia são no máximo 3, mesmo quando a página guardada tem mais linhas de outras pessoas esperando.
