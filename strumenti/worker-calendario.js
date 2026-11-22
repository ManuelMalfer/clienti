// Servizio Cloudflare Worker: il CALENDARIO dell'app "Clienti" da collegare a Google Calendar o al Calendario di iPhone/iCloud.
//
// Perché esiste: Google e Apple aggiornano da soli un calendario "sottoscritto" leggendo un link .ics. Il sito è statico e non
// può creare quel file con i dati veri (stanno in Firestore, dietro il login): questo servizio lo crea al momento, leggendo
// Firestore con una chiave di servizio. È un collegamento IN UNA DIREZIONE: i richiami si cambiano dall'app, il calendario li mostra.
//
// Link: https://<worker>/cal/<uid>/<token>.ics
//   uid   = utente Firebase
//   token = codice segreto casuale salvato dall'app in utenti/{uid}/impostazioni/calendario (campo "token"). Chi non ha il link
//           completo non vede nulla; con "Crea un nuovo link" nell'app il vecchio smette di funzionare.
//
// Impostazioni nel pannello Cloudflare (Worker > Settings > Variables and Secrets):
//   SERVICE_ACCOUNT  (Secret)  il contenuto del file JSON della chiave di servizio Firebase (progetto clienti-malfer)
//
// Altri percorsi:  GET /ping  -> 200 (l'app controlla che il servizio sia attivo)
//
// Cosa contiene il calendario:
//   - un evento per ogni richiamo ("Richiamare: <nome>"), dagli ultimi 60 giorni in avanti; 30 minuti con avviso 15 minuti prima
//     se c'è l'ora, altrimenti tutto il giorno;
//   - se nelle impostazioni "giro" non è false: un evento di tutto il giorno per ogni giorno con ordini da raccogliere
//     ("Giro: N ordini", nomi nella descrizione), dalla settimana scorsa alle prossime 8 settimane, saltando i clienti chiusi.

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const STATI = { "DA CONTATTARE": "Da contattare", "CONTATTATO": "Contattato", "CLIENTE": "Cliente", "CLIENTE PERSO": "Cliente perso", "NON SERVIBILE": "Non servibile" };
const CAMPI = ["nome", "luogo", "indirizzo", "referente", "tel", "cellulare", "email", "stato", "note", "ricontattare", "ricontattareOra",
  "giorniOrdine", "orarioOrdine", "chiusoDal", "chiusoAl"];
const PERCORSO = /^\/cal\/([A-Za-z0-9_-]{6,128})\/([a-f0-9]{32,128})\.ics$/;

/* ---------- accesso a Firestore con la chiave di servizio (stesso metodo di Rosario) ---------- */
const b64u = b => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; bytes.forEach(x => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let saSrc = "", sa = null, chiave = null, tok = null;
function servizio(env){
  if(!env.SERVICE_ACCOUNT) throw new Error("manca SERVICE_ACCOUNT");
  if(saSrc !== env.SERVICE_ACCOUNT){ sa = JSON.parse(env.SERVICE_ACCOUNT); saSrc = env.SERVICE_ACCOUNT; chiave = null; tok = null; }
  return sa;
}
async function accesso(env){
  if(env.FAKE_TOKEN) return env.FAKE_TOKEN;                 // solo per le prove in locale
  if(tok && tok.exp > Date.now() + 120000) return tok.v;
  const s = servizio(env);
  if(!chiave){
    const raw = Uint8Array.from(atob(s.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), c => c.charCodeAt(0));
    chiave = await crypto.subtle.importKey("pkcs8", raw, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  }
  const iat = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({ iss: s.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chiave, new TextEncoder().encode(head + "." + claim));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + b64u(firma) })
  });
  if(!r.ok) throw new Error("accesso a Google non riuscito (" + r.status + ")");
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.v;
}
const base = env => (env.FIRESTORE_URL || "https://firestore.googleapis.com/v1") + "/projects/" + (env.FIREBASE_PROJECT || servizio(env).project_id) + "/databases/(default)/documents";
function val(v){
  if(!v || "nullValue" in v) return null;
  if("stringValue" in v) return v.stringValue;
  if("booleanValue" in v) return v.booleanValue;
  if("integerValue" in v) return Number(v.integerValue);
  if("doubleValue" in v) return v.doubleValue;
  if("timestampValue" in v) return v.timestampValue;
  if("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  if("mapValue" in v) return campi(v.mapValue.fields || {});
  return null;
}
const campi = f => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, val(x)]));
async function leggi(env, url){
  const r = await fetch(url, { headers: { authorization: "Bearer " + await accesso(env) } });
  if(r.status === 404) return null;
  if(!r.ok) throw new Error("Firestore " + r.status);
  return r.json();
}
async function clientiDi(env, uid){
  const out = []; let pag = "";
  do {
    const q = ["pageSize=300", ...CAMPI.map(k => "mask.fieldPaths=" + k), pag ? "pageToken=" + encodeURIComponent(pag) : ""].filter(Boolean).join("&");
    const d = await leggi(env, base(env) + "/utenti/" + encodeURIComponent(uid) + "/clienti?" + q);
    (d && d.documents || []).forEach(x => out.push({ id: decodeURIComponent(x.name.split("/").pop()), ...campi(x.fields || {}) }));
    pag = d && d.nextPageToken || "";
  } while(pag);
  return out;
}

