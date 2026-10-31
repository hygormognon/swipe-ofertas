// Robô de coleta do swipe de ofertas. Abre a Biblioteca de Anúncios pública num
// Chromium headless (sem login), lê os anúncios que a página já traz embutidos no HTML
// e os que chegam pelo GraphQL ao rolar, e manda tudo para a edge function `swipe`.
// A extração segue o athm793/meta-ads-scraper (Apache 2.0).
//
// Uso:
//   node coletar.mjs                    pega as buscas devidas na API, coleta e grava
//   node coletar.mjs --checar           só imprime quantas buscas estão devidas (sem navegador)
//   node coletar.mjs --teste "termo" [--pais US] [--max 50] [--novos] [--saida x.json]
//                                       coleta um termo e grava em arquivo, sem a API
//   node coletar.mjs --raiox            só o raio-X das páginas de vendas pendentes
//   node coletar.mjs --raiox-teste URL  raio-X de uma página, sem a API
//
// Ambiente: SWIPE_API (URL da função), COLETOR_KEY (swipe_config.coletor_key),
// COLETOR_HORAS (idade mínima da última coleta para uma busca ficar devida; padrão 16),
// RADAR_MAX (anúncios da 2ª passada, a dos mais recentes; padrão 40 no PC, 0 no GitHub) e
// RAIOX_MAX (páginas de vendas lidas por rodada; padrão 40 no PC, 0 no GitHub).

import fs from "node:fs";
import { raioX } from "./raiox.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const API = process.env.SWIPE_API || "https://zdpiertlotdpxdufsjhr.supabase.co/functions/v1/swipe";
const KEY = process.env.COLETOR_KEY || "";
const BASE = "https://www.facebook.com/ads/library/";
const ORIGEM = process.env.GITHUB_ACTIONS ? "github" : "pc";
// No GitHub a Meta corta a paginação e os cloakers mostram página branca para IP de
// servidor: radar e raio-X só valem a pena no PC.
const RADAR_MAX = Number(process.env.RADAR_MAX ?? (ORIGEM === "pc" ? 40 : 0));
const RAIOX_MAX = Number(process.env.RAIOX_MAX ?? (ORIGEM === "pc" ? 40 : 0));

const espera = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function api(acao, dados = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-coletor": KEY },
    body: JSON.stringify({ acao, ...dados }),
  });
  const corpo = await r.json().catch(() => ({ erro: `HTTP ${r.status}` }));
  if (!r.ok || corpo.erro) throw new Error(`${acao}: ${corpo.erro || r.status}`);
  return corpo;
}

// modo "novos": a ordenação da Biblioteca que traz os anúncios mais recentes primeiro
// (o padrão da busca é a ordem por impressões).
function urlDaBusca(b, modo = "padrao") {
  if (b.tipo === "url") return b.termo;
  const u = new URL(BASE);
  u.searchParams.set("active_status", "active");
  u.searchParams.set("ad_type", "all");
  u.searchParams.set("country", b.pais || "US");
  u.searchParams.set("media_type", "all");
  if (b.tipo === "pagina") {
    const id = String(b.termo).match(/(?:view_all_page_id=|[?&]id=|^)(\d{5,})/)?.[1];
    if (!id) throw new Error("para vigiar uma página, use o ID numérico dela ou a URL da Biblioteca com view_all_page_id");
    u.searchParams.set("search_type", "page");
    u.searchParams.set("view_all_page_id", id);
    return u.toString();
  }
  u.searchParams.set("q", b.termo);
  u.searchParams.set("search_type", "keyword_unordered");
  if (modo === "novos") {
    u.searchParams.set("sort_data[direction]", "desc");
    u.searchParams.set("sort_data[mode]", "relevancy_monthly_grouped");
  }
  return u.toString();
}

// ---- Extração (formato cru da Meta -> formato do actor do Apify, que a função já entende) ----

