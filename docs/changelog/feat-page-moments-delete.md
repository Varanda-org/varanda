### Alterado

- Momentos da Página para quem a administra (PR `feat/page-moments-delete`): agindo como uma Página, o perfil mostra os momentos dela, os das últimas 24 horas e os anteriores, cada um com **Apagar**. A lista vem da leitura assinada `status` da Página, que passa a responder `moments` (até 20, do mais novo ao mais antigo, só texto e data). Assim o dono ou um administrador que não segue a Página, ou um momento com mais de 24 horas, ainda pode ser apagado.
