- Vagas de conexão divididas por endereço, com prioridade para membros certificados (PR `feat/peer-limit-per-address`, #32). Verificação em `docs/verification/feat-peer-limit-per-address.md`.

### Alterado

- O semeador e o nó do membro dividem as vagas de conexão por endereço (IPv6 por bloco /64): com as vagas cheias, uma conexão de um endereço toma a vaga de um endereço com pelo menos duas conexões a mais, e conexões do mesmo endereço (CGNAT, uma rede compartilhada) se revezam depois de 10 s. Muitas conexões de um só endereço não ocupam mais todas as vagas. O endereço fica só na memória e nunca aparece em registros.
- O semeador guarda a vaga de outro semeador verificado (uma conexão por semeador, só pelo swarm) e a de um membro que prova, na conexão, ser dono de um diário certificado que o semeador guarda. O app e a CLI mandam essa prova (mensagem `prove`, capacidade `CAP_PEER_PROOF = 8`) só a semeadores verificados que a oferecem.
- A entrada WebSocket do semeador divide as suas vagas pelo endereço de quem conecta, repassado pelo Caddy em `X-Forwarded-For`. Uma conexão que perde a vaga fecha com o código 1013, como a recusada por lotação. As conexões do próprio servidor que não passam pelo Caddy (as do serviço de conta) mantêm a vaga, até um quarto das vagas. Novo motivo de descarte nos registros: `connection-displaced`.
