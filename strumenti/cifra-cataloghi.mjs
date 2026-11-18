// Cifra i PDF dei cataloghi prima di metterli su GitHub, così chi conosce il link diretto non può aprirli.
//
//   COME SI USA (dalla cartella principale del progetto):
//     1. metti i PDF originali nella cartella  cataloghi-originali/   (NON viene caricata su GitHub)
//     2. lancia:  node strumenti/cifra-cataloghi.mjs
//   Per ogni PDF crea  cataloghi/nome.pdf.enc  : un file illeggibile senza la chiave.
//
//   Nessuna password da ricordare: la prima volta il programma crea una CHIAVE casuale e la salva in
//   cataloghi-originali/chiave-cataloghi.txt (solo sul tuo computer). Le volte dopo la riusa.
//   La chiave va incollata UNA volta nell'app (la richiede da sola al primo catalogo che apri, per ogni
//   account): da lì in poi sta nel tuo account Firebase, protetta dal login, e l'app decifra da sola.
//
//   Opzioni:
//     --tutti    cifra di nuovo tutti i PDF (anche quelli già fatti)
//     --nuova    crea una chiave nuova (poi va cifrato tutto da capo e incollata di nuovo nell'app)
//
// Cifratura: AES-256-GCM con chiave casuale di 256 bit. Nessuna libreria esterna.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const RADICE = path.resolve(import.meta.dirname, "..");
const ORIGINALI = path.join(RADICE, "cataloghi-originali");
const DEST = path.join(RADICE, "cataloghi");
const FILE_CHIAVE = path.join(ORIGINALI, "chiave-cataloghi.txt");
const META = path.join(DEST, "cifratura.json");
const NUOVA = process.argv.includes("--nuova");
const TUTTI = process.argv.includes("--tutti") || NUOVA;

const b64 = u8 => Buffer.from(u8).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));

async function cifra(key, dati){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dati));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;                       // formato: 12 byte iniziali (iv) + testo cifrato con sigillo
}

function copiaNegliAppunti(testo){
  if(process.env.CATALOGHI_SENZA_APPUNTI) return false;     // solo per le prove automatiche
  try{ const r = spawnSync("clip", [], { input: testo, shell: true }); return r.status === 0; }catch(e){ return false; }
}

async function main(){
  fs.mkdirSync(ORIGINALI, { recursive: true });
  fs.mkdirSync(DEST, { recursive: true });
  const pdf = fs.readdirSync(ORIGINALI).filter(f => /\.pdf$/i.test(f)).sort();
  if(!pdf.length){ console.log("Nessun PDF in cataloghi-originali/. Copiaci dentro i PDF da cifrare e rilancia."); return; }

  // chiave: si crea la prima volta (o con --nuova), poi si riusa
  let chiaveB64, nuovaChiave = false;
  if(!NUOVA && fs.existsSync(FILE_CHIAVE)){
    chiaveB64 = fs.readFileSync(FILE_CHIAVE, "utf8").trim().replace(/\s+/g, "");
  } else {
    chiaveB64 = b64(crypto.getRandomValues(new Uint8Array(32)));
    fs.writeFileSync(FILE_CHIAVE, chiaveB64 + "\n");
    nuovaChiave = true;
  }
  const raw = unb64(chiaveB64);
  if(raw.length !== 32){ console.error("La chiave in cataloghi-originali/chiave-cataloghi.txt non è valida (deve essere di 32 byte)."); process.exitCode = 1; return; }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);

  // piccolo "sigillo" che l'app usa per controllare che la chiave incollata sia quella giusta
  if(nuovaChiave || !fs.existsSync(META)){
    const v = await cifra(key, new TextEncoder().encode("catalogo-ok"));
    fs.writeFileSync(META, JSON.stringify({ v: 2, verifica: { iv: b64(v.slice(0, 12)), ct: b64(v.slice(12)) } }, null, 1) + "\n");
  }

  let fatti = 0, saltati = 0;
  for(const f of pdf){
    const da = path.join(ORIGINALI, f), a = path.join(DEST, f + ".enc");
    if(!TUTTI && fs.existsSync(a) && fs.statSync(a).mtimeMs >= fs.statSync(da).mtimeMs){ saltati++; continue; }
    fs.writeFileSync(a, await cifra(key, new Uint8Array(fs.readFileSync(da))));
    fatti++;
    console.log("  cifrato:", f);
  }
  console.log(`Fatto: ${fatti} cifrati, ${saltati} già a posto.`);

  if(nuovaChiave){
    const ok = copiaNegliAppunti(chiaveB64);
    console.log("");
    console.log("CHIAVE DEI CATALOGHI (da incollare UNA volta nell'app, per ogni account):");
    console.log("   " + chiaveB64);
    console.log(ok ? "   -> È già copiata negli appunti: basta incollarla." : "   -> Copiala da qui, oppure aprila dal file cataloghi-originali/chiave-cataloghi.txt");
    console.log("   Il file chiave-cataloghi.txt resta solo sul tuo computer: fanne anche una copia al sicuro.");
  }
  console.log("I file .enc in cataloghi/ sono pronti per GitHub; i PDF in cataloghi-originali/ restano solo qui.");
}
main().catch(e => { console.error("Errore:", e.message); process.exitCode = 1; });
