# App "Clienti" — clienti.malfer.it

Questo file passa a Claude Code il contesto del progetto, nato e sviluppato in una chat su claude.ai.
Leggilo tutto prima di modificare qualcosa.

## Chi la usa e a cosa serve

Manuel Malfer è un agente di commercio nel ramo alimentare (distribuzione per Marchi S.p.A.).
Copre la zona da Malcesine (Lago di Garda) fino alla Val di Non, passando per Alto Garda e Trento.
L'app sostituisce il suo Excel "Mappatura clienti": ci registra i locali della zona (ristoranti, pizzerie,
hotel, bar…), ne segue lo stato commerciale e organizza visite, consegne e richiami.
Lavora soprattutto da **iPad e iPhone** (app aggiunta alla schermata Home da Safari) e dal PC Windows.

Il papà di Manuel userà l'app con un suo account: **ogni utente vede solo i propri clienti**.

Lingua: tutta l'interfaccia è in **italiano**. Manuel non è uno sviluppatore: spiegagli i passaggi in modo
semplice e concreto, un passo alla volta.

## Architettura

- **Un solo file**: `index.html` (HTML + CSS + JavaScript in un unico file, nessun build, nessun npm).
  Mantieni questa struttura: Manuel finora aggiornava il sito caricando `index.html` su GitHub.
- Altri file del sito: `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`,
  `robots.txt` (Disallow: /), `CNAME` (clienti.malfer.it).
- **Hosting**: GitHub Pages, repository pubblico `ManuelMalfer/clienti`, branch `main`, cartella root.
- **Dominio**: `clienti.malfer.it`. I DNS di malfer.it sono su **Cloudflare** (dominio comprato su Aruba).
  Record CNAME `clienti` → `manuelmalfer.github.io`, **proxy disattivato (nuvola grigia)**, altrimenti
  GitHub non rilascia il certificato HTTPS. "Enforce HTTPS" è attivo su GitHub Pages.
