# Gastos

Controle financeiro pessoal para iPhone: envelope diário a partir do extrato do Banco Inter. Funciona offline e sem servidor. Os dados ficam só no aparelho (IndexedDB).

**App:** https://fezolamanzi.github.io/gastos-pessoais/

## Instalar no iPhone

1. Abra o link acima no **Safari**.
2. Toque em **Compartilhar** e em **Adicionar à Tela de Início**.
3. Abra sempre pelo ícone. No Safari os dados ficam separados, e o app avisa quando isso acontece.
4. Em **Ajustes**, toque em **Restaurar backup** e escolha o backup inicial, ou preencha salário, fixos e investimento.

## Uso semanal (5 minutos)

1. No app do Inter, exporte o extrato em **OFX** e salve em Arquivos.
2. Em **Hoje**, toque em **Importar extrato ou fatura**. Pode repetir períodos: nada duplica.
3. Resolva **A classificar**: um toque categoriza e cria a regra.
4. Resolva **Revisar**: extrato parecido com lançamento manual ou com a soma dos itens do dia.

No dia a dia, lance só o que não aparece no extrato, como dinheiro em espécie: `35 almoço`, `almoço 12,50` ou `ontem 35 almoço`. Em **Lançar**, os favoritos registram um item em 2 toques.

## Todo mês

- O envelope recomeça no dia 1. Se sobrou, o app mostra quanto mandar para a reserva. A falta não passa para o mês seguinte e fica no histórico, em **Resumo**.
- Categorize a transferência para a reserva como **Investimento**, para ela não contar como gasto.
- Importe a fatura do cartão em CSV: as compras descontam no dia da compra, e o pagamento da fatura não conta como gasto.

## Backup

Em **Ajustes**, toque em **Exportar backup** e salve em Arquivos. O app lembra depois de 30 dias. **Apagar o app da tela inicial apaga os dados**, então faça o backup antes.

## Desenvolvimento

Sem dependências e sem build. `npm test` roda os testes; os que usam extratos reais são pulados se a pasta `extratos/` não existir. As pastas `extratos/` e `privado/` nunca vão para o Git.
