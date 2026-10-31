// Raio-X da página de vendas: abre o link do anúncio e lê preço, checkout, formato
// (VSL, quiz, TSL, página), player de vídeo, order bump e garantia. Roda no PC, porque
// cloaker costuma mostrar página branca para IP de servidor.
//
// `analisar` é puro (recebe o que a página tinha) para poder ser testado sem navegador.

const CHECKOUTS = [
  ["hotmart", /pay\.hotmart\.com|go\.hotmart\.com|hotmart\.com\/[^"' ]*checkout/],
  ["kiwify", /pay\.kiwify\.com|kiwify\.com\.br/],
  ["eduzz", /sun\.eduzz\.com|chk\.eduzz\.com|eduzz\.com\/checkout/],
  ["monetizze", /monetizze\.com\.br/],
  ["perfectpay", /perfectpay\.com\.br/],
  ["cakto", /cakto\.com\.br|pay\.cakto/],
  ["kirvano", /kirvano\.com/],
  ["ticto", /ticto\.com\.br|ticto\.app/],
  ["braip", /braip\.com/],
  ["greenn", /greenn\.com\.br/],
  ["lastlink", /lastlink\.com/],
  ["pepper", /pepper\.com\.br/],
  ["yampi", /yampi\.com\.br|yampi\.io/],
  ["appmax", /appmax\.com\.br/],
  ["clickbank", /clickbank\.net|clkbank\.com/],
  ["digistore24", /digistore24\.com/],
  ["buygoods", /buygoods\.com/],
  ["maxweb", /maxweb\.com/],
  ["stripe", /buy\.stripe\.com|checkout\.stripe\.com/],
  ["paypal", /paypal\.com\/(?:cgi-bin|checkoutnow|ncp|webapps|paypalme)/],
  ["samcart", /samcart\.com/],
  ["thrivecart", /thrivecart\.com/],
  ["cartpanda", /cartpanda\.com/],
  ["checkoutchamp", /checkoutchamp\.com/],
  ["gumroad", /gumroad\.com/],
  ["payhip", /payhip\.com/],
  ["systeme", /systeme\.io/],
  ["clickfunnels", /clickfunnels\.com|myclickfunnels\.com/],
  ["kajabi", /kajabi\.com|mykajabi\.com/],
  ["stan", /stan\.store/],
  ["podia", /podia\.com/],
  ["teachable", /teachable\.com/],
  ["whop", /whop\.com/],
  ["shopify", /cdn\.shopify\.com|myshopify\.com|\/cart\/\d/],
];

const PLAYERS = [
  ["vturb", /converteai\.net|vturb/],
  ["panda", /pandavideo/],
  ["wistia", /wistia\.(?:com|net)|fast\.wistia/],
  ["vidalytics", /vidalytics/],
  ["vimeo", /player\.vimeo\.com/],
  ["youtube", /youtube\.com\/embed|youtube-nocookie\.com/],
  ["smartplayer", /smartplayer|scripts\.converteai/],
  ["spotlightr", /spotlightr|vooplayer/],
];

const QUIZ = /inlead\.|typeform\.com|heyflow\.|xquiz|quiz\.|\/quiz|question \d+ of \d+|pergunta \d+ de \d+|step \d+ of \d+|take the quiz|fa[çc]a o quiz|responda (?:o|ao) quiz/i;
const BUMP = /order bump|yes,? (?:i want to )?add|yes!? add|add (?:this )?to (?:my )?order|one[- ]time offer|sim,? (?:eu )?quero (?:adicionar|levar|incluir)|adicionar ao (?:meu )?pedido|oferta [úu]nica|levar junto/i;
const GARANTIA = /(\d{1,3})[- ]?(?:day|dias?)\s+(?:100% )?(?:money[- ]back |unconditional |incondicional )?(?:guarantee|garantia)|garantia (?:incondicional |total )?de (\d{1,3}) dias|(\d{1,3})[- ]day (?:refund|risk[- ]free)/i;

// Loja de produto físico (advertorial de sapato, suplemento, gadget): carrinho, frete e
// estoque, sem nenhum sinal de entrega digital.
const FISICO = /add to cart|adicionar ao carrinho|free shipping|frete gr[aá]tis|calcular frete|ships (?:in|within|from|free)|shipping (?:&|and) returns|in stock|em estoque|out of stock|sold out|esgotado|tracking number|c[oó]digo de rastreio/i;
const DIGITAL = /instant (?:access|download)|acesso (?:imediato|vital[ií]cio)|digital (?:download|product|access)|produto digital|e-?book|pdf|printable|online (?:course|program)|curso online|members? area|[áa]rea de membros|receba no (?:seu )?e-?mail|delivered (?:by|via|to your) e-?mail/i;

// Câmbio aproximado só para o filtro "até US$ X" comparar moedas; a tela mostra o preço original.
const PARA_USD = { USD: 1, BRL: 0.18, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, MXN: 0.055 };

function numero(s, moeda) {
  // BRL e EUR usam vírgula decimal; USD e GBP, ponto. "1.297,00" / "1,297.00" / "47,90" / "9.99".
  let t = s.trim();
  if (moeda === "BRL" || moeda === "EUR") t = t.replace(/\./g, "").replace(",", ".");
  else if (/,\d{2}$/.test(t) && !/\.\d/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// Preços no texto da página. Ignora parcela ("12x de R$ 9,90"), "por dia" e valores absurdos.
export function precosDoTexto(texto) {
  const achados = [];
  const re = /(R\$|US\$|USD|C\$|CA\$|A\$|AU\$|MX\$|€|£|(?<![A-Za-z])\$)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\d)/g;
  let m;
  while ((m = re.exec(texto))) {
    const sim = m[1];
    const moeda = sim === "R$" ? "BRL" : sim === "€" ? "EUR" : sim === "£" ? "GBP" : /^C/.test(sim) ? "CAD" : /^A/.test(sim) ? "AUD" : /^MX/.test(sim) ? "MXN" : "USD";
    const antes = texto.slice(Math.max(0, m.index - 14), m.index);
    const depois = texto.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (/\d+\s?x\s*(?:de\s*)?$/i.test(antes)) continue; // parcela
    if (/^\s*(?:\/|per |por |a )\s*(?:day|dia|week|semana|month|m[eê]s|mo\b)/i.test(depois)) continue;
    const v = numero(m[2], moeda);
    if (v == null || v <= 0 || v >= 5000) continue;
    achados.push({ v, moeda });
  }
  return achados;
}

export function analisar({ html = "", texto = "", visivel = "", links = [], hosts = [], lang = "" }) {
  const tudo = `${html}\n${links.join("\n")}\n${hosts.join("\n")}`.toLowerCase();
  const checkout = CHECKOUTS.filter(([, re]) => re.test(tudo)).map(([n]) => n);
  const player = PLAYERS.filter(([, re]) => re.test(tudo)).map(([n]) => n);

  const precos = precosDoTexto(texto);
  const moedas = {};
  for (const p of precos) moedas[p.moeda] = (moedas[p.moeda] || 0) + 1;
  const moeda = Object.entries(moedas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const daMoeda = [...new Set(precos.filter((p) => p.moeda === moeda).map((p) => p.v))].sort((a, b) => a - b);
  // O preço de frente de low ticket costuma ser o menor da página ("de $97 por $17");
  // abaixo de 1 é quase sempre "por dia" ou centavos de outra coisa.
  const preco = daMoeda.find((v) => v >= 1) ?? null;

  const quiz = QUIZ.test(tudo) || QUIZ.test(visivel);
  const tamanho = visivel.replace(/\s+/g, " ").length;
  const formato = quiz ? "quiz" : player.length && tamanho < 4000 ? "vsl" : tamanho > 9000 ? "tsl" : player.length ? "vsl + texto" : "página";
  const g = (texto.match(GARANTIA) || []).slice(1).find(Boolean);

  return {
    preco,
    moeda: preco != null ? moeda : null,
    preco_usd: preco != null && PARA_USD[moeda] ? Math.round(preco * PARA_USD[moeda] * 100) / 100 : null,
    precos: daMoeda.slice(0, 12),
    checkout: checkout.join(", ") || null,
    player: player.join(", ") || null,
    formato,
    order_bump: BUMP.test(texto),
    garantia_dias: g ? Number(g) : null,
    fisico: FISICO.test(texto) && !DIGITAL.test(texto),
    idioma: String(lang || "").slice(0, 10) || null,
  };
}

const CONTEXTO = {
  locale: "en-US",
  viewport: { width: 1366, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

async function lerPagina(context, url) {
  const page = await context.newPage();
  const hosts = new Set();
  page.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* url estranha */ } });
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const d = await page.evaluate(() => {
      // Texto inclui o que está escondido (botão de compra que só aparece no fim da VSL),
      // mas sem script e estilo, que trazem números de JSON.
      const corpo = document.body?.cloneNode(true);
      corpo?.querySelectorAll("script, style, noscript, svg").forEach((e) => e.remove());
      const links = [...document.querySelectorAll("a[href], form[action], iframe[src]")]
        .map((e) => e.href || e.action || e.src).filter(Boolean).slice(0, 800);
      return {
        titulo: document.title || "",
        lang: document.documentElement.lang || "",
        texto: (corpo?.textContent || "").replace(/\s+/g, " ").slice(0, 300000),
        visivel: (document.body?.innerText || "").slice(0, 60000),
        links,
        html: document.documentElement.outerHTML.slice(0, 1500000),
      };
    });
    return { ...d, hosts: [...hosts], status: resp?.status() ?? null, url_final: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
}

// Abre a página; se ela não mostrar preço mas tiver link de checkout, abre o checkout
// também (VSL de low ticket costuma esconder o preço até o carrinho).
export async function raioX(browser, url) {
  const context = await browser.newContext(CONTEXTO);
  try {
    const p = await lerPagina(context, url);
    let r = analisar(p);
    let checkoutLido = null;
    if (r.preco == null && r.checkout) {
      // Só link de compra: o "powered by" que leva à home da plataforma não tem preço da oferta.
      const deCompra = (l) => { try { const u = new URL(l); return u.pathname.length > 1 || u.search.length > 1; } catch { return false; } };
      const alvo = p.links.find((l) => deCompra(l) && CHECKOUTS.some(([n, re]) => n !== "shopify" && re.test(l.toLowerCase())));
      if (alvo) {
        try {
          const c = await lerPagina(context, alvo);
          const rc = analisar(c);
          checkoutLido = c.url_final;
          r = { ...r, preco: rc.preco, moeda: rc.moeda, preco_usd: rc.preco_usd, precos: rc.precos, order_bump: r.order_bump || rc.order_bump, fisico: r.fisico || rc.fisico,
            checkout: [...new Set([...(r.checkout || "").split(", "), ...(rc.checkout || "").split(", ")].filter(Boolean))].join(", ") };
        } catch { /* checkout não abriu: fica o que a página deu */ }
      }
    }
    return { ...r, titulo: p.titulo.slice(0, 200), status_http: p.status, url_final: p.url_final.slice(0, 600), checkout_lido: checkoutLido };
  } finally {
    await context.close().catch(() => {});
  }
}
