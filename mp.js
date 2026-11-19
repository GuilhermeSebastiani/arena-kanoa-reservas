// Integração com o Mercado Pago (PIX). Sem MP_ACCESS_TOKEN roda em modo de teste com PIX simulado.
const crypto = require('node:crypto');

const TOKEN = () => { const t = (process.env.MP_ACCESS_TOKEN || '').trim(); return t.length > 10 ? t : ''; };
const API = 'https://api.mercadopago.com';
// modo: 'mp' (Mercado Pago com confirmação automática), 'manual' (PIX na chave da Arena, confirmado no painel)
// ou 'teste' (só local ou com MODO_TESTE=1: PIX simulado)
function modo() {
  if (process.env.MODO_PAGAMENTO) return process.env.MODO_PAGAMENTO;
  if (TOKEN()) return 'mp';
  if (process.env.MODO_TESTE === '1' || !process.env.DATABASE_URL) return 'teste';
  return 'manual';
}
const modoTeste = () => modo() === 'teste';

// PIX copia e cola (BR Code estático com valor) para a chave da Arena
function campo(id, v) { return id + String(v.length).padStart(2, '0') + v; }
function crc16(str) {
  let crc = 0xffff;
  for (const b of Buffer.from(str, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const semAcento = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase();
function brCode({ chave, valor, txid, nome, cidade }) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave);
  let p = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986') +
    campo('54', valor.toFixed(2)) + campo('58', 'BR') + campo('59', semAcento(nome).slice(0, 25)) +
    campo('60', semAcento(cidade).slice(0, 15)) + campo('62', campo('05', String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'));
  p += '6304';
  return p + crc16(p);
}

function isoBrasilia(date) {
  const d = new Date(date.getTime() - 3 * 3600e3);
  return d.toISOString().replace('Z', '-03:00');
}

async function criarPix({ reservaId, valor, descricao, nome, email, expiraEm, notificationUrl }) {
  if (modo() === 'manual') {
    const chave = process.env.PIX_CHAVE;
    const copia = chave ? brCode({ chave, valor, txid: `ARENA${reservaId.replace(/-/g, '').slice(0, 12)}`, nome: process.env.PIX_NOME || 'Arena Kanoa', cidade: process.env.PIX_CIDADE || 'Sete Quedas' }) : null;
    return { id: `manual_${reservaId}`, status: 'pending', copia, qrBase64: null, teste: false };
  }
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
  if (modo() !== 'mp' || !/^\d+$/.test(String(paymentId))) return null;
  const r = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  if (!r.ok) throw new Error(`Mercado Pago: HTTP ${r.status}`);
  const j = await r.json();
  return { id: String(j.id), status: j.status, ref: j.external_reference, valor: j.transaction_amount, pagoEm: j.date_approved };
}

// Valida o cabeçalho x-signature do webhook (quando MP_WEBHOOK_SECRET está configurado)
function assinaturaValida(headers, dataId) {
  const secret = (process.env.MP_WEBHOOK_SECRET || '').trim().length > 10 ? process.env.MP_WEBHOOK_SECRET.trim() : '';
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

module.exports = { criarPix, consultar, assinaturaValida, modoTeste, modo, brCode };