function nosDeAnuncio(json, saida = [], prof = 0) {
  if (!json || typeof json !== "object" || prof > 40) return saida;
  if (Array.isArray(json)) {
    for (const n of json) nosDeAnuncio(n, saida, prof + 1);
    return saida;
  }
  if ("ad_archive_id" in json && json.snapshot) {
    saida.push(json);
    return saida;
  }
  for (const v of Object.values(json)) nosDeAnuncio(v, saida, prof + 1);
  return saida;
}

const texto = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v.text === "string") return v.text;
  if (typeof v.markup?.__html === "string") return v.markup.__html.replace(/<[^>]+>/g, " ");
  return "";
};
const semToken = (s) => (s && s.replace(/\{\{[^}]*\}\}/g, "").trim() ? s : "");

function converter(n) {
  const s = n.snapshot || {};
  const card = s.cards?.[0] || {};
  const imagem =
    s.images?.[0]?.resized_image_url || s.images?.[0]?.original_image_url ||
    card.resized_image_url || card.original_image_url ||
    s.videos?.[0]?.video_preview_image_url || card.video_preview_image_url || null;
  return {
    adArchiveId: String(n.ad_archive_id),
    pageId: String(n.page_id ?? s.page_id ?? ""),
    pageName: n.page_name ?? s.page_name ?? "",
    pageLikeCount: s.page_like_count ?? null,
    isActive: n.is_active ?? true,
    startDate: n.start_date ?? n.ad_delivery_start_time ?? null,
    endDate: n.end_date ?? n.ad_delivery_stop_time ?? null,
    collationCount: n.collation_count ?? 1,
    collationId: n.collation_id ?? null,
    displayFormat: s.display_format ?? "",
    linkUrl: s.link_url || card.link_url || null,
    linkCaption: s.caption || card.caption || null,
    title: semToken(s.title || card.title || ""),
    ctaText: s.cta_text || card.cta_text || "",
    bodyText: semToken(texto(s.body)) || semToken(texto(card.body)) || "",
    containsAiMedia: Boolean(n.contains_digital_created_media),
    adLibraryUrl: `https://www.facebook.com/ads/library/?id=${n.ad_archive_id}`,
    imageUrls: imagem ? [imagem] : [],
    videoUrls: [s.videos?.[0]?.video_hd_url || s.videos?.[0]?.video_sd_url || card.video_hd_url || card.video_sd_url].filter(Boolean),
    pageProfilePictureUrl: s.page_profile_picture_url ?? null,
  };
}

function extrairDoHtml(html) {
  const nos = [];
  const re = /<script[^>]+data-sjs[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!m[1].includes("ad_archive_id")) continue;
    try { nosDeAnuncio(JSON.parse(m[1]), nos); } catch { /* bloco que não é JSON */ }
  }
  return nos;
}

function extrairDoGraphql(textoResp) {
  const nos = [];
  for (const linha of textoResp.replace(/^for \(;;\);/, "").split("\n")) {
    const t = linha.trim();
    if (t[0] !== "{") continue;
    try { nosDeAnuncio(JSON.parse(t), nos); } catch { /* linha incompleta */ }
  }
  return nos;
}

async function aceitarCookies(page) {
  for (const sel of [
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Allow essential and optional cookies")',
  ]) {
    const b = page.locator(sel).first();
    if (await b.isVisible({ timeout: 1200 }).catch(() => false)) {
      await b.click().catch(() => {});
      await espera(700, 1200);
      return;
    }
  }
}

