// Scarica il catalogo articoli dal sito pubblico di Marchi S.p.A. (www.marchispa.it) per la pagina "Articoli" dell'app.
//
//   node strumenti/articoli-marchi.mjs            scarica/aggiorna tutto (riprende da dove si era fermato)
//   node strumenti/articoli-marchi.mjs --nuovo    ignora la memoria e riscarica tutte le pagine (le foto già scaricate restano)
//
// Cosa fa:
//  1. legge la mappa pubblica del sito (sitemap): elenco di tutti i prodotti con nome e foto, e di tutte le categorie;
//  2. apre ogni pagina di categoria (nome e percorso: categoria principale > sottocategoria);
//  3. apre ogni pagina prodotto (codice articolo, nome, descrizione breve, categoria principale);
//  4. scarica la prima foto di ogni prodotto in formato medio (~30 KB) in articoli/img/<id>.jpg;
//  5. scrive articoli.json (letto dall'app).
// È lento apposta (poche richieste alla volta, con pause) per non appesantire il sito di Marchi: rispetta robots.txt
// (pagine prodotto e categorie sono permesse). La memoria delle pagine già lette sta in strumenti/.cache-articoli/ (non va su GitHub).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const QUI = path.dirname(fileURLToPath(import.meta.url));
const RADICE = path.resolve(QUI, "..");
const CACHE = path.join(QUI, ".cache-articoli");
const DIR_IMG = path.join(RADICE, "articoli", "img");
const SITO = "https://www.marchispa.it";
const UA = "Mozilla/5.0 (compatible; catalogo-interno)";
const PARALLELE = 3, PAUSA = 250;              // 3 richieste alla volta, 250 ms tra una e l'altra
const NUOVO = process.argv.includes("--nuovo");
const LIMITE = +process.env.LIMITE || 0;      // solo per le prove: LIMITE=20 legge solo 20 prodotti e 20 categorie

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(DIR_IMG, { recursive: true });
const dorme = ms => new Promise(r => setTimeout(r, ms));
const leggiJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const scriviJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

async function scarica(url, tipo = "text", tentativi = 4){
  for(let t = 1; ; t++){
    try{
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "it-IT,it" } });
      if(r.status === 404) return null;
      if(!r.ok) throw new Error("HTTP " + r.status);
      return tipo === "buf" ? Buffer.from(await r.arrayBuffer()) : await r.text();
    }catch(e){
      if(t >= tentativi) { console.warn("  ! " + url + " → " + e.message); return null; }
      await dorme(1500 * t);
    }
  }
}
async function aTurni(lista, fn, etichetta){
  let i = 0, fatti = 0;
  const lavoratore = async () => {
    while(i < lista.length){
      const x = lista[i++];
      await fn(x);
      fatti++;
      if(fatti % 100 === 0 || fatti === lista.length) console.log(`  ${etichetta}: ${fatti}/${lista.length}`);
      await dorme(PAUSA);
    }
  };
  await Promise.all(Array.from({ length: PARALLELE }, lavoratore));
}
const testo = s => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const breadcrumb = html => {
  const m = /"breadcrumb":\{"links":(\[[^\]]*\])/.exec(html);
  try { return m ? JSON.parse(m[1]).map(l => l.title) : []; } catch (e) { return []; }
};

// 1. sitemap
console.log("1. Leggo la mappa del sito…");
const indice = await scarica(SITO + "/1_index_sitemap.xml");
const mappe = [...String(indice || "").matchAll(/<loc>(?:<!\[CDATA\[)?([^<\]]+)/g)].map(m => m[1]);
const prodotti = new Map(), categorieUrl = new Set();
for(const m of mappe){
  const xml = await scarica(m);
  for(const u of String(xml || "").split("<url>").slice(1)){
    const loc = (/<loc><!\[CDATA\[([^\]]+)\]\]><\/loc>/.exec(u) || [])[1];
    if(!loc) continue;
    const p = /^https:\/\/www\.marchispa\.it\/([a-z0-9-]+)\/(\d+)-[^/]+\.html$/.exec(loc);
    if(p){
      const img = [...u.matchAll(/<image:loc><!\[CDATA\[([^\]]+)\]\]>/g)].map(x => x[1]);
      const tit = (/<image:title><!\[CDATA\[([^\]]*)\]\]>/.exec(u) || [])[1] || "";
      prodotti.set(+p[2], { id: +p[2], url: loc, slug: p[1], img, tit: testo(tit) });
    } else if(/^https:\/\/www\.marchispa\.it\/\d+-[a-z0-9-]+$/.test(loc)) categorieUrl.add(loc);
  }
}
if(LIMITE){ [...prodotti.keys()].slice(LIMITE).forEach(k => prodotti.delete(k)); [...categorieUrl].slice(LIMITE).forEach(u => categorieUrl.delete(u)); }
console.log(`   ${prodotti.size} prodotti, ${categorieUrl.size} categorie`);

