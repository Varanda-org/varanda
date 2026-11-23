### Adicionado

- Descoberta de grupos sem comunidade e de comunidades no índice do semeador (PR `feat/discovery-index`): quatro rotas novas, `/index/discover/groups/<ordem>`, `/index/discover/communities/<ordem>`, `/index/discover/search/<segmento>` e `/index/discover/of/<D>`, listam grupos públicos sem comunidade e comunidades públicas, nunca os grupos de uma comunidade. As rotas antigas de descoberta continuam com o mesmo caminho e a mesma resposta. Verificação em `docs/verification/feat-discovery-index.md`.

### Alterado

- Atualize os semeadores com este PR e com `feat/standalone-group-protocol` antes de publicar um app que use as rotas `/index/discover/*`. Um app novo diante de um semeador antigo recebe 404 nessas rotas e esconde as listas.
