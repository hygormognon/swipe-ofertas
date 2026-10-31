// API do swipe de ofertas. Uma função só, roteada pelo campo `acao` do corpo.
// - A tela manda `x-senha` (secret SWIPE_SENHA).
// - O pg_cron manda `x-cron` (swipe_config.cron_key), para `coletar` e `processar`.
// - O robô do GitHub Actions manda `x-coletor` (swipe_config.coletor_key), para
//   `coletor_buscas`, `ingerir` e `recalcular`.
// Duas fontes de coleta, escolhidas em swipe_config.coleta.fonte:
// - "robo" (padrão): o robô roda de hora em hora, pede as buscas devidas, raspa a
//   Biblioteca e manda os anúncios pelo `ingerir`. O cron do banco não faz nada.
// - "apify": uma execução do Apify por busca, até `max_paralelo` ao mesmo tempo; o cron
//   chama `processar` a cada 5 minutos para baixar as que terminaram.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") ?? "";
const SENHA = Deno.env.get("SWIPE_SENHA") ?? "";
const ACTOR = "automation-lab~facebook-ads-library";
const CAMPOS = [
  "adArchiveId", "pageId", "pageName", "pageLikeCount", "isActive", "startDate", "endDate",
  "collationCount", "collationId", "displayFormat", "linkUrl", "linkCaption", "title", "ctaText",
  "bodyText", "containsAiMedia", "adLibraryUrl", "imageUrls", "videoUrls", "videoPreviewUrls", "pageProfilePictureUrl",
].join(",");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-senha, x-cron, x-coletor, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Cfg = { ativo: boolean; fonte: "robo" | "apify"; max_ads: number; max_paralelo: number; janela_dias: number };

async function config(): Promise<Cfg> {
  const { data } = await SB.from("swipe_config").select("valor").eq("chave", "coleta").single();
  return { ativo: true, fonte: "robo", max_ads: 100, max_paralelo: 3, janela_dias: 3, ...(data?.valor ?? {}) };
}

const chaves: Record<string, string> = {};
async function chaveInterna(nome: "cron_key" | "coletor_key") {
  if (chaves[nome] === undefined) {
    const { data } = await SB.from("swipe_config").select("valor").eq("chave", nome).maybeSingle();
    chaves[nome] = data?.valor?.k ?? "";
  }
  return chaves[nome];
}

