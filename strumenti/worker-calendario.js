// Servizio Cloudflare Worker "calendario" dell'app "Clienti".
//
// Fa due cose:
//  1) LINK .ics (sola lettura, per iPhone/iCloud o altri calendari): https://<worker>/cal/<uid>/<token>.ics
//     token = codice casuale salvato dall'app in utenti/{uid}/impostazioni/calendario (campo "token").
//  2) GOOGLE CALENDAR NEI DUE SENSI (v6.3): l'utente autorizza l'app sul suo account Google; da lì
//     - ogni richiamo di un cliente diventa un evento nel calendario Google scelto ("Richiamare: <nome>");
//     - se in Google l'evento viene spostato o cancellato, il richiamo del cliente si sposta o si toglie (riga nello storico);
//     - gli appuntamenti dei calendari Google scelti si copiano (sola lettura) in utenti/{uid}/impostazioni/gcal_eventi
//       e l'app li mostra nel Calendario.
//     Si sincronizza quando l'app lo chiede (subito dopo una modifica) e ogni 5 minuti con il "Cron Trigger".
//
// Impostazioni nel pannello Cloudflare (Worker > Settings):
//   SERVICE_ACCOUNT      (Secret)  JSON della chiave di servizio Firebase (progetto clienti-malfer)
//   GOOGLE_CLIENT_ID     (Secret)  ID client OAuth "Applicazione web" della console Google (stesso progetto)
//   GOOGLE_CLIENT_SECRET (Secret)  il suo segreto
//   Trigger events > Cron Triggers: */5 * * * *
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
  const S = await leggiDoc(env, "calendario_segreti/" + uid);
  if(!S || !S.refresh) return { collegato: false };
  const g = new Google(env, S.refresh);
  const oggi = opz.oggi || oggiRoma(), dal = piuGiorni(oggi, -60);
  const mappa = S.mappa && typeof S.mappa === "object" ? S.mappa : {};
  const stat = { creati: 0, cambiati: 0, tolti: 0, daGoogle: 0, rimandati: 0 };
  const scritture = [], storicoOggi = oggi;
  let calendari = Array.isArray(S.calendari) ? S.calendari : [];
  try {
    if(opz.calendari || !calendari.length) calendari = await g.calendari();
    const clienti = await clientiDi(env, uid, ["storico"]);
    const perId = new Map(clienti.map(c => [c.id, c]));
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
      for(const ev of cambiati){
        const cid = evCliente.get(ev.id) || (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.app === "clienti" ? ev.extendedProperties.private.cliente : null);
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
      let scritte = 0;
      const tocca = () => { if(scritte >= MAX_SCRITTURE){ stat.rimandati++; return false; } scritte++; return true; };
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
      for(const cid of Object.keys(mappa)) if(!perId.has(cid)){        // cliente eliminato dall'app
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
    scritture.push({ percorso: "calendario_segreti/" + uid, campi: ["mappa", "syncToken", "calendari"], dati: { mappa, syncToken, calendari } });
    scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["collegato", "ultimo", "errore", "calendari", "mostra"],
      dati: { collegato: true, ultimo: new Date().toISOString(), errore: stat.rimandati ? "Molti richiami da copiare: finisco tra pochi minuti" : null, calendari, mostra } });
    scritture.push({ percorso: "utenti/" + uid + "/impostazioni/gcal_eventi", dati: { agg: new Date().toISOString(), ev: ev.slice(0, 600) } });
    await scrivi(env, scritture);
    return { collegato: true, ...stat, chiamateGoogle: g.chiamate };
  } catch(err){
    // salva comunque i progressi fatti (eventi già creati) e l'errore da mostrare nell'app
    const revocato = err.stato === 410;
    await scrivi(env, [
      { percorso: "calendario_segreti/" + uid, campi: ["mappa"], dati: { mappa } },
      { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["errore", "collegato"], dati: { errore: String(err.message || err).slice(0, 200), collegato: !revocato } }
    ]).catch(() => {});
    throw err;
  }
}

