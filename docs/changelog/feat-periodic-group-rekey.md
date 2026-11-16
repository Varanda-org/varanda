### Segurança

- Troca periódica da chave dos grupos privados (parte da #350): um administrador que pode distribuir troca a chave da época sozinho depois de 7 dias de uso ou de 1000 mensagens, multiplicados por um fator de 1 a 8 que cresce com o tamanho do grupo. Grupo parado não troca. Quem abriu a época troca primeiro; os outros administradores esperam mais 48 h e um sorteio de até 6 h. Sem formato novo e sem método novo no RPC. Verificação em `docs/verification/feat-periodic-group-rekey.md`.
