// Arena Kanoa — sistema de reservas (quadras e eventos) com PIX.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./logic');
const mp = require('./mp');
const { open } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || 'dev';
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://arenakanoa.com.br';

let db;

// ---------- utilidades ----------
const agoraISO = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
const erro = (res, status, msg) => send(res, status, { erro: msg });

async function lerJSON(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error('corpo grande demais'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.ico': 'image/x-icon' };
function estatico(res, arquivo) {
  const p = path.join(__dirname, 'public', arquivo);
  if (!p.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(p)) return send(res, 404, 'Não encontrado');
  const ext = path.extname(p);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
  fs.createReadStream(p).pipe(res);
}

// trava simples para evitar duas reservas simultâneas no mesmo horário (instância única)
let fila = Promise.resolve();
const exclusivo = (fn) => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };

// limite de pedidos por IP
const tentativas = new Map();
function limitado(ip, max = 12, janelaMs = 3600e3) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < janelaMs);
  lista.push(agora);
  tentativas.set(ip, lista);
  return lista.length > max;
}
const ipDe = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- config ----------
async function cfg() {
  const row = await db.get('SELECT valor FROM config WHERE chave = $1', ['arena']);
  const salvo = row ? JSON.parse(row.valor) : {};
  return { ...L.DEFAULTS, ...salvo, precos: { ...L.DEFAULTS.precos, ...(salvo.precos || {}) } };
}
async function salvarCfg(novo) {
  const json = JSON.stringify(novo);
  const r = await db.run('UPDATE config SET valor = $1 WHERE chave = $2', [json, 'arena']);
  if (!r.changes) await db.run('INSERT INTO config (chave, valor) VALUES ($1, $2)', ['arena', json]);
}

async function reservasEntre(de, ate) {
  return db.all('SELECT * FROM reservas WHERE data >= $1 AND data <= $2 ORDER BY data, inicio', [de, ate]);
}

const publica = (r) => ({
  id: r.id, tipo: r.tipo, data: r.data, inicio: r.inicio, fim: r.fim, quadras: r.quadras, espaco: r.espaco,
  resp: r.resp, valor: r.valor, valorPix: r.valor_pix, status: r.status, expiraEm: r.expira_em, pagoEm: r.pago_em,
  copia: r.status === 'pendente' ? r.pix_copia : undefined,
  qr: r.status === 'pendente' ? r.pix_qr : undefined,
});

// ---------- pagamento ----------
async function aplicarPagamento(r, pg) {
  if (!pg || pg.status !== 'approved') return r;
  if (r.status === 'confirmada' || r.status === 'conflito') return r;
  return exclusivo(async () => {
    const c = await cfg();
    const atual = await db.get('SELECT * FROM reservas WHERE id = $1', [r.id]);
    if (atual.status === 'confirmada' || atual.status === 'conflito') return atual;
    const agora = agoraISO();
    let livre = true;
    if (!L.ativa(atual, agora)) {
      // o prazo venceu antes do PIX: só confirma se o horário continua livre
      const outras = (await reservasEntre(atual.data, atual.data)).filter((x) => x.id !== atual.id);
      if (atual.tipo === 'evento') livre = L.eventoDisponivel(c, atual.data, atual.espaco, outras, agora);
      else {
        const oc = L.ocupacaoDoDia(c, atual.data, outras, agora);
        livre = !oc.quadrasBloqueadas && L.quadrasLivresNoIntervalo(c, oc.blocos, L.toMin(atual.inicio), L.toMin(atual.fim)) >= atual.quadras;
      }
    }
    const status = livre ? 'confirmada' : 'conflito';
    const obs = livre ? atual.obs : `${atual.obs ? atual.obs + ' | ' : ''}PIX pago depois do prazo e o horário já tinha sido ocupado: devolver ou remarcar.`;
    await db.run('UPDATE reservas SET status = $1, pago_em = $2, obs = $3 WHERE id = $4', [status, pg.pagoEm || agora, obs, atual.id]);
    console.log(`[pagamento] reserva ${atual.id} -> ${status}`);
    return db.get('SELECT * FROM reservas WHERE id = $1', [atual.id]);
  });
}

async function checarNoMP(r) {
  if (!r.mp_payment_id || r.status !== 'pendente') return r;
  const ultima = r.checado_em ? Date.parse(r.checado_em) : 0;
  if (Date.now() - ultima < 8000) return r;
  await db.run('UPDATE reservas SET checado_em = $1 WHERE id = $2', [agoraISO(), r.id]);
  try {
    const pg = await mp.consultar(r.mp_payment_id);
    if (pg && pg.ref === r.id) return aplicarPagamento(r, pg);
  } catch (e) { console.error('[mp consulta]', e.message); }
  return r;
}

