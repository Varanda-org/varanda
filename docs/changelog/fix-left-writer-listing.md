### Corrigido

- Os leitores voltam a aceitar o escritor de quem saiu de um grupo antes de o semeador guardá-lo (PR `fix/left-writer-listing`, #350): o semeador lista esse escritor, e também o liberado por um corte, pela última entrada ligada no grupo, e não mais pela entrada desligada, que os nós no app, na web e na CLI recusavam e contavam contra o semeador. Uma listagem já guardada com a entrada desligada se corrige no próximo escaneamento do diário. Só o semeador muda: os apps instalados continuam como estão. Verificação em `docs/verification/fix-left-writer-listing.md`.
