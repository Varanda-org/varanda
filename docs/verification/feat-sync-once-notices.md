# Avisos de uma só vez em todo aparelho (branch feat/sync-once-notices)

O aviso antes da primeira mensagem a uma Página e o aviso de convite novo deixam de se repetir num segundo aparelho da mesma passkey. Quando um aparelho mostra um deles, acrescenta uma marca opaca à lista `avisos.own` do bloco cifrado de vistos (32 hex, teto de 256 dividido com os Avisos, mais novas primeiro): os 16 primeiros bytes de sha256 sobre `'varanda-once-v1\n' + tipo + '\n' + membro + '\n' + id`, com `tipo` `page-dm-notice` ou `invite-drop`. Todo aparelho lê as marcas depois de cada passagem de vistos; o aviso de convite espera a primeira passagem da sessão (cerca de 4 s no máximo, também em falha). O formato do documento e os limites de `seen.merge` não mudam, sem rota nova. Vale só na instalação hospedada com vistos sincronizados, desbloqueada e com os Termos aceitos; nó core nativo e `varanda-serve` seguem por aparelho. Termos versão 67.

Verificações automáticas: a preencher.

Resultados: a preencher.

Conferência no aparelho:

- [ ] Web hospedada, dois aparelhos da mesma passkey: mostrar o aviso da Página na A e abrir uma conversa com a mesma Página na B: a B não mostra o aviso: pendente.
- [ ] O aviso de convite visto na A não aparece na B depois da primeira passagem de vistos da B: pendente.
- [ ] Nó core nativo: o aviso continua por aparelho: pendente.
- [ ] Aparelho bloqueado, ou antes de aceitar os Termos: o aviso aparece como antes: pendente.
- [ ] Termos versão 67: o parágrafo de vistos da Privacidade diz "Esse mesmo bloco guarda também marcas opacas de que o aviso antes da primeira mensagem a uma Página e o aviso de convite novo já foram mostrados, na mesma janela do Avisos, para que outro aparelho da mesma conta não os mostre de novo; as marcas não revelam a Página nem o convite.": pendente.