/* ---------- date (ora italiana) ---------- */
const oggiRoma = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function piuGiorni(iso, n){ const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const giornoSett = iso => new Date(iso + "T12:00:00Z").getUTCDay();
const chiusoIl = (c, iso) => !!(c.chiusoDal || c.chiusoAl) && (!c.chiusoDal || iso >= c.chiusoDal) && (!c.chiusoAl || iso <= c.chiusoAl);
const dataIt = iso => iso.split("-").reverse().join("/");

/* ---------- file .ics ---------- */
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function piega(riga){
  const enc = new TextEncoder(); if(enc.encode(riga).length <= 75) return riga;
  const out = []; let cur = "", n = 0;
  for(const ch of riga){ const b = enc.encode(ch).length; if(n + b > (out.length ? 74 : 75)){ out.push(cur); cur = ""; n = 0; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n ");
}
const VTZ = ["BEGIN:VTIMEZONE", "TZID:Europe/Rome", "X-LIC-LOCATION:Europe/Rome",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE"];
const pad = n => String(n).padStart(2, "0");

export function creaCalendario(clienti, opz = {}){
  const oggi = opz.oggi || oggiRoma();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Malfer//Clienti//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + esc(opz.nome || "Clienti – richiami e giro"), "X-WR-TIMEZONE:Europe/Rome",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTZ];
  const tuttoGiorno = iso => ["DTSTART;VALUE=DATE:" + iso.replace(/-/g, ""), "DTEND;VALUE=DATE:" + piuGiorni(iso, 1).replace(/-/g, "")];

  // richiami
  const dal = piuGiorni(oggi, -60);
  for(const c of clienti){
    if(!c.ricontattare || !/^\d{4}-\d{2}-\d{2}$/.test(c.ricontattare) || c.ricontattare < dal) continue;
    const d = c.ricontattare.replace(/-/g, "");
    L.push("BEGIN:VEVENT", "UID:richiamo-" + c.id + "-" + d + "@clienti.malfer.it", "DTSTAMP:" + stamp);
    const m = /^(\d{1,2}):(\d{2})$/.exec(c.ricontattareOra || "");
    if(m){
      const h = +m[1], mi = +m[2], fine = h * 60 + mi + 30;
      L.push("DTSTART;TZID=Europe/Rome:" + d + "T" + pad(h) + pad(mi) + "00",
        fine < 24 * 60 ? "DTEND;TZID=Europe/Rome:" + d + "T" + pad(Math.floor(fine / 60)) + pad(fine % 60) + "00" : "DURATION:PT30M");
      L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc("Richiamare " + (c.nome || "")), "TRIGGER:-PT15M", "END:VALARM");
    } else L.push(...tuttoGiorno(c.ricontattare));
    L.push("SUMMARY:" + esc("Richiamare: " + (c.nome || "cliente")));
    const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", ");
    if(luogo) L.push("LOCATION:" + esc(luogo));
    const desc = [c.referente && "Referente: " + c.referente, c.tel && "Tel: " + c.tel, c.cellulare && "Cell: " + c.cellulare,
      c.email && "Email: " + c.email, c.stato && "Stato: " + (STATI[c.stato] || c.stato), c.note && "Note: " + c.note, "App: https://clienti.malfer.it"].filter(Boolean).join("\n");
    L.push("DESCRIPTION:" + esc(desc), "END:VEVENT");
  }

  // giro: ordini da raccogliere, un evento per giorno
  if(opz.giro !== false){
    for(let i = -7; i <= 56; i++){
      const iso = piuGiorni(oggi, i), g = GIORNI[giornoSett(iso)];
      if(g === "Domenica") continue;
      const ord = clienti.filter(c => Array.isArray(c.giorniOrdine) && c.giorniOrdine.includes(g) && !chiusoIl(c, iso))
        .sort((a, b) => String(a.luogo || "").localeCompare(String(b.luogo || ""), "it") || String(a.nome || "").localeCompare(String(b.nome || ""), "it"));
      if(!ord.length) continue;
      L.push("BEGIN:VEVENT", "UID:giro-" + iso.replace(/-/g, "") + "@clienti.malfer.it", "DTSTAMP:" + stamp, ...tuttoGiorno(iso),
        "SUMMARY:" + esc("Giro: " + ord.length + (ord.length === 1 ? " ordine" : " ordini")),
        "DESCRIPTION:" + esc("Ordini da raccogliere " + g.toLowerCase() + " " + dataIt(iso) + ":\n" +
          ord.map(c => "• " + (c.nome || "") + (c.luogo ? " (" + c.luogo + ")" : "") + (c.orarioOrdine ? " – " + c.orarioOrdine : "")).join("\n")),
        "TRANSP:TRANSPARENT", "END:VEVENT");
    }
  }
  L.push("END:VCALENDAR");
  return L.map(piega).join("\r\n") + "\r\n";
}

function uguali(a, b){
  if(typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0; for(let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": "*" };
    if(req.method !== "GET" && req.method !== "HEAD") return new Response("metodo non ammesso", { status: 405, headers: cors });
    if(url.pathname === "/ping") return new Response("ok", { headers: { ...cors, "cache-control": "no-store" } });
    const m = PERCORSO.exec(url.pathname);
    const nonTrovato = () => new Response("calendario non trovato", { status: 404, headers: { ...cors, "cache-control": "no-store" } });
    if(!m) return nonTrovato();
    const [, uid, token] = m;
    try {
      const imp = await leggi(env, base(env) + "/utenti/" + encodeURIComponent(uid) + "/impostazioni/calendario");
      const o = imp ? campi(imp.fields || {}) : null;
      if(!o || !uguali(String(o.token || ""), token)) return nonTrovato();
      const testo = creaCalendario(await clientiDi(env, uid), { giro: o.giro !== false });
      return new Response(req.method === "HEAD" ? null : testo, { headers: {
        ...cors, "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300",
        "content-disposition": 'inline; filename="clienti.ics"' } });
    } catch(err){
      return new Response("calendario momentaneamente non disponibile", { status: 503, headers: { ...cors, "cache-control": "no-store", "retry-after": "600" } });
    }
  }
};