// 2. categorie
console.log("2. Leggo le categorie…");
const fileCat = path.join(CACHE, "categorie.json");
const cat = NUOVO ? {} : leggiJson(fileCat, {});
await aTurni([...categorieUrl].filter(u => !cat[u]), async u => {
  const html = await scarica(u);
  if(!html) return;
  const bc = breadcrumb(html).filter(t => !/^(home|catalogo)$/i.test(t));
  const nome = testo((/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html) || [])[1]) || bc[bc.length - 1] || "";
  const m = /^https:\/\/www\.marchispa\.it\/(\d+)-([a-z0-9-]+)$/.exec(u);
  cat[u] = { id: +m[1], slug: m[2], nome, percorso: bc };
  if(Object.keys(cat).length % 50 === 0) scriviJson(fileCat, cat);
}, "categorie");
scriviJson(fileCat, cat);

// 3. pagine prodotto
console.log("3. Leggo le pagine dei prodotti (codice, descrizione, categoria)…");
const fileProd = path.join(CACHE, "prodotti.json");
const det = NUOVO ? {} : leggiJson(fileProd, {});
let daSalvare = 0;
await aTurni([...prodotti.values()].filter(p => !det[p.id]), async p => {
  const html = await scarica(p.url);
  if(!html){ det[p.id] = { assente: true }; return; }
  const ref = (/product-reference[^>]*>[\s\S]{0,200}?Cod\.\s*([A-Za-z0-9./-]+)/.exec(html) || [])[1] || "";
  const nome = testo((/<h1[^>]*product-detail-name[^>]*>([\s\S]*?)<\/h1>/.exec(html) || [])[1]);
  const breve = testo((/product-description-short[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1]);
  const lunga = testo((/<div class="product-description"[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1]).slice(0, 600);
  const marca = testo((/product-manufacturer[\s\S]{0,300}?<a[^>]*>([\s\S]*?)<\/a>/.exec(html) || [])[1]);
  const bc = breadcrumb(html).filter(t => !/^(home|catalogo)$/i.test(t));
  det[p.id] = { ref, nome, breve, lunga, marca, top: bc.length > 1 ? bc[0] : "" };
  if(++daSalvare % 50 === 0) scriviJson(fileProd, det);
}, "prodotti");
scriviJson(fileProd, det);

// 4. foto (formato medio)
console.log("4. Scarico le foto…");
await aTurni([...prodotti.values()].filter(p => p.img.length && !fs.existsSync(path.join(DIR_IMG, p.id + ".jpg"))), async p => {
  const u = p.img[0].replace(/-large_default\//, "-medium_default/");
  const buf = await scarica(u, "buf");
  if(buf && buf.length > 500) fs.writeFileSync(path.join(DIR_IMG, p.id + ".jpg"), buf);
}, "foto");

// 5. articoli.json
console.log("5. Scrivo articoli.json…");
const catList = Object.values(cat);
const tops = [];          // categorie principali, nell'ordine del sito
const subs = [];          // sottocategorie: { n, t (indice categoria principale), s (slug) }
const topIdx = n => { let i = tops.findIndex(t => t.toUpperCase() === String(n).toUpperCase()); if(i < 0){ tops.push(n); i = tops.length - 1; } return i; };
catList.filter(c => c.percorso.length === 1).sort((a, b) => a.id - b.id).forEach(c => topIdx(c.nome));
const subIdx = new Map();
const articoli = [];
for(const p of [...prodotti.values()].sort((a, b) => a.id - b.id)){
  const d = det[p.id];
  if(!d || d.assente) continue;
  // sottocategoria: quella del link del prodotto (slug), scegliendo, se ce n'è più d'una con lo stesso nome, quella sotto la sua categoria principale
  const cand = catList.filter(c => c.slug === p.slug);
  const c = cand.find(x => x.percorso[0] && d.top && x.percorso[0].toUpperCase() === d.top.toUpperCase()) || cand[0];
  const topNome = d.top || (c && c.percorso[0]) || "Altro";
  const t = topIdx(topNome);
  let s = -1;
  if(c && c.percorso.length > 1){
    const chiave = t + "|" + c.percorso.slice(1).join(" > ");
    if(!subIdx.has(chiave)){ subIdx.set(chiave, subs.length); subs.push({ n: c.percorso.slice(1).join(" › "), t }); }
    s = subIdx.get(chiave);
  }
  const foto = fs.existsSync(path.join(DIR_IMG, p.id + ".jpg"));
  const o = { i: p.id, c: d.ref, n: d.nome || p.tit, t, s };
  if(d.breve && d.breve !== o.n && !o.n.startsWith(d.breve)) o.b = d.breve;
  if(d.lunga && d.lunga !== d.breve) o.d = d.lunga;
  if(d.marca) o.m = d.marca;
  if(!foto) o.f = 0;
  articoli.push(o);
}
const out = { agg: new Date().toISOString().slice(0, 10), fonte: SITO, top: tops, sub: subs, a: articoli };
fs.writeFileSync(path.join(RADICE, "articoli.json"), JSON.stringify(out));
const conFoto = articoli.filter(a => a.f !== 0).length;
console.log(`Fatto: ${articoli.length} articoli, ${tops.length} categorie, ${subs.length} sottocategorie, ${conFoto} con foto, ${articoli.filter(a => !a.c).length} senza codice.`);
