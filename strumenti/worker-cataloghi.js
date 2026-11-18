// Servizio Cloudflare Worker: carica i cataloghi CIFRATI su GitHub per conto dell'app "Clienti".
//
// Perché esiste: il sito è statico (GitHub Pages), non può ricevere file. L'app cifra il PDF nel telefono e lo manda
// qui; il servizio controlla che a chiamare sia un account autorizzato (login Firebase), poi scrive il file nel
// repository e aggiunge la voce a cataloghi.json. La chiave di GitHub sta SOLO qui (segreto del Worker), mai nell'app.
//
// Impostazioni da fare nel pannello Cloudflare (Worker > Settings > Variables and Secrets):
//   GITHUB_TOKEN    (Secret)  chiave GitHub "fine-grained" solo per il repository clienti, permesso Contents: Read and write
//   ALLOWED_EMAILS  (Secret)  email degli account che possono caricare, separate da virgola (quelle del login dell'app)
//   GITHUB_REPO     (Text)    ManuelMalfer/clienti
//   GITHUB_BRANCH   (Text)    main
//   FIREBASE_PROJECT (Text)   clienti-malfer
//   ALLOWED_ORIGINS (Text)    https://clienti.malfer.it        (più indirizzi separati da virgola; facoltativo)
//
// Percorsi:
//   GET  /ping            controlla il login e il permesso (l'app lo usa per mostrare il pulsante "Aggiungi")
//   PUT  /file/<nome>.pdf.enc   scrive cataloghi/<nome>.pdf.enc (il corpo è il JSON dell'API GitHub: {message, content})
//   POST /elenco          aggiunge/aggiorna la voce in cataloghi.json
//
// Il Worker non guarda e non decifra il contenuto dei PDF: riceve già byte cifrati.

const JWKS_GOOGLE = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_FILE_JSON = 90 * 1024 * 1024;           // corpo massimo accettato (base64 incluso)
const NOME_FILE = /^[a-z0-9][a-z0-9-]{0,80}\.pdf\.enc$/;
const PERCORSO_FILE = /^cataloghi\/[a-z0-9][a-z0-9-]{0,80}\.pdf\.enc$/;

class Errore extends Error { constructor(stato, msg){ super(msg); this.stato = stato; } }
const risposta = (obj, stato, cors) => new Response(JSON.stringify(obj), { status: stato, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });

const b64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const dec = s => JSON.parse(new TextDecoder().decode(b64u(s)));
function bytesToB64(u8){ let s = ""; for(let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }

/* ---- login: controlla il token Firebase (firma Google, scadenza, progetto) e l'elenco delle email ---- */
let jwksCache = null, jwksQuando = 0;
async function chiaviGoogle(env){
  if(jwksCache && Date.now() - jwksQuando < 3600e3) return jwksCache;
  const r = await fetch(env.JWKS_URL || JWKS_GOOGLE);
  if(!r.ok) throw new Errore(502, "non riesco a verificare il login");
  jwksCache = (await r.json()).keys || []; jwksQuando = Date.now();
  return jwksCache;
}
async function utente(req, env){
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if(!m) throw new Errore(401, "accesso mancante");
  const parti = m[1].split(".");
  if(parti.length !== 3) throw new Errore(401, "accesso non valido");
  let head, pay;
  try{ head = dec(parti[0]); pay = dec(parti[1]); }catch(e){ throw new Errore(401, "accesso non valido"); }
  const prog = env.FIREBASE_PROJECT, ora = Math.floor(Date.now() / 1000);
  if(head.alg !== "RS256" || !prog || pay.aud !== prog || pay.iss !== "https://securetoken.google.com/" + prog || !pay.sub || !(pay.exp > ora) || pay.iat > ora + 300)
    throw new Errore(401, "accesso scaduto o non valido");
  const jwk = (await chiaviGoogle(env)).find(k => k.kid === head.kid);
  if(!jwk) throw new Errore(401, "accesso non valido");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parti[2]), new TextEncoder().encode(parti[0] + "." + parti[1]));
  if(!ok) throw new Errore(401, "accesso non valido");
  const email = String(pay.email || "").toLowerCase();
  const permessi = String(env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  if(!email || !permessi.includes(email)) throw new Errore(403, "questo account non può aggiungere cataloghi");
  return email;
}

