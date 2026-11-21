// Schede tecniche degli articoli: le cifra (stessa chiave dei cataloghi) e le carica su Cloudflare R2.
//
//   node strumenti/schede-tecniche.mjs            cifra le schede nuove o cambiate e le carica su R2, poi aggiorna schede.json
//   node strumenti/schede-tecniche.mjs --cifra    solo cifratura (nessun caricamento): utile per una prova
//   node strumenti/schede-tecniche.mjs --prova    carica UNA scheda e controlla che si scarichi dall'indirizzo pubblico
//
// Da dove prende i PDF: la cartella "schede tecniche" sul Desktop (con le sottocartelle MARCHI SPA_…), oppure SCHEDE_DIR=… .
// Il nome del file è il codice articolo (es. 01205.pdf). Regole:
//  - si tengono solo i codici presenti in articoli.json (il catalogo dell'app);
//  - i file "-old", "-old2", "-temp" si ignorano; "12044-12045.pdf" vale per entrambi i codici; "13942-1.pdf" solo se manca 13942.pdf;
//  - se lo stesso codice è in due cartelle si prende il file più recente.
// Cifratura AES-256-GCM con la chiave di cataloghi-originali/chiave-cataloghi.txt (formato: 12 byte iv + testo cifrato),
// quindi l'app le apre con la chiave che ha già. File cifrati in cataloghi-originali/schede-enc/ (non va su GitHub).
// Caricamento su R2 con l'API compatibile S3 (firma AWS v4, nessuna libreria). Credenziali in cataloghi-originali/r2.json:
//   { "accountId": "...", "accessKeyId": "...", "secretAccessKey": "...", "bucket": "schede-tecniche", "pubblico": "https://schede.malfer.it" }
// Si caricano solo le schede nuove o cambiate (memoria in cataloghi-originali/schede-caricate.json).

import fs from "node:fs";
import path from "node:path";
import { webcrypto as crypto, createHash, createHmac } from "node:crypto";

const RADICE = path.resolve(import.meta.dirname, "..");
const PRIVATI = path.join(RADICE, "cataloghi-originali");
const FILE_CHIAVE = path.join(PRIVATI, "chiave-cataloghi.txt");
const DIR_ENC = path.join(PRIVATI, "schede-enc");
const FILE_R2 = path.join(PRIVATI, "r2.json");
const FILE_FATTE = path.join(PRIVATI, "schede-caricate.json");
const SORGENTE = process.env.SCHEDE_DIR || path.join(process.env.USERPROFILE || "", "Desktop", "schede tecniche");
const SOLO_CIFRA = process.argv.includes("--cifra"), PROVA = process.argv.includes("--prova");
const PARALLELE = 4;

const leggiJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const sha256hex = b => createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

// 1. quali file, per quale codice
function elencoSchede(){
  const art = leggiJson(path.join(RADICE, "articoli.json"), null);
  if(!art) throw new Error("Manca articoli.json: lancia prima strumenti/articoli-marchi.mjs");
  const codici = new Set(art.a.map(x => String(x.c || "").trim()).filter(Boolean));
  if(!fs.existsSync(SORGENTE)) throw new Error("Non trovo la cartella delle schede: " + SORGENTE);
  const perCodice = new Map();           // codice -> { file, mtime, size, esatto }
  const metti = (cod, f, st, esatto) => {
    if(!codici.has(cod)) return;
    const v = perCodice.get(cod);
    if(!v || (esatto && !v.esatto) || (esatto === v.esatto && st.mtimeMs > v.mtime)) perCodice.set(cod, { file: f, mtime: st.mtimeMs, size: st.size, esatto });
  };
  const cartelle = [SORGENTE, ...fs.readdirSync(SORGENTE).map(d => path.join(SORGENTE, d)).filter(p => fs.statSync(p).isDirectory())];
  for(const dir of cartelle){
    for(const f of fs.readdirSync(dir)){
      if(!/\.pdf$/i.test(f)) continue;
      const base = f.replace(/\.pdf$/i, "");
      if(/-(old\d*|temp)$/i.test(base)) continue;
      const full = path.join(dir, f), st = fs.statSync(full);
      if(/^[A-Z]?\d{4,6}$/i.test(base)) metti(base.toUpperCase(), full, st, true);
      else if(/^\d{4,6}(-\d{4,6})+$/.test(base)) base.split("-").forEach(c => metti(c, full, st, true));     // un file per più codici
      else if(/^\d{4,6}-\d{1,2}$/.test(base)) metti(base.split("-")[0], full, st, false);                       // variante (es. 13942-1)
    }
  }
  return perCodice;
}

// 2. cifratura
async function chiave(){
  const raw = new Uint8Array(Buffer.from(fs.readFileSync(FILE_CHIAVE, "utf8").trim().replace(/\s+/g, ""), "base64"));
  if(raw.length !== 32) throw new Error("La chiave in " + FILE_CHIAVE + " non è valida.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
}
async function cifra(key, dati){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dati));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}

