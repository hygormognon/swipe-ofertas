// Teste do painel: abre o index.html com a API simulada e passa por todas as abas e botões,
// registrando erros de JavaScript. Rodar com: node testes/painel.mjs (precisa do npm ci no coletor).
import { chromium } from "../coletor/node_modules/playwright/index.mjs";
const html = new URL("../index.html", import.meta.url).href;
const chamadas = [];
const oferta = (i, extra = {}) => ({ chave: `oferta${i}.com`, dominio: `oferta${i}.com`, tipo: "info", fase: "escalada", score: 20 - i, dias_no_ar: 100, anuncios_ativos: 5, variacoes: 9, paginas: 2, novos_7d: 1, tendencia: "nova", paises: ["US"], buscas: ["instant access"], titulo_exemplo: "Titulo " + i, texto_exemplo: "texto", imagem_exemplo: null, biblioteca: [], paginas_nomes: ["Pag"], marca: "", formatos: { VIDEO: 2 }, link_exemplo: `https://oferta${i}.com/vsl`, em_alta: 9 - i, novos_3d: 1, topo: 2, ...extra });
const comRaioX = { raiox_em: new Date().toISOString(), preco: 17, moeda: "USD", preco_usd: 17, precos: [17, 97], checkout: "digistore24", formato_pagina: "vsl", player: "vturb", order_bump: true, garantia_dias: 60, titulo_pagina: "Pagina" };
const respostas = {
  ping: { ok: true, ia: false },
  resumo: { fases: { escalada: 3 }, anuncios: 10, novas_hoje: 1, ultima_coleta: new Date().toISOString(), na_fila: 0, custo_30d: 0, config: { fonte: "robo", ativo: true, max_ads: 100 }, ia: false },
  buscas: { buscas: [{ id: 1, termo: "instant access", tipo: "termo", pais: "US", ativo: true, nicho: "CTA" }, { id: 2, termo: "ebook", tipo: "termo", pais: "BR", ativo: true }], coletas: [{ busca_id: 1, status: "processada", anuncios: 100, criado_em: new Date().toISOString() }] },
  oferta: { oferta: oferta(1, comRaioX), anuncios: [{ id: "9", pagina_id: "123456", pagina: "Pag", ativo: true, inicio: "2026-08-01", variacoes: 3, titulo: "T", texto: "X", video: "https://video.xx.fbcdn.net/v.mp4", imagem: null, url_biblioteca: "https://facebook.com/ads/library/?id=9", link: "https://oferta1.com" }], hist: [] },
  coletas: { coletas: [] },
};
const browser = await chromium.launch();
const page = await browser.newPage();
await page.context().route("https://oferta*.com/**", (r) => r.fulfill({ body: "pagina de vendas" }));
const erros = [];
page.on("pageerror", (e) => erros.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && erros.push("console: " + m.text()));
await page.route("**/functions/v1/swipe", async (route) => {
  const corpo = JSON.parse(route.request().postData() || "{}");
  chamadas.push(corpo.acao + (corpo.filtros ? " " + JSON.stringify(corpo.filtros) : ""));
  let r = respostas[corpo.acao] ?? { ok: true };
  if (corpo.acao === "baixar") { await route.fulfill({ status: 200, contentType: "video/mp4", headers: { "access-control-allow-origin": "*", "content-disposition": "attachment; filename=\"Pag_9.mp4\"", "access-control-expose-headers": "Content-Disposition" }, body: "fake" }); return; }
  if (corpo.acao === "perguntar") r = { resposta: "**Top**\n- oferta1.com: 100 dias\n- oferta2.com" };
  if (corpo.acao === "coletar") r = { enfileiradas: 1, fonte: "robo" };
  if (corpo.acao === "config_salvar") r = { ok: true, config: { fonte: "robo", ativo: false, max_ads: 80, max_paralelo: 3, janela_dias: 3 } };
  if (corpo.acao === "coletas") r = { coletas: [{ criado_em: new Date().toISOString(), termo: "x", tipo: "termo", pais: "US", status: "erro", erro: "falhou" }] };
  if (corpo.acao === "ofertas") r = { ofertas: corpo.filtros?.busca ? [oferta(7)] : [oferta(1, comRaioX), oferta(2, { dominio: "um-dominio-bem-comprido-de-oferta.com", titulo_exemplo: "Um título de anúncio bem longo que ocupa a coluna inteira da tabela e mais um pouco".repeat(2), checkout: "clickbank, digistore24", raiox_em: "2026-10-31", preco: 1297, moeda: "USD", formato_pagina: "vsl + texto" })], total: corpo.filtros?.busca ? 1 : 2 };
  await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(r) });
});
await page.goto(html);
await page.fill("#senha", "x");
await page.click("#form-login button");
await page.waitForTimeout(800);
const passo = async (nome, fn) => { try { await fn(); console.log("ok  ", nome); } catch (e) { console.log("FALHA", nome, "-", e.message.split("\n")[0]); } };
await passo("lista de ofertas aparece", async () => { await page.waitForSelector("tr.oferta", { timeout: 3000 }); });
await passo("visão em alta acesa e preço na lista", async () => {
  if (!(await page.isVisible('.visao.on[data-visao="alta"]'))) throw new Error("visão padrão não acesa");
  const pag = await page.textContent("tr.oferta .pag");
  if (!pag.includes("US$ 17") || !pag.includes("digistore24")) throw new Error(pag);
  if (!chamadas[chamadas.length - 1].includes('"ordem":"em_alta"')) throw new Error("não ordenou por em alta");
});
await passo("visão low ticket manda preço e checkout", async () => {
  await page.click('.visao[data-visao="low"]'); await page.waitForTimeout(400);
  const ult = chamadas[chamadas.length - 1];
  if (!ult.includes('"preco_max":50') || !ult.includes('"com_checkout":true')) throw new Error(ult);
  if (!(await page.isVisible('.visao.on[data-visao="low"]'))) throw new Error("visão low não acesa");
  await page.click('.visao[data-visao="alta"]'); await page.waitForTimeout(400);
});
await passo("abre painel da oferta", async () => { await page.click("tr.oferta"); await page.waitForSelector("#painel:not(.esconde) h2", { timeout: 3000 }); });
await passo("player de video no painel", async () => { await page.waitForSelector("#painel video", { timeout: 2000 }); });
await passo("botão da página de vendas no anúncio", async () => {
  const href = await page.$eval("#painel .anuncio .btn-pagina", (a) => a.href);
  const texto = await page.textContent("#painel .anuncio .btn-pagina");
  if (href !== "https://oferta1.com/" || !texto.includes("página de vendas") || !texto.includes("oferta1.com")) throw new Error(`${href} | ${texto}`);
});
await passo("raio-X no painel", async () => {
  const t = await page.textContent("#painel");
  if (!t.includes("Raio-X") || !t.includes("US$ 17") || !t.includes("garantia de 60 dias") || !t.includes("order bump")) throw new Error("raio-X incompleto");
});
await passo("vigiar anunciante", async () => {
  await page.click("[data-vigiar]"); await page.waitForTimeout(400);
  if (!chamadas.some((c) => c.startsWith("vigiar"))) throw new Error("não chamou vigiar");
});
await passo("fecha painel", async () => { await page.click("#painel .fechar"); await page.waitForSelector("#painel.esconde", { state: "attached", timeout: 2000 }); });
await passo("link da página na lista não abre o painel", async () => {
  const [nova] = await Promise.all([page.context().waitForEvent("page", { timeout: 3000 }), page.click("tr.oferta .link-pagina")]);
  await nova.close();
  await page.waitForTimeout(400);
  if (await page.isVisible("#painel")) throw new Error("abriu o painel junto");
});
await passo("aba buscas lista", async () => { await page.click('nav button[data-aba="buscas"]'); await page.waitForSelector("#lista-buscas tr[data-id]", { timeout: 3000 }); });
await passo("ver ofertas da busca", async () => {
  await page.click('#lista-buscas tr[data-id="1"] [data-acao="ver"]');
  await page.waitForTimeout(800);
  const visivel = await page.isVisible("#aba-ofertas");
  const valor = await page.$eval("#f-busca", (s) => s.value);
  const dom = await page.$eval("#lista", (t) => t.textContent);
  if (!visivel || valor !== "instant access" || !dom.includes("oferta7")) throw new Error(`aba visivel=${visivel} filtro=${valor} lista tem oferta7=${dom.includes("oferta7")}`);
});
await passo("marcar favorita no painel", async () => {
  await page.click("tr.oferta"); await page.waitForSelector("#painel:not(.esconde) h2", { timeout: 3000 });
  await page.click("[data-marca=favorita]"); await page.waitForTimeout(500);
  if (!chamadas.some((c) => c.startsWith("marcar"))) throw new Error("nao chamou marcar");
});
await passo("salvar anotacao", async () => { await page.fill("#nota", "teste"); await page.click("#salvar-nota"); await page.waitForTimeout(300); if (chamadas.filter((c) => c.startsWith("marcar")).length < 2) throw new Error("nao salvou"); });
await passo("baixar video", async () => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 4000 }), page.click("[data-baixar]")]);
  if (dl.suggestedFilename() !== "Pag_9.mp4") throw new Error("nome " + dl.suggestedFilename());
});
await passo("perguntar sobre a oferta", async () => {
  await page.click("#perguntar-oferta"); await page.waitForSelector("#aba-perguntar:not(.esconde)", { timeout: 2000 });
  await page.fill("#chat-texto", "o que acha?"); await page.keyboard.press("Enter");
  await page.waitForSelector(".msg.ia b", { timeout: 3000 });
  if (!chamadas.some((c) => c.startsWith("perguntar"))) throw new Error("nao perguntou");
});
await passo("sugestao do chat", async () => { await page.click("#chat-limpar"); await page.click("#sugestoes button"); await page.waitForTimeout(500); if (chamadas.filter((c) => c.startsWith("perguntar")).length < 2) throw new Error("sugestao nao enviou"); });
await passo("adicionar busca", async () => { await page.click('nav button[data-aba="buscas"]'); await page.fill("#b-termos", "novo termo"); await page.click("#form-busca button"); await page.waitForTimeout(400); if (!chamadas.some((c) => c.startsWith("busca_salvar"))) throw new Error("nao salvou"); });
await passo("rodar busca", async () => { await page.click('#lista-buscas tr[data-id="2"] [data-acao="rodar"]'); await page.waitForTimeout(400); if (!chamadas.some((c) => c.startsWith("coletar"))) throw new Error("nao rodou"); });
await passo("filtro de fase recarrega", async () => { const n = chamadas.length; await page.click('nav button[data-aba="ofertas"]'); await page.click("[data-fase=teste]"); await page.waitForTimeout(400); if (chamadas.length === n) throw new Error("nao recarregou"); });
await passo("busca por texto", async () => { const n = chamadas.length; await page.fill("#f-texto", "abc"); await page.waitForTimeout(700); if (!chamadas.slice(n).some((c) => c.includes("\"texto\":\"abc\""))) throw new Error("nao filtrou"); });
await passo("filtros ativos e limpar", async () => {
  const aviso = await page.textContent("#filtros-ativos");
  if (!aviso.includes("Limpar filtros")) throw new Error("sem aviso de filtro: " + aviso);
  await page.click("#limpar-filtros"); await page.waitForTimeout(500);
  const depois = await page.textContent("#filtros-ativos");
  const busca = await page.$eval("#f-busca", (s) => s.value);
  if (depois.trim() || busca) throw new Error(`continuou filtrado: "${depois}" busca=${busca}`);
});
await passo("tabela cabe em 1063px", async () => {
  await page.setViewportSize({ width: 1063, height: 800 });
  const larg = await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector(".tabela").scrollWidth, document.querySelector(".tabela").clientWidth]);
  if (larg[0] > 1063 || larg[1] > larg[2]) throw new Error("largura " + larg);
});
await passo("aba perguntar abre", async () => { await page.click('nav button[data-aba="perguntar"]'); await page.waitForSelector("#aba-perguntar:not(.esconde)", { timeout: 2000 }); });
await passo("aba coletas abre", async () => { await page.click('nav button[data-aba="coletas"]'); await page.waitForSelector("#aba-coletas:not(.esconde)", { timeout: 2000 }); });
await passo("aba config abre", async () => { await page.click('nav button[data-aba="config"]'); await page.waitForSelector("#aba-config:not(.esconde)", { timeout: 2000 }); });
await passo("coletas mostra erro", async () => { await page.click('nav button[data-aba="coletas"]'); await page.waitForSelector("#lista-coletas .st.erro", { timeout: 2000 }); });
await passo("salvar config", async () => { await page.click('nav button[data-aba="config"]'); await page.fill("#c-max-ads", "80"); await page.click("#salvar-config"); await page.waitForTimeout(400); if (!chamadas.some((c) => c.startsWith("config_salvar"))) throw new Error("nao salvou"); });
await passo("sair", async () => { await page.click("#sair"); await page.waitForSelector("#login:not(.esconde)", { timeout: 2000 }); });
console.log("\nchamadas:", chamadas.join(" | "));
console.log("erros:", erros.length ? erros.join("\n") : "nenhum");
await browser.close();
