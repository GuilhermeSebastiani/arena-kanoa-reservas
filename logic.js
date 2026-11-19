// Regras da Arena: preços, horários, fixos e disponibilidade.

const DEFAULTS = {
  valorHora: 50,            // por quadra
  totalQuadras: 2,
  abre: '07:00',
  fecha: '23:00',
  passoMin: 30,
  duracoes: [60, 90, 120, 150, 180],
  diasAntecedencia: 90,
  holdMin: 30,              // minutos que o horário fica segurado aguardando o PIX (Mercado Pago)
  holdManualMin: 180,       // no PIX manual a Arena confirma olhando o extrato, então segura mais tempo
  salarioMinimo: 1621,
  precos: {
    arena: { semana: 1000, fimDeSemana: 'salarioMinimo' },
    quiosque: { semana: 400, fimDeSemana: 700 },
  },
  sinalEventoPct: 50,       // % do valor do evento cobrado no PIX para garantir a data
  feriados: [
    '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25',
    '2027-01-01', '2027-03-26', '2027-04-21', '2027-05-01', '2027-05-27',
    '2027-09-07', '2027-10-12', '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25',
  ],
  fixos: [
    { id: 'misto-seg', nome: 'Misto', dias: [1], inicio: '17:30', fim: '19:30', quadras: 2 },
    { id: 'thaila-ter', nome: 'Thaila', dias: [2], inicio: '17:30', fim: '19:30', quadras: 1 },
    { id: 'patricia-qua', nome: 'Patrícia Peterlini', dias: [3], inicio: '15:00', fim: '17:00', quadras: 1 },
    { id: 'thaila-qua', nome: 'Thaila', dias: [3], inicio: '17:00', fim: '19:00', quadras: 1 },
    { id: 'lidiane-qua', nome: 'Lidiane Pieroni', dias: [3], inicio: '17:30', fim: '19:30', quadras: 1 },
    { id: 'misto-qui', nome: 'Misto', dias: [4], inicio: '17:30', fim: '19:30', quadras: 2 },
  ],
  fixosCancelados: [],      // "YYYY-MM-DD|idDoFixo"
};

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round2 = (v) => Math.round(v * 100) / 100;

// "agora" no fuso de Sete Quedas (America/Campo_Grande, UTC-4)
function agoraLocal() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Campo_Grande', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  const hora = g('hour') === '24' ? '00' : g('hour');
  return { data: `${g('year')}-${g('month')}-${g('day')}`, min: toMin(`${hora}:${g('minute')}`) };
}

function addDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();

function ehFimDeSemanaOuFeriado(cfg, data) {
  const w = diaSemana(data);
  return w === 0 || w === 6 || (cfg.feriados || []).includes(data);
}

function precoEvento(cfg, data, espaco) {
  const tab = cfg.precos[espaco];
  if (!tab) return null;
  let v = ehFimDeSemanaOuFeriado(cfg, data) ? tab.fimDeSemana : tab.semana;
  if (v === 'salarioMinimo') v = cfg.salarioMinimo;
  return Number(v);
}

function precoQuadra(cfg, quadras, durMin) {
  return round2(quadras * (durMin / 60) * cfg.valorHora);
}

const ativa = (r, agoraISO) =>
  r.status === 'confirmada' || r.status === 'conflito' ||
  (r.status === 'pendente' && r.expira_em && r.expira_em > agoraISO);

const parseQuadras = (v, q, total) => {
  const arr = String(v || '').split(',').map(Number).filter((n) => n >= 1 && n <= total);
  return arr.length ? [...new Set(arr)].sort() : null;
};
const sobrepoe = (a, b) => a.ini < b.fim && b.ini < a.fim;

// Distribui os blocos nas quadras: quem já tem quadra definida fica nela; o resto vai
// preferencialmente para a Quadra 1, e só usa a Quadra 2 se a 1 estiver ocupada.
function alocar(cfg, blocos) {
  const total = cfg.totalQuadras;
  const ocup = {};
  for (let c = 1; c <= total; c++) ocup[c] = [];
  const fixos = blocos.filter((b) => b.courts);
  const auto = blocos.filter((b) => !b.courts).sort((x, y) => x.ini - y.ini || y.q - x.q);
  for (const b of fixos) for (const c of b.courts) ocup[c].push(b);
  for (const b of auto) {
    if (b.q >= total) b.courts = Array.from({ length: total }, (_, i) => i + 1);
    else {
      const livre = Object.keys(ocup).map(Number).find((c) => !ocup[c].some((o) => sobrepoe(o, b)));
      b.courts = [livre || 1];
      if (!livre) b.conflito = true;
    }
    for (const c of b.courts) ocup[c].push(b);
  }
  return ocup;
}

function quadrasLivresLista(ocup, ini, fim) {
  return Object.keys(ocup).map(Number).filter((c) => !ocup[c].some((o) => o.ini < fim && ini < o.fim));
}

