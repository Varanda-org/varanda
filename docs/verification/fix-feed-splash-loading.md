# Splash até A Rua estar inteira, também no celular (branch fix/feed-splash-loading)

No Android e no iOS, uma partida fria podia trocar o splash pela prévia d'A Rua guardada no aparelho (`ARuaPreview` em `apps/app/src/screens/ARua.js`, a partir da PR `perf: show A Rua's saved first page while the node boots`). A prévia não tem a faixa de Momentos. Quando A Rua de verdade assumia, a faixa aparecia no topo e empurrava as linhas para baixo. Na web e no PWA a prévia nunca rodou (`previewCapable` falso), então o splash já esperava as linhas e os Momentos (`ruaFeedReady` em `apps/app/src/splashGate.js`).

- `previewCapable` passa a ser falso também em `apps/app/src/feedSnapshotStore.native.js`. Essa bandeira só liga a prévia de `App.js` (`test/ruaSnapshot.test.js`): a leitura da prévia não roda, e o splash cobre a partida até `feedReady`, como na web.
- A Rua continua lendo e gravando a página guardada em todas as plataformas e a pinta primeiro, debaixo do splash. Por isso as linhas e os detalhes assentam logo e o splash espera só os Momentos.
- `ARuaPreview` e `previewAllowed` ficam no código, sem uso em tempo de execução. Para religar a prévia basta voltar a bandeira, mas antes a prévia precisa ganhar a faixa de Momentos.

Como verificar, a partir da raiz:

- `node apps/app/test/feedSnapshotStore.test.js`, `node apps/app/test/ruaSnapshot.test.js`, `node apps/app/test/splashGate.test.js`.
- `npm run lint`.

Caminhada, a fazer com uma conta hospedada que já abriu A Rua neste aparelho (há página guardada) e com Momentos de quem ela segue:

- [ ] Android: fechar o app de vez e abrir. O splash fica até A Rua aparecer com a faixa de Momentos já no topo. Nada pula nem pisca.
- [ ] iOS: o mesmo.
- [ ] Web e PWA: o mesmo, sem mudança contra antes.

Limites:

- Nenhuma caixa acima foi marcada nesta documentação; só os testes automatizados rodaram.
- A partida fria no celular mostra o splash por mais tempo do que a prévia mostrava, já que agora ele espera os Momentos.
- Na etapa final (`pronto`), o splash espera os detalhes e os Momentos por no máximo 5 s (`CONTENT_PATIENCE_MS`), contados do começo dessa etapa e iguais em todas as plataformas. Se os Momentos demorarem mais que isso, a faixa ainda aparece depois. Não há medida com nó vivo de quanto eles levam no Android (`docs/verification/docs-perf-m5.md`).
- Depois que A Rua aparece, um momento novo ou a permissão de publicar momento ainda podem fazer a faixa surgir. Isso já era assim.
