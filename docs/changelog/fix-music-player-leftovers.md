- Sobras dos players de música e do Audius (fecha a issue #537). Verificação em `docs/verification/fix-music-player-leftovers.md`.

### Alterado

- Termos e Política na versão 64, com novo aceite: com a chave "Prévia de links" desligada, nenhum player de YouTube, SoundCloud, Spotify ou Apple Music carrega e os que estavam carregados fecham; o cartão aparece como os outros e um toque abre o link. A nota da chave em Ajustes diz isso.
- Em Publicar, o player da prévia não carrega enquanto o teclado cobre a prévia, e o mesmo vale para qualquer cartão atrás do teclado no app instalado.
- Serviço de conta: cada conta gasta no máximo um décimo do orçamento diário do Audius (1.200 de 12.000 unidades: consultas, aberturas de áudio e contatos com o host das capas). Passado esse teto, a conta recebe `limite-musica` e as outras continuam ouvindo.

### Corrigido

- Serviço de conta: uma capa do Audius cuja busca falhou depois de falar com o host da capa (queda, prazo, erro 5xx, 429) responde `indisponivel` por 60 segundos sem falar com o host de novo e devolve o uso da conta, em vez de gastar o orçamento a cada aparição da capa.
