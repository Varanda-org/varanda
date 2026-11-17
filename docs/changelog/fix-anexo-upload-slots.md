### Corrigido

- O envio de uma denúncia com imagem ou áudio (`/account/report/anexo`) não tem mais o limite de 4 leituras ao mesmo tempo, que era ocupado antes de conferir quem denuncia: um envio parado de quem não assina não ocupa mais a vez de uma denúncia válida, que antes podia receber `limite`. As leituras continuam limitadas pelo teto de 64 conexões do serviço, pelo tamanho declarado de cada corpo, pelo corte de 5 s sem dados e pelo prazo que cresce com o tamanho. O formato do pedido não muda. Verificação em `docs/verification/fix-anexo-upload-slots.md`. Parte da #31.