async function apify(caminho: string, init: RequestInit = {}) {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN não configurado no Supabase");
  const r = await fetch(`https://api.apify.com/v2${caminho}`, {
    ...init,
    headers: { Authorization: `Bearer ${APIFY_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Apify ${r.status}: ${corpo?.error?.message ?? "erro"}`);
  return corpo;
}

// ---- Normalização: mesma lógica do minerar.mjs ----

const REDES = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|messenger\.com|instagram\.com|threads\.net|youtube\.com|youtu\.be|tiktok\.com|linktr\.ee|t\.me|telegram\.me|m\.me)$/;
const X1 = /(^|\.)(wa\.me|whatsapp\.com|api\.whatsapp\.com|chat\.whatsapp\.com)$/;
const APP = /(^|\.)(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|adjust\.com|onelink\.me|app\.link|appsflyer\.com|go\.link)$/;
// Marketplaces (físico) e plataformas de produto digital juntam muitos vendedores no mesmo
// domínio: nos dois casos a oferta é agrupada por página, como nas redes.
const MARKET = /(^|\.)(amazon\.[a-z.]+|amzn\.to|ebay\.[a-z.]+|walmart\.com|temu\.com|aliexpress\.com|shein\.com)$/;
const PLATAFORMA = /(^|\.)(etsy\.com|teacherspayteachers\.com|gumroad\.com|udemy\.com|skillshare\.com|stan\.store|payhip\.com|ko-fi\.com|patreon\.com)$/;

// O Postgres recusa o caractere nulo e metades soltas de emoji (comuns quando o texto
// é cortado no meio de um par UTF-16); sem limpar, o lote inteiro volta como JSON inválido.
const limpo = (s: unknown) =>
  typeof s === "string" ? s.replace(/\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "") : s;
const cut = (s: unknown, n: number) =>
  typeof s === "string" ? String(limpo(s.length > n ? s.slice(0, n) + "…" : s)) : "";
const toDate = (v: unknown) => {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v).length === 10 ? `${v}T12:00:00Z` : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function dominioDe(link: string, legenda: string) {
  try {
    if (link) return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch { /* link inválido: tenta a legenda */ }
  const c = String(legenda || "").toLowerCase().replace(/^www\./, "").trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(c) ? c : "";
}

function classificar(texto: string, titulo: string, cta: string, link: string, dom: string) {
  const txt = `${texto} ${titulo}`.toLowerCase();
  if (!dom) return /message|mensaje|mensagem|whatsapp/.test(cta.toLowerCase()) ? "x1" : "outros";
  if (X1.test(dom)) return "x1";
  if (APP.test(dom)) return "app";
  if (REDES.test(dom)) return "outros";
  if (MARKET.test(dom)) return "marketplace";
  if (/\/products?\/|\/collections\/|\/cart/.test(link) || /contra ?entrega|pago contra|frete gr[aá]tis|env[ií]o gratis|free shipping|cash on delivery/.test(txt)) return "fisico";
  return "info";
}

// deno-lint-ignore no-explicit-any
function normalizar(it: any, busca: string, pais: string) {
  const id = String(it.adArchiveId ?? it.adArchiveID ?? "");
  if (!id) return null;
  const link = it.linkUrl ?? "";
  const titulo = it.title ?? "";
  const texto = cut(it.bodyText ?? "", 600);
  const cta = it.ctaText ?? "";
  const dom = dominioDe(link, it.linkCaption ?? "");
  const paginaId = String(it.pageId ?? "");
  const chave = dom && !REDES.test(dom) && !X1.test(dom) && !APP.test(dom) && !MARKET.test(dom) && !PLATAFORMA.test(dom) ? dom : `pagina:${paginaId}`;
  const linha = {
    id,
    pagina_id: paginaId,
    pagina: it.pageName ?? "",
    curtidas_pagina: Number.isFinite(it.pageLikeCount) ? it.pageLikeCount : null,
    ativo: it.isActive ?? true,
    inicio: toDate(it.startDate),
    fim: toDate(it.endDate),
    variacoes: Number(it.collationCount ?? 1) || 1,
    colacao: it.collationId ? String(it.collationId) : "",
    formato: it.displayFormat ?? "",
    link,
    dominio_legenda: it.linkCaption ?? "",
    titulo,
    cta,
    texto,
    ia: Boolean(it.containsAiMedia),
    url_biblioteca: it.adLibraryUrl ?? `https://www.facebook.com/ads/library/?id=${id}`,
    imagem: it.imageUrls?.[0] ?? it.videoPreviewUrls?.[0] ?? null,
    video: it.videoUrls?.[0] ?? null,
    pagina_foto: it.pageProfilePictureUrl ?? null,
    dominio: dom,
    chave,
    tipo: classificar(texto, titulo, cta, link, dom),
    buscas: busca ? [busca] : [],
    paises: pais ? [pais] : [],
  };
  return Object.fromEntries(Object.entries(linha).map(([k, v]) => [k, limpo(v)])) as typeof linha;
}

// ---- Coleta ----

function inputDaBusca(c: { tipo: string; termo: string; pais: string; max_ads: number }) {
  const base = { country: c.pais || "US", activeStatus: "active", mediaType: "all", maxAds: c.max_ads };
  if (c.tipo === "pagina") return { ...base, pageUrls: [c.termo] };
  if (c.tipo === "url") return { ...base, adsLibraryUrls: [c.termo] };
  return { ...base, searchQueries: [c.termo] };
}

async function enfileirar(ids?: number[]) {
  const cfg = await config();
  let q = SB.from("swipe_buscas").select("*").eq("ativo", true);
  if (ids?.length) q = SB.from("swipe_buscas").select("*").in("id", ids);
  const { data: buscas, error } = await q;
  if (error) throw error;
  const { data: abertas } = await SB.from("swipe_coletas").select("busca_id").in("status", ["fila", "rodando"]);
  const ocupadas = new Set((abertas ?? []).map((c) => c.busca_id));
  const novas = (buscas ?? [])
    .filter((b) => !ocupadas.has(b.id))
    .map((b) => ({ busca_id: b.id, termo: b.termo, tipo: b.tipo, pais: b.pais, max_ads: cfg.max_ads, status: "fila" }));
  if (novas.length) {
    const { error: e2 } = await SB.from("swipe_coletas").insert(novas);
    if (e2) throw e2;
  }
  return novas.length;
}

// Normaliza e grava um lote cru (formato do actor do Apify, que o robô também usa).
// deno-lint-ignore no-explicit-any
async function gravarItens(lote: any[], busca: { tipo: string; termo: string; pais: string }) {
  const unicos = new Map<string, ReturnType<typeof normalizar>>();
  for (const it of lote) {
    if (it?.error) continue;
    const a = normalizar(it, busca.tipo === "termo" ? busca.termo : `${busca.tipo}: ${busca.termo}`, busca.pais);
    if (a) unicos.set(a.id, a);
  }
  const itens = [...unicos.values()];
  for (let i = 0; i < itens.length; i += 500) {
    const { error } = await SB.rpc("swipe_ingerir", { itens: itens.slice(i, i + 500) });
    if (error) throw error;
  }
  return itens.length;
}

// Buscas que o robô deve rodar agora: as pedidas pela tela (coleta na fila) e as
// ativas sem coleta boa nas últimas 20 horas, pulando as que deram erro há menos de 3.
async function buscasDevidas() {
  const cfg = await config();
  const [{ data: buscas }, { data: recentes }] = await Promise.all([
    SB.from("swipe_buscas").select("id,termo,tipo,pais,ativo").order("id"),
    SB.from("swipe_coletas").select("busca_id,status,criado_em,processado_em").gte("criado_em", new Date(Date.now() - 20 * 3600_000).toISOString()),
  ]);
  const pedidas = new Set((recentes ?? []).filter((c) => c.status === "fila").map((c) => c.busca_id));
  const feitas = new Set((recentes ?? []).filter((c) => c.status === "processada").map((c) => c.busca_id));
  const comErro = new Set(
    (recentes ?? []).filter((c) => c.status === "erro" && Date.now() - new Date(c.processado_em ?? c.criado_em).getTime() < 3 * 3600_000).map((c) => c.busca_id),
  );
  const devidas = (buscas ?? []).filter((b) =>
    pedidas.has(b.id) || (cfg.ativo && b.ativo && !feitas.has(b.id) && !comErro.has(b.id))
  );
  return { buscas: devidas.slice(0, 40), max_ads: cfg.max_ads };
}

// deno-lint-ignore no-explicit-any
async function ingerirDoRobo(b: any) {
  const { data: busca, error } = await SB.from("swipe_buscas").select("*").eq("id", b.busca_id).single();
  if (error) throw error;
  const { data: fila } = await SB.from("swipe_coletas").select("id").eq("busca_id", busca.id).eq("status", "fila").order("id").limit(1);
  const agora = new Date().toISOString();
  let linha;
  if (b.erro) {
    linha = { status: "erro", erro: String(b.erro).slice(0, 500), processado_em: agora };
  } else {
    const n = await gravarItens(Array.isArray(b.itens) ? b.itens : [], busca);
    linha = { status: "processada", anuncios: n, custo_usd: 0, processado_em: agora };
  }
  const base = { busca_id: busca.id, termo: busca.termo, tipo: busca.tipo, pais: busca.pais, iniciado_em: agora, run_id: "robo" };
  const r = fila?.length
    ? await SB.from("swipe_coletas").update({ ...linha, iniciado_em: agora, run_id: "robo" }).eq("id", fila[0].id)
    : await SB.from("swipe_coletas").insert({ ...base, ...linha, max_ads: (await config()).max_ads });
  if (r.error) throw r.error;
  return { ok: true, anuncios: "anuncios" in linha ? linha.anuncios : 0 };
}

// deno-lint-ignore no-explicit-any
async function baixarEGravar(c: any) {
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(
      `https://api.apify.com/v2/datasets/${c.dataset_id}/items?format=json&clean=1&limit=1000&offset=${offset}&fields=${CAMPOS}`,
      { headers: { Authorization: `Bearer ${APIFY_TOKEN}` } },
    );
    if (!r.ok) throw new Error(`Apify ${r.status} ao baixar o dataset ${c.dataset_id}`);
    const lote = await r.json();
    total += await gravarItens(lote, c);
    if (lote.length < 1000) break;
  }
  return total;
}

async function processar() {
  const cfg = await config();
  const saida = { processadas: 0, erros: 0, iniciadas: 0, rodando: 0 };
  // Com o robô, a fila é dele: o Apify não entra.
  if (cfg.fonte !== "apify") return saida;
  const { data: rodando } = await SB.from("swipe_coletas").select("*").eq("status", "rodando").order("iniciado_em");
  let mudou = false;
  for (const c of rodando ?? []) {
    try {
      const run = (await apify(`/actor-runs/${c.run_id}`)).data;
      const custo = run?.usageTotalUsd ?? null;
      if (run?.status === "SUCCEEDED") {
        // No máximo 2 por chamada, para caber no tempo da função; o resto vai na próxima.
        if (saida.processadas >= 2) { saida.rodando++; continue; }
        const n = await baixarEGravar(c);
        await SB.from("swipe_coletas").update({ status: "processada", anuncios: n, custo_usd: custo, processado_em: new Date().toISOString() }).eq("id", c.id);
        saida.processadas++;
        mudou = true;
      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run?.status)) {
        await SB.from("swipe_coletas").update({ status: "erro", erro: `Apify: ${run.status}`, custo_usd: custo, processado_em: new Date().toISOString() }).eq("id", c.id);
        saida.erros++;
      } else if (Date.now() - new Date(c.iniciado_em).getTime() > 3 * 3600_000) {
        await SB.from("swipe_coletas").update({ status: "erro", erro: "passou de 3 horas rodando", processado_em: new Date().toISOString() }).eq("id", c.id);
        saida.erros++;
      } else {
        saida.rodando++;
      }
    } catch (e) {
      await SB.from("swipe_coletas").update({ status: "erro", erro: String((e as Error).message ?? e), processado_em: new Date().toISOString() }).eq("id", c.id);
      saida.erros++;
    }
  }
  if (mudou) {
    const { error } = await SB.rpc("swipe_recalcular");
    if (error) throw error;
  }

  const vagas = Math.max(0, cfg.max_paralelo - saida.rodando);
  if (vagas) {
    const { data: fila } = await SB.from("swipe_coletas").select("*").eq("status", "fila").order("id").limit(vagas);
    for (const c of fila ?? []) {
      try {
        const run = (await apify(`/acts/${ACTOR}/runs`, { method: "POST", body: JSON.stringify(inputDaBusca(c)) })).data;
        await SB.from("swipe_coletas").update({ status: "rodando", run_id: run.id, dataset_id: run.defaultDatasetId, iniciado_em: new Date().toISOString() }).eq("id", c.id);
        saida.iniciadas++;
      } catch (e) {
        await SB.from("swipe_coletas").update({ status: "erro", erro: String((e as Error).message ?? e), processado_em: new Date().toISOString() }).eq("id", c.id);
        saida.erros++;
        if (String(e).includes("APIFY_TOKEN")) break;
      }
    }
  }
  return saida;
}

