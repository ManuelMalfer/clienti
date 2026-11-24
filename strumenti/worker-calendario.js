// @ts-nocheck  (l'editor di Cloudflare controlla i tipi come se fosse TypeScript: qui non servono)
// Servizio Cloudflare Worker "calendario" dell'app "Clienti".
//
// Fa tre cose:
//  1) LINK .ics (sola lettura, per iPhone/iCloud o altri calendari): https://<worker>/cal/<uid>/<token>.ics
//     token = codice casuale salvato dall'app in utenti/{uid}/impostazioni/calendario (campo "token").
//  2) GOOGLE CALENDAR NEI DUE SENSI (v6.3): l'utente autorizza l'app sul suo account Google; da lì
//     - ogni richiamo di un cliente diventa un evento nel calendario Google scelto ("Richiamare: <nome>");
//     - se in Google l'evento viene spostato o cancellato, il richiamo del cliente si sposta o si toglie (riga nello storico);
//     - gli appuntamenti dei calendari Google scelti si copiano (sola lettura) in utenti/{uid}/impostazioni/gcal_eventi
//       e l'app li mostra nel Calendario.
//  3) iCLOUD NEI DUE SENSI (v6.8): come Google, ma con CalDAV ed email Apple + password per app (sezione 3 qui sotto).
//     Gli appuntamenti vanno in UN solo servizio (Google o iCloud); dagli altri calendari si vedono solo gli eventi.
//     Si sincronizza quando l'app lo chiede (subito dopo una modifica) e con il "Cron Trigger" ogni minuto: giro leggero (legge da
//     Firestore solo i clienti degli eventi cambiati in Google) e, allo scoccare di ogni ora, un controllo completo.
//
// Impostazioni nel pannello Cloudflare (Worker > Settings):
//   SERVICE_ACCOUNT      (Secret)  JSON della chiave di servizio Firebase (progetto clienti-malfer)
//   GOOGLE_CLIENT_ID     (Secret)  ID client OAuth "Applicazione web" della console Google (stesso progetto)
//   GOOGLE_CLIENT_SECRET (Secret)  il suo segreto
//   Trigger events > Cron Triggers: * * * * *   (ogni minuto)
//   (facoltative) ALLOWED_ORIGINS = https://clienti.malfer.it   APP_URL = https://clienti.malfer.it
//
// Dove stanno i dati:
//   calendario_segreti/{uid}            (solo il servizio: le regole di Firestore non lo fanno leggere all'app)
//       { refresh, email, calId, calNome, mostra[], calendari[], syncToken, mappa: { <idCliente>: { ev, k } }, creato }
//       k = "YYYY-MM-DD|HH:MM" del richiamo come è ora nell'evento Google (serve a capire chi ha cambiato cosa)
//   utenti/{uid}/impostazioni/gcal       stato per l'app { collegato, email, calId, calNome, mostra[], calendari[], ultimo, errore }
//   utenti/{uid}/impostazioni/gcal_eventi  { agg, ev: [ { id, c, t, s, e, g, l, u } ] }   (appuntamenti Google da mostrare)
//
// Percorsi:
//   GET  /ping                         servizio attivo
//   GET  /cal/<uid>/<token>.ics        link .ics
//   POST /google/inizio                (login app) -> { url } pagina di autorizzazione Google
//   GET  /google/ritorno?code&state    Google torna qui: salva il permesso e mostra "fatto"
//   POST /google/scegli                (login app) { calId } | { nuovo: "Nome" } | { mostra: [id…] }
//   POST /google/sincronizza           (login app) sincronizza adesso
//   POST /google/scollega              (login app) toglie il permesso e i dati del collegamento
//   POST /icloud/collega               (login app) { user, pass } oppure { rosario: true } (usa l'iCloud già dato a Rosario)
//   POST /icloud/scegli | /icloud/scollega | /icloud/sincronizza   come per Google
//   utenti/{uid}/impostazioni/icloud e icloud_eventi: stato e appuntamenti iCloud per l'app (come gcal e gcal_eventi)

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const STATI = { "DA CONTATTARE": "Da contattare", "CONTATTATO": "Contattato", "CLIENTE": "Cliente", "CLIENTE PERSO": "Cliente perso", "NON SERVIBILE": "Non servibile" };
const CAMPI = ["nome", "luogo", "indirizzo", "referente", "tel", "cellulare", "email", "stato", "note", "ricontattare", "ricontattareOra", "ricontattareModo", "ricontattareFine",
  "giorniOrdine", "orarioOrdine", "chiusoDal", "chiusoAl"];
const PERCORSO = /^\/cal\/([A-Za-z0-9_-]{6,128})\/([a-f0-9]{32,128})\.ics$/;
const SCOPE = "openid email https://www.googleapis.com/auth/calendar";
const MAX_SCRITTURE = 25;          // eventi Google creati/cambiati per giro di sincronizzazione (limite di richieste del Worker gratuito)

class Errore extends Error { constructor(stato, msg){ super(msg); this.stato = stato; } }

