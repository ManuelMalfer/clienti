// Servizio Cloudflare Worker: scrive con Google Gemini il testo dell'email di un reclamo per l'app "Clienti" (v6.5).
//
// Perché esiste: la chiave di Gemini non può stare nell'app (il sito è pubblico). L'app manda qui i dati del reclamo
// (cliente, codice, articoli, tipologia, descrizione); il servizio controlla il login Firebase e l'email abilitata,
// chiede a Gemini il testo nello stile delle email di Manuel e lo restituisce. Non salva nulla.
// Se il servizio non risponde, l'app scrive l'email da un modello pronto (funzione rcModello in index.html).
//
// Impostazioni da fare nel pannello Cloudflare (Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY   (Secret)  chiave di Google AI Studio (la stessa di Rosario va bene)
//   ALLOWED_EMAILS   (Secret)  email degli account dell'app che possono usarlo, separate da virgola
//   FIREBASE_PROJECT (Text)    clienti-malfer
//   ALLOWED_ORIGINS  (Text)    https://clienti.malfer.it        (facoltativo)
//   GEMINI_MODELLI   (Text)    facoltativo: modelli da provare in ordine, separati da virgola
//
// Percorsi:
//   GET  /ping    controlla il login (l'app lo usa per sapere se l'IA è disponibile)
//   POST /email   { cliente, codice, luogo, data, prodotti:[{c, n, qta, lotto, scad}], tipi:[…], richiesta, descrizione, saluto, firma }
//                 → { oggetto, testo, modello }

const JWKS_GOOGLE = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MODELLI = "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash";
const MAX_CORPO = 30000;

class Errore extends Error { constructor(stato, msg){ super(msg); this.stato = stato; } }
const risposta = (obj, stato, cors) => new Response(JSON.stringify(obj), { status: stato, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });
const b64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const dec = s => JSON.parse(new TextDecoder().decode(b64u(s)));

/* ---- login: token Firebase (firma Google, scadenza, progetto) + elenco delle email ---- */
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
  if(!email || !permessi.includes(email)) throw new Errore(403, "questo account non può usare il servizio");
  return email;
}

/* ---- dati del reclamo: solo testo, lunghezze limitate ---- */
const pulisci = (s, max) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
function controlla(v){
  if(!v || typeof v !== "object") throw new Errore(400, "dati mancanti");
  const o = {
    cliente: pulisci(v.cliente, 120), codice: pulisci(v.codice, 30), luogo: pulisci(v.luogo, 80), data: pulisci(v.data, 20),
    richiesta: pulisci(v.richiesta, 120), descrizione: pulisci(v.descrizione, 3000), saluto: pulisci(v.saluto, 30) || "Buongiorno",
    firma: pulisci(v.firma, 300), foto: Math.max(0, Math.min(20, +v.foto || 0)),
    tipi: (Array.isArray(v.tipi) ? v.tipi : []).map(x => pulisci(x, 100)).filter(Boolean).slice(0, 12),
    prodotti: (Array.isArray(v.prodotti) ? v.prodotti : []).slice(0, 30).map(p => ({ c: pulisci(p && p.c, 20), n: pulisci(p && p.n, 160), qta: pulisci(p && p.qta, 40), lotto: pulisci(p && p.lotto, 40), scad: pulisci(p && p.scad, 20) })).filter(p => p.c || p.n)
  };
  if(!o.cliente) throw new Errore(400, "manca il cliente");
  return o;
}