// ---- Download do criativo ----

// Só mídia da própria Meta: o proxy não vira um baixador de qualquer URL.
const MIDIA_OK = /(^|\.)fbcdn\.net$/;

// deno-lint-ignore no-explicit-any
async function baixar(b: any) {
  const { data: a, error } = await SB.from("swipe_anuncios").select("id,pagina,video,imagem").eq("id", String(b.id)).single();
  if (error) throw error;
  const imagem = b.tipo === "imagem";
  const url = imagem ? a.imagem : a.video;
  if (!url) throw new Error(`esse anúncio não tem ${imagem ? "imagem" : "vídeo"} guardado`);
  if (!MIDIA_OK.test(new URL(url).hostname)) throw new Error("link de mídia fora do fbcdn");
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(r.status === 403 || r.status === 410
      ? "o link da Meta venceu; ele é renovado na próxima coleta deste anúncio"
      : `a Meta respondeu ${r.status}`);
  }
  const tipo = r.headers.get("content-type") ?? (imagem ? "image/jpeg" : "video/mp4");
  const ext = /png/.test(tipo) ? "png" : /webp/.test(tipo) ? "webp" : /jpe?g/.test(tipo) ? "jpg" : "mp4";
  const nome = `${String(a.pagina || "anuncio").normalize("NFD").replace(/[^\w-]+/g, "_").slice(0, 40)}_${a.id}.${ext}`;
  return new Response(r.body, {
    headers: {
      ...CORS,
      "Content-Type": tipo,
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
    },
  });
}

