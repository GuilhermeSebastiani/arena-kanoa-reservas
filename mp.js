// Integração com o Mercado Pago (PIX). Sem MP_ACCESS_TOKEN roda em modo de teste com PIX simulado.
const crypto = require('node:crypto');

const TOKEN = () => process.env.MP_ACCESS_TOKEN || '';
const API = 'https://api.mercadopago.com';
const modoTeste = () => !TOKEN();

function isoBrasilia(date) {
  const d = new Date(date.getTime() - 3 * 3600e3);
  return d.toISOString().replace('Z', '-03:00');
}

async function criarPix({ reservaId, valor, descricao, nome, email, expiraEm, notificationUrl }) {
  if (modoTeste()) {
    const fake = `00020126TESTE-ARENA-KANOA-${reservaId.slice(0, 8)}-${valor.toFixed(2)}`;
    return { id: `teste_${reservaId}`, status: 'pending', copia: fake, qrBase64: null, teste: true };
  }
  const body = {
    transaction_amount: Number(valor.toFixed(2)),
    description: descricao,
    payment_method_id: 'pix',
    external_reference: reservaId,
    date_of_expiration: isoBrasilia(expiraEm),
    payer: { email, first_name: (nome || '').split(' ')[0] || 'Cliente' },
  };
  if (notificationUrl) body.notification_url = notificationUrl;
  const r = await fetch(`${API}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': reservaId,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.message || j.error || `HTTP ${r.status}`;
    throw Object.assign(new Error(`Não foi possível gerar o PIX agora (${msg}). Tente de novo em instantes.`), { status: 502 });
  }
  const td = (j.point_of_interaction && j.point_of_interaction.transaction_data) || {};
  return { id: String(j.id), status: j.status, copia: td.qr_code, qrBase64: td.qr_code_base64, teste: false };
}

async function consultar(paymentId) {
  if (modoTeste() || String(paymentId).startsWith('teste_')) return null;
  const r = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  if (!r.ok) throw new Error(`Mercado Pago: HTTP ${r.status}`);
  const j = await r.json();
  return { id: String(j.id), status: j.status, ref: j.external_reference, valor: j.transaction_amount, pagoEm: j.date_approved };
}

// Valida o cabeçalho x-signature do webhook (quando MP_WEBHOOK_SECRET está configurado)
function assinaturaValida(headers, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const sig = headers['x-signature'] || '';
  const reqId = headers['x-request-id'] || '';
  const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (reqId) manifest += `request-id:${reqId};`;
  manifest += `ts:${parts.ts};`;
  const calc = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(parts.v1)); } catch { return false; }
}

module.exports = { criarPix, consultar, assinaturaValida, modoTeste };
