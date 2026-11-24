# Arena Kanoa — Reservas

Reserva de quadras e eventos com pagamento por PIX (Mercado Pago).

- `/` página pública de reserva
- `/admin` painel (senha em `ADMIN_PASSWORD`)
- `/api/agenda` datas com evento (sem nomes), usada pelo site e pelo story semanal
- `/api/export?token=EXPORT_TOKEN` exportação completa para o caixa da Arena
- `/webhooks/mp` aviso de pagamento do Mercado Pago

## Variáveis
| Nome | Para quê |
|---|---|
| DATABASE_URL | Postgres (o Render preenche) |
| ADMIN_USER / ADMIN_PASSWORD | primeiro usuário do painel (os outros são criados no painel, aba Usuários) |
| PIX_CHAVE | chave PIX da Arena, usada no modo PIX manual (antes do Mercado Pago) |
| MP_ACCESS_TOKEN | Access Token de produção do Mercado Pago. Sem ele, roda em PIX manual |
| MP_WEBHOOK_SECRET | assinatura secreta do webhook do Mercado Pago |
| BASE_URL | https://reservas.arenakanoa.com.br |
| EXPORT_TOKEN, SESSION_SECRET | gerados pelo Render |
| DB_SCHEMA | `arena`: usa um espaço próprio dentro de um banco dividido com a Agro Sebastiani |
| MIGRAR_DE | só na mudança de banco: endereço do banco antigo. Copia reservas, usuários e config uma vez e pode ser removida depois |

Teste local sem dependências: `ADMIN_PASSWORD=x node server.js` (usa SQLite em memória e PIX simulado).
