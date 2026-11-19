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
| ADMIN_PASSWORD | senha do painel |
| MP_ACCESS_TOKEN | Access Token de produção do Mercado Pago. Sem ele, roda em modo teste |
| MP_WEBHOOK_SECRET | assinatura secreta do webhook do Mercado Pago |
| BASE_URL | https://reservas.arenakanoa.com.br |
| EXPORT_TOKEN, SESSION_SECRET | gerados pelo Render |

Teste local sem dependências: `ADMIN_PASSWORD=x node server.js` (usa SQLite em memória e PIX simulado).
