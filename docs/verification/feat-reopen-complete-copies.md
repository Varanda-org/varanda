# feat/reopen-complete-copies

Na reabertura, A Rua, o Diário, as Conversas e os Avisos pintam nomes, fotos e originais citados a partir do aparelho. A lista de bloqueio deixa de segurar as linhas salvas de outras pessoas. Termos versão 115. O apagamento das listas no Sair vem de #978, já na `main`.

## Comandos

No pouso rodam `npm run lint`, os testes direcionados sobre o diff do PR (cada arquivo de teste alterado, cada arquivo de teste que importa ou lê por caminho um arquivo de `git diff --name-only origin/main...HEAD` e os testes de `apps/app` que varrem `src`, cada um com `node <arquivo>`) e `npm run demo`. A suíte inteira roda no GitHub CI (Node 20 e 24). Nenhum `npm test` local.

Resultados (2026-11-27, Node 24): `npm run lint` sem erros; 204 arquivos de teste direcionados passaram (160 de `apps/app`, 22 deles porque varrem `src`; 33 de `apps/cli`; 9 de `packages/core`; 1 de `apps/site`; 1 de `packages/web-member`); `npm run demo` terminou com DEMO OK.

O diff não toca `apps/app/ios/`, `apps/app/android/`, `apps/app/assets/worklet/`, `dist/`, `*.bundle` nem `apps/app/public/varanda-node.js` (conferido na entrega).

## O que pinta do aparelho na reabertura

| Tela | Pinta do aparelho | Ainda espera a rede |
|---|---|---|
| A Rua | Linhas, nomes, fotos de perfil, fotos das publicações, originais citados, respondidos ou repostados (inclusive de quem não se segue). Linhas de outras pessoas aparecem sem esperar a lista de bloqueio. | Publicações novas, contadores e a conferência da lista de bloqueio. |
| Diário | Publicações, nomes, fotos e reposts guardados de quem não se segue. A limpeza só tira quem está bloqueado. | Publicações novas e a lista atual. |
| Membro | Página de quem se segue, com reposts e citações de quem não se segue, nomes e fotos. A página de quem só se visita nunca é guardada. | Posts novos e qualquer página visitada. |
| Conversas | Linhas, nomes, @nome, fotos de perfil, imagens de grupos públicos e a foto dos grupos privados, guardada decifrada. | Verificação ao vivo dos nomes e a foto privada atual. |
| Avisos | Linhas com nome, @nome e foto de perfil. | Avisos novos. |
| Refresh em segundo plano (nativo) | Salva a cópia de A Rua com até 6 pessoas que você não segue lidas por `diary.peek`. | A leitura em si, enquanto houver tempo no prazo. |
| PWA (web) | Fotos de quem se segue vêm do navegador (`varanda-kept-photos`, 64 MiB, 2000 arquivos, 30 dias), mais as listas de bloqueio e de silêncio. | Fotos de quem não se segue além da cópia (8 MiB, 200 arquivos, 14 dias). |

## Limites conhecidos

- Conversas: o `verifiedAt` de um nome é aproximado. Um nome salvo estável mantém o carimbo antigo e, passados 14 dias, cai por uma reabertura (conservador).
- Web: se o IndexedDB falhar ao apagar no Sair, as fotos guardadas continuam lá até a próxima limpeza, como no armazenamento da Espiadinha. Só a mesma pessoa, entrando de novo, as lê.
- Telas que salvam a cópia fora de A Rua e do Diário gravam com a lista mostrada (guardada ou ao vivo). O conteúdo é o mesmo que a cópia anterior já mostrava.
- A leitura de desconhecidos no refresh em segundo plano mantém uma sincronização aberta por alguns segundos, que também sincroniza grupos.
- Uma foto de grupo privado guardada logo depois de um salvamento antigo pode ser apagada uma vez e volta na abertura seguinte.
- Uma cópia antiga do Diário, do Membro ou das Conversas a poucos bytes do limite do arquivo pode ser apagada uma vez ao ganhar o campo de nomes. Volta no próximo salvamento.
- Membro: na reabertura, uma citação de alguém bloqueado fica fora até a página ao vivo.
- A foto de um grupo privado decifrada antes da lista de bloqueio desta abertura só é guardada na próxima vez que a linha aparece.
- Web: depois de Sair ou Recomeçar, o pedido para o service worker apagar as listas se repete a cada abertura até as duas listas da nova sessão chegarem a ele. Um bloqueio ou silêncio feito antes da primeira leitura completa da lista só chega ao worker na leitura seguinte.
- Fotos de grupos privados só vêm das linhas de Conversas, nunca de outro lugar. Chave, nonce e núcleo ficam no nó.
- Refresh em segundo plano só no app nativo (a web não tem tarefa de fundo) e no máximo 6 pessoas desconhecidas por passagem. Uma falha de leitura pula aquela pessoa, sem nova tentativa.
- O refresh em segundo plano guarda só os originais de reposts que já estavam na cópia e os que leu de desconhecidos. Uma citação ou resposta de quem se segue, e o nível seguinte dentro de um original, aparecem sem o original até a página ao vivo, como antes.
- Se `block.list` falha, só as linhas da própria pessoa aparecem, como hoje.
- Membro: a página que só se visita continua sem cópia.
- A foto de quem não se segue só é guardada depois que a lista de bloqueio e a de seguidos desta abertura são conhecidas. Uma foto mostrada antes disso não é guardada nesta abertura. Um bloqueio feito em outro aparelho vale quando a lista desta abertura chega.

## Conferência no aparelho (não feita)

Android, iOS e PWA, depois de uma abertura normal e de fechar o app por completo.

- [ ] 1. Reabrir em modo avião A Rua, o Diário, as Conversas e os Avisos mostra nomes, fotos de perfil, originais e fotos.
- [ ] 2. Com uma pessoa bloqueada, as linhas das outras aparecem de uma vez e a prévia não pisca.
- [ ] 3. Um bloqueio feito em um segundo aparelho some no primeiro na primeira atualização.
- [ ] 4. Depois de Sair, não sobra lista, cópia nem foto de cópia.
- [ ] 5. Nada novo é gravado antes de aceitar os novos Termos.
- [ ] 6. Reabrir em modo avião o Membro de alguém que se segue mostra os reposts e citações de desconhecidos, e as Conversas mostram a foto dos grupos privados.
- [ ] 7. No PWA, sem rede, as fotos de quem se segue vêm do armazenamento do navegador.
- [ ] 8. No Android e no iOS, depois de um refresh em segundo plano com um desconhecido citado em A Rua, a próxima abertura em modo avião mostra a citação.