- **Nascosto ai motori di ricerca**: `robots.txt` + meta `noindex, nofollow, noarchive`.
- **Backend**: Firebase, progetto `clienti-malfer`.
  - Authentication: solo Email/password. Gli utenti li crea Manuel a mano dalla console (niente registrazione).
    Dominio autorizzato aggiunto: clienti.malfer.it.
  - Firestore in `europe-west8` (Milano), modalità produzione, cache offline persistente
    (`persistentLocalCache` + `persistentMultipleTabManager`): l'app funziona anche senza rete.
  - La config Firebase web è dentro `index.html`. La chiave API web è pubblica per natura:
    GitHub l'ha segnalata come "secret leak", è stato chiuso come falso positivo. È consigliato
    limitarla per referrer (clienti.malfer.it/* e clienti-malfer.firebaseapp.com/*) dalla Google Cloud Console.
- **Librerie da CDN** (pinnate): Firebase JS SDK 10.12.2 (gstatic, ES modules), SheetJS xlsx 0.18.5,
  Leaflet 1.9.4 (cdnjs), Tesseract.js 5.1.1 (jsdelivr, caricato solo quando serve, lingua `ita`).
  Font Google: Barlow e Barlow Semi Condensed.

## Regole di sicurezza Firestore

I dati stanno in `utenti/{uid}/clienti/{id}`. Le regole (pubblicate nella console Firebase, scheda Regole)
permettono lettura/scrittura solo se l'utente è autenticato, la sua email è nell'elenco abilitato e
`request.auth.uid == userId`. **Le email abilitate NON vanno messe nel repository** (è pubblico):
la copia locale `firestore.rules` è esclusa da git tramite `.gitignore`.
Per aggiungere un utente: crearlo in Authentication e aggiungere la sua email all'elenco nelle regole.

## Modello dati (documento cliente)

Campi: `nome` (insegna del locale), `ragioneSociale`, `codice` (codice cliente aziendale),
`referente`, `tel`, `cellulare`, `email`, `pec`, `luogo` (località), `indirizzo`, `cap`, `prov`,
`tipologia`, `piva`, `codiceFiscale`, `codiceUnivoco` (SDI), `pagamento`,
`fornitori` (array), `giorniOrdine` e `giorniConsegna` (array di "Lunedì"…"Sabato"),
`orarioOrdine`, `orarioConsegna`, `stato`, `ricontattare` (YYYY-MM-DD), `ricontattareOra` (HH:MM),
`note`, `storico` (array di `{d: "YYYY-MM-DD", t: "testo"}`), `lat`, `lng`, `approx` (posizione al
centro paese), `geoFail`, `creato`, `aggiornato` (ISO).

Stati: `DA CONTATTARE`, `CONTATTATO`, `CLIENTE`, `NON SERVIBILE`.
Le vecchie categorie `CLIENTE MAX` e `CLIENTE LUTTERI` sono state eliminate: vengono convertite in
`NON SERVIBILE` con nota "Cliente di Massimiliano" / "Cliente di Lutteri" (funzione `migraExClienti`,
eseguita automaticamente, e anche all'importazione Excel).

Ogni cambio di stato aggiunge automaticamente una riga allo storico.

## Funzioni presenti

Barra in basso: **Clienti, Mappa, Giro, Richiami, Riepilogo** + pulsante flottante **Nuovo**.

- **Clienti**: ricerca multi-parola su tutti i campi, filtri per stato, località e tipologia.
  Pulsante **Zone**: apre la mappa delle zone di lavoro (SVG inline, nessuna richiesta di rete), divisa
  in 17 zone = 15 comunità di valle + Territorio Val d'Adige ("Trento e dintorni") + la sponda veronese
  "Malcesine e Brenzone" (comuni di Malcesine e Brenzone sul Garda). Grigie di base, si
  colorano quando le tocchi (selezione multipla) e filtrano l'elenco (`ui.zone`). Un locale appartiene alla zona
  del suo comune (`luogo`, tabella `ZONE_COMUNI`); se la località non è un comune (es. frazione) si usano le
  coordinate (`zonaDi`). I contorni (`ZONE_GEO`) sono ricavati dai confini comunali openpolis/geojson-italy,
  uniti e semplificati (~100 m). Locali fuori da queste zone = nessuna zona.
- **Scheda cliente** (dialog): Chiama, WhatsApp (usa il cellulare; il fisso solo se inizia per 3),
  Email, Naviga (Google Maps); cambio stato rapido; "Richiama il" con data + ora, +1 settimana,
  +1 mese, Fatto, Aggiungi al calendario; posizione sulla mappa (Vedi / Correggi posizione);
  storico note con data; Modifica, Elimina.
- **Nuovo/Modifica**: obbligatori solo nome, località e tipologia. "Salva e aggiungi un altro" mantiene
  località e tipologia. Avviso duplicati (stesso nome+località o stesso indirizzo+località).
  Controlli morbidi su P.IVA (11 cifre) e codice univoco (7 caratteri).
- **Compila da screenshot**: nel modulo Nuovo. Legge lo screenshot iPad della scheda cliente del
  gestionale aziendale e compila i campi. Dettagli sotto.
- **Mappa** (Leaflet + OpenStreetMap, vista Satellite Esri): pallini verdi = Cliente, arancioni =
  Contattato, rossi = Da contattare, grigi = Non servibile (nascosti di default). Pulsante "La mia
  posizione". Bottone **Solo la mia zona** (attivo di default): la mappa resta a colori solo entro
  1 km da ogni locale, fuori diventa in bianco e nero (canvas con `mix-blend-mode: saturation` +
  velo bianco, ritagliato con `destination-out`). All'apertura inquadra la zona principale ignorando i
  locali a più di 60 km dalla mediana.
  Geocoding automatico con Nominatim (max 1 richiesta/secondo): indirizzo+località → nome+località →
  sola via → centro paese (`approx: true`, bordo tratteggiato). Le coordinate vengono salvate; se cambia
  l'indirizzo vengono azzerate e ricalcolate.
- **Giro**: per ogni giorno Lun–Sab, consegne e ordini da raccogliere con orari e pulsante chiama.
- **Richiami**: scaduti / oggi / prossimi 7 giorni / più avanti, ordinati per data e ora; badge rosso
  sulla tab con i richiami scaduti o di oggi. Pulsante **Aggiungi al calendario** che genera un file
  `.ics` con tutti i richiami da oggi in avanti (evento di 30 min con avviso 15 min prima se c'è l'ora,
  altrimenti tutto il giorno). È un'esportazione, non una sincronizzazione.
- **Riepilogo**: clienti attivi, in trattativa, locali mappati; conteggi per stato; copertura per
  località (clienti attivi sul totale, cliccabile); fornitori attuali più diffusi;
  **Importa da Excel** (foglio DATABASE, salta i duplicati nome+indirizzo+località) ed **Esporta in Excel**
  (stesse colonne, reimportabile); account ed Esci.
- Banner offline; tema chiaro/scuro; safe area iPhone; nessun localStorage.

## Compila da screenshot (dettagli tecnici)

Il gestionale aziendale mostra la scheda cliente sempre con lo stesso layout su iPad
(screenshot di riferimento 2360×1640, orizzontale). L'app:
1. trova il pannello grigio (RGB 170,170,170) per adattarsi a scale diverse;
2. ritaglia ogni riquadro con le coordinate in `SS_FIELDS` (relative a `SS_PANEL`);
3. binarizza ogni ritaglio con soglia di Otsu (il testo può essere nero su giallo, bianco su rosso
   o nero su rosso) e salta i riquadri vuoti;
4. legge con Tesseract.js (`psm 7`, whitelist di caratteri per tipo di campo), tutto sul dispositivo;
5. normalizza: Title Case (SRL/SNC/SAS/SPA restano maiuscoli), separa il civico ("ORO12" → "Oro, 12"),
   abbina località e tipologia a quelle esistenti, giorni "1;2;3;" → Lunedì… (7 = domenica ignorata,
   si prende la prima cifra di ogni gruppo separato da ";"), orari mattino e pomeriggio, stato = Cliente;
6. evidenzia in arancione i campi con confidenza < 75 o P.IVA che non supera la cifra di controllo;
7. se il locale esiste già (stessa P.IVA, stesso nome+località o stessa ragione sociale) aggiorna la
   scheda esistente invece di crearne una nuova.

Mappatura campi del gestionale: insegna → nome, ragione sociale, indirizzo, CAP, località, provincia,
telefono, cellulare, email, P.IVA, codice fiscale, PEC, GG cons → giorni di consegna, pagamento,
canale vendita → tipologia, Cons. mattino/pomeriggio → orario consegna.
Il campo "Cliente" (es. "N4") viene usato come codice cliente solo se è numerico (≥ 4 cifre):
da chiarire con Manuel se "N4" è un codice provvisorio o definitivo.

## Come lavorare su questo progetto

- Modifiche piccole e mirate a `index.html`; non introdurre framework o build.
- Testo dell'interfaccia in italiano, tono semplice; maiuscole solo a inizio frase nei titoli.
- Dopo ogni modifica: controlla la sintassi del modulo JS (estrai il contenuto di
  `<script type="module">` in un file `.mjs` e lancia `node --check`).
- Per provare l'interfaccia senza Firebase è stato usato Playwright, intercettando gli URL di
  firebase-app / firebase-auth / firebase-firestore e sostituendoli con piccoli moduli finti
  (onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch in memoria). Non mettere nel repository dati
  reali dei clienti: il repo è pubblico.
- Pubblicare = commit + push su `main`; GitHub Pages aggiorna in 1–2 minuti. Su iPhone l'app sulla
  Home può mostrare la versione vecchia finché non viene chiusa e riaperta.
- I dati vivono solo su Firestore: modificare `index.html` non tocca i dati.

## Idee aperte / possibili sviluppi

- Zona a colori calcolata solo sui clienti attivi invece che su tutti i locali (domanda posta, senza risposta).
- Vista "responsabile" in cui Manuel vede anche i clienti del papà.
- Automatismo screenshot → cartella OneDrive → creazione cliente (scartato per ora: richiede
  registrazione app Microsoft e probabilmente permessi IT aziendali; si è scelto il pulsante nell'app).
- Calendario sincronizzato (feed iCal in abbonamento) al posto dell'export `.ics`: richiede un piccolo
  servizio lato server (es. Cloudflare Worker).
- Adattare la lettura screenshot ad altri dispositivi se Manuel usa il gestionale anche altrove.
