### Corrigido

- As Conversas de uma Página não mostram mais a palavra "ocupado" com "tentar de novo" quando o nó está com a leitura tomada: o app tenta de novo sozinho e, se ainda estiver ocupado, espera a próxima leitura (PR `fix/paginas-agir-estado`, parte da #352).
- Quem agia como uma Página que foi encerrada, mudou de chave ou deixou de ser sua em outro aparelho volta a agir como a própria pessoa assim que a lista de Páginas é lida, sem recarregar o app. Verificação em `docs/verification/fix-paginas-agir-estado.md`.
