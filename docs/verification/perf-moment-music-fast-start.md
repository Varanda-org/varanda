# Verificação: música do momento começa mais rápido

Branch `perf/moment-music-fast-start`. Entrada do changelog em `docs/changelog/perf-moment-music-fast-start.md`.

## Testes automatizados

Rodar a partir da raiz, um arquivo por vez:

- `node apps/cli/test/audius-routes.test.js`: reabertura direta da URL de armazenamento (com `Range`, sem chave, queda para o caminho normal, expiração, endereço não público, tempo de conexão, mesmo gasto de abertura e de orçamento) e troca de relé no teto por membro (uma abertura ainda esperando o provedor nunca é trocada).
- `node apps/cli/test/stream-fetch.test.js`: agente keep-alive compartilhado, corpo de redirecionamento drenado, nova tentativa única após reset em socket reaproveitado, corpo cheio que espera o fim do upstream.
- `node apps/app/test/streamPlayer.test.js`: confirmação do seek a cada 50 ms.
- `node apps/app/test/momentosScreen.test.js`: o visualizador abre o áudio do próximo momento depois que o atual começou, foi dado como indisponível ou não tem música, e só adianta item e ticket depois que apenas o prazo de 3 s terminou.
- `node apps/app/test/momentMusic.test.js`.
- `node apps/cli/test/audius-server.test.js`.

Resultado: todos passam no Node 24 (lint, `npm test -- --affected` e `npm run demo` no PR). Cada correção foi conferida removendo-a e vendo o teste falhar.

## Verificação manual no aparelho

Todas pendentes (não executado):

- Tempo entre o momento aparecer e o som começar, antes e depois da mudança, no build de debug do Android, no simulador iOS e na web (não executado).
- Cadeia de momentos com música: o trecho atual toca até o fim enquanto o próximo é pré-carregado, sem corte quando a retransmissão do próximo abre (não executado).
- Seek além do zero começa no segundo certo (não executado).
- Serviço de conta antigo: o 503 no teto por membro cai para o tempo da foto, sem erro nem queda do app (não executado).
