### Alterado

- Publicar, responder, citar, curtir, repostar e mudar o perfil não param mais a sincronização em andamento, no app instalado, na web e no `varanda-serve`: a escrita entra no diário enquanto a sincronização segue, sem `sync.stopped` `preempted` nem reinício, e o bloco novo sai na mesma ligação com o semeador (#66). As outras escritas (seguir, apagar, grupos, Páginas, aparelhos, Feira) continuam pausando a sincronização como antes.