// Tudo o que ocupa o dia: reservas ativas + fixos (que somem se houver evento da arena inteira)
function ocupacaoDoDia(cfg, data, reservas, agoraISO) {
  const doDia = reservas.filter((r) => r.data === data && ativa(r, agoraISO));
  const eventos = doDia.filter((r) => r.tipo === 'evento');
  const bloqueioTotal = doDia.some((r) => r.tipo === 'bloqueio' && r.espaco === 'tudo');
  const eventoArena = eventos.some((r) => r.espaco === 'arena');
  const quadrasBloqueadas = bloqueioTotal || eventoArena;

  const blocos = [];
  for (const r of doDia) {
    if (r.tipo === 'quadra' || (r.tipo === 'bloqueio' && r.espaco !== 'tudo')) {
      const q = Math.min(Number(r.quadras) || cfg.totalQuadras, cfg.totalQuadras);
      blocos.push({ ini: toMin(r.inicio || cfg.abre), fim: toMin(r.fim || cfg.fecha), q, courts: parseQuadras(r.quadras_num, q, cfg.totalQuadras), origem: r.id, nome: r.resp });
    }
  }
  const fixosDoDia = [];
  if (!quadrasBloqueadas) {
    const w = diaSemana(data);
    for (const f of cfg.fixos || []) {
      if (!f.dias.includes(w)) continue;
      if ((cfg.fixosCancelados || []).includes(`${data}|${f.id}`)) continue;
      const q = Math.min(Number(f.quadras) || 1, cfg.totalQuadras);
      const courts = q >= cfg.totalQuadras ? null : parseQuadras(f.quadra, q, cfg.totalQuadras);
      blocos.push({ ini: toMin(f.inicio), fim: toMin(f.fim), q, courts, origem: `fixo:${f.id}`, nome: f.nome });
      fixosDoDia.push(f);
    }
  }
  const ocup = alocar(cfg, blocos);
  return { doDia, eventos, bloqueioTotal, eventoArena, quadrasBloqueadas, blocos, fixosDoDia, ocup };
}

// quantas quadras ficam livres o intervalo inteiro (cada uma tem que estar livre do início ao fim)
function quadrasLivresNoIntervalo(cfg, blocos, ini, fim) {
  const ocup = alocar(cfg, blocos.map((b) => ({ ...b, courts: b.courts ? [...b.courts] : null })));
  return quadrasLivresLista(ocup, ini, fim).length;
}

// escolhe a(s) quadra(s) para uma reserva nova: Quadra 1 sempre que der
function escolherQuadras(cfg, oc, ini, fim, q) {
  const livres = quadrasLivresLista(oc.ocup, ini, fim);
  if (livres.length < q) return null;
  return livres.slice(0, q);
}

// grade do dia (de 30 em 30 min) com o que está ocupado em cada quadra, sem nomes
function gradeDoDia(cfg, oc) {
  const out = [];
  for (let t = toMin(cfg.abre); t < toMin(cfg.fecha); t += cfg.passoMin) {
    const linha = { hora: toHHMM(t) };
    for (let c = 1; c <= cfg.totalQuadras; c++) {
      linha[`q${c}`] = oc.quadrasBloqueadas || oc.ocup[c].some((o) => o.ini <= t && t < o.fim);
    }
    out.push(linha);
  }
  return out;
}

function validaData(cfg, data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return 'Data inválida.';
  const hoje = agoraLocal().data;
  if (data < hoje) return 'Essa data já passou.';
  if (data > addDias(hoje, cfg.diasAntecedencia)) return `Reservas abertas só para os próximos ${cfg.diasAntecedencia} dias.`;
  return null;
}

// Horários de início disponíveis para uma reserva de quadra
function horariosQuadra(cfg, data, durMin, quadras, reservas, agoraISO) {
  const oc = ocupacaoDoDia(cfg, data, reservas, agoraISO);
  if (oc.quadrasBloqueadas) return [];
  const agora = agoraLocal();
  const abre = toMin(cfg.abre), fecha = toMin(cfg.fecha);
  const out = [];
  for (let t = abre; t + durMin <= fecha; t += cfg.passoMin) {
    if (data === agora.data && t <= agora.min + 15) continue;
    if (quadrasLivresLista(oc.ocup, t, t + durMin).length >= quadras) out.push(toHHMM(t));
  }
  return out;
}

function eventoDisponivel(cfg, data, espaco, reservas, agoraISO) {
  const oc = ocupacaoDoDia(cfg, data, reservas, agoraISO);
  if (oc.bloqueioTotal) return false;
  if (oc.eventos.length) return false; // um evento por dia
  if (espaco === 'arena') {
    // não derruba quem já reservou quadra pelo site/painel; fixos cedem ao evento
    if (oc.doDia.some((r) => r.tipo === 'quadra')) return false;
  }
  return true;
}

// Resumo de um mês para o calendário público: por dia, se há horário de quadra e se evento está livre
function resumoMes(cfg, ano, mes, reservas, agoraISO) {
  const dias = [];
  const hoje = agoraLocal().data;
  const limite = addDias(hoje, cfg.diasAntecedencia);
  const n = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  for (let d = 1; d <= n; d++) {
    const data = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (data < hoje || data > limite) { dias.push({ data, aberto: false }); continue; }
    dias.push({
      data,
      aberto: true,
      quadra: horariosQuadra(cfg, data, 60, 1, reservas, agoraISO).length > 0,
      arena: eventoDisponivel(cfg, data, 'arena', reservas, agoraISO),
      quiosque: eventoDisponivel(cfg, data, 'quiosque', reservas, agoraISO),
      fimDeSemana: ehFimDeSemanaOuFeriado(cfg, data),
    });
  }
  return dias;
}

module.exports = {
  DEFAULTS, toMin, toHHMM, round2, agoraLocal, addDias, diaSemana, ehFimDeSemanaOuFeriado,
  precoEvento, precoQuadra, ativa, ocupacaoDoDia, quadrasLivresNoIntervalo, quadrasLivresLista, escolherQuadras, gradeDoDia, alocar, validaData,
  horariosQuadra, eventoDisponivel, resumoMes,
};
