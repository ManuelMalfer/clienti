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
const CAMPI = ["nome", "luogo", "indirizzo", "referente", "tel", "cellulare", "email", "stato", "note", "ricontattare", "ricontattareOra",
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
  const r = await fsChiama(env, "POST", base(env) + ":batchGet", { documents: ids.map(id => radice(env) + "/utenti/" + uid + "/clienti/" + id), mask: { fieldPaths: [...CAMPI, "storico"] } });
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
    L.push("SUMMARY:" + esc("Richiamare: " + (c.nome || "cliente")));
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
const chiaveCliente = c => c && c.ricontattare && /^\d{4}-\d{2}-\d{2}$/.test(c.ricontattare) ? c.ricontattare + "|" + (/^\d{1,2}:\d{2}$/.test(c.ricontattareOra || "") ? c.ricontattareOra.padStart(5, "0") : "") : "";
function chiaveEvento(ev){
  if(!ev || !ev.start) return "";
  if(ev.start.date) return ev.start.date + "|";
  if(ev.start.dateTime){ const r = romaDi(ev.start.dateTime); return r.d + "|" + r.o; }
  return "";
}
function corpoEvento(c){
  const [d, o] = chiaveCliente(c).split("|");
  const ev = { summary: "Richiamare: " + (c.nome || "cliente"), description: descrizione(c),
    extendedProperties: { private: { app: "clienti", cliente: c.id } }, status: "confirmed" };
  const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", "); if(luogo) ev.location = luogo;
  if(o){
    const [h, m] = o.split(":").map(Number), t = new Date(Date.UTC(2000, 0, 1, h, m + 30));
    const fineD = t.getUTCDate() === 1 ? d : piuGiorni(d, 1);
    ev.start = { dateTime: d + "T" + o + ":00", timeZone: "Europe/Rome" };
    ev.end = { dateTime: fineD + "T" + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()) + ":00", timeZone: "Europe/Rome" };
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
            const [d, o] = kg.split("|");
            c.ricontattare = d; c.ricontattareOra = o;
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
        const tg = !!(e.start && e.start.date);
        const s = tg ? e.start.date : e.start && e.start.dateTime ? romaDi(e.start.dateTime) : null;
        const f = tg ? e.end && e.end.date : e.end && e.end.dateTime ? romaDi(e.end.dateTime) : null;
        if(!s) continue;
        ev.push({ id: String(e.id).slice(0, 200), c: nomi.get(id), t: String(e.summary || "(senza titolo)").slice(0, 200),
          s: tg ? s : s.d + "T" + s.o, e: tg ? (f || piuGiorni(s, 1)) : f ? f.d + "T" + f.o : s.d + "T" + s.o, g: tg,
          l: String(e.location || "").slice(0, 200), u: String(e.htmlLink || "").slice(0, 500) });
      }
    }
    ev.sort((a, b) => a.s.localeCompare(b.s));

    // d) salvataggio
    for(const c of clienti) if(c._cambiato)
      scritture.push({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true, campi: ["ricontattare", "ricontattareOra", "storico", "aggiornato"],
        dati: { ricontattare: c.ricontattare, ricontattareOra: c.ricontattareOra, storico: c.storico, aggiornato: new Date().toISOString() } });
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

