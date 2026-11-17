# Resposta rápida como página (branch feat/page-quick-reply)

## O que mudou

- `apps/app/src/replySend.js`: `quickReplyPlan` devolve `send-page` quando se age como Página (um link ou mais de 1000 caracteres ainda dão `expand`); `sendPageTextReply` faz uma só assinatura; um erro incerto devolve o `retry` dele (os mesmos bytes assinados) e, quando recebe esse `retry`, o envia no lugar de assinar de novo.
- `apps/app/src/screens/Conversa.js`: a barra mostra a Página (foto e nome pelo cache de nomes) e o campo diz "Comente como Nome" na publicação em destaque e "Responda como Nome" numa linha; o envio usa `actAs` com a Página capturada no começo, então uma troca de identidade durante o envio não muda quem assina nem abre a Publicar. Depois de um erro incerto, o próximo toque em enviar com o mesmo texto, o mesmo alvo e a mesma Página chama o `retry` (uma vez por toque, nunca sozinho); texto, alvo ou identidade diferentes assinam de novo sem chamar o `retry`. Os bytes guardados só saem quando o `retry` se resolve (resposta ou recusa certa) ou quando outro erro incerto os substitui: outra resposta da Página que chega, recusa de palavra, abrir a Publicar e falha antes da assinatura os mantêm. A Publicar nunca usa o `retry` (assina uma resposta nova); abri-la com o mesmo texto e alvo mostra o aviso de que a mensagem anterior pode ter sido enviada e que enviar de novo na barra, sem mudar o texto, a reenvia sem duplicar. Esse aviso só aparece se a identidade e o alvo ainda são os do envio; senão vale o aviso de conferir a conversa. Trocar o alvo ou a identidade apaga o aviso, e o alvo não pode ser cancelado durante um envio; os bytes continuam presos à Página, ao alvo e ao texto. O serviço aceita um nonce por 600 s, então os bytes só são reenviados por 8 minutos: depois disso, o toque com o mesmo texto não envia nada, descarta os bytes e pede para conferir a conversa; o toque seguinte assina de novo.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/app/test/replySend.test.js
node apps/app/test/conversaScreen.test.js
node apps/app/test/replyBar.test.js
node apps/app/test/platformGate.test.js
npx standard apps/app/src/screens/Conversa.js apps/app/src/replySend.js
```

Casos fixados: a Página responde sem o nó local; a chave do membro que falha mostra um aviso e não abre nada; a troca para a pessoa durante o envio mantém a Página; erro incerto não é repetido sozinho; o toque seguinte com o mesmo texto reenvia pelo `retry` (sem nova assinatura); texto mudado ou troca de identidade assinam de novo e nunca chamam o `retry` antigo; recusa de palavra, Publicar recusada, falha da chave do membro e recusa certa da resposta nova mantêm o `retry`; uma resposta diferente que chega também o mantém, e o texto original depois reenvia pelo `retry`, sem terceira assinatura; o aviso de reenvio não aparece se a identidade ou o alvo mudaram durante o envio; voltar à Página com o mesmo texto reenvia; a Publicar com o mesmo texto e alvo mostra o aviso e mantém o `retry`; trocar o alvo ou a identidade apaga o aviso; bytes guardados há mais de 8 minutos não são reenviados (o toque pede para conferir a conversa e o seguinte assina de novo).

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Como a Página A, abrir a Conversa de uma publicação: a barra mostra a foto e o nome da Página A, e o campo diz "Comente como A" ("Responda como A" ao mirar um comentário). Pendente.
- [ ] Enviar uma resposta curta: ela aparece como a Página A, também para uma pessoa que a segue. Pendente.
- [ ] Com o modo avião ligado no meio do envio (resposta perdida), desligar e tocar em enviar de novo sem mudar o texto: a resposta aparece uma vez só. Repetir abrindo a Publicar no meio e voltando: o aviso diz que só a barra reenvia sem duplicar, e tocar em enviar na barra com o mesmo texto não duplica. Pendente.
- [ ] Depois do aviso de envio incerto, fechar o alvo ("cancelar resposta") ou trocar de identidade: o aviso some. Pendente.
- [ ] Um link, ou um texto com mais de 1000 caracteres, ainda abre a Publicar com o rascunho. Pendente.
- [ ] Sem internet a barra não aparece (aviso de sem conexão), como antes. Pendente.
- [ ] Voltar a agir como a própria pessoa: a barra volta à foto e ao campo de antes, e a resposta sai como a pessoa. Pendente.

## Não verificado / limites conhecidos

- Não conferido em aparelho.