// ---------- criação de reserva pelo site ----------
async function criarReservaSite(body, ip) {
  const c = await cfg();
  const tipo = body.tipo === 'evento' ? 'evento' : 'quadra';
  const data = String(body.data || '');
  const nome = String(body.nome || '').trim().slice(0, 80);
  const telefone = String(body.telefone || '').replace(/[^\d+() -]/g, '').slice(0, 30);
  const email = String(body.email || '').trim().slice(0, 120);
  const obs = String(body.obs || '').trim().slice(0, 400);
  const errData = L.validaData(c, data);
  if (errData) throw Object.assign(new Error(errData), { status: 400 });
  if (nome.length < 3) throw Object.assign(new Error('Informe seu nome.'), { status: 400 });
  if (telefone.replace(/\D/g, '').length < 10) throw Object.assign(new Error('Informe um telefone com DDD.'), { status: 400 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('E-mail inválido.'), { status: 400 });
  if (limitado(ip)) throw Object.assign(new Error('Muitas tentativas. Tente de novo mais tarde.'), { status: 429 });

  return exclusivo(async () => {
    const agora = agoraISO();
    const doDia = await reservasEntre(data, data);
    let r = { id: uid(), tipo, data, resp: nome, telefone, email, obs, status: 'pendente', origem: 'site', criado: agora };

    if (tipo === 'quadra') {
      const dur = Number(body.dur);
      const quadras = Number(body.quadras);
      if (!c.duracoes.includes(dur)) throw Object.assign(new Error('Duração inválida.'), { status: 400 });
      if (![1, 2].includes(quadras) || quadras > c.totalQuadras) throw Object.assign(new Error('Número de quadras inválido.'), { status: 400 });
      const livres = L.horariosQuadra(c, data, dur, quadras, doDia, agora);
      if (!livres.includes(body.inicio)) throw Object.assign(new Error('Esse horário acabou de ser ocupado. Escolha outro.'), { status: 409 });
      r = { ...r, inicio: body.inicio, fim: L.toHHMM(L.toMin(body.inicio) + dur), quadras, valor: L.precoQuadra(c, quadras, dur) };
      r.valor_pix = r.valor;
    } else {
      const espaco = body.espaco === 'quiosque' ? 'quiosque' : 'arena';
      if (!L.eventoDisponivel(c, data, espaco, doDia, agora)) throw Object.assign(new Error('Essa data não está mais disponível para evento.'), { status: 409 });
      const valor = L.precoEvento(c, data, espaco);
      r = { ...r, espaco, quadras: 0, valor, valor_pix: L.round2(valor * (Number(c.sinalEventoPct) || 100) / 100) };
    }

    const expira = new Date(Date.now() + c.holdMin * 60e3);
    r.expira_em = expira.toISOString();
    const [y, m, d] = data.split('-');
    const desc = tipo === 'quadra'
      ? `Arena Kanoa - ${r.quadras} quadra(s) ${d}/${m} ${r.inicio}-${r.fim}`
      : `Arena Kanoa - evento (${r.espaco === 'arena' ? 'arena toda' : 'quiosque'}) ${d}/${m}/${y}${r.valor_pix < r.valor ? ' - sinal' : ''}`;

    const pix = await mp.criarPix({
      reservaId: r.id, valor: r.valor_pix, descricao: desc, nome,
      email: email || process.env.PIX_EMAIL_PADRAO || 'reservas@arenakanoa.com.br',
      expiraEm: expira,
      notificationUrl: BASE_URL ? `${BASE_URL}/webhooks/mp` : undefined,
    });
    r.mp_payment_id = pix.id;
    r.pix_copia = pix.copia;
    r.pix_qr = pix.qrBase64;

    await db.run(
      `INSERT INTO reservas (id, tipo, data, inicio, fim, quadras, espaco, resp, telefone, email, valor, valor_pix, status, origem,
        mp_payment_id, pix_copia, pix_qr, expira_em, obs, criado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [r.id, r.tipo, r.data, r.inicio || null, r.fim || null, r.quadras || 0, r.espaco || null, r.resp, r.telefone, r.email || null,
        r.valor, r.valor_pix, r.status, r.origem, r.mp_payment_id, r.pix_copia || null, r.pix_qr || null, r.expira_em, r.obs || null, r.criado],
    );
    return { ...publica(r), teste: pix.teste };
  });
}

// ---------- admin ----------
function assinar(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex'); }
function cookieAdmin() {
  const ts = String(Date.now());
  return `${ts}.${assinar(ts)}`;
}
function ehAdmin(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m || !ADMIN_PASSWORD) return false;
  const [ts, sig] = decodeURIComponent(m[1]).split('.');
  if (!ts || !sig || sig.length !== 64) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(assinar(ts)));
  return ok && Date.now() - Number(ts) < 30 * 864e5;
}

async function criarReservaAdmin(b) {
  const c = await cfg();
  const tipo = ['quadra', 'evento', 'bloqueio'].includes(b.tipo) ? b.tipo : 'quadra';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '')) throw Object.assign(new Error('Data inválida.'), { status: 400 });
  const r = {
    id: uid(), tipo, data: b.data, inicio: b.inicio || null, fim: b.fim || null,
    quadras: Number(b.quadras) || (tipo === 'quadra' ? 1 : 0),
    espaco: b.espaco || null, resp: String(b.resp || '').slice(0, 80), telefone: b.telefone || null,
    valor: Number(b.valor) || 0, semValor: b.valor === undefined || b.valor === null || b.valor === '', status: b.status === 'pendente' ? 'pendente' : 'confirmada', obs: b.obs || null,
  };
  if (tipo === 'quadra' && (!r.inicio || !r.fim)) throw Object.assign(new Error('Informe início e fim.'), { status: 400 });
  if (tipo === 'evento' && r.semValor) r.valor = L.precoEvento(c, r.data, r.espaco || 'arena') || 0;
  if (tipo === 'quadra' && r.semValor) r.valor = L.precoQuadra(c, r.quadras, L.toMin(r.fim) - L.toMin(r.inicio));
  const expira = r.status === 'pendente' ? '9999-12-31T00:00:00.000Z' : null; // pendente do painel = "a receber", segura a data
  await db.run(
    `INSERT INTO reservas (id, tipo, data, inicio, fim, quadras, espaco, resp, telefone, valor, valor_pix, status, origem, expira_em, obs, criado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'admin',$13,$14,$15)`,
    [r.id, r.tipo, r.data, r.inicio, r.fim, r.quadras, r.espaco, r.resp, r.telefone, r.valor, 0, r.status, expira, r.obs, agoraISO()],
  );
  return r;
}

async function fixosNoPeriodo(c, de, ate, reservas) {
  const out = [];
  const agora = agoraISO();
  for (let d = de; d <= ate; d = L.addDias(d, 1)) {
    const oc = L.ocupacaoDoDia(c, d, reservas, agora);
    const w = L.diaSemana(d);
    for (const f of c.fixos || []) {
      if (!f.dias.includes(w)) continue;
      const cancelado = (c.fixosCancelados || []).includes(`${d}|${f.id}`);
      out.push({ data: d, fixoId: f.id, nome: f.nome, inicio: f.inicio, fim: f.fim, quadras: f.quadras, cancelado, cedeAoEvento: oc.quadrasBloqueadas && !cancelado });
    }
  }
  return out;
}

// ---------- rotas ----------
async function rotear(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const M = req.method;

  // páginas
  if (M === 'GET' && (p === '/' || p === '/index.html')) return estatico(res, 'index.html');
  if (M === 'GET' && (p === '/admin' || p === '/admin/')) return estatico(res, 'admin.html');
  if (M === 'GET' && /^\/[\w.-]+\.(png|jpg|svg|ico)$/.test(p)) return estatico(res, p.slice(1));
  if (M === 'GET' && p === '/saude') return send(res, 200, { ok: true });

  // API pública
  if (M === 'GET' && p === '/api/config') {
    const c = await cfg();
    return send(res, 200, {
      valorHora: c.valorHora, totalQuadras: c.totalQuadras, duracoes: c.duracoes, abre: c.abre, fecha: c.fecha,
      holdMin: c.holdMin, sinalEventoPct: c.sinalEventoPct, diasAntecedencia: c.diasAntecedencia, hoje: L.agoraLocal().data,
      modoTeste: mp.modoTeste(),
    });
  }
  if (M === 'GET' && p === '/api/mes') {
    const c = await cfg();
    const ano = Number(q.ano), mes = Number(q.mes);
    if (!ano || !mes || mes < 1 || mes > 12) return erro(res, 400, 'Mês inválido.');
    const de = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const ate = `${ano}-${String(mes).padStart(2, '0')}-31`;
    return send(res, 200, { dias: L.resumoMes(c, ano, mes, await reservasEntre(de, ate), agoraISO()) });
  }
  if (M === 'GET' && p === '/api/dia') {
    const c = await cfg();
    const e = L.validaData(c, q.data);
    if (e) return erro(res, 400, e);
    const rs = await reservasEntre(q.data, q.data);
    const agora = agoraISO();
    const dur = c.duracoes.includes(Number(q.dur)) ? Number(q.dur) : 60;
    const quadras = Number(q.quadras) === 2 ? 2 : 1;
    return send(res, 200, {
      data: q.data,
      fimDeSemana: L.ehFimDeSemanaOuFeriado(c, q.data),
      quadra: { dur, quadras, valor: L.precoQuadra(c, quadras, dur), horarios: L.horariosQuadra(c, q.data, dur, quadras, rs, agora) },
      eventos: ['arena', 'quiosque'].map((esp) => {
        const valor = L.precoEvento(c, q.data, esp);
        return { espaco: esp, livre: L.eventoDisponivel(c, q.data, esp, rs, agora), valor, sinal: L.round2(valor * (Number(c.sinalEventoPct) || 100) / 100) };
      }),
    });
  }
  if (M === 'POST' && p === '/api/reservas') {
    const body = await lerJSON(req);
    return send(res, 201, await criarReservaSite(body, ipDe(req)));
  }
  let m = /^\/api\/reservas\/([\w-]{36})$/.exec(p);
  if (M === 'GET' && m) {
    let r = await db.get('SELECT * FROM reservas WHERE id = $1', [m[1]]);
    if (!r) return erro(res, 404, 'Reserva não encontrada.');
    r = await checarNoMP(r);
    if (r.status === 'pendente' && !L.ativa(r, agoraISO())) r = { ...r, status: 'expirada' };
    const out = publica(r);
    delete out.resp;
    return send(res, 200, out);
  }
  if (M === 'GET' && p === '/api/agenda') {
    // datas com evento (sem nomes) para o site e o story semanal
    const hoje = L.agoraLocal().data;
    const rs = await reservasEntre(hoje, L.addDias(hoje, 120));
    const agora = agoraISO();
    const datas = [...new Set(rs.filter((r) => (r.tipo === 'evento' || (r.tipo === 'bloqueio' && r.espaco === 'tudo')) && L.ativa(r, agora)).map((r) => r.data))];
    return send(res, 200, { atualizado: hoje, reservados: datas.sort() }, { 'Access-Control-Allow-Origin': SITE_ORIGIN === '*' ? '*' : SITE_ORIGIN });
  }
  if (M === 'GET' && p === '/api/export') {
    if (!EXPORT_TOKEN || q.token !== EXPORT_TOKEN) return erro(res, 403, 'Sem acesso.');
    const rs = await db.all('SELECT id, tipo, data, inicio, fim, quadras, espaco, resp, telefone, email, valor, valor_pix, status, origem, mp_payment_id, pago_em, obs, criado FROM reservas ORDER BY data, inicio');
    return send(res, 200, { reservas: rs, config: await cfg() });
  }

  m = /^\/api\/teste\/pagar\/([\w-]{36})$/.exec(p);
  if (M === 'POST' && m && mp.modoTeste()) {
    const r = await db.get('SELECT * FROM reservas WHERE id = $1', [m[1]]);
    if (!r) return erro(res, 404, 'Reserva não encontrada.');
    await aplicarPagamento(r, { status: 'approved', pagoEm: agoraISO() });
    return send(res, 200, { ok: true });
  }

  // webhook do Mercado Pago
  if (M === 'POST' && p === '/webhooks/mp') {
    const body = await lerJSON(req).catch(() => ({}));
    const id = q['data.id'] || (body.data && body.data.id) || q.id;
    const tipo = q.type || body.type || q.topic;
    if (!id || (tipo && tipo !== 'payment')) return send(res, 200, { ok: true });
    if (!mp.assinaturaValida(req.headers, String(id))) return erro(res, 401, 'assinatura inválida');
    try {
      const pg = await mp.consultar(String(id));
      if (pg && pg.ref) {
        const r = await db.get('SELECT * FROM reservas WHERE id = $1', [pg.ref]);
        if (r && r.mp_payment_id === pg.id) await aplicarPagamento(r, pg);
      }
    } catch (e) { console.error('[webhook]', e.message); return erro(res, 500, 'falha ao consultar'); }
    return send(res, 200, { ok: true });
  }

  // admin
  if (M === 'POST' && p === '/admin/login') {
    const b = await lerJSON(req);
    if (limitado(`login:${ipDe(req)}`, 10, 900e3)) return erro(res, 429, 'Muitas tentativas. Aguarde 15 minutos.');
    const ok = ADMIN_PASSWORD && typeof b.senha === 'string' && b.senha.length === ADMIN_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(b.senha), Buffer.from(ADMIN_PASSWORD));
    if (!ok) return erro(res, 401, 'Senha incorreta.');
    const seguro = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `adm=${encodeURIComponent(cookieAdmin())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${seguro}` });
  }
  if (M === 'POST' && p === '/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/; Max-Age=0' });

  if (p.startsWith('/admin/api/')) {
    if (!ehAdmin(req)) return erro(res, 401, 'Faça login.');
    const c = await cfg();
    if (M === 'GET' && p === '/admin/api/reservas') {
      const de = q.de || L.agoraLocal().data;
      const ate = q.ate || L.addDias(de, 60);
      const rs = await reservasEntre(de, ate);
      const agora = agoraISO();
      const lista = rs.map((r) => ({ ...r, pix_qr: undefined, status: r.status === 'pendente' && !L.ativa(r, agora) ? 'expirada' : r.status }));
      return send(res, 200, { reservas: lista, fixos: await fixosNoPeriodo(c, de, ate, rs), modoTeste: mp.modoTeste() });
    }
    if (M === 'POST' && p === '/admin/api/reservas') return send(res, 201, await criarReservaAdmin(await lerJSON(req)));
    m = /^\/admin\/api\/reservas\/([\w-]{36})$/.exec(p);
    if (M === 'POST' && m) {
      const b = await lerJSON(req);
      const r = await db.get('SELECT * FROM reservas WHERE id = $1', [m[1]]);
      if (!r) return erro(res, 404, 'Reserva não encontrada.');
      if (b.acao === 'cancelar') await db.run("UPDATE reservas SET status = 'cancelada' WHERE id = $1", [r.id]);
      else if (b.acao === 'confirmar') await db.run("UPDATE reservas SET status = 'confirmada', pago_em = COALESCE(pago_em, $1) WHERE id = $2", [agoraISO(), r.id]);
      else if (b.acao === 'simular_pago' && mp.modoTeste()) await aplicarPagamento(r, { status: 'approved', pagoEm: agoraISO() });
      else if (b.acao === 'obs') await db.run('UPDATE reservas SET obs = $1 WHERE id = $2', [String(b.obs || '').slice(0, 400), r.id]);
      else return erro(res, 400, 'Ação inválida.');
      return send(res, 200, { ok: true });
    }
    if (M === 'POST' && p === '/admin/api/fixo') {
      const b = await lerJSON(req);
      const chave = `${b.data}|${b.fixoId}`;
      const set = new Set(c.fixosCancelados || []);
      if (b.cancelar) set.add(chave); else set.delete(chave);
      await salvarCfg({ ...c, fixosCancelados: [...set].sort() });
      return send(res, 200, { ok: true });
    }
    if (M === 'GET' && p === '/admin/api/config') return send(res, 200, c);
    if (M === 'PUT' && p === '/admin/api/config') {
      const b = await lerJSON(req);
      const permitido = ['valorHora', 'abre', 'fecha', 'holdMin', 'salarioMinimo', 'precos', 'sinalEventoPct', 'feriados', 'fixos', 'diasAntecedencia', 'duracoes'];
      const novo = { ...c };
      for (const k of permitido) if (k in b) novo[k] = b[k];
      await salvarCfg(novo);
      return send(res, 200, novo);
    }
    return erro(res, 404, 'Rota não encontrada.');
  }

  return send(res, 404, 'Não encontrado');
}

async function main() {
  db = await open();
  // primeira subida: importa os eventos já combinados (seed.json)
  const cont = await db.get('SELECT COUNT(*) AS n FROM reservas');
  if (Number(cont.n) === 0 && fs.existsSync(path.join(__dirname, 'seed.json'))) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    for (const s of seed) await criarReservaAdmin(s);
    console.log(`[seed] ${seed.length} reservas importadas`);
  }
  console.log(`[db] ${db.kind}${mp.modoTeste() ? ' | Mercado Pago em MODO TESTE (sem MP_ACCESS_TOKEN)' : ''}`);
  http.createServer(async (req, res) => {
    try { await rotear(req, res); } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) erro(res, status, e.status ? e.message : 'Erro interno. Tente novamente.');
    }
  }).listen(PORT, () => console.log(`Arena Kanoa reservas na porta ${PORT}`));
}

if (require.main === module) main();
module.exports = { main };
