# Linhas estáveis nas demais listas e relógio de minuto pausado (branch perf/list-rows)

Este arquivo confere o PR4 da rodada de desempenho: Espiadinha, Diário, Busca, Conversa, Membro e Mensagem passam a ter linhas estáveis (tratadores e `extraData` que não mudam a cada renderização da tela), e `useVisibleNow(60000)` (`src/ui/index.js`, `src/visibleNow.js`) pausa o relógio de minuto enquanto a tela está escondida. Ambiente: o da seção 252, de `docs/verification/perf-render-isolation.md` e de `docs/verification/perf-row-mount.md` (emulador Android `varanda-perf` sem janela, Vitrine grande e rica, sem nó). Antes é o PR3 (`docs/verification/perf-row-mount.md`, logs de T10 no mesmo emulador); depois é esta árvore, com as mudanças ainda sem commit.

```sh
# a partir de apps/app, Metro novo por célula
EXPO_PUBLIC_VARANDA_VITRINE=1 EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1 EXPO_PUBLIC_VARANDA_PERF=1 EXPO_PUBLIC_VARANDA_VITRINE_RICH=1 [EXPO_PUBLIC_VARANDA_PERF_SCROLL=rua] npx expo start --port 8097 --clear
# idle e teclado: toques de adb nas abas, contagem das linhas "perf: render" do logcat por janela de horário
```

Rolagem roteirizada de A Rua, Android rico, mediana de 3 execuções. Atenção à carga: antes 17 a 22, depois 10 a 12 (a máquina estava mais livre), então milissegundos e quadros não se comparam com o antes; só as contagens.

| Medida | Antes (254) | Depois | Leitura |
|---|---|---|---|
| `tab:rua`, renderizações / ms | 817 / 9363 | 980 / 6625 | contagem maior com mais quadros (3109 contra 2192), carga diferente: sem conclusão |
| renderizações por linha montada | 1 | 1 | igual |
| abas escondidas somadas, renderizações / ms | 82 / 77 | 80 / 49 | igual / dentro da carga |
| `tab:espiadinha` / `list:espiadinha` | 15 / 4 | 13 / 4 | -2 / igual |
| `tab:diario` / `list:diario` | 15 / 6 | 15 / 6 | igual |
| `tab:busca`, `list:conversas` | 11, 6 | 11, 6 | igual |
| quadros p95 | 64,8 | 38,0 | carga diferente, não se afirma ganho |

Parado e em uso, 60 s por tela (uma execução; sem linha de base, porque a seção 252, `docs/verification/perf-render-isolation.md` e `docs/verification/perf-row-mount.md` não mediram estas telas):

| Tela | renderizações / ms em 60 s |
|---|---|
| A Rua parada (abas escondidas 2 a 4 cada) | `list:rua` 5 / 100 |
| Espiadinha parada | `list:espiadinha` 12 / 148 |
| Busca parada | `tab:busca` 1 / 5 |
| Diário parado (inclui carga inicial) | `list:diario` 18 / 463 |
| Conversa (thread) parada | `list:conversa` 8 / 36 |
| Conversa, teclado aberto | `list:conversa` 2 / 31 |
| Membro parado | `list:membro` 12 / 313 |
| Mensagem parada | `list:mensagem` 10 / 193 |
| Mensagem, 8 caracteres digitados com teclado aberto | `list:mensagem` 11 / 59 |
| Mensagem, 10 caracteres a mais | `list:mensagem` 15 ou mais / 42 |
| Rolagem Espiadinha (4 linhas) | `list:espiadinha` 49 / 76, p95 de quadro 20,9 |
| Rolagem Diário | `list:diario` 136 / 642, p95 49,6, 69 quadros acima de 32 ms, renderizações por linha 1 (P95 3) |

A Rua escondida atrás de uma tela empilhada (Conversa, Membro, Mensagem) ainda renderiza 4 a 5 vezes por minuto (cerca de 100 ms); `ARua.js` não faz parte deste PR.

## À mão

Android (emulador, Vitrine rica, Metro 8097), com captura de tela:

- [x] Espiadinha: curtir uma linha marca só aquela linha (Tomás Ferreira, contagem 1); seguir Bia Araújo tira a linha dela e mantém a de Tomás.
- [x] Busca, aba Publicações, busca "cafe": curtir marca a linha certa (João Nascimento, "descurtir", 1).
- [x] Conversa (thread) abre de uma publicação; a Vitrine não tem nó, diz "Esta conversa não está disponível" e o campo de resposta abre o teclado.
- [x] Membro (João) abre pelo cabeçalho e Mensagem abre pelo botão "Mensagem", com a conversa da Feira da Vitrine.
- [x] Mensagem: digitar no campo de texto mostra o texto e o botão de enviar.
- [ ] Não verificado: denunciar, reação, apagar e bloquear na thread, prévia de resposta, Diário apagar e republicar, enviar, reagir, deslizar para responder, pular com destaque e abrir mídia no chat. Motivo: sem nó a Vitrine não executa essas ações (as folhas abrem, o resultado não se confere) e o orçamento da rodada acabou.
- [ ] Não verificado: se uma linha de mensagem renderiza ao digitar. O `Profiler` de `list:mensagem` cobre a lista inteira e dá cerca de 1,5 commits por caractere a 2,8 ms cada, o que não separa linhas de rodapé da lista (as sugestões de resposta); o contador de linhas só existe em `PostRow`. Fica como leitura aberta, sem prova de que linha alguma renderiza.
- iOS: não medido nem conferido à mão (orçamento esgotado; o simulador não rodou nenhuma célula desta rodada).

## Não medido

- iOS e web nesta rodada; Android com players; nó vivo, PWA, release e aparelho de verdade (lista da seção 252).
- Antes das telas parada, thread, Membro, Mensagem e teclado: sem linha de base (nenhuma seção anterior as mediu e não se troca de branch para obter uma).

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar. A demo termina com `DEMO OK`.
