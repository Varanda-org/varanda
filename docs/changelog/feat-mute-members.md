### Adicionado

- Silenciar uma pessoa sem bloquear: pelo menu de uma publicação ou pelo perfil, "Silenciar" tira as publicações, as republicações, os momentos e os avisos dela de A Rua e de Avisos. A pessoa não é avisada, continua seguida e as mensagens continuam chegando. A lista fica em Ajustes, Pessoas silenciadas, e vale em todos os aparelhos da passkey. Na web, os avisos push dessa pessoa ficam quietos, como os de quem você bloqueou. Métodos `mute.set` e `mute.list` (`docs/rpc.md` 5.178 e 5.179), só no nó do navegador (PR `feat/mute-members`).

### Alterado

- Bloco cifrado de vistos na versão 5 (`docs/protocol.md`, seção 14): bloqueios e silêncios dividem a mesma janela de 128 entradas, e os bloqueios têm prioridade. A versão 4 continua sendo lida; um aparelho com app antigo deixa a versão 5 de lado até atualizar.
- A Feira deixa de mostrar anúncios e alertas de quem você bloqueou.
- Termos de Uso e Política de Privacidade na versão 111: descrevem silenciar e o que o bloco de vistos guarda dos silenciados. Quem já aceitou aceita de novo.
