### Alterado

- Reabrir o app com a cópia completa do aparelho (PR `feat/reopen-complete-copies`): no Android, no iOS e na web, A Rua, o Diário, as Conversas e os Avisos mostram de uma vez nomes, @nome, fotos de perfil e as publicações citadas, respondidas ou repostadas, tudo lido do aparelho, sem esperar a rede. A página de quem você segue também guarda o que essa pessoa reposta ou cita de quem você não segue, com nome e foto. As Conversas mostram a foto dos grupos privados, guardada já decifrada no aparelho (nunca a chave). Na web, as fotos de quem você segue ficam guardadas no navegador (64 MiB, 2000 arquivos, 30 dias). No app nativo, o refresh em segundo plano pode ler as publicações de até 6 pessoas que você não segue quando uma publicação de A Rua as reposta, cita ou responde. As listas de bloqueio e de silêncio ficam guardadas no aparelho (até 500 chaves, 14 dias). Termos versão 115.

### Corrigido

- Linhas de outras pessoas na reabertura (PR `feat/reopen-complete-copies`): as linhas salvas de outras pessoas não esperam mais a lista de bloqueio chegar. A foto de uma pessoa que você não segue só é guardada depois que a lista de bloqueio e a de seguidos desta abertura são conhecidas, e um bloqueio feito em outro aparelho vale assim que a lista desta abertura chega. Conferência em `docs/verification/feat-reopen-complete-copies.md`.
