### Corrigido

- Votar numa enquete e responder a um evento voltam a funcionar: o app mandava a referência do post como objeto e o contrato só aceita o texto `autor:seq`. Uma falha ao ler o próprio voto agora aparece na tela, com nova tentativa.