async function coletar(browser, busca, max, modo = "padrao") {
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const vistos = new Map();
  let bloqueado = false;
  let html = "";
  const diag = { graphql: 0, comAnuncios: 0, status: {}, nomes: {}, amostra: "" };
  const somar = (nos) => {
    for (const n of nos) if (!vistos.has(String(n.ad_archive_id))) vistos.set(String(n.ad_archive_id), converter(n));
  };
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      const st = resp.status();
      if ((url.includes("ads/library") || url.includes("/api/graphql")) && (st === 429 || st === 403)) bloqueado = true;
      if (url.includes("/api/graphql")) {
        diag.graphql++;
        diag.status[st] = (diag.status[st] || 0) + 1;
        const nome = resp.request().headers()["x-fb-friendly-name"] || "?";
        diag.nomes[nome] = (diag.nomes[nome] || 0) + 1;
        if (/Search|Pagination/i.test(nome) && !diag.amostra) {
          diag.amostra = (await resp.text().catch(() => "")).slice(0, 300);
        }
      }
      if (st !== 200) return;
      const metodo = resp.request().method();
      if (metodo === "GET" && url.includes("ads/library") && !html) {
        const t = await resp.text().catch(() => "");
        if (t.includes("ad_archive_id")) html = t;
      } else if (metodo === "POST" && url.includes("/api/graphql")) {
        const t = await resp.text().catch(() => "");
        if (t.includes("ad_archive_id")) { diag.comAnuncios++; somar(extrairDoGraphql(t)); }
      }
    } catch { /* resposta já descartada */ }
  });

  try {
    await page.goto(urlDaBusca(busca, modo), { waitUntil: "domcontentloaded", timeout: 45000 });
    await espera(3500, 5000);
    await aceitarCookies(page);
    if (html) somar(extrairDoHtml(html));
    let parado = 0;
    for (let i = 0; i < Math.ceil(max / 10) + 8 && vistos.size < max; i++) {
      const antes = vistos.size;
      // Rola de dois jeitos: o scroll por script nem sempre dispara o carregamento
      // infinito no headless; a roda do mouse gera os eventos que a página espera.
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })).catch(() => {});
      await page.mouse.wheel(0, 2500).catch(() => {});
      await espera(2500, 4000);
      if (vistos.size === antes) {
        if (++parado >= 4) break;
      } else parado = 0;
    }
    if (process.env.COLETOR_DIAG) {
      const pistas = await page.evaluate(() => {
        const t = document.body?.innerText || "";
        return { login: /log in|entrar|iniciar sesi/i.test(t.slice(-3000)), altura: document.body?.scrollHeight };
      }).catch(() => ({}));
      console.log(`   diag: ${JSON.stringify({ ...diag, ...pistas, html: Boolean(html), total: vistos.size })}`);
    }
  } finally {
    await context.close().catch(() => {});
  }
  if (!vistos.size && bloqueado) throw new Error("a Meta bloqueou o acesso (429/403)");
  // A busca padrão vem na ordem de impressões: a posição do anúncio é o sinal de verba
  // que existe fora da UE. Na passada dos mais recentes a ordem é outra e não conta.
  const lista = [...vistos.values()].slice(0, max);
  if (modo === "padrao" && busca.tipo === "termo") lista.forEach((a, i) => (a.posicao = i + 1));
  return lista;
}

// Coleta padrão + passada dos mais recentes, juntas num lote só (sem repetir anúncio).
async function coletarBusca(browser, b, max) {
  const itens = await coletar(browser, b, max);
  if (!RADAR_MAX || b.tipo !== "termo") return { itens, novos: 0 };
  await espera(3000, 6000);
  const ids = new Set(itens.map((a) => a.adArchiveId));
  let novos = 0;
  try {
    for (const a of await coletar(browser, b, RADAR_MAX, "novos")) {
      if (ids.has(a.adArchiveId)) continue;
      ids.add(a.adArchiveId);
      itens.push(a);
      novos++;
    }
  } catch (e) {
    console.log(`   radar falhou: ${e.message}`);
  }
  return { itens, novos };
}