class ICloud {
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
    const out = [], risp = xmlTutti(r.t, "response");
    // rapporto tecnico (solo nomi dei tag, niente dati) per capire cosa manda iCloud se non si trova nessun calendario
    const soloTag = s => (String(s || "").match(/<[w:-]+/g) || []).map(t => t.slice(1).replace(/^[w-]+:/, "")).join(",");
    this.diag = "stato " + r.s + ", home " + new URL(this.home).host + new URL(this.home).pathname.replace(/d+/g, "N") + ", risposte " + risp.length + ": " +
      risp.slice(0, 6).map(resp => "[" + soloTag(xmlUno(resp, "resourcetype")) + " | " + soloTag(xmlUno(resp, "supported-calendar-component-set")) + " | " + (xmlUno(resp, "supported-calendar-component-set") || "").replace(/<[^>]*name=.([A-Z]+).[^>]*>/g, "$1 ").replace(/<[^>]*>/g, "").trim() + "]").join(" ") +
      (risp.length ? "" : " inizio: " + r.t.slice(0, 160).replace(/d{4,}/g, "N"));
    for(const resp of risp){
      const tipo = xmlUno(resp, "resourcetype") || "";
      if(!xmlHa(tipo, "calendar")) continue;
      const comp = xmlUno(resp, "supported-calendar-component-set");
      if(comp && !/name="VEVENT"/i.test(comp)) continue;
      const priv = xmlUno(resp, "current-user-privilege-set");
      const href = percorso(xmlTesto(xmlUno(resp, "href")), this.home);
      out.push({ id: new URL(href, this.home).toString().replace(/\/?$/, "/"), nome: xmlTesto(xmlUno(resp, "displayname")) || "Calendario",
        colore: (xmlTesto(xmlUno(resp, "calendar-color")).match(/^#[0-9a-f]{6}/i) || ["#FF9500"])[0], principale: false,
        scrivibile: !priv || xmlHa(priv, "write") || xmlHa(priv, "all"), ctag: xmlTesto(xmlUno(resp, "getctag")) });
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
    for(const resp of xmlTutti(r.t, "response")){ const d = xmlUno(resp, "calendar-data"); if(d) out.set(percorso(xmlTesto(xmlUno(resp, "href")), cal), xmlTesto(d)); }
    return out;
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
        out.push({ id: (uid + (e["RECURRENCE-ID"] ? "|" + e["RECURRENCE-ID"].v : "")).slice(0, 200), t: icsTesto(e.SUMMARY ? e.SUMMARY.v : "(senza titolo)").slice(0, 200),
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
    const [h, m] = o.split(":").map(Number), t = new Date(Date.UTC(2000, 0, 1, h, m + 30));
    const fineD = (t.getUTCDate() === 1 ? d : piuGiorni(d, 1)).replace(/-/g, "");
    L.push("DTSTART;TZID=Europe/Rome:" + dd + "T" + pad(h) + pad(m) + "00", "DTEND;TZID=Europe/Rome:" + fineD + "T" + pad(t.getUTCHours()) + pad(t.getUTCMinutes()) + "00");
  } else L.push("DTSTART;VALUE=DATE:" + dd, "DTEND;VALUE=DATE:" + piuGiorni(d, 1).replace(/-/g, ""), "TRANSP:TRANSPARENT");
  L.push("SUMMARY:" + esc("Richiamare: " + (c.nome || "cliente")));
  const luogo = [c.indirizzo, c.luogo].filter(Boolean).join(", ");
  if(luogo) L.push("LOCATION:" + esc(luogo));
  L.push("DESCRIPTION:" + esc(descrizione(c)));
  if(o) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc("Richiamare " + (c.nome || "")), "TRIGGER:-PT15M", "END:VALARM");
  L.push("END:VEVENT", "END:VCALENDAR");
  return L.map(piega).join("\r\n") + "\r\n";
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
      clienti = opz.leggero ? await clientiPerId(env, uid, toccati) : await clientiDi(env, uid, ["storico"]);
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
          const kg = chiaveIcs(icsData((icsEventi(testo)[0] || {}).DTSTART));
          if(!kg || kg === m.k) continue;
          const c = perId.get(cid);
          if(c && chiaveCliente(c) === m.k){
            const [d, o] = kg.split("|");
            c.ricontattare = d; c.ricontattareOra = o;
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

    // c) appuntamenti iCloud da mostrare nell'app (sola lettura)
    const mostra = (Array.isArray(I.mostra) ? I.mostra : []).filter(id => calendari.some(c => c.id === id)).slice(0, 4);
    for(const id of mostra) if(!opz.leggero || nuoviCtag[id] !== ctag[id] || !Array.isArray(evPer[id]))
      evPer[id] = (await ic.eventi(id, piuGiorni(oggi, -14), piuGiorni(oggi, 120))).slice(0, 300);
    for(const id of Object.keys(evPer)) if(!mostra.includes(id)) delete evPer[id];
    const ev = mostra.flatMap(id => (evPer[id] || []).map(e => ({ ...e, c: calendari.findIndex(c => c.id === id) }))).sort((a, b) => a.s.localeCompare(b.s)).slice(0, 600);
    const evHash = impronta(JSON.stringify(ev));

    const scritture = [];
    for(const c of clienti) if(c._cambiato)
      scritture.push({ percorso: "utenti/" + uid + "/clienti/" + c.id, esiste: true, campi: ["ricontattare", "ricontattareOra", "storico", "aggiornato"],
        dati: { ricontattare: c.ricontattare, ricontattareOra: c.ricontattareOra, storico: c.storico, aggiornato: new Date().toISOString() } });
    scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["icloud"], dati: { icloud: { ...I, home: ic.home, calendari, mostra, mappa, syncToken, ctag: nuoviCtag, ev: evPer, evHash, pulizia } } });
    scritture.push({ percorso: "utenti/" + uid + "/impostazioni/icloud", campi: ["collegato", "ultimo", "errore", "calendari", "mostra"],
      dati: { collegato: true, ultimo: new Date().toISOString(), errore: stat.rimandati ? "Molti appuntamenti da copiare: finisco tra pochi minuti" : null, calendari, mostra } });
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