// ---- Consultas da tela ----

const ORDENS = new Set(["score", "dias_no_ar", "variacoes", "anuncios_ativos", "novos_7d", "paginas", "delta_ativos", "primeira_vez"]);

// deno-lint-ignore no-explicit-any
async function ofertas(f: any) {
  let q = SB.from("swipe_ofertas_v").select("*", { count: "exact" });
  if (f.tipo && f.tipo !== "todos") q = q.eq("tipo", f.tipo);
  if (Array.isArray(f.fases) && f.fases.length) q = q.in("fase", f.fases);
  if (f.min_dias) q = q.gte("dias_no_ar", Number(f.min_dias));
  if (f.pais) q = q.contains("paises", [f.pais]);
  if (f.busca) q = q.contains("buscas", [f.busca]);
  if (f.tendencia) q = q.eq("tendencia", f.tendencia);
  else if (!f.incluir_sumidas) q = q.neq("tendencia", "sumiu");
  if (f.marca && f.marca !== "todas") q = q.eq("marca", f.marca === "sem" ? "" : f.marca);
  else if (!f.marca) q = q.neq("marca", "descartada");
  if (f.novas_dias) q = q.gte("primeira_vez", new Date(Date.now() - Number(f.novas_dias) * 86400_000).toISOString().slice(0, 10));
  const t = String(f.texto ?? "").replace(/[,()*%\\]/g, " ").trim();
  if (t) q = q.or(`dominio.ilike.*${t}*,titulo_exemplo.ilike.*${t}*,texto_exemplo.ilike.*${t}*`);
  const ordem = ORDENS.has(f.ordem) ? f.ordem : "score";
  q = q.order(ordem, { ascending: false, nullsFirst: false });
  if (ordem !== "score") q = q.order("score", { ascending: false });
  const limite = Math.min(Number(f.limite) || 100, 300);
  const inicio = Number(f.offset) || 0;
  const { data, count, error } = await q.range(inicio, inicio + limite - 1);
  if (error) throw error;
  return { ofertas: data, total: count };
}