async function rodarRaioX(browser) {
  if (!RAIOX_MAX) return;
  const { paginas } = await api("raiox_pendentes", { n: RAIOX_MAX });
  console.log(`raio-X: ${paginas.length} página(s) de vendas`);
  for (const p of paginas) {
    const t0 = Date.now();
    try {
      const r = await raioX(browser, p.link);
      await api("raiox_gravar", { chave: p.chave, url: p.link, ...r });
      console.log(`ok  raio-X ${p.chave}: ${r.preco != null ? `${r.moeda} ${r.preco}` : "sem preço"} · ${r.checkout || "sem checkout"} · ${r.formato} em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      const msg = e.message.split("\n")[0].slice(0, 300);
      console.log(`erro raio-X ${p.chave}: ${msg}`);
      await api("raiox_gravar", { chave: p.chave, url: p.link, erro: msg }).catch(() => {});
    }
  }
}

async function abrirNavegador() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
}

async function main() {
  if (flag("--checar", false)) {
    const { buscas } = await api("coletor_buscas", { horas: Number(process.env.COLETOR_HORAS) || 16 });
    console.log(`devidas=${buscas.length}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `devidas=${buscas.length}\n`);
    return;
  }

  const urlTeste = flag("--raiox-teste", null);
  if (urlTeste) {
    const browser = await abrirNavegador();
    try {
      console.log(JSON.stringify(await raioX(browser, urlTeste), null, 1));
    } finally {
      await browser.close();
    }
    return;
  }

  const teste = flag("--teste", null);
  if (teste) {
    const browser = await abrirNavegador();
    try {
      const busca = { tipo: "termo", termo: teste, pais: flag("--pais", "US") };
      const t0 = Date.now();
      const itens = await coletar(browser, busca, Number(flag("--max", 50)), flag("--novos", false) ? "novos" : "padrao");
      console.log(`${itens.length} anúncios em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      const dia = (v) => (v ? new Date(typeof v === "number" ? v * 1000 : v).toISOString().slice(0, 10) : "?");
      for (const a of itens.slice(0, 8)) console.log(`- ${a.pageName} | ${a.linkUrl} | início ${dia(a.startDate)} | var ${a.collationCount} | ${String(a.title).slice(0, 60)}`);
      const saida = flag("--saida", null);
      if (saida) fs.writeFileSync(saida, JSON.stringify(itens, null, 1));
    } finally {
      await browser.close();
    }
    return;
  }

  if (!KEY) throw new Error("COLETOR_KEY não definida");
  if (flag("--raiox", false)) {
    const browser = await abrirNavegador();
    try { await rodarRaioX(browser); } finally { await browser.close(); }
    return;
  }
  const { buscas, max_ads } = await api("coletor_buscas", { horas: Number(process.env.COLETOR_HORAS) || 16 });
  console.log(`${buscas.length} busca(s) devida(s), ${max_ads} anúncios cada${RADAR_MAX ? ` + até ${RADAR_MAX} mais recentes` : ""}`);
  if (!buscas.length && !RAIOX_MAX) return;
  const browser = await abrirNavegador();
  let gravadas = 0;
  try {
    for (const b of buscas) {
      const t0 = Date.now();
      try {
        const { itens, novos } = await coletarBusca(browser, b, max_ads);
        const r = await api("ingerir", { busca_id: b.id, itens, origem: ORIGEM });
        gravadas++;
        console.log(`ok  ${b.pais} "${b.termo}": ${itens.length} anúncios${novos ? ` (${novos} do radar)` : ""}, ${r.anuncios} gravados em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.log(`erro ${b.pais} "${b.termo}": ${e.message}`);
        await api("ingerir", { busca_id: b.id, erro: e.message, origem: ORIGEM }).catch(() => {});
      }
      await espera(4000, 8000);
    }
    if (gravadas) {
      const r = await api("recalcular");
      console.log(`ranking recalculado: ${r.ofertas} ofertas`);
    }
    // Depois do ranking, para o raio-X pegar as ofertas que acabaram de subir.
    await rodarRaioX(browser).catch((e) => console.log(`raio-X parou: ${e.message}`));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
