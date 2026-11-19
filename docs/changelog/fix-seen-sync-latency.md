### Alterado

- Uma leitura feita num aparelho é enviada ao serviço de conta em poucos segundos, ou em até 60 s depois de muitas leituras seguidas (antes, até cerca de 90 s). Os outros aparelhos da mesma passkey a recebem na próxima consulta deles (ao voltar para a tela, ao reconectar ou a cada 5 minutos), e então o ponto de Conversas e o do sino somem neles. Verificação em `docs/verification/fix-seen-sync-latency.md`.
- O serviço de conta aceita até 64 gravações e 120 leituras de marcas de leitura por 10 minutos por conta (antes, 10 e 30), o bastante para até 4 aparelhos ativos da mesma passkey. Um pedido recusado por excesso (429) continua sem gastar nada.
