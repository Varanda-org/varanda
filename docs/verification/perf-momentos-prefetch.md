# Momentos rápidos de um para o outro (branch perf/momentos-prefetch)

Esta verificação ainda não foi executada. Os itens abaixo são o roteiro; marque cada um só depois de rodá-lo e anote o que viu.

Aparelhos: web (Chrome com a rede limitada), build de debug do Android e simulador iOS, com um nó hospedado e uma pessoa seguida com 4 ou mais momentos de foto.

## Resultados

- [ ] Anel de 4 ou mais momentos, rede limitada: a partir do segundo momento não aparece o indicador de carregamento, e voltar ao anterior é instantâneo.
- [ ] Primeiro toque na faixa de A Rua depois de o app ficar parado (mais de 3 s em A Rua): a foto abre rápido.
- [ ] Nativo: bloquear com o visualizador aberto e conferir que `varanda/media-read` está vazio.
- [ ] Um momento apagado pela autora ou pelo autor deixa de aparecer em até 5 minutos.
- [ ] Visualizador com a música silenciada: nenhum pedido de música no painel de rede.
- [ ] Música ligada: o trecho do próximo momento começa mais cedo, e nunca há mais de dois players abertos.
- [ ] Web, com os pedidos `/blob/` travados (DevTools, bloqueio ou rede offline depois do cabeçalho): passar por vários momentos não acumula pedidos de leitura adiantada, cada GET termina em até 30 s e a foto volta a abrir quando a rede volta.
- [ ] Tempo até a foto dos itens 1 a 4 do anel, antes e depois da mudança (anotar os dois números por plataforma).