/* ---------- utilità ---------- */
const b64u = b => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; bytes.forEach(x => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const da64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const json64 = s => JSON.parse(new TextDecoder().decode(da64u(s)));
function uguali(a, b){
  if(typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0; for(let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
const B32 = "0123456789abcdefghijklmnopqrstuv";
function base32hex(str){            // per gli id degli eventi Google (ammessi solo 0-9 e a-v)
  let bits = 0, val = 0, out = "";
  for(const byte of new TextEncoder().encode(str)){ val = (val << 8) | byte; bits += 8; while(bits >= 5){ out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if(bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

/* ---------- accesso a Firestore con la chiave di servizio ---------- */
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
const progetto = env => env.FIREBASE_PROJECT || servizio(env).project_id;
const radice = env => "projects/" + progetto(env) + "/databases/(default)/documents";
const base = env => (env.FIRESTORE_URL || "https://firestore.googleapis.com/v1") + "/" + radice(env);
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
function enc(v){
  if(v === null || v === undefined) return { nullValue: null };
  if(typeof v === "boolean") return { booleanValue: v };
  if(typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if(typeof v === "string") return { stringValue: v };
  if(Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encCampi(v) } };
}
const encCampi = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)]));
async function fsChiama(env, metodo, url, corpo){
  const r = await fetch(url, { method: metodo, headers: { authorization: "Bearer " + await accesso(env), "content-type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  if(r.status === 404 && metodo === "GET") return null;
  if(!r.ok) throw new Error("Firestore " + metodo + " " + r.status);
  return r.json();
}
async function leggi(env, url){ return fsChiama(env, "GET", url); }
async function leggiDoc(env, percorso){ const d = await leggi(env, base(env) + "/" + percorso); return d ? campi(d.fields || {}) : null; }
// scritture in un colpo solo: [{ percorso, dati, campi? (solo questi campi), esiste? }] oppure { percorso, elimina: true }
async function scrivi(env, scritture){
  if(!scritture.length) return;
  const writes = scritture.map(w => w.elimina ? { delete: radice(env) + "/" + w.percorso } : {
    update: { name: radice(env) + "/" + w.percorso, fields: encCampi(w.dati) },
    ...(w.campi ? { updateMask: { fieldPaths: w.campi } } : {}),
    ...(w.esiste ? { currentDocument: { exists: true } } : {})
  });
  await fsChiama(env, "POST", base(env) + ":commit", { writes });
}
// solo alcuni clienti, in una richiesta (giro leggero)
async function clientiPerId(env, uid, ids){
  if(!ids.length) return [];
  const r = await fsChiama(env, "POST", base(env) + ":batchGet", { documents: ids.map(id => radice(env) + "/utenti/" + uid + "/clienti/" + id), mask: { fieldPaths: [...CAMPI, "storico", "giro"] } });
  return (r || []).filter(x => x.found).map(x => ({ id: decodeURIComponent(x.found.name.split("/").pop()), ...campi(x.found.fields || {}) }));
}
function impronta(s){ let a = 5381, b = 52711; for(let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); a = (a * 33) ^ c; b = (b * 33) ^ c; } return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36); }
async function clientiDi(env, uid, extra = []){
  const out = []; let pag = "";
  do {
    const q = ["pageSize=300", ...[...CAMPI, ...extra].map(k => "mask.fieldPaths=" + k), pag ? "pageToken=" + encodeURIComponent(pag) : ""].filter(Boolean).join("&");
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
const pad = n => String(n).padStart(2, "0");
function romaDi(dateTime){          // "2026-11-23T10:00:00+01:00" -> { d: "2026-11-23", o: "10:00" } in ora italiana
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(dateTime)).map(x => [x.type, x.value]));
  return { d: p.year + "-" + p.month + "-" + p.day, o: p.hour + ":" + p.minute };
}

/* ---------- 1) file .ics ---------- */
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function piega(riga){
  const e = new TextEncoder(); if(e.encode(riga).length <= 75) return riga;
  const out = []; let cur = "", n = 0;
  for(const ch of riga){ const b = e.encode(ch).length; if(n + b > (out.length ? 74 : 75)){ out.push(cur); cur = ""; n = 0; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n ");
}
const VTZ = ["BEGIN:VTIMEZONE", "TZID:Europe/Rome", "X-LIC-LOCATION:Europe/Rome",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE"];
const descrizione = c => [c.referente && "Referente: " + c.referente, c.tel && "Tel: " + c.tel, c.cellulare && "Cell: " + c.cellulare,
  c.email && "Email: " + c.email, c.stato && "Stato: " + (STATI[c.stato] || c.stato), c.note && "Note: " + c.note, "App: https://clienti.malfer.it"].filter(Boolean).join("\n");

export function creaCalendario(clienti, opz = {}){
  const oggi = opz.oggi || oggiRoma();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Malfer//Clienti//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + esc(opz.nome || "Clienti – richiami e giro"), "X-WR-TIMEZONE:Europe/Rome",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTZ];
  const tuttoGiorno = iso => ["DTSTART;VALUE=DATE:" + iso.replace(/-/g, ""), "DTEND;VALUE=DATE:" + piuGiorni(iso, 1).replace(/-/g, "")];
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
    L.push("SUMMARY:" + esc(titoloApp(c)));
    const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", ");
    if(luogo) L.push("LOCATION:" + esc(luogo));
    L.push("DESCRIPTION:" + esc(descrizione(c)), "END:VEVENT");
  }
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

/* ---------- login dell'app (token Firebase) ---------- */
let jwks = null, jwksQuando = 0;
async function utente(req, env){
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if(!m) throw new Errore(401, "accesso mancante");
  const parti = m[1].split(".");
  if(parti.length !== 3) throw new Errore(401, "accesso non valido");
  let head, pay;
  try { head = json64(parti[0]); pay = json64(parti[1]); } catch(e){ throw new Errore(401, "accesso non valido"); }
  const prog = progetto(env), ora = Math.floor(Date.now() / 1000);
  if(head.alg !== "RS256" || pay.aud !== prog || pay.iss !== "https://securetoken.google.com/" + prog || !pay.sub || !(pay.exp > ora) || pay.iat > ora + 300)
    throw new Errore(401, "accesso scaduto o non valido");
  if(!jwks || Date.now() - jwksQuando > 3600e3){
    const r = await fetch(env.JWKS_URL || "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    if(!r.ok) throw new Errore(502, "non riesco a verificare il login");
    jwks = (await r.json()).keys || []; jwksQuando = Date.now();
  }
  const jwk = jwks.find(k => k.kid === head.kid);
  if(!jwk) throw new Errore(401, "accesso non valido");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, da64u(parti[2]), new TextEncoder().encode(parti[0] + "." + parti[1]));
  if(!ok) throw new Errore(401, "accesso non valido");
  return pay.sub;
}

/* ---------- Google: permesso (OAuth) e chiamate ---------- */
const G_API = env => env.GOOGLE_API || "https://www.googleapis.com";
const G_TOKEN = env => (env.GOOGLE_OAUTH || "https://oauth2.googleapis.com") + "/token";
async function hmac(env, testo){
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("stato:" + env.GOOGLE_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(testo)));
}
async function creaStato(env, uid){ const p = b64u(JSON.stringify({ u: uid, e: Date.now() + 15 * 60e3 })); return p + "." + await hmac(env, p); }
async function leggiStato(env, s){
  const [p, f] = String(s || "").split(".");
  if(!p || !f || !uguali(f, await hmac(env, p))) return null;
  try { const o = json64(p); return o.e > Date.now() && typeof o.u === "string" ? o.u : null; } catch(e){ return null; }
}
const ritornoUrl = req => new URL(req.url).origin + "/google/ritorno";

class Google {
  constructor(env, refresh){ this.env = env; this.refresh = refresh; this.at = null; this.chiamate = 0; }
  async token(){
    if(this.at) return this.at;
    const r = await fetch(G_TOKEN(this.env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: this.refresh, grant_type: "refresh_token" }) });
    this.chiamate++;
    if(!r.ok){ const j = await r.json().catch(() => ({})); throw new Errore(j.error === "invalid_grant" ? 410 : 502, j.error === "invalid_grant" ? "permesso Google revocato o scaduto: ricollega Google" : "Google non risponde"); }
    this.at = (await r.json()).access_token; return this.at;
  }
  async chiama(metodo, percorso, corpo){
    const r = await fetch(G_API(this.env) + "/calendar/v3" + percorso, { method: metodo,
      headers: { authorization: "Bearer " + await this.token(), ...(corpo ? { "content-type": "application/json" } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    this.chiamate++;
    if(r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if(!r.ok){ const e = new Errore(r.status, "Google Calendar: " + ((j.error && j.error.message) || r.status)); e.google = r.status; throw e; }
    return j;
  }
  async calendari(){
    const j = await this.chiama("GET", "/users/me/calendarList?maxResults=250");
    return (j.items || []).map(c => ({ id: c.id, nome: c.summaryOverride || c.summary || c.id, colore: c.backgroundColor || "#4285F4",
      principale: !!c.primary, scrivibile: c.accessRole === "owner" || c.accessRole === "writer" }));
  }
}

/* ---------- 2) sincronizzazione ---------- */
// "data|ora" e, se c'è, "|telefono" o "|visita" (icona 📞/💼 nel titolo dell'evento)
// "data|ora", poi "|modo" (telefono/visita) e "|fine" solo se l'ora di fine non è la solita mezz'ora dopo
const piuMezzora = o => { const [hh, mm] = o.split(":").map(Number), t = (hh * 60 + mm + 30) % 1440; return pad(Math.floor(t / 60)) + ":" + pad(t % 60); };
function chiaveDa(d, o, modo, fine){
  const m = modo === "telefono" || modo === "visita" ? modo : "", f = o && /^\d{2}:\d{2}$/.test(fine || "") && fine !== piuMezzora(o) ? fine : "";
  return d + "|" + o + (f ? "|" + m + "|" + f : m ? "|" + m : "");
}
const chiaveCliente = c => c && c.ricontattare && /^\d{4}-\d{2}-\d{2}$/.test(c.ricontattare)
  ? chiaveDa(c.ricontattare, /^\d{1,2}:\d{2}$/.test(c.ricontattareOra || "") ? c.ricontattareOra.padStart(5, "0") : "", c.ricontattareModo, oraNorm(c.ricontattareFine)) : "";
// l'ora di fine scelta nell'app (se è dopo l'inizio), altrimenti mezz'ora
const fineCliente = (c, o) => { const f = oraNorm(c.ricontattareFine); return f && f > o ? f : piuMezzora(o); };
const titoloApp = c => ({ telefono: "📞 ", visita: "💼 " }[c.ricontattareModo] || "") + "Richiamare: " + (c.nome || "cliente");
function chiaveEvento(ev){
  if(!ev || !ev.start) return "";
  const m = modoDi(ev.summary || "");
  if(ev.start.date) return chiaveDa(ev.start.date, "", m, "");
  if(ev.start.dateTime){ const r = romaDi(ev.start.dateTime), f = ev.end && ev.end.dateTime ? romaDi(ev.end.dateTime) : null; return chiaveDa(r.d, r.o, m, f && f.d === r.d ? f.o : ""); }
  return "";
}
function corpoEvento(c){
  const [d, o] = chiaveCliente(c).split("|");
  const ev = { summary: titoloApp(c), description: descrizione(c),
    extendedProperties: { private: { app: "clienti", cliente: c.id } }, status: "confirmed" };
  const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", "); if(luogo) ev.location = luogo;
  if(o){
    const f = fineCliente(c, o), fineD = f > o ? d : piuGiorni(d, 1);
    ev.start = { dateTime: d + "T" + o + ":00", timeZone: "Europe/Rome" };
    ev.end = { dateTime: fineD + "T" + f + ":00", timeZone: "Europe/Rome" };
    ev.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] };
  } else {
    ev.start = { date: d }; ev.end = { date: piuGiorni(d, 1) };
    ev.reminders = { useDefault: false, overrides: [] };
    ev.transparency = "transparent";
  }
  return ev;
}
// un solo evento Google per cliente, con id fisso: se la memoria dei collegamenti si perde, non nascono doppioni
const idEvento = c => "cl" + base32hex(c.id);
async function creaEvento(g, calId, c){
  const id = idEvento(c), corpo = corpoEvento(c);
  try { await g.chiama("POST", cal(calId) + "/events", { id, ...corpo }); return id; }
  catch(e){ if(e.google !== 409) throw e; }
  try { await g.chiama("PUT", cal(calId) + "/events/" + id, corpo); return id; }        // esiste già (anche cancellato): si riusa
  catch(e){ if(![403, 404, 410].includes(e.google)) throw e; }
  const id2 = id + "v" + base32hex(String(Date.now()));                                // non riutilizzabile: id nuovo
  await g.chiama("POST", cal(calId) + "/events", { id: id2, ...corpo }); return id2;
}
const cal = id => "/calendars/" + encodeURIComponent(id);
const scrittaStorico = k => { const [d, o] = k.split("|"); return dataIt(d) + (o ? " ore " + o : ""); };

export async function sincronizza(env, uid, opz = {}){
  const S = opz.S !== undefined ? opz.S : await leggiDoc(env, "calendario_segreti/" + uid);
  if(!S || !S.refresh) return { collegato: false };
  const g = new Google(env, S.refresh);
  const oggi = opz.oggi || oggiRoma(), dal = piuGiorni(oggi, -60);
  const mappa = S.mappa && typeof S.mappa === "object" ? S.mappa : {};
  const stat = { creati: 0, cambiati: 0, tolti: 0, daGoogle: 0, rimandati: 0 };
  const scritture = [], storicoOggi = oggi;
  let calendari = Array.isArray(S.calendari) ? S.calendari : [];
  const pulizia = Array.isArray(S.pulizia) ? [...S.pulizia] : [];       // eventi rimasti nel calendario di prima, da togliere a rate
  let scritte = 0;
  const tocca = () => { if(scritte >= MAX_SCRITTURE){ stat.rimandati++; return false; } scritte++; return true; };
  try {
    if(opz.calendari || !calendari.length) calendari = await g.calendari();
    while(pulizia.length && tocca()){
      const x = pulizia[0];
      try { await g.chiama("DELETE", cal(x.cal) + "/events/" + encodeURIComponent(x.ev)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; }
      pulizia.shift();
    }
    // giro leggero (cron ogni minuto): si leggono solo i clienti degli eventi cambiati in Google, non tutto l'elenco
    let clienti = [], perId = new Map();
    let syncToken = S.syncToken || null;

    if(S.calId){
      // a) cosa è cambiato in Google dall'ultima volta
      const cambiati = [];
      const elenco = async (token) => {
        let pag = "", prossimo = null, giri = 0;
        do {
          const q = new URLSearchParams({ maxResults: "250", singleEvents: "true", showDeleted: "true" });
          if(token) q.set("syncToken", token); else q.set("timeMin", dal + "T00:00:00Z");
          if(pag) q.set("pageToken", pag);
          const j = await g.chiama("GET", cal(S.calId) + "/events?" + q);
          (j.items || []).forEach(e => cambiati.push(e));
          pag = j.nextPageToken || ""; prossimo = j.nextSyncToken || prossimo;
        } while(pag && ++giri < 6);
        return prossimo;
      };
      try { syncToken = await elenco(syncToken); }
      catch(e){ if(e.google === 410){ cambiati.length = 0; syncToken = await elenco(null); } else throw e; }

      const evCliente = new Map(Object.entries(mappa).map(([cid, m]) => [m.ev, cid]));
      const cidDi = ev => evCliente.get(ev.id) || (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.app === "clienti" ? ev.extendedProperties.private.cliente : null);
      const toccati = [...new Set(cambiati.map(cidDi).filter(cid => cid && mappa[cid]))];
      clienti = opz.leggero ? await clientiPerId(env, uid, toccati) : await clientiDi(env, uid, ["storico"]);
      perId = new Map(clienti.map(c => [c.id, c]));
      for(const ev of cambiati){
        const cid = cidDi(ev);
        if(!cid) continue;
        const m = mappa[cid], c = perId.get(cid);
        if(!m || m.ev !== ev.id) continue;
        if(ev.status === "cancelled"){
          if(c && chiaveCliente(c) === m.k){
            c.ricontattare = ""; c.ricontattareOra = "";
            c.storico = [...(c.storico || []), { d: storicoOggi, t: "Richiamo tolto da Google Calendar" }];
            c._cambiato = true; stat.daGoogle++;
          }
          delete mappa[cid];
          continue;
        }
        const kg = chiaveEvento(ev);
        if(kg && kg !== m.k){
          if(c && chiaveCliente(c) === m.k){
            const [d, o, mo, fi] = kg.split("|");
            c.ricontattare = d; c.ricontattareOra = o; c.ricontattareModo = mo || ""; c.ricontattareFine = fi || "";
            c.storico = [...(c.storico || []), { d: storicoOggi, t: "Richiamo spostato da Google Calendar al " + scrittaStorico(kg) }];
            c._cambiato = true; stat.daGoogle++;
          }
          m.k = kg;
        }
      }

      // b) dall'app a Google
      for(const c of clienti){
        const k = chiaveCliente(c), m = mappa[c.id];
        if(k && k.slice(0, 10) < dal && !m) continue;            // richiami vecchi: non si creano
        if(k && !m){
          if(!tocca()) continue;
          mappa[c.id] = { ev: await creaEvento(g, S.calId, c), k }; stat.creati++;
        } else if(k && m && k !== m.k){
          if(!tocca()) continue;
          try { await g.chiama("PUT", cal(S.calId) + "/events/" + encodeURIComponent(m.ev), corpoEvento(c)); m.k = k; stat.cambiati++; }
          catch(e){
            if(e.google !== 404 && e.google !== 410) throw e;
            mappa[c.id] = { ev: await creaEvento(g, S.calId, c), k }; stat.creati++;
          }
        } else if(!k && m){
          if(!tocca()) continue;
          try { await g.chiama("DELETE", cal(S.calId) + "/events/" + encodeURIComponent(m.ev)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; }
          delete mappa[c.id]; stat.tolti++;
        }
      }
      if(!opz.leggero) for(const cid of Object.keys(mappa)) if(!perId.has(cid)){        // cliente eliminato dall'app
        if(!tocca()) continue;
        try { await g.chiama("DELETE", cal(S.calId) + "/events/" + encodeURIComponent(mappa[cid].ev)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; }
        delete mappa[cid]; stat.tolti++;
      }
    }

    // c) appuntamenti Google da mostrare nell'app (sola lettura)
    const nomi = new Map(calendari.map((c, i) => [c.id, i]));
    const mostra = (Array.isArray(S.mostra) && S.mostra.length ? S.mostra : calendari.filter(c => c.principale).map(c => c.id)).filter(id => nomi.has(id)).slice(0, 4);
    const ev = [];
    for(const id of mostra){
      const q = new URLSearchParams({ maxResults: "250", singleEvents: "true", orderBy: "startTime", timeMin: piuGiorni(oggi, -14) + "T00:00:00Z", timeMax: piuGiorni(oggi, 120) + "T00:00:00Z" });
      const j = await g.chiama("GET", cal(id) + "/events?" + q);
      for(const e of j.items || []){
        if(e.status === "cancelled" || (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.app === "clienti")) continue;
        if(S.ggiro && (S.ggiro[e.recurringEventId] || S.ggiro[e.id])) continue;                // ordine del giro collegato: si vede tra gli ordini
        const tg = !!(e.start && e.start.date);
        const s = tg ? e.start.date : e.start && e.start.dateTime ? romaDi(e.start.dateTime) : null;
        const f = tg ? e.end && e.end.date : e.end && e.end.dateTime ? romaDi(e.end.dateTime) : null;
        if(!s) continue;
        ev.push({ id: String(e.id).slice(0, 200), r: String(e.recurringEventId || ""), c: nomi.get(id), t: String(e.summary || "(senza titolo)").slice(0, 200),
          s: tg ? s : s.d + "T" + s.o, e: tg ? (f || piuGiorni(s, 1)) : f ? f.d + "T" + f.o : s.d + "T" + s.o, g: tg,
          l: String(e.location || "").slice(0, 200), u: String(e.htmlLink || "").slice(0, 500) });
      }
    }
    ev.sort((a, b) => a.s.localeCompare(b.s));

    // d) salvataggio
    for(const c of clienti) if(c._cambiato)
      scritture.push({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true, campi: ["ricontattare", "ricontattareOra", "ricontattareModo", "ricontattareFine", "storico", "aggiornato"],
        dati: { ricontattare: c.ricontattare, ricontattareOra: c.ricontattareOra, ricontattareModo: c.ricontattareModo || "", ricontattareFine: c.ricontattareFine || "", storico: c.storico, aggiornato: new Date().toISOString() } });
    const evHash = impronta(JSON.stringify(ev.slice(0, 600)) + JSON.stringify(mostra));
    scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["mappa", "syncToken", "calendari", "evHash", "pulizia"], dati: { mappa, syncToken, calendari, evHash, pulizia } });
    scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["collegato", "ultimo", "errore", "calendari", "mostra"],
      dati: { collegato: true, ultimo: new Date().toISOString(), errore: stat.rimandati ? "Molti richiami da copiare: finisco tra pochi minuti" : null, calendari, mostra } });
    if(evHash !== S.evHash) scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal_eventi", dati: { agg: new Date().toISOString(), ev: ev.slice(0, 600) } });
    await scrivi(env, scritture);
    return { collegato: true, ...stat, chiamateGoogle: g.chiamate };
  } catch(err){
    // salva comunque i progressi fatti (eventi già creati) e l'errore da mostrare nell'app
    const revocato = err.stato === 410;
    await scrivi(env, [
      { percorso: "calendario_segreti/" + uid, campi: ["mappa", "pulizia"], dati: { mappa, pulizia } },
      { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["errore", "collegato"], dati: { errore: String(err.message || err).slice(0, 200), collegato: !revocato } }
    ]).catch(() => {});
    throw err;
  }
}

async function cambiaCalendario(env, uid, S, nuovoId, nuovoNome){
  const g = new Google(env, S.refresh);
  const mappa = S.mappa || {};
  // gli eventi del calendario vecchio si tolgono: i primi subito, gli altri ai giri dopo (pulizia)
  const pulizia = [...(Array.isArray(S.pulizia) ? S.pulizia : []), ...(S.calId && S.calId !== nuovoId ? Object.values(mappa).map(m => ({ cal: S.calId, ev: m.ev })) : [])];
  for(let n = 0; pulizia.length && n < MAX_SCRITTURE; n++){
    const x = pulizia[0];
    try { await g.chiama("DELETE", cal(x.cal) + "/events/" + encodeURIComponent(x.ev)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; }
    pulizia.shift();
  }
  await scrivi(env, [
    { percorso: "calendario_segreti/" + uid, campi: ["calId", "calNome", "mappa", "syncToken", "pulizia"], dati: { calId: nuovoId, calNome: nuovoNome, mappa: {}, syncToken: null, pulizia } },
    { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["calId", "calNome"], dati: { calId: nuovoId, calNome: nuovoNome } }
  ]);
}

/* ---------- 3) iCLOUD NEI DUE SENSI (v6.8) ----------
   Apple non ha un "consenti" come Google: si usa CalDAV (caldav.icloud.com) con l'email Apple e una PASSWORD PER APP
   (creata dall'utente su account.apple.com). Le credenziali stanno solo in calendario_segreti/{uid}.icloud.
   Gli appuntamenti vanno in UN solo servizio (Google o iCloud): scegliendo il calendario in uno, si tolgono dall'altro. */
const DAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"';
const xmlTutti = (s, tag) => [...String(s || "").matchAll(new RegExp("<(?:[\\w-]+:)?" + tag + "(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?" + tag + ">)", "g"))].map(m => m[1] || "");
const xmlUno = (s, tag) => xmlTutti(s, tag)[0];
const xmlHa = (s, tag) => new RegExp("<(?:[\\w-]+:)?" + tag + "[\\s/>]").test(String(s || ""));
const xmlTesto = s => String(s == null ? "" : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").trim();
const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const b64 = s => { let x = ""; new TextEncoder().encode(s).forEach(b => (x += String.fromCharCode(b))); return btoa(x); };
const percorso = (href, rif) => { try { return new URL(href, rif).pathname; } catch(e){ return String(href || ""); } };

export class ICloud {
  constructor(env, user, pass, home){ this.env = env; this.auth = "Basic " + b64(user + ":" + pass); this.home = home || ""; this.chiamate = 0; }
  get radice(){ return this.env.ICLOUD_URL || "https://caldav.icloud.com"; }
  async dav(metodo, url, corpo, extra = {}){
    const r = await fetch(new URL(url, this.home || this.radice).toString(), { method: metodo, redirect: "follow",
      headers: { authorization: this.auth, ...(corpo ? { "content-type": /^BEGIN:/.test(corpo) ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}), ...extra }, body: corpo });
    this.chiamate++;
    const t = await r.text();
    if(r.status === 401) throw new Errore(401, "iCloud non accetta email e password per app: controllale o creane una nuova e ricollega iCloud");
    return { s: r.status, t };
  }
  async scopri(){
    let r = await this.dav("PROPFIND", this.radice + "/", `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV}><d:prop><d:current-user-principal/></d:prop></d:propfind>`, { depth: "0" });
    if(r.s >= 400) throw new Errore(502, "iCloud non risponde (" + r.s + ")");
    const princ = xmlTesto(xmlUno(xmlUno(r.t, "current-user-principal"), "href"));
    if(!princ) throw new Errore(502, "iCloud non ha indicato il tuo account");
    const pUrl = new URL(princ, this.radice).toString();
    r = await this.dav("PROPFIND", pUrl, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, { depth: "0" });
    const home = xmlTesto(xmlUno(xmlUno(r.t, "calendar-home-set"), "href"));
    if(r.s >= 400 || !home) throw new Errore(502, "iCloud non ha indicato dove sono i tuoi calendari");
    this.home = new URL(home, pUrl).toString();
    if(!this.home.endsWith("/")) this.home += "/";
    return this.home;
  }
  // tutti i calendari, con il "ctag" (cambia quando cambia qualcosa dentro)
  async calendari(){
    const r = await this.dav("PROPFIND", this.home, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV}><d:prop><d:displayname/><d:resourcetype/><a:calendar-color/>` +
      `<c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/></d:prop></d:propfind>`, { depth: "1" });
    if(r.s >= 400) throw new Errore(502, "iCloud non dà l'elenco dei calendari (" + r.s + ")");
    const out = [], risp = xmlTutti(r.t, "response"), homePath = new URL(this.home).pathname;
    // rapporto tecnico (solo nomi dei tag, niente dati personali) per capire cosa manda iCloud se non si trova nessun calendario
    const soloTag = s => [...new Set((String(s || "").match(/<[\w:-]+/g) || []).map(t => t.slice(1).replace(/^[\w-]+:/, "")))].join(",");
    const compNomi = s => (String(s || "").match(/name\s*=\s*["']?([A-Za-z]+)/g) || []).map(x => x.replace(/.*["'=]\s*/, "").replace(/^name/i, "")).join(" ");
    this.diag = "stato " + r.s + ", home " + homePath.replace(/[0-9]{4,}/g, "N") + ", risposte " + risp.length + ": " + risp.slice(0, 8).map(resp => {
      const href = percorso(xmlTesto(xmlUno(resp, "href")), this.home);
      return "[" + (href === homePath ? "HOME" : href.replace(homePath, "").replace(/[0-9a-f-]{8,}/gi, "X")) + " | tipo:" + soloTag(xmlUno(resp, "resourcetype")) +
        " | comp:" + compNomi(xmlUno(resp, "supported-calendar-component-set")) + " | nome:" + (xmlTesto(xmlUno(resp, "displayname")) ? "sì" : "no") + " | prop:" + soloTag(resp).slice(0, 160) + "]";
    }).join(" ");
    for(const resp of risp){
      const href = percorso(xmlTesto(xmlUno(resp, "href")), this.home);
      if(href === homePath || /\/(inbox|outbox|notification|dropbox|freebusy)\/?$/i.test(href)) continue;     // cartella principale e caselle di sistema
      const tipo = xmlUno(resp, "resourcetype") || "";
      if(/schedule-(inbox|outbox)|notification/i.test(tipo)) continue;
      const comp = xmlUno(resp, "supported-calendar-component-set");
      const haEventi = comp ? /name\s*=\s*["']?VEVENT/i.test(comp) : null;
      // è un calendario se lo dice resourcetype, oppure se accetta eventi (iCloud a volte non manda resourcetype come ci si aspetta)
      if(!(xmlHa(tipo, "calendar") || haEventi)) continue;
      if(haEventi === false) continue;                                                                   // solo promemoria (VTODO)
      const priv = xmlUno(resp, "current-user-privilege-set");
      out.push({ id: new URL(href, this.home).toString().replace(/\/?$/, "/"), nome: xmlTesto(xmlUno(resp, "displayname")) || "Calendario",
        colore: (xmlTesto(xmlUno(resp, "calendar-color")).match(/^#[0-9a-f]{6}/i) || ["#FF9500"])[0], principale: false,
        scrivibile: !priv || xmlHa(priv, "write") || xmlHa(priv, "all") || xmlHa(priv, "write-content"), ctag: xmlTesto(xmlUno(resp, "getctag")) });
    }
    return out;
  }
  async creaCalendario(nome){
    const url = new URL("clienti-" + Date.now().toString(36) + "/", this.home).toString();
    const r = await this.dav("MKCALENDAR", url, `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar ${DAV}><d:set><d:prop><d:displayname>${xmlEsc(nome)}</d:displayname>` +
      `<a:calendar-color>#0F5A3DFF</a:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`);
    if(r.s !== 201 && r.s !== 200) throw new Errore(502, "iCloud non ha creato il calendario (" + r.s + ")");
    return url;
  }
  // cosa è cambiato nel calendario dall'ultima volta (RFC 6578)
  async sync(cal, token){
    const r = await this.dav("REPORT", cal, `<?xml version="1.0" encoding="utf-8"?><d:sync-collection ${DAV}><d:sync-token>${xmlEsc(token || "")}</d:sync-token>` +
      `<d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`, { depth: "1" });
    if(token && (r.s === 403 || r.s === 409 || r.s === 400)){ const e = new Error("token"); e.invalido = true; throw e; }
    if(r.s >= 400) throw new Errore(502, "iCloud non dà le modifiche (" + r.s + ")");
    const cambiati = [], cancellati = [];
    for(const resp of xmlTutti(r.t, "response")){
      const href = percorso(xmlTesto(xmlUno(resp, "href")), cal);
      if(!/\.ics$/i.test(href)) continue;
      if(!xmlHa(resp, "propstat") && /\b404\b/.test(xmlTesto(xmlUno(resp, "status")))) cancellati.push(href); else cambiati.push(href);
    }
    const tks = xmlTutti(r.t, "sync-token"), tk = xmlTesto(tks[tks.length - 1]);
    return { token: tk, cambiati, cancellati };
  }
  async multiget(cal, hrefs){
    const r = await this.dav("REPORT", cal, `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${DAV}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      hrefs.map(h => `<d:href>${xmlEsc(h)}</d:href>`).join("") + `</c:calendar-multiget>`, { depth: "1" });
    if(r.s >= 400) throw new Errore(502, "iCloud non dà gli eventi (" + r.s + ")");
    const out = new Map();
    this.etag = this.etag || new Map();
    for(const resp of xmlTutti(r.t, "response")){
      const d = xmlUno(resp, "calendar-data"), href = percorso(xmlTesto(xmlUno(resp, "href")), cal);
      if(d){ out.set(href, xmlTesto(d)); this.etag.set(href, xmlTesto(xmlUno(resp, "getetag"))); }
    }
    return out;
  }
  // eventi ricorrenti ogni settimana di un calendario (le serie, senza "espandere" le ripetizioni)
  async serie(cal){
    const z = iso => iso.replace(/-/g, "") + "T000000Z", da = oggiRoma(), a = piuGiorni(da, 15);
    const r = await this.dav("REPORT", cal, `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${z(da)}" end="${z(a)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, { depth: "1" });
    if(r.s >= 400) throw new Errore(502, "iCloud non dà gli eventi del giro (" + r.s + ")");
    const out = [];
    for(const resp of xmlTutti(r.t, "response")){
      const s = serieIcs(xmlTesto(xmlUno(resp, "calendar-data")));
      if(s && s.uid && !/^clienti-/.test(s.uid) && !s.finita) out.push({ ...s, cal, href: percorso(xmlTesto(xmlUno(resp, "href")), cal) });
    }
    return out;
  }
  async aggiorna(href, testo, etag){
    const r = await this.dav("PUT", href, testo, etag ? { "if-match": etag } : {});
    if(r.s === 412) return false;                               // cambiato nel frattempo: si riprova al giro dopo
    if(r.s >= 300) throw new Errore(502, "iCloud non ha aggiornato l'evento del giro (" + r.s + ")");
    return true;
  }
  // appuntamenti di un calendario in un periodo (ricorrenze già "espanse" da iCloud)
  async eventi(cal, da, a){
    const z = iso => iso.replace(/-/g, "") + "T000000Z";
    const r = await this.dav("REPORT", cal, `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV}><d:prop><c:calendar-data><c:expand start="${z(da)}" end="${z(a)}"/></c:calendar-data></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${z(da)}" end="${z(a)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, { depth: "1" });
    if(r.s >= 400) throw new Errore(502, "iCloud non dà gli appuntamenti (" + r.s + ")");
    const out = [];
    for(const resp of xmlTutti(r.t, "response")){
      for(const e of icsEventi(xmlTesto(xmlUno(resp, "calendar-data")))){
        const uid = e.UID ? e.UID.v : "";
        if(/^clienti-/.test(uid) || e["X-CLIENTI-ID"] || (e.STATUS && /CANCELLED/i.test(e.STATUS.v))) continue;
        const s = icsData(e.DTSTART); if(!s) continue;
        const f = icsData(e.DTEND), tg = !s.o;
        out.push({ id: (uid + (e["RECURRENCE-ID"] ? "|" + e["RECURRENCE-ID"].v : "")).slice(0, 200), h: percorso(xmlTesto(xmlUno(resp, "href")), cal),
          ri: e["RECURRENCE-ID"] ? "RECURRENCE-ID" + e["RECURRENCE-ID"].p + ":" + e["RECURRENCE-ID"].v : "", t: icsTesto(e.SUMMARY ? e.SUMMARY.v : "(senza titolo)").slice(0, 200),
          s: tg ? s.d : s.d + "T" + s.o, e: tg ? (f ? f.d : piuGiorni(s.d, 1)) : f && f.o ? f.d + "T" + f.o : s.d + "T" + s.o, g: tg,
          l: icsTesto(e.LOCATION ? e.LOCATION.v : "").slice(0, 200), u: "" });
      }
    }
    return out;
  }
  async metti(cal, c){
    const url = new URL("clienti-" + encodeURIComponent(c.id) + ".ics", cal).toString();
    const r = await this.dav("PUT", url, icsCliente(c));
    if(r.s >= 300) throw new Errore(502, "iCloud non ha salvato l'appuntamento (" + r.s + ")");
    return new URL(url).pathname;
  }
  async togli(href){
    const r = await this.dav("DELETE", href);
    if(r.s >= 300 && r.s !== 404 && r.s !== 410) throw new Errore(502, "iCloud non ha tolto l'appuntamento (" + r.s + ")");
  }
}

function icsEventi(testo){
  const righe = String(testo || "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = []; let ev = null, dentro = 0;
  for(const riga of righe){
    if(riga === "BEGIN:VEVENT"){ ev = {}; dentro = 0; continue; }
    if(riga === "END:VEVENT"){ if(ev) out.push(ev); ev = null; continue; }
    if(!ev) continue;
    if(/^BEGIN:/.test(riga)){ dentro++; continue; }
    if(/^END:/.test(riga)){ dentro--; continue; }
    if(dentro) continue;                                   // VALARM e simili
    const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(riga);
    if(m && !(m[1].toUpperCase() in ev)) ev[m[1].toUpperCase()] = { p: m[2], v: m[3] };
  }
  return out;
}
const icsTesto = v => String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
function icsData(x){
  if(!x) return null;
  if(/VALUE=DATE(?!-)/i.test(x.p) || /^\d{8}$/.test(x.v)) return { d: x.v.slice(0, 4) + "-" + x.v.slice(4, 6) + "-" + x.v.slice(6, 8) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(x.v);
  if(!m) return null;
  if(m[7]) return romaDi(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return { d: `${m[1]}-${m[2]}-${m[3]}`, o: `${m[4]}:${m[5]}` };           // ora con TZID (di solito Europe/Rome) o "locale"
}
const chiaveIcs = s => s ? s.d + "|" + (s.o || "") : "";
function icsCliente(c){
  const [d, o] = chiaveCliente(c).split("|");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Malfer//Clienti//IT", "CALSCALE:GREGORIAN", ...VTZ, "BEGIN:VEVENT",
    "UID:clienti-" + c.id + "@clienti.malfer.it", "DTSTAMP:" + stamp, "X-CLIENTI-ID:" + c.id];
  const dd = d.replace(/-/g, "");
  if(o){
    const f = fineCliente(c, o), fineD = (f > o ? d : piuGiorni(d, 1)).replace(/-/g, "");
    L.push("DTSTART;TZID=Europe/Rome:" + dd + "T" + o.replace(":", "") + "00", "DTEND;TZID=Europe/Rome:" + fineD + "T" + f.replace(":", "") + "00");
  } else L.push("DTSTART;VALUE=DATE:" + dd, "DTEND;VALUE=DATE:" + piuGiorni(d, 1).replace(/-/g, ""), "TRANSP:TRANSPARENT");
  L.push("SUMMARY:" + esc(titoloApp(c)));
  const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", ");
  if(luogo) L.push("LOCATION:" + esc(luogo));
  L.push("DESCRIPTION:" + esc(descrizione(c)));
  if(o) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc("Richiamare " + (c.nome || "")), "TRIGGER:-PT15M", "END:VALARM");
  L.push("END:VEVENT", "END:VCALENDAR");
  return L.map(piega).join("\r\n") + "\r\n";
}


/* ---------- GIRO DAL CALENDARIO iCLOUD (v6.11) ----------
   Manuel ha il giro nel suo calendario iCloud: un evento ricorrente ogni settimana per cliente, con 📞 (ordine al telefono)
   o 💼 (passa di persona) nel titolo. Ogni evento si abbina una volta al suo cliente; da lì giorni, ora e modo passano nei due sensi:
   evento ↔ cliente.giro [{g, ora, modo, ev}] + giorniOrdine/orarioOrdine (che l'app usa da sempre). */
const BYDAY = { MO: "Lunedì", TU: "Martedì", WE: "Mercoledì", TH: "Giovedì", FR: "Venerdì", SA: "Sabato", SU: "Domenica" };
const ORDINE_G = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const DAYBY = Object.fromEntries(Object.entries(BYDAY).map(([k, v]) => [v, k]));
const ICONA = { telefono: "📞", visita: "💼" };
const modoDi = t => /📞|☎|📱/u.test(t) ? "telefono" : /💼|🧳/u.test(t) ? "visita" : "";
const senzaIcone = t => String(t || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, "")
  .replace(/^[\s\-–—:·|]+|[\s\-–—:·|]+$/g, "").replace(/\s{2,}/g, " ").trim();
const ordinaG = arr => [...new Set(arr)].filter(g => ORDINE_G.includes(g)).sort((a, b) => ORDINE_G.indexOf(a) - ORDINE_G.indexOf(b));
const chiaveGiro = (giorni, ora, modo) => ordinaG(giorni).join(",") + "|" + (ora || "") + "|" + (modo || "");
const giornoDi = iso => ORDINE_G[(new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7];
const oraNorm = s => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s || "").trim()); return m ? pad(+m[1]) + ":" + m[2] : ""; };

// la serie settimanale (evento "padre", senza RECURRENCE-ID) di un file .ics
function serieIcs(testo){
  for(const e of icsEventi(testo)){
    if(e["RECURRENCE-ID"] || !e.RRULE || !/FREQ=WEEKLY/i.test(e.RRULE.v)) continue;
    const s = icsData(e.DTSTART); if(!s) continue;
    const by = (/BYDAY=([^;]+)/i.exec(e.RRULE.v) || [])[1];
    const giorni = by ? by.split(",").map(x => BYDAY[x.replace(/^[+-]?\d+/, "").toUpperCase()]).filter(Boolean) : [giornoDi(s.d)];
    const fine = /UNTIL=(\d{8})/i.exec(e.RRULE.v);
    const titolo = icsTesto(e.SUMMARY ? e.SUMMARY.v : "");
    return { uid: e.UID ? e.UID.v : "", titolo, nome: senzaIcone(titolo), modo: modoDi(titolo), giorni: ordinaG(giorni), ora: s.o || "",
      intervallo: +((/INTERVAL=(\d+)/i.exec(e.RRULE.v) || [])[1] || 1), finita: !!(fine && fine[1] < oggiRoma().replace(/-/g, "")) };
  }
  return null;
}
// ora di Roma → UTC ("20261123T083000Z")
function romaAUtc(d, o){
  const voluto = Date.parse(d + "T" + o + ":00Z");
  let t = voluto;
  for(let i = 0; i < 3; i++){ const r = romaDi(new Date(t).toISOString()); t -= Date.parse(r.d + "T" + r.o + ":00Z") - voluto; }
  return new Date(t).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}
// cambia giorni/ora/modo della serie lasciando com'è tutto il resto (promemoria, note, eccezioni)
export function cambiaSerie(testo, giorni, ora, modo){
  const righe = String(testo).replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((r, i, a) => r || i < a.length - 1);
  const out = []; let blocco = null, livello = 0;
  const lavora = b => {
    const top = []; let liv = 0;
    b.forEach((r, i) => { if(i > 0 && i < b.length - 1){ if(/^BEGIN:/.test(r)) liv++; else if(/^END:/.test(r)) liv--; else if(!liv) top.push(i); } });
    const trova = k => top.find(i => new RegExp("^" + k + "[;:]", "i").test(b[i]));
    if(trova("RECURRENCE-ID") !== undefined || trova("RRULE") === undefined) return b;
    const iS = trova("DTSTART"), iE = trova("DTEND"), iR = trova("RRULE"), iT = trova("SUMMARY");
    const mS = /^DTSTART((?:;[^:]*)?):(.*)$/i.exec(b[iS]); if(!mS) return b;
    const vecchio = icsData({ p: mS[1], v: mS[2] }); if(!vecchio) return b;
    // nuovo giorno: lo stesso se va bene, altrimenti il primo giorno scelto dopo l'inizio della serie
    let d = vecchio.d;
    for(let n = 0; n < 7 && !giorni.includes(giornoDi(d)); n++) d = piuGiorni(d, 1);
    const tutto = !vecchio.o, oNuova = tutto ? "" : (ora || vecchio.o);
    const fmt = (dd, oo, p, utc) => utc ? romaAUtc(dd, oo) : dd.replace(/-/g, "") + (oo ? "T" + oo.replace(":", "") + "00" : "");
    const utcS = /Z$/.test(mS[2]);
    let durata = null;
    if(iE !== undefined){
      const mE = /^DTEND((?:;[^:]*)?):(.*)$/i.exec(b[iE]); const fe = mE && icsData({ p: mE[1], v: mE[2] });
      if(fe) durata = Date.parse(fe.d + "T" + (fe.o || "00:00") + ":00Z") - Date.parse(vecchio.d + "T" + (vecchio.o || "00:00") + ":00Z");
      if(fe && durata != null){
        const fine = new Date(Date.parse(d + "T" + (oNuova || "00:00") + ":00Z") + durata).toISOString();
        b[iE] = "DTEND" + mE[1] + ":" + fmt(fine.slice(0, 10), tutto ? "" : fine.slice(11, 16), mE[1], /Z$/.test(mE[2]));
      }
    }
    b[iS] = "DTSTART" + mS[1] + ":" + fmt(d, oNuova, mS[1], utcS);
    const by = "BYDAY=" + ordinaG(giorni).map(g => DAYBY[g]).join(",");
    b[iR] = /BYDAY=[^;]*/i.test(b[iR]) ? b[iR].replace(/BYDAY=[^;]*/i, by) : b[iR] + ";" + by;
    if(modo && iT !== undefined){
      const mT = /^SUMMARY((?:;[^:]*)?):(.*)$/i.exec(b[iT]);
      if(mT && modoDi(mT[2]) !== modo) b[iT] = "SUMMARY" + mT[1] + ":" + ICONA[modo] + " " + senzaIcone(mT[2]);
    }
    return b;
  };
  for(const r of righe){
    if(r === "BEGIN:VEVENT" && !blocco){ blocco = [r]; livello = 0; continue; }
    if(blocco){
      blocco.push(r);
      if(/^BEGIN:/.test(r)) livello++;
      else if(r === "END:VEVENT" && !livello){ out.push(...lavora(blocco)); blocco = null; }
      else if(/^END:/.test(r)) livello--;
      continue;
    }
    out.push(r);
  }
  return out.filter(Boolean).map(piega).join("\r\n") + "\r\n";
}
// cosa vuole la scheda del cliente per quell'evento: giorni (da giorniOrdine), ora, modo
function chiaveClienteGiro(c, uid){
  const giro = Array.isArray(c.giro) ? c.giro : [];
  const voci = giro.filter(e => e.ev === uid); if(!voci.length) return "";
  const go = new Set(c.giorniOrdine || []);
  let giorni = voci.map(e => e.g).filter(g => go.has(g));
  const delGiro = new Set(giro.map(e => e.g));
  if(giro[0].ev === uid) giorni = giorni.concat([...go].filter(g => !delGiro.has(g)));      // giorni nuovi della scheda → al primo evento
  const eventi = new Set(giro.map(e => e.ev));
  const ora = eventi.size === 1 && oraNorm(c.orarioOrdine) ? oraNorm(c.orarioOrdine) : voci[0].ora || "";
  return giorni.length ? chiaveGiro(giorni, ora, voci[0].modo) : "";
}
// porta nella scheda i giorni/ora/modo di un evento
function giroSuCliente(c, uid, s){
  const giro = Array.isArray(c.giro) ? c.giro : [];
  const prima = giro.filter(e => e.ev === uid).map(e => e.g), altri = giro.filter(e => e.ev !== uid), altriG = new Set(altri.map(e => e.g));
  // le voci dell'evento restano al loro posto: il primo evento abbinato resta il primo (lì vanno i giorni aggiunti nell'app)
  const nuove = ordinaG(s.giorni).map(g => ({ g, ora: s.ora || "", modo: s.modo || "", ev: uid })), pos = giro.findIndex(e => e.ev === uid);
  c.giro = pos < 0 ? [...altri, ...nuove] : [...giro.slice(0, pos).filter(e => e.ev !== uid), ...nuove, ...giro.slice(pos).filter(e => e.ev !== uid)];
  c.giorniOrdine = ordinaG([...(c.giorniOrdine || []).filter(g => !prima.includes(g) || altriG.has(g)), ...s.giorni]);
  if(new Set(c.giro.map(e => e.ev)).size === 1 && s.ora && (!String(c.orarioOrdine || "").trim() || oraNorm(c.orarioOrdine))) c.orarioOrdine = s.ora;
  c._giro = true;
}
function giroViaDaCliente(c, uid, ancheGiorni){
  const giro = Array.isArray(c.giro) ? c.giro : [];
  const prima = giro.filter(e => e.ev === uid).map(e => e.g);
  c.giro = giro.filter(e => e.ev !== uid);
  if(ancheGiorni){ const resta = new Set(c.giro.map(e => e.g)); c.giorniOrdine = (c.giorniOrdine || []).filter(g => !prima.includes(g) || resta.has(g)); }
  c._giro = true;
}
const scrittaGiro = s => ordinaG(s.giorni).join(", ") + (s.ora ? " ore " + s.ora : "") + (s.modo ? " (" + (s.modo === "telefono" ? "al telefono" : "di persona") + ")" : "");

/* ---------- MODIFICARE O ELIMINARE UN EVENTO DAL CALENDARIO DELL'APP (v6.12) ----------
   Dalla finestra "Appuntamento" dell'app: nome, data, ora di inizio e fine (o tutto il giorno), eliminazione; per gli eventi che si
   ripetono "solo questa volta" (eccezione con RECURRENCE-ID, o EXDATE per toglierla) oppure "tutte le settimane" (la serie). */
const valoreIcs = (riga) => { const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(riga || ""); return m ? { k: m[1].toUpperCase(), p: m[2], v: m[3] } : null; };
// istante (ms) di un valore data/ora iCal, per confrontare RECURRENCE-ID scritti in modi diversi (UTC, TZID, data)
function istante(p, v){
  const s = icsData({ p, v }); if(!s) return NaN;
  if(!s.o) return Date.parse(s.d + "T00:00:00Z");
  if(/Z$/.test(v)) return Date.parse(v.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  return Date.parse(romaAUtc(s.d, s.o).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
}
// scrive data/ora nello stesso "stile" del valore di prima (UTC, TZID, solo data)
function dataComePrima(chiave, pPrima, vPrima, d, o){
  if(!o) return chiave + ";VALUE=DATE:" + d.replace(/-/g, "");
  if(/Z$/.test(vPrima || "")) return chiave + ":" + romaAUtc(d, o);
  const tz = /TZID=([^;:]+)/i.exec(pPrima || "");
  return chiave + ";TZID=" + (tz ? tz[1] : "Europe/Rome") + ":" + d.replace(/-/g, "") + "T" + o.replace(":", "") + "00";
}
// divide il file in righe e blocchi VEVENT (con la loro proprietà RECURRENCE-ID)
function blocchiIcs(testo){
  const righe = String(testo).replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
  const parti = []; let b = null, liv = 0;
  for(const r of righe){
    if(!b && r === "BEGIN:VEVENT"){ b = [r]; liv = 0; continue; }
    if(b){ b.push(r); if(/^BEGIN:/.test(r)) liv++; else if(r === "END:VEVENT" && !liv){ parti.push({ ev: b }); b = null; } else if(/^END:/.test(r)) liv--; continue; }
    parti.push({ riga: r });
  }
  return parti;
}
const topRighe = b => { const out = []; let liv = 0; b.forEach((r, i) => { if(i > 0 && i < b.length - 1){ if(/^BEGIN:/.test(r)) liv++; else if(/^END:/.test(r)) liv--; else if(!liv) out.push(i); } }); return out; };
const trovaProp = (b, k) => topRighe(b).find(i => (valoreIcs(b[i]) || {}).k === k);
function rimettiIcs(parti){
  const righe = parti.flatMap(x => x.ev || [x.riga]);
  // serve il fuso di Roma se ora lo usiamo e nel file non c'è
  if(righe.some(r => /TZID=Europe\/Rome/.test(r)) && !righe.some(r => r === "TZID:Europe/Rome")){
    const i = righe.findIndex(r => r === "BEGIN:VEVENT");
    if(i > 0) righe.splice(i, 0, ...VTZ);
  }
  return righe.map(piega).join("\r\n") + "\r\n";
}
// imposta titolo e date di un blocco VEVENT
function cambiaBlocco(b, x){
  const set = (k, riga) => { const i = trovaProp(b, k); if(i !== undefined) b[i] = riga; else b.splice(b.length - 1, 0, riga); };
  const togli = k => { const i = trovaProp(b, k); if(i !== undefined) b.splice(i, 1); };
  if(x.titolo != null){ const i = trovaProp(b, "SUMMARY"), p = i !== undefined ? valoreIcs(b[i]).p : ""; set("SUMMARY", "SUMMARY" + p + ":" + esc(x.titolo)); }
  if(x.data){
    const s = valoreIcs(b[trovaProp(b, "DTSTART")]) || { p: "", v: "" }, e = valoreIcs(b[trovaProp(b, "DTEND")] || "") || s;
    set("DTSTART", dataComePrima("DTSTART", s.p, s.v, x.data, x.tutto ? "" : x.inizio));
    togli("DURATION");
    const fineD = x.tutto ? piuGiorni(x.dataFine || x.data, 1) : (x.fine && x.fine <= x.inizio ? piuGiorni(x.data, 1) : x.data);
    set("DTEND", dataComePrima("DTEND", e.p, e.v, fineD, x.tutto ? "" : (x.fine || x.inizio)));
  }
  const dt = trovaProp(b, "DTSTAMP"); if(dt !== undefined) b[dt] = "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return b;
}
export function modificaIcs(testo, x){
  const parti = blocchiIcs(testo);
  const master = parti.find(p => p.ev && trovaProp(p.ev, "RECURRENCE-ID") === undefined) || parti.find(p => p.ev);
  if(!master) throw new Errore(404, "evento non trovato nel calendario");
  const ripete = trovaProp(master.ev, "RRULE") !== undefined;
  const ri = x.ri ? valoreIcs(x.ri) : null;
  const ist = ri ? istante(ri.p, ri.v) : NaN;
  const eccezione = ri ? parti.find(p => p.ev && p !== master && (() => { const i = trovaProp(p.ev, "RECURRENCE-ID"); const v = i !== undefined && valoreIcs(p.ev[i]); return v && istante(v.p, v.v) === ist; })()) : null;
  if(x.elimina){
    if(!ripete || x.serie) return null;                                                  // si cancella tutto il file
    const s = valoreIcs(master.ev[trovaProp(master.ev, "DTSTART")]);
    master.ev.splice(master.ev.length - 1, 0, "EXDATE" + (s.p || "").replace(/;?VALUE=DATE-TIME/i, "") + ":" + valoreDa(s, ist));
    return rimettiIcs(parti.filter(p => p !== eccezione));
  }
  if(!ripete){ cambiaBlocco(master.ev, x); return rimettiIcs(parti); }
  if(x.serie){
    // tutte le settimane: nome e orario della serie (il giorno resta quello della serie)
    const s = valoreIcs(master.ev[trovaProp(master.ev, "DTSTART")]), sd = icsData(s);
    cambiaBlocco(master.ev, { titolo: x.titolo, data: x.inizio || x.tutto ? sd.d : null, inizio: x.inizio, fine: x.fine, tutto: x.tutto });
    return rimettiIcs(parti);
  }
  // solo questa volta: eccezione con RECURRENCE-ID
  if(!ri) throw new Errore(400, "manca la data della ripetizione");
  if(eccezione){ cambiaBlocco(eccezione.ev, x); return rimettiIcs(parti); }
  const nuovo = master.ev.filter((r, i) => { const v = valoreIcs(r); return !(topRighe(master.ev).includes(i) && v && ["RRULE", "RDATE", "EXDATE", "EXRULE"].includes(v.k)); });
  const s = valoreIcs(master.ev[trovaProp(master.ev, "DTSTART")]);
  nuovo.splice(1, 0, "RECURRENCE-ID" + (s.p || "") + ":" + valoreDa(s, ist));
  cambiaBlocco(nuovo, x);
  const fine = parti.findIndex(p => p.riga === "END:VCALENDAR");
  parti.splice(fine < 0 ? parti.length : fine, 0, { ev: nuovo });
  return rimettiIcs(parti);
}
// scrive l'istante "ist" nello stesso formato di DTSTART della serie (serve per RECURRENCE-ID ed EXDATE)
function valoreDa(s, ist){
  const iso = new Date(ist).toISOString();
  if(/VALUE=DATE(?!-)/i.test(s.p)) return iso.slice(0, 10).replace(/-/g, "");
  if(/Z$/.test(s.v)) return iso.replace(/[-:]/g, "").slice(0, 15) + "Z";
  const r = romaDi(iso); return r.d.replace(/-/g, "") + "T" + r.o.replace(":", "") + "00";
}

async function eventoICloud(env, uid, S, x){
  const I = S.icloud, ic = new ICloud(env, I.user, I.pass, I.home);
  if(!ic.home) await ic.scopri();
  if(!(I.calendari || []).some(c => c.id === x.cal && c.scrivibile)) throw new Errore(400, "calendario non modificabile");
  const href = percorso(x.href, x.cal);
  // iCloud può scrivere il nome del file codificato in modo diverso (es. %40 / @): si confronta decodificato
  const mg = await ic.multiget(x.cal, [href]);
  const dec = s => { try { return decodeURIComponent(s); } catch(e){ return s; } };
  const chiaveF = [...mg.keys()].find(k => k === href || dec(k) === dec(href));
  const t = chiaveF ? mg.get(chiaveF) : null;
  if(chiaveF && ic.etag) ic.etag.set(href, ic.etag.get(chiaveF));
  if(!t) throw new Errore(404, "evento non più presente su iCloud");
  // un evento del giro: la data della ripetizione si ricava dalla serie
  if(!x.ri && x.occorrenza){
    const m = blocchiIcs(t).find(p => p.ev && trovaProp(p.ev, "RECURRENCE-ID") === undefined);
    const s = m && valoreIcs(m.ev[trovaProp(m.ev, "DTSTART")]), sd = s && icsData(s);
    if(sd) x.ri = "RECURRENCE-ID" + s.p + ":" + (sd.o ? (/Z$/.test(s.v) ? romaAUtc(x.occorrenza, sd.o) : x.occorrenza.replace(/-/g, "") + "T" + sd.o.replace(":", "") + "00") : x.occorrenza.replace(/-/g, ""));
  }
  let nuovo;
  if(x.giorni && x.serie){                                                                 // giro, tutte le settimane, cambio di giorno
    nuovo = cambiaSerie(t, x.giorni, x.tutto ? "" : x.inizio, x.modo || "");
    nuovo = modificaIcs(nuovo, { titolo: x.titolo, serie: true });
  } else nuovo = modificaIcs(t, x);
  if(nuovo === null) await ic.togli(href);
  else if(!(await ic.aggiorna(href, nuovo, ic.etag && ic.etag.get(href)))) throw new Errore(409, "l'evento è appena cambiato su iCloud: riprova");
}

async function eventoGoogle(env, S, x){
  const g = new Google(env, S.refresh);
  if(!(S.calendari || []).some(c => c.id === x.cal && c.scrivibile)) throw new Errore(400, "calendario non modificabile");
  // ordine del giro: x.r è la serie, x.occorrenza il giorno toccato
  if(x.r && x.occorrenza){
    const m = await g.chiama("GET", cal(x.cal) + "/events/" + encodeURIComponent(x.r));
    if(x.serie){
      if(x.elimina){ try { await g.chiama("DELETE", cal(x.cal) + "/events/" + encodeURIComponent(x.r)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; } return; }
      const s = serieGoogle(m) || { giorni: [], modo: "" };
      const corpo = patchSerieGoogle(m, x.giorni && x.giorni.length ? x.giorni : s.giorni, x.tutto ? "" : x.inizio, x.modo != null ? x.modo : s.modo, x.fine);
      if(x.titolo != null) corpo.summary = x.titolo;
      await g.chiama("PATCH", cal(x.cal) + "/events/" + encodeURIComponent(x.r), corpo);
      return;
    }
    const iid = encodeURIComponent(idIstanza(m, x.occorrenza));
    if(x.elimina){ try { await g.chiama("DELETE", cal(x.cal) + "/events/" + iid); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; } return; }
    const corpo = {};
    if(x.titolo != null) corpo.summary = x.titolo;
    const d = x.data || x.occorrenza, ini = x.inizio || (m.start.dateTime ? romaDi(m.start.dateTime).o : "");
    if(x.tutto || !ini){ corpo.start = { date: d, dateTime: null, timeZone: null }; corpo.end = { date: piuGiorni(d, 1), dateTime: null, timeZone: null }; }
    else { const f = x.fine && x.fine > ini ? x.fine : ini; corpo.start = { dateTime: d + "T" + ini + ":00", timeZone: "Europe/Rome", date: null }; corpo.end = { dateTime: d + "T" + f + ":00", timeZone: "Europe/Rome", date: null }; }
    await g.chiama("PATCH", cal(x.cal) + "/events/" + iid, corpo);
    return;
  }
  const id = encodeURIComponent(x.serie && x.r ? x.r : x.id);
  if(x.elimina){ try { await g.chiama("DELETE", cal(x.cal) + "/events/" + id); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; } return; }
  const corpo = {};
  if(x.titolo != null) corpo.summary = x.titolo;
  let data = x.data;
  if(x.serie && x.r){ const m = await g.chiama("GET", cal(x.cal) + "/events/" + id); data = m.start && (m.start.date || (m.start.dateTime && romaDi(m.start.dateTime).d)); }
  if(data && (x.inizio || x.tutto)){
    if(x.tutto){ corpo.start = { date: data, dateTime: null, timeZone: null }; corpo.end = { date: piuGiorni(x.dataFine || data, 1), dateTime: null, timeZone: null }; }
    else {
      const fineD = x.fine && x.fine <= x.inizio ? piuGiorni(data, 1) : data;
      corpo.start = { dateTime: data + "T" + x.inizio + ":00", timeZone: "Europe/Rome", date: null };
      corpo.end = { dateTime: fineD + "T" + (x.fine || x.inizio) + ":00", timeZone: "Europe/Rome", date: null };
    }
  }
  await g.chiama("PATCH", cal(x.cal) + "/events/" + id, corpo);
}
// controllo dei dati arrivati dall'app
function datiEvento(c){
  const x = { cal: String(c.cal || ""), serie: !!c.serie, elimina: c.azione === "elimina" };
  if(typeof c.titolo === "string") x.titolo = c.titolo.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  if(/^\d{4}-\d{2}-\d{2}$/.test(c.data || "")) x.data = c.data;
  if(/^\d{4}-\d{2}-\d{2}$/.test(c.dataFine || "")) x.dataFine = c.dataFine;
  if(/^\d{4}-\d{2}-\d{2}$/.test(c.occorrenza || "")) x.occorrenza = c.occorrenza;
  x.tutto = !!c.tutto;
  if(oraNorm(c.inizio)) x.inizio = oraNorm(c.inizio);
  if(oraNorm(c.fine)) x.fine = oraNorm(c.fine);
  if(!x.tutto && x.data && !x.inizio) x.tutto = true;
  if(Array.isArray(c.giorni)) x.giorni = ordinaG(c.giorni.filter(g => typeof g === "string"));
  if(["telefono", "visita", ""].includes(c.modo)) x.modo = c.modo;
  for(const k of ["href", "ri", "id", "r"]) if(typeof c[k] === "string") x[k] = c[k].slice(0, 500);
  if(!x.cal) throw new Errore(400, "calendario mancante");
  return x;
}

/* ---------- GIRO DAL CALENDARIO GOOGLE (v6.17) ----------
   Come il giro di iCloud: eventi che si ripetono ogni settimana (📞 / 💼 nel titolo) abbinati ai clienti, nei due sensi.
   Documento segreto: ggiro = { idSerie: { cal, cliente, k, nome } }, ggiroTok = { calendario: syncToken }; nel cliente le voci del giro
   hanno ev = "g:" + idSerie; stato per l'app: impostazioni/gcal.giro = { "g:"+id: { cliente, nome, cal, id } }. */
function serieGoogle(e){
  if(!e || e.status === "cancelled" || !Array.isArray(e.recurrence) || !e.start) return null;
  if(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.app === "clienti") return null;
  const rr = e.recurrence.find(x => /^RRULE:/i.test(x)); if(!rr || !/FREQ=WEEKLY/i.test(rr)) return null;
  const s = e.start.date ? { d: e.start.date, o: "" } : e.start.dateTime ? romaDi(e.start.dateTime) : null; if(!s) return null;
  const by = (/BYDAY=([^;]+)/i.exec(rr) || [])[1];
  const giorni = by ? by.split(",").map(x => BYDAY[x.replace(/^[+-]?\d+/, "").toUpperCase()]).filter(Boolean) : [giornoDi(s.d)];
  const fine = /UNTIL=(\d{8})/i.exec(rr), titolo = String(e.summary || "");
  return { id: e.id, titolo, nome: senzaIcone(titolo), modo: modoDi(titolo), giorni: ordinaG(giorni), ora: s.o || "",
    intervallo: +((/INTERVAL=(\d+)/i.exec(rr) || [])[1] || 1), finita: !!(fine && fine[1] < oggiRoma().replace(/-/g, "")) };
}
async function serieGoogleCal(g, calId){
  const q = new URLSearchParams({ maxResults: "250", singleEvents: "false", timeMin: oggiRoma() + "T00:00:00Z" });
  const j = await g.chiama("GET", cal(calId) + "/events?" + q);
  return (j.items || []).map(serieGoogle).filter(s => s && !s.finita).map(s => ({ ...s, cal: calId }));
}
// nuove regole della serie: giorni (BYDAY), ora (stessa durata, o fino a "fine"), icona del titolo
function patchSerieGoogle(m, giorni, ora, modo, fine){
  const by = "BYDAY=" + ordinaG(giorni).map(gg => DAYBY[gg]).join(",");
  const corpo = { recurrence: m.recurrence.map(x => /^RRULE:/i.test(x) ? (/BYDAY=[^;]*/i.test(x) ? x.replace(/BYDAY=[^;]*/i, by) : x + ";" + by) : x) };
  const allinea = d => { for(let n = 0; n < 7 && !giorni.includes(giornoDi(d)); n++) d = piuGiorni(d, 1); return d; };
  if(m.start.date){
    const giorniDurata = Math.max(1, Math.round((Date.parse(m.end.date) - Date.parse(m.start.date)) / 864e5)), d = allinea(m.start.date);
    corpo.start = { date: d }; corpo.end = { date: piuGiorni(d, giorniDurata) };
  } else {
    const s = romaDi(m.start.dateTime), e = romaDi(m.end.dateTime);
    const o = ora || s.o, d = allinea(s.d);
    const durata = fine && oraNorm(fine) && oraNorm(fine) > o ? Date.parse("2000-01-01T" + oraNorm(fine) + ":00Z") - Date.parse("2000-01-01T" + o + ":00Z")
      : Date.parse(e.d + "T" + e.o + ":00Z") - Date.parse(s.d + "T" + s.o + ":00Z");
    const f = new Date(Date.parse(d + "T" + o + ":00Z") + durata).toISOString();
    corpo.start = { dateTime: d + "T" + o + ":00", timeZone: "Europe/Rome" };
    corpo.end = { dateTime: f.slice(0, 16) + ":00", timeZone: "Europe/Rome" };
  }
  if(modo && modoDi(m.summary || "") !== modo) corpo.summary = ICONA[modo] + " " + senzaIcone(m.summary || "");
  return corpo;
}
// id dell'evento di un singolo giorno di una serie Google
function idIstanza(m, occ){
  if(m.start.date) return m.id + "_" + occ.replace(/-/g, "");
  return m.id + "_" + romaAUtc(occ, romaDi(m.start.dateTime).o);
}
// elenco delle modifiche di un calendario dal syncToken (al primo giro: tutto, per avere il token)
async function modificheGoogle(g, calId, token){
  const fai = async t => {
    let pag = "", prossimo = null, n = 0; const out = [];
    do {
      const q = new URLSearchParams({ maxResults: "2500", singleEvents: "false", showDeleted: "true" });
      if(t) q.set("syncToken", t); if(pag) q.set("pageToken", pag);
      const j = await g.chiama("GET", cal(calId) + "/events?" + q);
      (j.items || []).forEach(e => out.push(e)); pag = j.nextPageToken || ""; prossimo = j.nextSyncToken || prossimo;
    } while(pag && ++n < 10);
    return { eventi: out, token: prossimo };
  };
  try { return await fai(token); } catch(e){ if(e.google === 410 && token) return fai(null); throw e; }
}
const statoGiroGoogle = ggiro => Object.fromEntries(Object.entries(ggiro).map(([id, L]) => ["g:" + id, { cliente: L.cliente, nome: L.nome || "", cal: L.cal, id }]));

export async function sincronizzaGiroGoogle(env, uid, opz = {}){
  const S = opz.S !== undefined ? opz.S : await leggiDoc(env, "calendario_segreti/" + uid);
  if(!S || !S.refresh || !S.ggiro || !Object.keys(S.ggiro).length) return { collegato: false };
  const g = new Google(env, S.refresh), oggi = opz.oggi || oggiRoma();
  const ggiro = JSON.parse(JSON.stringify(S.ggiro)), tok = { ...(S.ggiroTok || {}) };
  const stat = { cambiati: 0, daGoogle: 0, rimandati: 0 }; let scritte = 0;
  const cambiati = new Map();                                   // id della serie → evento padre, oppure null se cancellata
  for(const calId of [...new Set(Object.values(ggiro).map(L => L.cal))]){
    const r = await modificheGoogle(g, calId, tok[calId] || null);
    if(r.token) tok[calId] = r.token;
    for(const e of r.eventi) if(ggiro[e.id] && ggiro[e.id].cal === calId) cambiati.set(e.id, e.status === "cancelled" ? null : e);
  }
  const clienti = opz.leggero ? await clientiPerId(env, uid, [...new Set([...cambiati.keys()].map(id => ggiro[id].cliente))]) : await clientiDi(env, uid, ["storico", "giro"]);
  const perId = new Map(clienti.map(c => [c.id, c]));
  for(const id of Object.keys(ggiro)){
    const L = ggiro[id], ev = "g:" + id, c = perId.get(L.cliente);
    if(!c){ if(!opz.leggero) delete ggiro[id]; continue; }
    const kc = chiaveClienteGiro(c, ev);
    let m = null;
    if(cambiati.has(id)){
      m = cambiati.get(id);
      if(m === null){
        if(kc === L.k){ giroViaDaCliente(c, ev, true); c.storico = [...(c.storico || []), { d: oggi, t: "Giro: evento «" + L.nome + "» tolto da Google Calendar" }]; stat.daGoogle++; }
        else giroViaDaCliente(c, ev, false);
        delete ggiro[id]; continue;
      }
      const s = serieGoogle(m);
      if(s){
        const ke = chiaveGiro(s.giorni, s.ora, s.modo);
        if(ke !== L.k){
          if(kc === L.k){ giroSuCliente(c, ev, s); c.storico = [...(c.storico || []), { d: oggi, t: "Giro cambiato da Google Calendar: «" + s.nome + "» " + scrittaGiro(s) }]; stat.daGoogle++; }
          L.k = ke; L.nome = s.nome;
        }
      }
    } else if(opz.leggero) continue;
    const kc2 = chiaveClienteGiro(c, ev);
    if(kc2 === L.k) continue;
    if(!kc2){ giroViaDaCliente(c, ev, false); delete ggiro[id]; continue; }
    if(scritte >= MAX_SCRITTURE){ stat.rimandati++; continue; }
    scritte++;
    try { if(!m) m = await g.chiama("GET", cal(L.cal) + "/events/" + encodeURIComponent(id)); }
    catch(e){ if(e.google === 404 || e.google === 410){ giroViaDaCliente(c, ev, false); delete ggiro[id]; continue; } throw e; }
    const [gs, ora, modo] = kc2.split("|"), nuovo = { giorni: gs.split(",").filter(Boolean), ora, modo };
    await g.chiama("PATCH", cal(L.cal) + "/events/" + encodeURIComponent(id), patchSerieGoogle(m, nuovo.giorni, nuovo.ora, nuovo.modo));
    giroSuCliente(c, ev, nuovo); L.k = chiaveGiro(nuovo.giorni, nuovo.ora, nuovo.modo); stat.cambiati++;
  }
  if(opz.leggero && !clienti.some(c => c._giro) && JSON.stringify(ggiro) === JSON.stringify(S.ggiro) && JSON.stringify(tok) === JSON.stringify(S.ggiroTok || {})) return { collegato: true, ...stat };
  const scritture = clienti.filter(c => c._giro).map(c => ({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true,
    campi: ["giro", "giorniOrdine", "orarioOrdine", "storico", "aggiornato"],
    dati: { giro: c.giro || [], giorniOrdine: c.giorniOrdine || [], orarioOrdine: c.orarioOrdine || "", storico: c.storico || [], aggiornato: new Date().toISOString() } }));
  scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["ggiro", "ggiroTok"], dati: { ggiro, ggiroTok: tok } });
  scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["giro"], dati: { giro: statoGiroGoogle(ggiro) } });
  await scrivi(env, scritture);
  return { collegato: true, ...stat };
}

export async function sincronizzaICloud(env, uid, opz = {}){
  const S = opz.S !== undefined ? opz.S : await leggiDoc(env, "calendario_segreti/" + uid);
  const I = S && S.icloud;
  if(!I || !I.user || !I.pass) return { collegato: false };
  const ic = new ICloud(env, I.user, I.pass, I.home);
  const oggi = opz.oggi || oggiRoma(), dal = piuGiorni(oggi, -60);
  const mappa = I.mappa && typeof I.mappa === "object" ? I.mappa : {};
  const ctag = I.ctag || {}, evPer = I.ev && typeof I.ev === "object" ? I.ev : {};
  const stat = { creati: 0, cambiati: 0, tolti: 0, daICloud: 0, rimandati: 0 };
  let calendari = Array.isArray(I.calendari) ? I.calendari : [], syncToken = I.syncToken || "", nuoviCtag = ctag;
  const pulizia = Array.isArray(I.pulizia) ? [...I.pulizia] : [];
  let scritte = 0;
  const tocca = () => { if(scritte >= MAX_SCRITTURE){ stat.rimandati++; return false; } scritte++; return true; };
  try {
    if(!ic.home) await ic.scopri();
    while(pulizia.length && tocca()){ await ic.togli(pulizia[0]); pulizia.shift(); }
    const lista = await ic.calendari();
    if(!lista.length) throw new Errore(502, "iCloud non mostra calendari. Dettagli per Claude: " + ic.diag);
    calendari = lista.map(({ ctag, ...c }) => c);
    nuoviCtag = Object.fromEntries(lista.map(c => [c.id, c.ctag || ""]));
    let clienti = [];
    if(I.calId && calendari.some(c => c.id === I.calId)){
      // a) cosa è cambiato su iCloud (solo se il calendario è cambiato, nel giro leggero)
      let cambiati = [], cancellati = [];
      if(!opz.leggero || nuoviCtag[I.calId] !== ctag[I.calId] || !syncToken){
        let r;
        try { r = await ic.sync(I.calId, syncToken); }
        catch(e){ if(!e.invalido) throw e; syncToken = ""; r = await ic.sync(I.calId, ""); }
        syncToken = r.token || syncToken; cambiati = r.cambiati; cancellati = r.cancellati;
      }
      const hrefCliente = new Map(Object.entries(mappa).map(([cid, m]) => [m.ev, cid]));
      const daLeggere = cambiati.filter(h => hrefCliente.has(h));
      const toccati = [...new Set([...daLeggere, ...cancellati].filter(h => hrefCliente.has(h)).map(h => hrefCliente.get(h)))];
      clienti = opz.leggero ? await clientiPerId(env, uid, toccati) : await clientiDi(env, uid, ["storico", "giro"]);
      const perId = new Map(clienti.map(c => [c.id, c]));
      for(const h of cancellati){
        const cid = hrefCliente.get(h); if(!cid || !mappa[cid]) continue;
        const c = perId.get(cid);
        if(c && chiaveCliente(c) === mappa[cid].k){
          c.ricontattare = ""; c.ricontattareOra = "";
          c.storico = [...(c.storico || []), { d: oggi, t: "Appuntamento tolto da iCloud" }];
          c._cambiato = true; stat.daICloud++;
        }
        delete mappa[cid];
      }
      if(daLeggere.length){
        const dati = await ic.multiget(I.calId, daLeggere);
        for(const [h, testo] of dati){
          const cid = hrefCliente.get(h), m = cid && mappa[cid]; if(!m) continue;
          const e0 = icsEventi(testo).find(e => !e["RECURRENCE-ID"]) || icsEventi(testo)[0] || {}, m0 = modoDi(icsTesto(e0.SUMMARY ? e0.SUMMARY.v : ""));
          const s0 = icsData(e0.DTSTART), f0 = icsData(e0.DTEND);
          const kg = s0 ? chiaveDa(s0.d, s0.o || "", m0, f0 && f0.o && f0.d === s0.d ? f0.o : "") : "";
          if(!kg || kg === m.k) continue;
          const c = perId.get(cid);
          if(c && chiaveCliente(c) === m.k){
            const [d, o, mo, fi] = kg.split("|");
            c.ricontattare = d; c.ricontattareOra = o; c.ricontattareModo = mo || ""; c.ricontattareFine = fi || "";
            c.storico = [...(c.storico || []), { d: oggi, t: "Appuntamento spostato da iCloud al " + scrittaStorico(kg) }];
            c._cambiato = true; stat.daICloud++;
          }
          m.k = kg;
        }
      }
      // b) dall'app a iCloud
      for(const c of clienti){
        const k = chiaveCliente(c), m = mappa[c.id];
        if(k && k.slice(0, 10) < dal && !m) continue;
        if(k && (!m || k !== m.k)){
          if(!tocca()) continue;
          mappa[c.id] = { ev: await ic.metti(I.calId, c), k };
          if(m) stat.cambiati++; else stat.creati++;
        } else if(!k && m){
          if(!tocca()) continue;
          await ic.togli(m.ev); delete mappa[c.id]; stat.tolti++;
        }
      }
      if(!opz.leggero) for(const cid of Object.keys(mappa)) if(!perId.has(cid)){
        if(!tocca()) continue;
        await ic.togli(mappa[cid].ev); delete mappa[cid]; stat.tolti++;
      }
    }

    // b2) il giro: eventi ricorrenti abbinati ai clienti, nei due sensi
    const giro = I.giro && typeof I.giro === "object" ? I.giro : {}, giroTok = I.giroTok && typeof I.giroTok === "object" ? I.giroTok : {};
    if(Object.keys(giro).length){
      const cambiatiG = new Map();                                // uid → testo dell'evento, oppure null se cancellato
      for(const cal of [...new Set(Object.values(giro).map(L => L.cal))]){
        if(!calendari.some(c => c.id === cal)) continue;
        if(opz.leggero && nuoviCtag[cal] === ctag[cal] && giroTok[cal]) continue;
        let r;
        try { r = await ic.sync(cal, giroTok[cal] || ""); } catch(e){ if(!e.invalido) throw e; r = await ic.sync(cal, ""); }
        giroTok[cal] = r.token || giroTok[cal] || "";
        const perHref = new Map(Object.entries(giro).filter(([, L]) => L.cal === cal).map(([u, L]) => [L.href, u]));
        for(const hh of r.cancellati) if(perHref.has(hh)) cambiatiG.set(perHref.get(hh), null);
        const leggere = r.cambiati.filter(hh => perHref.has(hh));
        if(leggere.length) for(const [hh, t] of await ic.multiget(cal, leggere)) cambiatiG.set(perHref.get(hh), t);
      }
      // i clienti che servono (nel giro leggero solo quelli degli eventi cambiati)
      const perTutti = new Map(clienti.map(c => [c.id, c]));
      const servono = opz.leggero ? [...new Set([...cambiatiG.keys()].map(u => giro[u].cliente))] : [];
      if(!opz.leggero && !clienti.length){ clienti = await clientiDi(env, uid, ["storico", "giro"]); clienti.forEach(c => perTutti.set(c.id, c)); }
      const mancano = servono.filter(id => !perTutti.has(id));
      if(mancano.length) for(const c of await clientiPerId(env, uid, mancano)){ clienti.push(c); perTutti.set(c.id, c); }
      for(const u of Object.keys(giro)){
        const L = giro[u], c = perTutti.get(L.cliente);
        if(!c){ if(!opz.leggero) delete giro[u]; continue; }                      // cliente eliminato
        const kc = chiaveClienteGiro(c, u);
        let testo = null;
        if(cambiatiG.has(u)){
          testo = cambiatiG.get(u);
          if(testo === null){                                                     // serie cancellata su iCloud
            if(kc === L.k){ giroViaDaCliente(c, u, true); c.storico = [...(c.storico || []), { d: oggi, t: "Giro: evento «" + L.nome + "» tolto da iCloud" }]; stat.daICloud++; }
            else giroViaDaCliente(c, u, false);
            delete giro[u]; continue;
          }
          const s = serieIcs(testo);
          if(s){
            const ke = chiaveGiro(s.giorni, s.ora, s.modo);
            if(ke !== L.k){
              if(kc === L.k){ giroSuCliente(c, u, s); c.storico = [...(c.storico || []), { d: oggi, t: "Giro cambiato da iCloud: «" + s.nome + "» " + scrittaGiro(s) }]; stat.daICloud++; }
              L.k = ke; L.nome = s.nome;
            }
          }
        } else if(opz.leggero) continue;
        // dall'app a iCloud
        const kc2 = chiaveClienteGiro(c, u);
        if(kc2 === L.k) continue;
        if(!kc2){ giroViaDaCliente(c, u, false); delete giro[u]; continue; }          // tolti tutti i giorni nell'app: si scollega, l'evento resta
        if(!tocca()) continue;
        if(testo == null){ const d = await ic.multiget(L.cal, [L.href]); testo = d.get(L.href) || null; }
        if(testo == null){ delete giro[u]; giroViaDaCliente(c, u, false); continue; }
        const [gs, ora, modo] = kc2.split("|");
        const nuovo = { giorni: gs.split(",").filter(Boolean), ora, modo };
        if(await ic.aggiorna(L.href, cambiaSerie(testo, nuovo.giorni, nuovo.ora, nuovo.modo), ic.etag && ic.etag.get(L.href))){
          giroSuCliente(c, u, nuovo); L.k = chiaveGiro(nuovo.giorni, nuovo.ora, nuovo.modo); stat.cambiati++;
        }
      }
    }

    // c) appuntamenti iCloud da mostrare nell'app (sola lettura)
    const mostra = (Array.isArray(I.mostra) ? I.mostra : []).filter(id => calendari.some(c => c.id === id)).slice(0, 4);
    // si rileggono anche gli impegni salvati da versioni vecchie, senza il file (h) che serve per modificarli dall'app
    for(const id of mostra) if(!opz.leggero || nuoviCtag[id] !== ctag[id] || !Array.isArray(evPer[id]) || evPer[id].some(e => e.h === undefined))
      evPer[id] = (await ic.eventi(id, piuGiorni(oggi, -14), piuGiorni(oggi, 120))).slice(0, 300);
    for(const id of Object.keys(evPer)) if(!mostra.includes(id)) delete evPer[id];
    const ev = mostra.flatMap(id => (evPer[id] || []).filter(e => !giro[String(e.id).split("|")[0]]).map(e => ({ ...e, c: calendari.findIndex(c => c.id === id) })))     // gli eventi del giro abbinati non si ripetono
      .sort((a, b) => a.s.localeCompare(b.s)).slice(0, 600);
    const evHash = impronta(JSON.stringify(ev));

    const scritture = [];
    for(const c of clienti) if(c._cambiato || c._giro){
      const campi = [...(c._cambiato ? ["ricontattare", "ricontattareOra", "ricontattareModo", "ricontattareFine"] : []), ...(c._giro ? ["giro", "giorniOrdine", "orarioOrdine"] : []), "storico", "aggiornato"];
      const dati = { storico: c.storico || [], aggiornato: new Date().toISOString() };
      if(c._cambiato){ dati.ricontattare = c.ricontattare; dati.ricontattareOra = c.ricontattareOra; dati.ricontattareModo = c.ricontattareModo || ""; dati.ricontattareFine = c.ricontattareFine || ""; }
      if(c._giro){ dati.giro = c.giro || []; dati.giorniOrdine = c.giorniOrdine || []; dati.orarioOrdine = c.orarioOrdine || ""; }
      scritture.push({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true, campi, dati });
    }
    scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, home: ic.home, calendari, mostra, mappa, syncToken, ctag: nuoviCtag, ev: evPer, evHash, pulizia, giro, giroTok } } });
    scritture.push({ percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["collegato", "ultimo", "errore", "calendari", "mostra", "giro"],
      dati: { collegato: true, ultimo: new Date().toISOString(), errore: stat.rimandati ? "Molti appuntamenti da copiare: finisco tra pochi minuti" : null, calendari, mostra,
        giro: Object.fromEntries(Object.entries(giro).map(([u, L]) => [u, { cliente: L.cliente, nome: L.nome || "", href: L.href, cal: L.cal }])) } });
    if(evHash !== I.evHash) scritture.push({ percorso: "utenti/" + uid + "/impostazioni/icloud_eventi", dati: { agg: new Date().toISOString(), ev } });
    await scrivi(env, scritture);
    return { collegato: true, ...stat, chiamateICloud: ic.chiamate };
  } catch(err){
    const rifiutato = err.stato === 401;
    await scrivi(env, [
      { percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, mappa, pulizia, syncToken: I.syncToken || "" } } },
      { percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["errore", "collegato"], dati: { errore: String(err.message || err).slice(0, 200), collegato: !rifiutato } }
    ]).catch(() => {});
    throw err;
  }
}

// toglie gli appuntamenti dal calendario iCloud (quando si cambia calendario o si passa a Google)
async function iCloudCambia(env, uid, S, nuovoId, nuovoNome){
  const I = S.icloud;
  if(!I) return;
  const pulizia = [...(Array.isArray(I.pulizia) ? I.pulizia : []), ...(I.calId && I.calId !== nuovoId ? Object.values(I.mappa || {}).map(m => m.ev) : [])];
  const ic = new ICloud(env, I.user, I.pass, I.home);
  for(let n = 0; pulizia.length && n < MAX_SCRITTURE; n++){ await ic.togli(pulizia[0]).catch(e => { if(e.stato === 401) throw e; }); pulizia.shift(); }
  await scrivi(env, [
    { percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, calId: nuovoId, calNome: nuovoNome, mappa: {}, syncToken: "", pulizia } } },
    { percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["calId", "calNome"], dati: { calId: nuovoId, calNome: nuovoNome } }
  ]);
}

// sincronizza Google e iCloud (quello che è collegato); un errore di uno non ferma l'altro
async function sincronizzaTutto(env, uid, opz = {}){
  const S = await leggiDoc(env, "calendario_segreti/" + uid);
  const out = { creati: 0, cambiati: 0, tolti: 0, daGoogle: 0, daICloud: 0, errori: [] };
  const somma = r => { for(const k of ["creati", "cambiati", "tolti", "daGoogle", "daICloud"]) out[k] += r[k] || 0; };
  if(S && S.refresh){ try { const r = await sincronizza(env, uid, { ...opz, S }); somma(r); out.google = true; } catch(e){ out.errori.push({ servizio: "google", stato: e.stato, msg: e.message }); } }
  if(S && S.refresh && S.ggiro && Object.keys(S.ggiro).length){ try { somma(await sincronizzaGiroGoogle(env, uid, { ...opz, S })); } catch(e){ out.errori.push({ servizio: "google", stato: e.stato, msg: e.message }); } }
  if(S && S.icloud){ try { const r = await sincronizzaICloud(env, uid, { ...opz, S }); somma(r); out.icloud = true; } catch(e){ out.errori.push({ servizio: "icloud", stato: e.stato, msg: e.message }); } }
  return out;
}

/* ---------- pagine e risposte ---------- */
const pagina = (titolo, testo, app) => new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titolo}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#F3F5F4;color:#1C2B2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border-radius:18px;padding:28px 24px;max-width:420px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:22px;margin:0 0 10px}p{line-height:1.5;color:#5E6F72}
a{display:inline-block;margin-top:14px;background:#17607A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#121A1C;color:#E6EDEC}main{background:#1B2528}p{color:#93A3A5}a{background:#5DB3CF;color:#0E1A1D}}</style></head>
<body><main><h1>${titolo}</h1><p>${testo}</p><a href="${app}">Torna all'app</a></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const json = (o, stato, cors) => new Response(JSON.stringify(o), { status: stato, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });

async function feed(req, env, uid, token){
  const cors = { "access-control-allow-origin": "*" };
  const nonTrovato = () => new Response("calendario non trovato", { status: 404, headers: { ...cors, "cache-control": "no-store" } });
  try {
    const o = await leggiDoc(env, "utenti/" + encodeURIComponent(uid) + "/impostazioni/calendario");
    if(!o || !uguali(String(o.token || ""), token)) return nonTrovato();
    const testo = creaCalendario(await clientiDi(env, uid), { giro: o.giro !== false });
    return new Response(req.method === "HEAD" ? null : testo, { headers: {
      ...cors, "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", "content-disposition": 'inline; filename="clienti.ics"' } });
  } catch(err){
    return new Response("calendario momentaneamente non disponibile", { status: 503, headers: { ...cors, "cache-control": "no-store", "retry-after": "600" } });
  }
}

export default {
  async fetch(req, env){
    const url = new URL(req.url), p = url.pathname;
    const app = env.APP_URL || "https://clienti.malfer.it";
    if(p === "/ping") return new Response("ok", { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
    if(p.startsWith("/cal/") && req.method !== "GET" && req.method !== "HEAD") return new Response("metodo non ammesso", { status: 405 });
    const mf = PERCORSO.exec(p);
    if(mf){
      return feed(req, env, mf[1], mf[2]);
    }

    // Google torna qui dopo l'autorizzazione (pagina aperta nel browser)
    if(p === "/google/ritorno" && req.method === "GET"){
      const uid = await leggiStato(env, url.searchParams.get("state")).catch(() => null);
      if(!uid) return pagina("Collegamento non riuscito", "Il collegamento è scaduto o non è valido. Riprova dall'app (Calendario › Collega).", app);
      if(!url.searchParams.get("code")) return pagina("Collegamento annullato", "Non hai dato il permesso a Google Calendar. Puoi riprovare quando vuoi dall'app.", app);
      try {
        const r = await fetch(G_TOKEN(env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: ritornoUrl(req), grant_type: "authorization_code" }) });
        const t = await r.json();
        if(!r.ok || !t.refresh_token) throw new Error("token");
        let email = ""; try { email = json64(String(t.id_token).split(".")[1]).email || ""; } catch(e){}
        const g = new Google(env, t.refresh_token); g.at = t.access_token;
        const calendari = await g.calendari();
        const prima = await leggiDoc(env, "calendario_segreti/" + uid) || {};
        const stessoAccount = prima.email && prima.email === email;
        const calId = stessoAccount && prima.calId && calendari.some(c => c.id === prima.calId) ? prima.calId : null;
        const calNome = calId ? (calendari.find(c => c.id === calId) || {}).nome || "" : "";
        const mostra = stessoAccount && Array.isArray(prima.mostra) && prima.mostra.length ? prima.mostra : calendari.filter(c => c.principale).map(c => c.id);
        await scrivi(env, [
          { percorso: "calendario_segreti/" + uid, dati: { refresh: t.refresh_token, email, calId, calNome, mostra, calendari,
            mappa: calId ? (prima.mappa || {}) : {}, syncToken: calId ? (prima.syncToken || null) : null, creato: new Date().toISOString() } },
          { percorso: "utenti/" + uid + "/impostazioni/gcal", dati: { collegato: true, email, calId, calNome, mostra, calendari, ultimo: null, errore: null } }
        ]);
        if(calId) await sincronizza(env, uid).catch(() => {});
        return pagina("Google Calendar collegato ✓", "Ora torna all'app: in Calendario › Collega scegli il calendario dove mettere i richiami (o creane uno nuovo).", app);
      } catch(err){
        return pagina("Collegamento non riuscito", "Google non ha risposto come previsto. Riprova dall'app tra qualche minuto.", app);
      }
    }

    // chiamate dell'app (con il login)
    if(p.startsWith("/google/") || p.startsWith("/icloud/")){
      const origine = req.headers.get("Origin") || "";
      const consentite = String(env.ALLOWED_ORIGINS || app).split(",").map(s => s.trim()).filter(Boolean);
      if(!consentite.includes(origine)) return json({ errore: "origine non consentita" }, 403, {});
      const cors = { "Access-Control-Allow-Origin": origine, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400" };
      if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if(req.method !== "POST") return json({ errore: "metodo non ammesso" }, 405, cors);
      try {
        const google = p.startsWith("/google/");
        if(google && p !== "/google/sincronizza" && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) throw new Errore(503, "collegamento a Google non ancora configurato nel servizio");
        const uid = await utente(req, env);
        const corpo = await req.json().catch(() => ({}));
        // sincronizza tutto quello che è collegato (Google e/o iCloud)
        if(p === "/google/sincronizza" || p === "/icloud/sincronizza"){
          const r = await sincronizzaTutto(env, uid, { calendari: !!corpo.calendari });
          return json({ ok: true, ...r }, 200, cors);
        }
        if(p === "/google/inizio"){
          const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: ritornoUrl(req), response_type: "code", scope: SCOPE,
            access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: await creaStato(env, uid) });
          return json({ url: (env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth") + "?" + q }, 200, cors);
        }
        const S = await leggiDoc(env, "calendario_segreti/" + uid);

        /* ----- Google ----- */
        if(p === "/google/scollega"){
          if(S && S.refresh) await fetch((env.GOOGLE_OAUTH || "https://oauth2.googleapis.com") + "/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: S.refresh }) }).catch(() => {});
          await scrivi(env, [
            S && S.icloud
              ? { percorso: "calendario_segreti/" + uid, campi: ["refresh", "email", "calId", "calNome", "mostra", "calendari", "mappa", "syncToken", "evHash"], dati: {} }
              : { percorso: "calendario_segreti/" + uid, elimina: true },
            { percorso: "utenti/" + uid + "/impostazioni/gcal", dati: { collegato: false } },
            { percorso: "utenti/" + uid + "/impostazioni/gcal_eventi", dati: { agg: new Date().toISOString(), ev: [] } }
          ]);
          return json({ ok: true }, 200, cors);
        }
        if(google){
          if(!S || !S.refresh) throw new Errore(409, "Google Calendar non è collegato");
          if(p === "/google/scegli"){
            if(Array.isArray(corpo.mostra)){
              const ids = new Set((S.calendari || []).map(c => c.id));
              const mostra = corpo.mostra.filter(x => typeof x === "string" && ids.has(x)).slice(0, 4);
              await scrivi(env, [
                { percorso: "calendario_segreti/" + uid, campi: ["mostra"], dati: { mostra } },
                { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["mostra"], dati: { mostra } }
              ]);
            } else if(typeof corpo.nuovo === "string" || typeof corpo.calId === "string"){
              let id, nome;
              if(typeof corpo.nuovo === "string"){
                nome = corpo.nuovo.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "Clienti";
                const c = await new Google(env, S.refresh).chiama("POST", "/calendars", { summary: nome, timeZone: "Europe/Rome", description: "Appuntamenti dei clienti (app Clienti)" });
                id = c.id;
              } else {
                const c = (S.calendari || []).find(x => x.id === corpo.calId && x.scrivibile);
                if(!c) throw new Errore(400, "calendario non disponibile");
                id = c.id; nome = c.nome;
              }
              if(S.icloud && S.icloud.calId) await iCloudCambia(env, uid, S, null, "");     // gli appuntamenti vanno in un solo servizio
              await cambiaCalendario(env, uid, S, id, nome);
            } else throw new Errore(400, "richiesta non valida");
            const r = await sincronizzaTutto(env, uid, { calendari: true });
            return json({ ok: true, ...r }, 200, cors);
          }
          if(p === "/google/giro/eventi"){
            const g = new Google(env, S.refresh), cals = [...new Set([...(S.mostra || []), S.calId].filter(Boolean))], eventi = [];
            for(const c of cals) for(const s of await serieGoogleCal(g, c))
              eventi.push({ ...s, uid: s.id, calNome: ((S.calendari || []).find(x => x.id === c) || {}).nome || "", cliente: (S.ggiro || {})[s.id] ? S.ggiro[s.id].cliente : null });
            return json({ ok: true, eventi: eventi.sort((a, b) => a.nome.localeCompare(b.nome, "it")).slice(0, 400) }, 200, cors);
          }
          if(p === "/google/giro/abbina"){
            const g = new Google(env, S.refresh), ggiro = { ...(S.ggiro || {}) }, tok = { ...(S.ggiroTok || {}) };
            const voci = (Array.isArray(corpo.voci) ? corpo.voci : []).filter(v => v && typeof v.id === "string" && typeof v.cal === "string" && typeof v.cliente === "string").slice(0, 100);
            const togli = (Array.isArray(corpo.togli) ? corpo.togli : []).map(String).filter(id => ggiro[id]).slice(0, 200);
            const ids = [...new Set([...voci.map(v => v.cliente), ...voci.map(v => ggiro[v.id] && ggiro[v.id].cliente).filter(Boolean), ...togli.map(id => ggiro[id].cliente)])];
            const perId = new Map((await clientiPerId(env, uid, ids)).map(c => [c.id, c]));
            for(const id of togli){ const c = perId.get(ggiro[id].cliente); if(c) giroViaDaCliente(c, "g:" + id, false); delete ggiro[id]; }
            let fatti = 0;
            for(const v of voci){
              if(!(S.calendari || []).some(c => c.id === v.cal)) continue;
              let m; try { m = await g.chiama("GET", cal(v.cal) + "/events/" + encodeURIComponent(v.id)); } catch(e){ continue; }
              const s = serieGoogle(m), c = perId.get(v.cliente);
              if(!s || !c) continue;
              if(ggiro[v.id] && ggiro[v.id].cliente !== v.cliente){ const vecchio = perId.get(ggiro[v.id].cliente); if(vecchio) giroViaDaCliente(vecchio, "g:" + v.id, false); }
              giroSuCliente(c, "g:" + v.id, s);
              c.storico = [...(c.storico || []), { d: oggiRoma(), t: "Giro collegato a Google Calendar: «" + s.nome + "» " + scrittaGiro(s) }];
              ggiro[v.id] = { cal: v.cal, cliente: v.cliente, k: chiaveGiro(s.giorni, s.ora, s.modo), nome: s.nome };
              fatti++;
            }
            // primo elenco delle modifiche dei calendari del giro: serve il "segnalino" per i giri successivi
            for(const c of [...new Set(Object.values(ggiro).map(L => L.cal))]) if(!tok[c]){ const rr = await modificheGoogle(g, c, null); if(rr.token) tok[c] = rr.token; }
            const scritture = [...perId.values()].filter(c => c._giro).map(c => ({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true,
              campi: ["giro", "giorniOrdine", "orarioOrdine", "storico", "aggiornato"],
              dati: { giro: c.giro || [], giorniOrdine: c.giorniOrdine || [], orarioOrdine: c.orarioOrdine || "", storico: c.storico || [], aggiornato: new Date().toISOString() } }));
            scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["ggiro", "ggiroTok", "evHash"], dati: { ggiro, ggiroTok: tok, evHash: "" } });
            scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["giro"], dati: { giro: statoGiroGoogle(ggiro) } });
            await scrivi(env, scritture);
            await sincronizzaTutto(env, uid, {}).catch(() => {});
            return json({ ok: true, collegati: fatti, tolti: togli.length }, 200, cors);
          }
          if(p === "/google/evento"){
            const x = datiEvento(corpo);
            if(!x.id && !x.r) throw new Errore(400, "evento mancante");
            await eventoGoogle(env, S, x);
            const r = await sincronizzaTutto(env, uid, {});
            return json({ ok: true, ...r }, 200, cors);
          }
          return json({ errore: "percorso sconosciuto" }, 404, cors);
        }

        /* ----- iCloud ----- */
        if(p === "/icloud/collega"){
          let user, pass;
          if(corpo.rosario){
            const R = await leggiDoc(env, "rosario_segreti/" + uid);
            if(!R || R.tipo !== "icloud" || !R.user || !R.password) throw new Errore(404, "Rosario non ha un iCloud collegato: scrivi email e password per app");
            user = String(R.user); pass = String(R.password);
          } else {
            user = String(corpo.user || "").trim().slice(0, 120); pass = String(corpo.pass || "").replace(/\s+/g, "").slice(0, 64);
            if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user) || pass.length < 8) throw new Errore(400, "Scrivi l'email del tuo ID Apple e la password per app");
          }
          const ic = new ICloud(env, user, pass);
          await ic.scopri();
          const lista = await ic.calendari();
          const calendari = lista.map(({ ctag, ...c }) => c);
          const prima = S && S.icloud && S.icloud.user === user ? S.icloud : null;
          const calId = prima && prima.calId && calendari.some(c => c.id === prima.calId) ? prima.calId : null;
          const mostra = prima && Array.isArray(prima.mostra) && prima.mostra.length ? prima.mostra : calendari.filter(c => c.scrivibile).slice(0, 4).map(c => c.id);
          const icloud = { user, pass, home: ic.home, calId, calNome: calId ? (calendari.find(c => c.id === calId) || {}).nome || "" : "", mostra, calendari,
            mappa: calId ? prima.mappa || {} : {}, syncToken: calId ? prima.syncToken || "" : "", ctag: {}, ev: {}, evHash: "" };
          await scrivi(env, [
            S ? { percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud } } : { percorso: "calendario_segreti/" + uid, dati: { icloud, creato: new Date().toISOString() } },
            { percorso: "utenti/" + uid + "/impostazioni/icloud", dati: { collegato: true, user, calId, calNome: icloud.calNome, mostra, calendari, ultimo: null, errore: null } }
          ]);
          await sincronizzaICloud(env, uid).catch(() => {});
          return json({ ok: true, calendari: calendari.length }, 200, cors);
        }
        if(p === "/icloud/scollega"){
          await scrivi(env, [
            S && S.refresh ? { percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: {} } : { percorso: "calendario_segreti/" + uid, elimina: true },
            { percorso: "utenti/" + uid + "/impostazioni/icloud", dati: { collegato: false } },
            { percorso: "utenti/" + uid + "/impostazioni/icloud_eventi", dati: { agg: new Date().toISOString(), ev: [] } }
          ]);
          return json({ ok: true }, 200, cors);
        }
        if(!S || !S.icloud) throw new Errore(409, "iCloud non è collegato");
        if(p === "/icloud/scegli"){
          const I = S.icloud;
          if(Array.isArray(corpo.mostra)){
            const ids = new Set((I.calendari || []).map(c => c.id));
            const mostra = corpo.mostra.filter(x => typeof x === "string" && ids.has(x)).slice(0, 4);
            await scrivi(env, [
              { percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, mostra } } },
              { percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["mostra"], dati: { mostra } }
            ]);
          } else if(typeof corpo.nuovo === "string" || typeof corpo.calId === "string"){
            let id, nome;
            if(typeof corpo.nuovo === "string"){
              nome = corpo.nuovo.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "Clienti";
              const ic = new ICloud(env, I.user, I.pass, I.home);
              if(!ic.home) await ic.scopri();
              id = await ic.creaCalendario(nome);
              I.calendari = [...(I.calendari || []), { id, nome, colore: "#0F5A3D", principale: false, scrivibile: true }];
            } else {
              const c = (I.calendari || []).find(x => x.id === corpo.calId && x.scrivibile);
              if(!c) throw new Errore(400, "calendario non disponibile");
              id = c.id; nome = c.nome;
            }
            if(S.refresh && S.calId) await cambiaCalendario(env, uid, S, null, "");       // gli appuntamenti vanno in un solo servizio
            await iCloudCambia(env, uid, S, id, nome);
          } else throw new Errore(400, "richiesta non valida");
          const r = await sincronizzaTutto(env, uid, { calendari: true });
          return json({ ok: true, ...r }, 200, cors);
        }
        if(p === "/icloud/evento"){
          const x = datiEvento(corpo);
          if(!x.href) throw new Errore(400, "evento mancante");
          await eventoICloud(env, uid, S, x);
          const r = await sincronizzaTutto(env, uid, {});
          return json({ ok: true, ...r }, 200, cors);
        }
        if(p === "/icloud/giro/eventi"){
          const I = S.icloud, ic = new ICloud(env, I.user, I.pass, I.home);
          if(!ic.home) await ic.scopri();
          const cals = [...new Set([...(I.mostra || []), I.calId].filter(Boolean))];
          const eventi = [];
          for(const cal of cals) for(const s of await ic.serie(cal))
            eventi.push({ ...s, calNome: ((I.calendari || []).find(c => c.id === cal) || {}).nome || "", cliente: (I.giro || {})[s.uid] ? I.giro[s.uid].cliente : null });
          return json({ ok: true, eventi: eventi.sort((a, b) => a.nome.localeCompare(b.nome, "it")).slice(0, 400) }, 200, cors);
        }
        if(p === "/icloud/giro/abbina"){
          const I = S.icloud, ic = new ICloud(env, I.user, I.pass, I.home);
          const giro = { ...(I.giro || {}) };
          const voci = (Array.isArray(corpo.voci) ? corpo.voci : []).filter(v => v && typeof v.uid === "string" && typeof v.cliente === "string" && typeof v.href === "string" && typeof v.cal === "string").slice(0, 200);
          const togli = (Array.isArray(corpo.togli) ? corpo.togli : []).filter(u => typeof u === "string" && giro[u]).slice(0, 200);
          const ids = [...new Set([...voci.map(v => v.cliente), ...voci.map(v => giro[v.uid] && giro[v.uid].cliente).filter(Boolean), ...togli.map(u => giro[u].cliente)])];
          const perId = new Map((await clientiPerId(env, uid, ids)).map(c => [c.id, c]));
          for(const u of togli){ const c = perId.get(giro[u].cliente); if(c) giroViaDaCliente(c, u, false); delete giro[u]; }
          let fatti = 0;
          const perCal = new Map(); voci.forEach(v => perCal.set(v.cal, [...(perCal.get(v.cal) || []), v]));
          for(const [cal, vv] of perCal){
            if(!(I.calendari || []).some(c => c.id === cal)) continue;
            const testi = await ic.multiget(cal, vv.map(v => v.href));
            for(const v of vv){
              const s = testi.has(v.href) && serieIcs(testi.get(v.href)), c = perId.get(v.cliente);
              if(!s || !c || s.uid !== v.uid) continue;
              if(giro[v.uid] && giro[v.uid].cliente !== v.cliente){ const vecchio = perId.get(giro[v.uid].cliente); if(vecchio) giroViaDaCliente(vecchio, v.uid, false); }
              giroSuCliente(c, v.uid, s);
              c.storico = [...(c.storico || []), { d: oggiRoma(), t: "Giro collegato al calendario iCloud: «" + s.nome + "» " + scrittaGiro(s) }];
              giro[v.uid] = { cal, href: v.href, cliente: v.cliente, k: chiaveGiro(s.giorni, s.ora, s.modo), nome: s.nome };
              fatti++;
            }
          }
          const scritture = [...perId.values()].filter(c => c._giro).map(c => ({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true,
            campi: ["giro", "giorniOrdine", "orarioOrdine", "storico", "aggiornato"],
            dati: { giro: c.giro || [], giorniOrdine: c.giorniOrdine || [], orarioOrdine: c.orarioOrdine || "", storico: c.storico || [], aggiornato: new Date().toISOString() } }));
          scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, giro, evHash: "" } } });
          scritture.push({ percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["giro"], dati: { giro: Object.fromEntries(Object.entries(giro).map(([u, L]) => [u, { cliente: L.cliente, nome: L.nome || "", href: L.href, cal: L.cal }])) } });
          await scrivi(env, scritture);
          await sincronizzaICloud(env, uid).catch(() => {});
          return json({ ok: true, collegati: fatti, tolti: togli.length }, 200, cors);
        }
        return json({ errore: "percorso sconosciuto" }, 404, cors);
      } catch(err){
        const stato = err instanceof Errore ? (err.stato >= 400 && err.stato < 600 ? err.stato : 502) : 500;
        return json({ errore: err instanceof Errore ? err.message : "errore del servizio" }, stato, cors);
      }
    }
    return new Response("non trovato", { status: 404 });
  },

  // ogni minuto un giro leggero; allo scoccare di ogni ora un controllo completo (rilegge tutti i clienti)
  async scheduled(evento, env, ctx){
    const completo = new Date(evento && evento.scheduledTime || Date.now()).getUTCMinutes() === 0;
    const d = await leggi(env, base(env) + "/calendario_segreti?pageSize=50&mask.fieldPaths=creato");
    for(const x of (d && d.documents) || []){
      const uid = decodeURIComponent(x.name.split("/").pop());
      try { await sincronizzaTutto(env, uid, { leggero: !completo }); } catch(e){ /* l'errore è già salvato per l'app */ }
    }
  }
};