// 3. caricamento su R2 (API S3, firma v4)
function firmaPut(cfg, chiaveOggetto, corpo){
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const uri = "/" + encodeURIComponent(cfg.bucket) + "/" + chiaveOggetto.split("/").map(encodeURIComponent).join("/");
  const ora = new Date(), amzDate = ora.toISOString().replace(/[-:]|\.\d{3}/g, ""), giorno = amzDate.slice(0, 8);
  const hash = sha256hex(corpo);
  const canon = ["PUT", uri, "", `host:${host}`, `x-amz-content-sha256:${hash}`, `x-amz-date:${amzDate}`, "", "host;x-amz-content-sha256;x-amz-date", hash].join("\n");
  const ambito = `${giorno}/auto/s3/aws4_request`;
  const daFirmare = ["AWS4-HMAC-SHA256", amzDate, ambito, sha256hex(canon)].join("\n");
  const k = hmac(hmac(hmac(hmac("AWS4" + cfg.secretAccessKey, giorno), "auto"), "s3"), "aws4_request");
  const firma = createHmac("sha256", k).update(daFirmare).digest("hex");
  return { url: `https://${host}${uri}`, headers: {
    "Authorization": `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${ambito}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${firma}`,
    "x-amz-content-sha256": hash, "x-amz-date": amzDate, "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=86400" } };
}
async function carica(cfg, chiaveOggetto, corpo){
  for(let t = 1; ; t++){
    const { url, headers } = firmaPut(cfg, chiaveOggetto, corpo);
    try{
      const r = await fetch(url, { method: "PUT", headers, body: corpo });
      if(r.ok) return;
      const txt = (await r.text()).slice(0, 300);
      if(r.status === 403 || r.status === 401) throw Object.assign(new Error("R2 rifiuta le credenziali (" + r.status + "): " + txt), { fatale: true });
      throw new Error("HTTP " + r.status + " " + txt);
    }catch(e){
      if(e.fatale || t >= 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * t));
    }
  }
}

async function main(){
  const elenco = elencoSchede();
  console.log(`Schede trovate per gli articoli del catalogo: ${elenco.size}`);
  const key = await chiave();
  fs.mkdirSync(DIR_ENC, { recursive: true });
  const fatte = leggiJson(FILE_FATTE, {});                      // codice -> "mtime|size" della sorgente già caricata
  const firma = v => Math.round(v.mtime) + "|" + v.size;
  let cfg = null;
  if(!SOLO_CIFRA){
    cfg = leggiJson(FILE_R2, null);
    if(!cfg || !cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket || !cfg.pubblico)
      throw new Error("Mancano le credenziali di R2 in " + FILE_R2 + " (accountId, accessKeyId, secretAccessKey, bucket, pubblico).");
    cfg.pubblico = cfg.pubblico.replace(/\/+$/, "");
    // l'Account ID è di 32 caratteri esadecimali: va bene anche incollare l'intero indirizzo S3 (https://<id>.r2.cloudflarestorage.com)
    const id = String(cfg.accountId).match(/[0-9a-f]{32}/i);
    if(!id) throw new Error("In r2.json il campo accountId non contiene l'Account ID (32 caratteri, cifre e lettere da a a f). Copialo dalla pagina R2 → Account Details, oppure incolla l'indirizzo S3 https://….r2.cloudflarestorage.com");
    cfg.accountId = id[0].toLowerCase();
  }
  let lista = [...elenco.entries()].filter(([c, v]) => PROVA || fatte[c] !== firma(v));
  if(PROVA) lista = lista.slice(0, 1);
  console.log(SOLO_CIFRA ? `Da cifrare: ${lista.length}` : `Da cifrare e caricare: ${lista.length}`);
  let i = 0, n = 0, errori = 0, ultimoSalvataggio = Date.now();
  const lavora = async () => {
    while(i < lista.length){
      const [cod, v] = lista[i++];
      try{
        const enc = await cifra(key, new Uint8Array(fs.readFileSync(v.file)));
        fs.writeFileSync(path.join(DIR_ENC, cod + ".pdf.enc"), enc);
        if(cfg) await carica(cfg, cod + ".pdf.enc", enc);
        if(cfg) fatte[cod] = firma(v);
        n++;
        if(n % 100 === 0) console.log(`  ${n}/${lista.length}`);
        if(cfg && Date.now() - ultimoSalvataggio > 10000){ fs.writeFileSync(FILE_FATTE, JSON.stringify(fatte)); ultimoSalvataggio = Date.now(); }
      }catch(e){
        if(e.fatale){ i = lista.length; throw e; }
        errori++; console.warn(`  ! ${cod}: ${e.message}`);
      }
    }
  };
  try{ await Promise.all(Array.from({ length: PARALLELE }, lavora)); }
  finally{ if(cfg) fs.writeFileSync(FILE_FATTE, JSON.stringify(fatte)); }
  console.log(`Fatto: ${n} ${cfg ? "cifrate e caricate" : "cifrate"}${errori ? `, ${errori} errori (rilancia per riprovare)` : ""}.`);

  if(PROVA && cfg && lista.length){
    const [cod] = lista[0];
    const r = await fetch(`${cfg.pubblico}/${cod}.pdf.enc`, { headers: { Origin: "https://clienti.malfer.it" } });
    console.log(`Prova di lettura ${cfg.pubblico}/${cod}.pdf.enc → HTTP ${r.status}, CORS: ${r.headers.get("access-control-allow-origin") || "(manca)"}`);
    return;
  }
  if(cfg){
    // elenco per l'app: solo i codici caricati e ancora presenti tra le schede
    const codici = [...elenco.keys()].filter(c => fatte[c]).sort();
    fs.writeFileSync(path.join(RADICE, "schede.json"), JSON.stringify({ agg: new Date().toISOString().slice(0, 10), base: cfg.pubblico, codici }));
    console.log(`schede.json aggiornato: ${codici.length} schede collegate agli articoli.`);
  }
}
main().catch(e => { console.error("Errore:", e.message); process.exitCode = 1; });