async function oferta(chave: string) {
  const [o, ads, hist] = await Promise.all([
    SB.from("swipe_ofertas_v").select("*").eq("chave", chave).single(),
    SB.from("swipe_anuncios").select("*").eq("chave", chave).order("ativo", { ascending: false }).order("variacoes", { ascending: false }).limit(80),
    SB.from("swipe_ofertas_hist").select("dia,score,anuncios_ativos,variacoes,paginas,fase").eq("chave", chave).order("dia").limit(120),
  ]);
  if (o.error) throw o.error;
  return { oferta: o.data, anuncios: ads.data ?? [], hist: hist.data ?? [] };
}

const PERMITIDAS: Record<string, string[]> = {
  cron: ["coletar", "processar"],
  coletor: ["coletor_buscas", "ingerir", "recalcular"],
};

// deno-lint-ignore no-explicit-any
async function rotear(acao: string, b: any, via: "senha" | "cron" | "coletor") {
  if (via !== "senha" && !PERMITIDAS[via].includes(acao)) throw new Error(`ação não permitida para ${via}`);
  switch (acao) {
    case "coletor_buscas":
      return await buscasDevidas();
    case "ingerir":
      return await ingerirDoRobo(b);
    case "ping":
      return { ok: true, apify: Boolean(APIFY_TOKEN) };
    case "resumo": {
      const [{ data, error }, cfg] = await Promise.all([SB.rpc("swipe_resumo"), config()]);
      if (error) throw error;
      return { ...data, config: cfg, apify: Boolean(APIFY_TOKEN) };
    }
    case "ofertas":
      return await ofertas(b.filtros ?? {});
    case "oferta":
      return await oferta(String(b.chave));
    case "marcar": {
      const chave = String(b.chave);
      if (!b.status && !b.nota) {
        await SB.from("swipe_marcas").delete().eq("chave", chave);
      } else {
        const { error } = await SB.from("swipe_marcas").upsert({ chave, status: b.status || null, nota: b.nota ?? null, atualizado_em: new Date().toISOString() });
        if (error) throw error;
      }
      return { ok: true };
    }
    case "buscas": {
      const [bs, cs] = await Promise.all([
        SB.from("swipe_buscas").select("*").order("pais").order("termo"),
        SB.from("swipe_coletas").select("busca_id,status,anuncios,criado_em,processado_em,erro").order("id", { ascending: false }).limit(500),
      ]);
      if (bs.error) throw bs.error;
      return { buscas: bs.data, coletas: cs.data ?? [] };
    }
    case "busca_salvar": {
      const linha = {
        termo: String(b.termo ?? "").trim(),
        tipo: ["termo", "pagina", "url"].includes(b.tipo) ? b.tipo : "termo",
        pais: String(b.pais || "US").toUpperCase().trim(),
        nicho: b.nicho ? String(b.nicho).trim() : null,
        ativo: b.ativo !== false,
      };
      if (!linha.termo) throw new Error("termo vazio");
      const r = b.id
        ? await SB.from("swipe_buscas").update(linha).eq("id", b.id)
        : await SB.from("swipe_buscas").upsert(linha, { onConflict: "tipo,termo,pais" });
      if (r.error) throw r.error;
      return { ok: true };
    }
    case "busca_apagar": {
      const { error } = await SB.from("swipe_buscas").delete().eq("id", b.id);
      if (error) throw error;
      return { ok: true };
    }
    case "config_salvar": {
      const atual = await config();
      const novo = {
        ativo: b.ativo ?? atual.ativo,
        fonte: b.fonte === "apify" ? "apify" : b.fonte === "robo" ? "robo" : atual.fonte,
        max_ads: Math.min(500, Math.max(10, Number(b.max_ads ?? atual.max_ads))),
        max_paralelo: Math.min(10, Math.max(1, Number(b.max_paralelo ?? atual.max_paralelo))),
        janela_dias: Math.min(14, Math.max(1, Number(b.janela_dias ?? atual.janela_dias))),
      };
      const { error } = await SB.from("swipe_config").upsert({ chave: "coleta", valor: novo });
      if (error) throw error;
      return { ok: true, config: novo };
    }
    case "coletas": {
      const { data, error } = await SB.from("swipe_coletas").select("*").order("id", { ascending: false }).limit(100);
      if (error) throw error;
      return { coletas: data };
    }
    case "coletar": {
      const cfg = await config();
      // O cron só dispara o Apify, e respeita o liga/desliga. Com o robô, ele mesmo
      // decide o que está devido; o botão da tela só põe as buscas na fila dele.
      if (via === "cron" && (!cfg.ativo || cfg.fonte !== "apify")) return { ok: true, ignorada: true };
      const n = await enfileirar(Array.isArray(b.ids) ? b.ids : undefined);
      const p = await processar();
      return { enfileiradas: n, fonte: cfg.fonte, ...p };
    }
    case "processar":
      return await processar();
    case "recalcular": {
      const { data, error } = await SB.rpc("swipe_recalcular");
      if (error) throw error;
      return { ofertas: data };
    }
    default:
      throw new Error(`ação desconhecida: ${acao}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const senha = req.headers.get("x-senha") ?? "";
  const cron = req.headers.get("x-cron") ?? "";
  const coletor = req.headers.get("x-coletor") ?? "";
  let via: "senha" | "cron" | "coletor" | null = null;
  if (SENHA && senha === SENHA) via = "senha";
  else if (cron && cron === (await chaveInterna("cron_key"))) via = "cron";
  else if (coletor && coletor === (await chaveInterna("coletor_key"))) via = "coletor";
  if (!via) return json({ erro: SENHA ? "senha incorreta" : "SWIPE_SENHA não configurada no Supabase" }, 401);
  try {
    const b = await req.json().catch(() => ({}));
    if (b.acao === "baixar" && via === "senha") return await baixar(b);
    return json(await rotear(String(b.acao ?? ""), b, via));
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 400);
  }
});
