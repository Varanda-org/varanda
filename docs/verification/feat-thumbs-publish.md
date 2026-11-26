# Miniaturas ao publicar

## Escopo

`Publicar.js` chama `buildPostThumbs` (`apps/app/src/postThumbs.js`) depois do envio dos originais, com os bytes codificados retidos e o upload da pessoa ou da Página. Acrescenta `thumbs` ao pedido somente quando há ao menos uma miniatura. O registro `post-thumbs` e a opção `thumbs` estão descritos em `docs/protocol.md` e `docs/rpc.md` (branch `feat/post-thumbs`). Nenhuma mudança na fila de saída, no plano de anexos ou em dependências.

Regras do envio:

- Falha de codificação, tamanho fora dos limites ou envio recusado deixa `null` naquela posição, sem impedir o post e sem repetir o pedido. Se todas faltam, a chave sai do pedido.
- Um envio de miniatura com resultado desconhecido segue a regra dos originais: para o envio e mostra "Não deu para confirmar o envio de uma miniatura. Toque em publicar de novo." O pedido assinado fica guardado e o próximo toque o reenvia, sem assinar outro.
- Miniaturas já enviadas ficam guardadas e não são enviadas de novo. Uma foto codificada de novo, ou de outro dono, perde o estado guardado.

## Verificação automatizada

Node v24.22.1, sem rede.

```sh
node apps/app/test/postThumbs.test.js
node apps/app/test/postShareCompose.test.js
npm run lint
```

- `postThumbs.test.js`: 12/12 testes, 134/134 asserções. Limites de 640 px e 65536 B; hash, tamanho, lados e MIME conferidos; ordem e posições preservadas; vídeo, par de vídeo e fotos pequenas sem miniatura; falhas definitivas sem repetição; envio incerto para o envio e guarda o pedido; um pedido guardado que falha de vez vira miniatura ausente.
- `postShareCompose.test.js`: 24/24 testes, 570/570 asserções. Caminhos pessoal e de Página com miniaturas alinhadas e sem repetição; texto, GIFs, fotos pequenas e vídeos sem `thumbs`; envio incerto e o próximo toque com a mesma assinatura; miniaturas guardadas depois de uma falha definitiva do post.
- Lint limpo.

## Roteiro manual

Não executado nesta rodada.

1. Android e simulador iOS, depois web e PWA: publicar uma foto maior que 640 px. Lendo o diário com `thumbs: true`, o post traz uma lista com um descritor JPEG de até 640 px e 65536 B.
2. Publicar texto, um GIF, um vídeo e uma foto pequena: nenhum traz `thumbs`.
3. Cortar a rede durante o envio da miniatura: a mensagem acima aparece; o próximo toque publica sem reenviar as fotos já enviadas.
4. Repetir o passo 1 numa Página.

## Limites

Nenhuma tela mostra as miniaturas ainda. Não medidos: tempo de publicação, tráfego e desempenho em aparelhos.