/* ---- GitHub ---- */
const ghUrl = (env, percorso) => `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${percorso}`;
const ghHead = (env, extra) => ({ "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "clienti-cataloghi-worker", "X-GitHub-Api-Version": "2022-11-28", ...extra });
const ref = env => "?ref=" + encodeURIComponent(env.GITHUB_BRANCH || "main");

const pulisci = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function controllaVoce(v){
  if(!v || typeof v !== "object") throw new Errore(400, "dati mancanti");
  const o = { titolo: pulisci(v.titolo, 120), file: String(v.file || "") };
  if(!o.titolo) throw new Errore(400, "serve un titolo");
  if(!PERCORSO_FILE.test(o.file)) throw new Errore(400, "nome file non valido");
  for(const [k, max] of [["fornitore", 80], ["categoria", 60], ["desc", 160], ["anno", 20]]){ const s = pulisci(v[k], max); if(s) o[k] = s; }
  if(Array.isArray(v.tag)){ const t = [...new Set(v.tag.map(x => pulisci(x, 40).toLowerCase()).filter(Boolean))].slice(0, 20); if(t.length) o.tag = t; }
  return o;
}

async function aggiornaElenco(env, voce){
  for(let tentativo = 0; tentativo < 4; tentativo++){
    // il file cifrato deve già essere nel repository
    const ex = await fetch(ghUrl(env, voce.file) + ref(env), { headers: ghHead(env) });
    if(ex.status === 404) throw new Errore(400, "il file non risulta ancora caricato");
    if(!ex.ok) throw new Errore(502, "GitHub non risponde (" + ex.status + ")");
    const r = await fetch(ghUrl(env, "cataloghi.json") + ref(env), { headers: ghHead(env) });
    if(!r.ok) throw new Errore(502, "non riesco a leggere l'elenco (" + r.status + ")");
    const info = await r.json();
    const dati = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(info.content).replace(/\s/g, "")), c => c.charCodeAt(0))));
    if(!Array.isArray(dati.cataloghi)) dati.cataloghi = [];
    if(!Array.isArray(dati.categorie)) dati.categorie = [];
    const i = dati.cataloghi.findIndex(x => x.file === voce.file);
    if(i >= 0) dati.cataloghi[i] = voce; else dati.cataloghi.push(voce);
    if(voce.categoria && !dati.categorie.includes(voce.categoria)) dati.categorie.push(voce.categoria);
    const testo = JSON.stringify(dati, null, 1) + "\n";
    const put = await fetch(ghUrl(env, "cataloghi.json"), {
      method: "PUT", headers: ghHead(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message: "Cataloghi: " + (i >= 0 ? "aggiornato" : "aggiunto") + " «" + voce.titolo + "» (da app)", content: bytesToB64(new TextEncoder().encode(testo)), sha: info.sha, branch: env.GITHUB_BRANCH || "main" })
    });
    if(put.ok) return i >= 0 ? "aggiornato" : "aggiunto";
    if(put.status !== 409 && put.status !== 422) throw new Errore(502, "non riesco a scrivere l'elenco (" + put.status + ")");
    // 409/422: l'elenco è cambiato nel frattempo, si rilegge e si riprova
  }
  throw new Errore(409, "l'elenco è stato modificato da qualcun altro: riprova");
}

export default {
  async fetch(req, env){
    const origine = req.headers.get("Origin") || "";
    const consentite = String(env.ALLOWED_ORIGINS || "https://clienti.malfer.it").split(",").map(s => s.trim()).filter(Boolean);
    const cors = consentite.includes(origine)
      ? { "Access-Control-Allow-Origin": origine, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Max-Age": "86400" }
      : null;
    if(!cors) return risposta({ errore: "origine non consentita" }, 403, {});
    if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try{
      if(!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.FIREBASE_PROJECT) throw new Errore(500, "servizio non configurato");
      const url = new URL(req.url);
      const email = await utente(req, env);

      if(req.method === "GET" && url.pathname === "/ping") return risposta({ ok: true, email }, 200, cors);

      const mf = req.method === "PUT" && /^\/file\/([^/]+)$/.exec(url.pathname);
      if(mf){
        const nome = decodeURIComponent(mf[1]);
        if(!NOME_FILE.test(nome)) throw new Errore(400, "nome file non valido");
        const lung = +req.headers.get("content-length");
        if(!lung) throw new Errore(411, "dimensione mancante");
        if(lung > MAX_FILE_JSON) throw new Errore(413, "file troppo grande (massimo circa 60 MB)");
        // il corpo è già il JSON dell'API GitHub ({message, content}): si inoltra senza leggerlo (niente carico per il Worker)
        // Su Cloudflare si usa FixedLengthStream (lunghezza dichiarata, niente trasferimento "a pezzi"); nelle prove locali un Request normale.
        let gh;
        if(typeof FixedLengthStream !== "undefined"){
          const { readable, writable } = new FixedLengthStream(lung);
          const passa = req.body.pipeTo(writable);
          gh = await fetch(ghUrl(env, "cataloghi/" + nome), { method: "PUT", headers: ghHead(env, { "Content-Type": "application/json" }), body: readable });
          await passa.catch(() => {});
        } else {
          gh = await fetch(new Request(ghUrl(env, "cataloghi/" + nome), { method: "PUT", headers: ghHead(env, { "Content-Type": "application/json", "Content-Length": String(lung) }), body: req.body, duplex: "half" }));
        }
        if(gh.status === 201 || gh.status === 200) return risposta({ ok: true }, 201, cors);
        if(gh.status === 422) throw new Errore(409, "esiste già un catalogo con questo nome");
        if(gh.status === 413) throw new Errore(413, "file troppo grande");
        throw new Errore(502, "GitHub ha rifiutato il file (" + gh.status + ")");
      }

      if(req.method === "POST" && url.pathname === "/elenco"){
        const lung = +req.headers.get("content-length") || 0;
        if(lung > 20000) throw new Errore(413, "dati troppo lunghi");
        let corpo; try{ corpo = await req.json(); }catch(e){ throw new Errore(400, "dati non validi"); }
        const esito = await aggiornaElenco(env, controllaVoce(corpo));
        return risposta({ ok: true, esito }, 200, cors);
      }
      throw new Errore(404, "percorso sconosciuto");
    }catch(e){
      return risposta({ errore: e.message || "errore" }, e.stato || 500, cors);
    }
  }
};
