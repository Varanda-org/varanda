# Conferência de palavras: números colados e prévia de link (branch fix/conferencia-palavras-sobras)

Dois limites da seção 138 de `docs/verification.md` (issue #449). Não muda protocolo, semeador nem RPC. Texto de prévia e @nome continuam só no aparelho: nada é pedido, contado nem registrado.

- Números colados: `findTerm` (`apps/app/src/wordCheck.js`) lê o texto como antes e, se nada casou, lê de novo com os números do começo e do fim de cada palavra tirados. `termo123`, `2termo` e `007termo99` casam com `termo`; `termo1x` e `t1ermo` não, porque o número fica no meio. Uma palavra só de números continua separando as palavras ao redor.
- Prévia de link: `previewRefusal` confere o título e a descrição do cartão do rascunho. Em Publicar, o envio de publicação (também resposta e citação) recusa com a mensagem da prévia, e o rascunho fica. Em grupo, só um grupo sabidamente público confere; privado e visibilidade desconhecida não. Mensagens diretas seguem fora.

Como verificar, a partir da raiz:

- `node apps/app/test/wordCheck.test.js` (20 testes; antes 17). Sem a segunda leitura, os testes "an @nome is read word by word" e "digits glued to the start or end of a word" falham.
- `npm run lint`.

Caminhada, a fazer no celular (build de debug do Android e simulador iOS) e depois na web e no PWA, com um link cuja página tenha um termo da lista no título ou na descrição (um site de teste seu):

- [ ] Publicar: colar o link, esperar o cartão aparecer e tocar em Publicar. Aparece a recusa da prévia, o rascunho continua e nada entra na fila. Tocar no X do cartão e publicar funciona.
- [ ] Grupo público: a mesma recusa acima da caixa. Grupo privado: o mesmo link é enviado com o cartão.
- [ ] Escrever `termo123` (com um termo da lista no lugar de `termo`) numa publicação: recusado. `termo1x`: publica.
- [ ] Mensagem direta com o mesmo link: enviada com o cartão.

Limites:

- Nenhuma caixa acima foi marcada nesta documentação; só os testes automatizados rodaram.
- A imagem do cartão não é lida. Números no meio da palavra e grafias trocadas (`n1gger`) passam.
- O @nome no serviço de conta e o que fazer com app modificado, build antigo e CLI foram decididos depois: veja `docs/verification/fix-word-check-leftovers.md`.
