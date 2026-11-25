# fix/poll-vote-ref (#909)

- `node apps/app/test/polls.test.js`: o teste novo passa os parâmetros de `choice.mine` e `choice.set` por `validateRequest`; sem `choiceRef` (objeto `{ author, seq }`) é recusado.
- `npm run lint` e `npm run demo`.
- Não conferido: voto numa enquete e resposta a evento no app nativo e na web com conta real.