// Lo stile viene dalle email vere di Manuel all'ufficio qualità (esempi inventati qui sotto, nessun dato reale).
function prompt(r){
  const righe = r.prodotti.map(p => "- " + [p.n, p.c ? "cod. " + p.c : "", p.qta ? "quantità: " + p.qta : "", p.lotto ? "lotto: " + p.lotto : "", p.scad ? "scadenza: " + p.scad : ""].filter(Boolean).join(" · ")).join("\n") || "(nessun articolo indicato)";
  return `Sei l'assistente di un agente di commercio di Marchi S.p.A. (distribuzione alimentare per ristoranti, hotel e bar).
Scrivi l'email che l'agente manda all'ufficio Qualità dell'azienda (qualita@marchispa.com) per segnalare un reclamo di un cliente.

STILE (copia quello delle sue email vere):
- Italiano, cortese ma diretto e breve: di solito 3-8 righe di testo. Niente frasi di circostanza lunghe, niente elenchi di scuse.
- Apertura: "${r.saluto}," su una riga.
- Cita sempre il cliente con il codice nella forma: il cliente <Nome> cod. <codice> (oppure "rilevata dal cliente <Nome> (cod. <codice>)").
- Gli articoli si citano con il codice: "<nome articolo> cod.<codice>". Se sono più articoli, mettili in un elenco puntato con il problema di ognuno.
- Racconta solo i fatti che ricevi: cosa lamenta il cliente, quando, su quali articoli. Se ci sono foto scrivi "(vedi foto in allegato)". NON inventare date, quantità, lotti, nomi o dettagli che non ti sono stati dati.
- Se c'è una richiesta (nota di credito, sostituzione, ritiro) scrivila in modo chiaro, per esempio: "Chiedo di procedere con nota di credito, avete bisogno che il prodotto rientri?" oppure "chiedo cortesemente di procedere con l'emissione di una nota di credito relativa a…". Se il cliente ha già smaltito la merce e non serve nota di credito, dillo.
- Chiusura tipica: "Attendo gentile riscontro." oppure "Resto in attesa di un vostro gentile riscontro.", poi "Grazie e buona giornata," (o "Cordiali saluti,") e la firma.
- Firma esattamente così, su righe separate:
${r.firma || "(nessuna firma)"}
- Oggetto: breve, maiuscolo o normale, che dica il problema, l'articolo e il cliente. Esempi di oggetti veri: "Problema qualitativo", "Lavorazione non effettuata", "Merce arrivata parzialmente cliente Rossi cod. 1001000000", "Richiesta nota di credito – Calamari cod. 10000 – Bar Centrale di Arco", "Non conformità tiramisù monoporzione", "DESCRIZIONE ARTICOLO 10000 NON CONFORME".

ESEMPIO (dati inventati):
Buonasera,
con la presente segnalo una non conformità rilevata dal cliente Bar Centrale di Arco (cod. 1001000000).
Il cliente ha riscontrato quanto segue:
- Petto di pollo cod.00000: cattivo odore su tutto il lotto consegnato (vedi foto in allegato);
- Mozzarella cod.00001: confezioni gonfie e sapore acido.
Il cliente ha già provveduto allo smaltimento della merce.
Attendo un gentile riscontro in merito.
Cordiali saluti,
Mario Rossi

DATI DEL RECLAMO:
Cliente: ${r.cliente}${r.luogo ? " (località: " + r.luogo + ")" : ""}
Codice cliente: ${r.codice || "(non indicato)"}
Data della segnalazione: ${r.data || "(non indicata)"}
Tipologia: ${r.tipi.join("; ") || "(non indicata)"}
Richiesta all'azienda: ${r.richiesta || "verifica e riscontro"}
Foto allegate: ${r.foto ? r.foto : "nessuna"}
Articoli coinvolti:
${righe}
Cosa è successo (scritto in fretta dall'agente, da riscrivere in modo corretto):
${r.descrizione || "(nessuna descrizione)"}

Rispondi solo con JSON: {"oggetto": "...", "testo": "..."} (il testo con gli a capo \\n, firma compresa).`;
}

async function gemini(env, testo){
  const modelli = String(env.GEMINI_MODELLI || MODELLI).split(",").map(s => s.trim()).filter(Boolean);
  const inizio = Date.now();
  let ultimo = "";
  for(const m of modelli){
    if(Date.now() - inizio > 22000) break;
    let res;
    try{
      res = await fetch(`${env.GEMINI_URL || "https://generativelanguage.googleapis.com"}/v1beta/models/${m}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: testo }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1500, responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { oggetto: { type: "STRING" }, testo: { type: "STRING" } }, required: ["oggetto", "testo"] } }
        })
      });
    }catch(e){ ultimo = "rete"; continue; }
    if(!res.ok){
      ultimo = m + " " + res.status;
      if(res.status === 401 || res.status === 403) throw new Errore(502, "la chiave di Gemini non è valida");
      continue;   // 404 modello sparito, 429 limite, 5xx sovraccarico: si prova il modello dopo
    }
    try{
      const j = await res.json();
      const t = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || "").join("") || "";
      const o = JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const oggetto = pulisci(o.oggetto, 200), corpo = String(o.testo || "").replace(/\r/g, "").trim().slice(0, 6000);
      if(oggetto && corpo) return { oggetto, testo: corpo, modello: m };
      ultimo = m + " risposta vuota";
    }catch(e){ ultimo = m + " risposta non leggibile"; }
  }
  throw new Errore(503, "Gemini non risponde (" + ultimo + ")");
}

export default {
  async fetch(req, env){
    const origine = req.headers.get("Origin") || "";
    const consentite = String(env.ALLOWED_ORIGINS || "https://clienti.malfer.it").split(",").map(s => s.trim()).filter(Boolean);
    const cors = consentite.includes(origine)
      ? { "Access-Control-Allow-Origin": origine, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" }
      : null;
    if(!cors) return risposta({ errore: "origine non consentita" }, 403, {});
    if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try{
      if(!env.GEMINI_API_KEY || !env.FIREBASE_PROJECT) throw new Errore(500, "servizio non configurato");
      const url = new URL(req.url);
      const email = await utente(req, env);
      if(req.method === "GET" && url.pathname === "/ping") return risposta({ ok: true, email }, 200, cors);
      if(req.method === "POST" && url.pathname === "/email"){
        if((+req.headers.get("content-length") || 0) > MAX_CORPO) throw new Errore(413, "dati troppo lunghi");
        const grezzo = await req.text();
        if(grezzo.length > MAX_CORPO) throw new Errore(413, "dati troppo lunghi");
        let corpo; try{ corpo = JSON.parse(grezzo); }catch(e){ throw new Errore(400, "dati non validi"); }
        return risposta(await gemini(env, prompt(controlla(corpo))), 200, cors);
      }
      throw new Errore(404, "percorso sconosciuto");
    }catch(e){
      return risposta({ errore: e.message || "errore" }, e.stato || 500, cors);
    }
  }
};
