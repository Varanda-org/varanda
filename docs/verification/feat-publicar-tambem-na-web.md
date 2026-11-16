# Publicar também na web (branch feat/publicar-tambem-na-web)

A caixa "Publicar também na web" em Publicar envia um `post.share` (RPC 5.122) depois da publicação e abre a folha "Página pública na web". Nenhuma das rodadas em aparelho abaixo foi feita neste PR: ficam todas por fazer, celular primeiro (build de debug do Android e simulador iOS), depois web hospedada e PWA.

## Quando a caixa aparece

- [ ] Com `/p/policy` desligada, a caixa não aparece.
- [ ] Num nó de core ou de configuração manual (sem a instalação), a caixa não aparece.
- [ ] Sem rede, a caixa não aparece.
- [ ] Numa resposta, numa citação, numa enquete, num evento, num Momento e ao publicar como uma Página ("Publicar como"), a caixa não aparece; a publicação vai para a web depois pelo "mais".
- [ ] Numa publicação comum no próprio diário, com a política ligada e rede, a caixa aparece.
- [ ] A caixa começa desmarcada a cada abertura da folha e depois de escolher uma resposta.

## Aparência e acessibilidade

- [ ] Marcada, o texto de consentimento é legível com o teclado aberto em 360x640 e com texto grande.
- [ ] O leitor de tela anuncia uma caixa de seleção e o estado dela.
- [ ] Temas claro e escuro.

## Envio

- [ ] Marcada, a publicação gera um `post.create` e um `post.share` (console da web ou log do nó); a folha abre com o link, "Compartilhar" e "Copiar link", e `/p/<chave>/<seq>` mostra a publicação uma vez que o semeador a tem.
- [ ] Rede cortada entre as duas gravações: a folha diz o que este aparelho registrou (enviado, não foi para a web, ou que o envio à web não foi confirmado), nunca "liberada na web" junto de um aviso de falha, e nada é reenviado.
- [ ] Limite `POST_SHARES_PER_DIARY` atingido: aviso de falha com o motivo e o botão "Publicar na web".
- [ ] Semeador inalcançável no portão de escrita com a caixa marcada: o rascunho fica em Publicar com o erro e nada entra na fila de saída.
- [ ] Bloqueio do app durante o envio: depois de desbloquear, a folha não abre.
- [ ] Publicações com fotos, com vídeo e com cartão de link, com a caixa marcada.

## Testes automáticos

Rodam na CI; não marcados aqui.

- [ ] `apps/app/test/postShareCompose.test.js`
- [ ] `apps/app/test/postShare.test.js`
- [ ] `apps/app/test/musicDraft.test.js`
- [ ] `apps/app/test/videoCompose.test.js`
- [ ] `apps/app/test/conversaScreen.test.js`
