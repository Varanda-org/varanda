# Sobras de Páginas: chaves no app (branch fix/paginas-app-chaves)

Parte da #352. Só o app muda (`apps/app`). Não muda formato, RPC nem Termos: o app passa a usar `dm.pageForget`, `dm.pageLegacyBlocks` e o evento `dm.pageKeyMismatch`, que já existiam (`docs/rpc.md` 5.114).

- **`dm.pageForget` depois de encerrar.** `PaginaAjustes.js` chama `pagesDmForget` (`apps/app/src/pages.js`) quando o encerramento termina. Mudar de chave não esquece nada: as conversas da chave antiga ficam.
- **`dm.pageForget` depois de perder o papel.** As telas Páginas e Publicar leem a lista por `pagesList` (`pages.js`). Uma resposta mais nova que a última aplicada para a mesma pessoa e a mesma origem de conta esquece as chaves de uma Página encerrada (uma que mudou de chave não conta: o serviço marca a chave antiga como encerrada, com `movedTo`) e de uma que a resposta anterior, a Página em que a pessoa age ou as Páginas que o nó marcou com `dm.pageKeyMismatch` citavam e esta não cita mais (`pagesNoLongerRun`, `apps/app/src/pageSecrets.js`). Cada Página é tentada uma vez por sessão. Uma leitura que falhou, uma resposta malformada ou uma resposta mais antiga que chega depois não esquece nada.
- **Só o que o nó guarda.** `pagesDmForget` pergunta antes por `dm.pageLegacyBlocks`, que só responde enquanto o nó guarda as chaves da Página: uma Página que o aparelho nunca guardou não grava nada. No nó core (sem Conversas) não chama nada.
- **Aviso de chave diferente ao abrir.** `node.js` guarda as Páginas que o nó marcou com `dm.pageKeyMismatch` nesta conexão e neste desbloqueio. As Conversas da Página (`PageInboxNote`, `Mensagens.js`) mostram o aviso logo ao abrir, com "ler a chave de novo", que guarda a cópia da chave mesmo que a sessão já a tenha guardado. Na conversa (`Mensagem.js`) o aviso é uma linha que não bloqueia: a marca pode estar velha até o próximo pull, e um envio recusado já mostra o bloqueio. A marca sai quando a chave é guardada de novo, quando um envio como Página dá certo, numa nova conexão e ao bloquear.
- **Avisos vazios.** O texto de Avisos vazios da Página (`notices.js`) cita curtidas e republicações, que os Avisos da Página já mostram (`notices/3`).

Como verificar, a partir da raiz:

- `node apps/app/test/pages.test.js`: "pagesDmForget asks the node only for a page whose keys it holds, never on a core node, and never throws" falha sem a pergunta por `dm.pageLegacyBlocks`. "pagesList forgets, once, the keys of a page the newest list no longer shows; a failed or older answer forgets nothing" falha sem a comparação de ordem das respostas e sem a origem da conta na memória da última resposta.
- `node apps/app/test/pageSecrets.test.js`: "mismatch notes..." e "pagesNoLongerRun: closed pages..." cobrem as funções puras. O segundo falha se uma Página que mudou de chave (o serviço manda a chave antiga com `closed: true` e `movedTo`) contar como encerrada.
- `node apps/app/test/notices.test.js`: o texto de Avisos vazios.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no aparelho (Android primeiro, depois iOS, depois web), ainda não feita:

- [ ] Encerrar uma Página com Conversas ativas: Mensagens não mostra mais a caixa dela neste aparelho.
- [ ] Mudar a chave de uma Página com Conversas e abrir Páginas de novo: as conversas da chave antiga continuam no aparelho.
- [ ] Num segundo aparelho, admin removido pelo dono: ao abrir Páginas, a Página some e a caixa dela também.
- [ ] Depois que o dono muda a chave de mensagens num aparelho, abrir as Conversas da Página no outro: o aviso aparece antes de qualquer envio; "ler a chave de novo" guarda a chave nova e o aviso some.
- [ ] Avisos de uma Página sem nenhum aviso: o texto cita curtidas e republicações.

Limites:

- Um papel perdido com o app fechado só é notado quando Páginas ou Publicar leem a lista depois que um pull marcou a Página, ou quando ela é a Página em que a pessoa age. Remover um admin de Página com Conversas troca a chave de mensagens, então o pull marca a Página; sem essa marca, as chaves ficam no aparelho.
- Uma Página encerrada some dos outros aparelhos da pessoa na próxima leitura da lista em cada um.
- O nó core não tem Conversas: nada a esquecer lá até a paridade do nó core (outro PR da #352).