async function cambiaCalendario(env, uid, S, nuovoId, nuovoNome){
  const g = new Google(env, S.refresh);
  const mappa = S.mappa || {};
  if(S.calId && S.calId !== nuovoId){                              // si tolgono gli eventi dal calendario vecchio
    let n = 0;
    for(const m of Object.values(mappa)){
      if(++n > MAX_SCRITTURE) break;
      try { await g.chiama("DELETE", cal(S.calId) + "/events/" + encodeURIComponent(m.ev)); } catch(e){ if(e.google !== 404 && e.google !== 410) throw e; }
    }
  }
  await scrivi(env, [
    { percorso: "calendario_segreti/" + uid, campi: ["calId", "calNome", "mappa", "syncToken"], dati: { calId: nuovoId, calNome: nuovoNome, mappa: {}, syncToken: null } },
    { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["calId", "calNome"], dati: { calId: nuovoId, calNome: nuovoNome } }
  ]);
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
    const mf = PERCORSO.exec(p);
    if(mf){
      if(req.method !== "GET" && req.method !== "HEAD") return new Response("metodo non ammesso", { status: 405 });
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
    if(p.startsWith("/google/")){
      const origine = req.headers.get("Origin") || "";
      const consentite = String(env.ALLOWED_ORIGINS || app).split(",").map(s => s.trim()).filter(Boolean);
      if(!consentite.includes(origine)) return json({ errore: "origine non consentita" }, 403, {});
      const cors = { "Access-Control-Allow-Origin": origine, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400" };
      if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if(req.method !== "POST") return json({ errore: "metodo non ammesso" }, 405, cors);
      try {
        if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Errore(503, "collegamento a Google non ancora configurato nel servizio");
        const uid = await utente(req, env);
        const corpo = await req.json().catch(() => ({}));
        if(p === "/google/inizio"){
          const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: ritornoUrl(req), response_type: "code", scope: SCOPE,
            access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: await creaStato(env, uid) });
          return json({ url: (env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth") + "?" + q }, 200, cors);
        }
        const S = await leggiDoc(env, "calendario_segreti/" + uid);
        if(p === "/google/scollega"){
          if(S && S.refresh) await fetch((env.GOOGLE_OAUTH || "https://oauth2.googleapis.com") + "/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: S.refresh }) }).catch(() => {});
          await scrivi(env, [
            { percorso: "calendario_segreti/" + uid, elimina: true },
            { percorso: "utenti/" + uid + "/impostazioni/gcal", dati: { collegato: false } },
            { percorso: "utenti/" + uid + "/impostazioni/gcal_eventi", dati: { agg: new Date().toISOString(), ev: [] } }
          ]);
          return json({ ok: true }, 200, cors);
        }
        if(!S || !S.refresh) throw new Errore(409, "Google Calendar non è collegato");
        if(p === "/google/scegli"){
          if(Array.isArray(corpo.mostra)){
            const ids = new Set((S.calendari || []).map(c => c.id));
            const mostra = corpo.mostra.filter(x => typeof x === "string" && ids.has(x)).slice(0, 4);
            await scrivi(env, [
              { percorso: "calendario_segreti/" + uid, campi: ["mostra"], dati: { mostra } },
              { percorso: "utenti/" + uid + "/impostazioni/gcal", campi: ["mostra"], dati: { mostra } }
            ]);
          } else if(typeof corpo.nuovo === "string"){
            const nome = corpo.nuovo.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "Clienti";
            const g = new Google(env, S.refresh);
            const c = await g.chiama("POST", "/calendars", { summary: nome, timeZone: "Europe/Rome", description: "Richiami dei clienti (app Clienti)" });
            await cambiaCalendario(env, uid, S, c.id, nome);
          } else if(typeof corpo.calId === "string"){
            const c = (S.calendari || []).find(x => x.id === corpo.calId && x.scrivibile);
            if(!c) throw new Errore(400, "calendario non disponibile");
            await cambiaCalendario(env, uid, S, c.id, c.nome);
          } else throw new Errore(400, "richiesta non valida");
          const r = await sincronizza(env, uid, { calendari: true });
          return json({ ok: true, ...r }, 200, cors);
        }
        if(p === "/google/sincronizza"){
          const r = await sincronizza(env, uid, { calendari: !!corpo.calendari });
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

  // ogni 5 minuti: sincronizza gli utenti collegati (porta nell'app le modifiche fatte in Google)
  async scheduled(evento, env, ctx){
    const d = await leggi(env, base(env) + "/calendario_segreti?pageSize=50&mask.fieldPaths=calId");
    for(const x of (d && d.documents) || []){
      const uid = decodeURIComponent(x.name.split("/").pop());
      try { await sincronizza(env, uid); } catch(e){ /* l'errore è già salvato per l'app */ }
    }
  }
};
