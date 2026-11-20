# Fotos e Varandinha voltam depois de uma atualização (PR fix/media-retry-after-restart)

Os testes cobrem a regra: `apps/app/test/mediaFetch.test.js` (502 e 504 da própria origem são tentados de novo, de outra origem não, 500 e 501 não), `apps/app/test/mediaCache.test.js` (a escada de 2, 5, 15, 30 e 60 s) e `apps/app/test/garden.test.js` (`reloadDelay`, `wantsReload` e a ligação na tela). O que só o app de verdade mostra está abaixo. Num servidor em modo pull, `sudo /opt/varanda-release/current/update.sh apply` com uma versão nova reinicia o semeador; o log `"event":"ready"` dele mostra quanto a partida levou (cerca de 70 s em 2026-11-17).

- [ ] 1. Web: abra a aba Pessoas (fotos de perfil de quem você não segue) e aplique a atualização no servidor. Abra outra lista de pessoas durante a janela. Esperado: as fotos mostram as iniciais por um tempo e aparecem sozinhas em até dois minutos, sem reabrir a tela.
- [ ] 2. Web: uma publicação com foto que ainda não está no aparelho, aberta durante a janela. Esperado: "foto indisponível" some sozinho quando o semeador volta.
- [ ] 3. Web, num segundo aparelho da mesma passkey: abra a própria Varandinha durante a janela. Esperado: o erro "Sem conexão com o servidor agora" aparece e a varanda volta sozinha, com os vasos, depois que o semeador volta.
- [ ] 4. A varanda de um vizinho aberta logo depois da atualização, enquanto o índice ainda se monta. Esperado: "A varanda ainda está sendo montada" some sozinho quando o índice termina.
- [ ] 5. Android (debug) e iOS (simulador), com a instalação hospedada: repita os itens 1 e 3.
