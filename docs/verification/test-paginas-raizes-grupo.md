# Busca dos grupos de uma Página pelo semeador, ponta a ponta (branch test/paginas-raizes-grupo)

Parte da issue #352, item do #441: "a busca do grupo pelo semeador no aparelho admin não tem teste". Só teste: nenhum código de produção muda.

Um aparelho administrador guarda as chaves de uma Página, mas não o diário dela. Quando a sessão do navegador termina a primeira passagem contínua, `refreshRemotePageRoots` (`packages/web-member/lib/session.js`) lê pelo semeador, com a espiada limitada (`peekPageRoots` sobre `diaryPeekWithin`), os grupos em que a Página entrou, e `restartForRoots` reinicia a passagem com essas raízes. Até aqui isso só tinha teste em partes: `page-groups-sync.test.js` (semeador real, mas a espiada e as raízes passadas à mão, sem sessão) e `session-groups.test.js` (a sessão com a sincronização falsa).

## O teste

`packages/web-member/test/page-group-roots-e2e.test.js`: uma sessão de verdade (`memberNode`, `test/helpers/dm-e2e.js`) e um semeador de verdade atrás de um WebSocket, na DHT local. Nem a sincronização nem a espiada são falsas, e o teste nunca chama `peekPageRoots` nem passa `pageRoots`.

- O aparelho N gera as chaves da Página P (`dm.pageGenerate`) e as adota (`dm.pageSecrets`) com uma passagem contínua rodando; o diário de P (certificado, roster com N como dono, dm-key e a entrada de P num grupo privado G) fica só em outro armazenamento e no semeador. O dono do grupo, O, cria G, admite P e publica.
- Antes da passagem com as raízes: `store.replicaExists(N, P)` é falso e N não tem nada da comunidade nem de G.
- A passagem seguinte acha as raízes pela espiada e reinicia sozinha: ela termina com `sync.stopped` `preempted` e a sucessora traz a comunidade (`groups.changed` da comunidade), sem nenhum pedido nem reinício do teste nessa espera.
- Depois a comunidade e G ficam guardados em N com o mesmo tamanho que em O, um segundo post em G chega numa passagem seguinte, e N nunca ganha escritor próprio em G.
- O teste só lê os núcleos guardados de N com a passagem parada: as réplicas de grupo não são instâncias compartilhadas (`openGroupReplica` em `node-store.js`), e um segundo Hypercore aberto no núcleo em que a passagem está baixando derruba os blocos dela. A primeira versão do teste lia durante a passagem e travava a comunidade no bloco 0 em cerca de 1 rodada em 3.
- `group.read` com `page` fica de fora: precisa das chaves de grupo da Página e da entrada selada.

## Conferido

- Com `missingPageRoots` respondendo sempre `false` (`session.js`), o teste falha na espera do `preempted` ("tempo esgotado: sync.stopped 3", cerca de 87 s no total). Com o arquivo restaurado (`git diff` vazio), passa.
- Dez rodadas seguidas, o arquivo sozinho (`node packages/web-member/test/page-group-roots-e2e.test.js`): 10 de 10 passam, 25 a 27 s cada, 14 asserções. A versão que lia os núcleos durante a passagem falhou em 10 de cerca de 20 rodadas nas mesmas condições.
- `npx standard` no arquivo.

## Limites

- O núcleo de G às vezes chega uma passagem depois do da comunidade, e um post novo só chega numa passagem que começa depois dele. A conferência guardada para a passagem, compara e, se faltar algo, reinicia e espera o núcleo mudar, até 5 vezes; por isso a prova da raiz é o `preempted` e a chegada da comunidade, antes de qualquer reinício do teste.
- O diário de P passa a ficar em N depois que G sincroniza (os diários dos membros de G são buscados), então `replicaExists` só é conferido antes.
