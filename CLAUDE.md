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
`chiusoDal`/`chiusoAl` (periodo di chiusura, YYYY-MM-DD, entrambi facoltativi: nel periodo il cliente non compare nel Giro, né ordini né mappa; funzione `chiusoIl(c, iso)`; campi nel modulo e nella scheda cliente, etichetta "Chiuso fino al…" nell'elenco), `note`, `codiceDest` (codice di destinazione, dopo l'unione di due schede), `altriNomi` (nomi che la scheda aveva prima dell'unione, per la ricerca), `fattId` (id della scheda di fatturazione a cui è collegata), `codiceFatt` (codice di fatturazione, nelle destinazioni di una fatturazione con più locali), `codiceReport` (codice del report target collegato a mano, se la scheda ha già un altro `codice`), `ordiniFatti` (date in cui l'ordine del giorno è stato raccolto, dal Giro), `storico` (array di `{d: "YYYY-MM-DD", t: "testo"}`), `lat`, `lng`, `approx` (posizione al
centro paese), `geoFail`, `creato`, `aggiornato` (ISO).

Stati: `DA CONTATTARE`, `CONTATTATO`, `CLIENTE`, `CLIENTE PERSO` (dalla v6.0, colore viola `--st-clienteperso`), `NON SERVIBILE`.
Le vecchie categorie `CLIENTE MAX` e `CLIENTE LUTTERI` sono state eliminate: vengono convertite in
`NON SERVIBILE` con nota "Cliente di Massimiliano" / "Cliente di Lutteri" (funzione `migraExClienti`,
eseguita automaticamente, e anche all'importazione Excel).

Ogni cambio di stato aggiunge automaticamente una riga allo storico.

## Funzioni presenti

Barra in basso (5 voci): **Clienti, Calendario, Cataloghi, Riepilogo, Altro**; in **Altro** (griglia di riquadri) stanno **Mappa, Giro,
Preventivi, Reclami, Rosario**. Pulsante flottante rotondo **+** (nuovo cliente / nuovo preventivo). Vedi "Interfaccia" più sotto.

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
- **Giro**: per ogni giorno Lun–Sab (di base oggi). Una **mappa delle zone** (le stesse 17 dei Clienti, `zoneGeometria()`) a lato (sopra su
  telefono): **verde** le zone dove ci sono consegne **il giorno dopo** quello scelto (gli ordini raccolti oggi si consegnano domani: scegliendo
  Lunedì la mappa mostra le consegne di Martedì, ... Sabato → Lunedì; cliente con quel giorno in `giorniConsegna`, zona da `zonaDi`;
  variabile `giornoCons`), **gialla** le altre; sotto "N consegne in M zone" e le zone verdi con il numero. L'elenco delle consegne NON si mostra più. La barra dei giorni conta gli
  **ordini** ("7 ord.") di quel giorno, come l'elenco sotto (non le consegne). **Ordini da raccogliere** (`giorniOrdine`): il cerchio con le iniziali del cliente è una **spunta**
  (`data-fatto`): toccandolo la riga diventa trasparente con nome e località sbarrati e il cerchio verde con il segno di spunta;
  si annulla ripremendolo. Lo stato sta nel documento del cliente, campo `ordiniFatti` (array di date `YYYY-MM-DD`: la spunta vale
  solo per quel giorno e su tutti i dispositivi; si tengono solo le ultime 3 settimane). `giroData(i)` calcola la data del giorno scelto
  (la domenica si guarda già la settimana dopo).
- **Calendario** (fino alla v6.0 "Richiami"; la vista resta `v-richiami`, `renderRichiami` → `renderCalendario`): vedi la sezione
  "Calendario (v6.1)" più sotto. Badge rosso sulla voce con i richiami scaduti o di oggi.
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

## Funzioni ripristinate (9 novembre 2026)

Il caricamento "Add files via upload" del 9/11/2026 alle 10:27 (commit `a099ab8`) aveva sostituito l'`index.html`
completo (~2600 righe) con una versione più corta, facendo sparire tre funzioni. Sono state rimesse con una
fusione a tre vie partendo dalla versione precedente (`e3c6667`). **Prima di caricare un `index.html` nuovo su
GitHub controlla che contenga anche queste funzioni**, altrimenti spariscono di nuovo.

- **Cerca su Google** (modulo Nuovo cliente): cerca il locale con Google Places API (nuova) e compila indirizzo,
  telefono, tipologia e posizione; c'è anche "Sono qui" (locali vicini). La chiave API di Google si inserisce
  dall'ingranaggio accanto al pulsante e sta in Firestore, `utenti/{uid}/impostazioni/google` (campo `key`).
  Non va messa nel repository.
- **Preventivi** (scheda in barra): legge il PDF dell'ordine del gestionale (pdf.js), ricorda le correzioni agli
  articoli, permette di modificare e genera il PDF finale (jsPDF + html2canvas, funziona anche su iPhone/iPad).
  Dati in `utenti/{uid}/preventivi`. Librerie da cdnjs: pdf.js 3.11.174, jsPDF 2.5.1, html2canvas 1.4.1.
- **Import contatti dal gestionale**: l'importazione Excel riconosce anche l'export contatti del gestionale
  (colonne COD_CONTO, RAG_SOCIALE, LOCALITA…) oltre al foglio DATABASE.

Le schede sono 8 (Clienti, Richiami, Cataloghi, Riepilogo + Mappa, Giro, Preventivi, Rosario in "Altro").

## Cataloghi

Scheda **Cataloghi** nella barra in basso: i cataloghi PDF dei fornitori e di Marchi, con barra di ricerca,
etichette per **categoria** e elenco **raggruppato per categoria** (gruppi che si aprono/chiudono, "Chiudi tutte").
Ogni riga: titolo, fornitore, breve descrizione, anno; si apre nel **lettore PDF** dell'app (sotto); il pulsante di
condivisione manda il PDF vero (decifrato) con la condivisione del telefono, oppure lo scarica sul PC.

- **Ricerca**: per inizio parola (non per pezzi dentro le parole: "gelato" non trova "surgelato"), ignora l'ultima
  lettera (mozzarella = mozzarelle). Cerca in titolo, fornitore, descrizione, anno e `tag`; NON nel nome della
  categoria, perciò ogni voce ha nei `tag` le parole generiche della sua categoria (pesce, carne, dolci…).
- I file stanno nel repository (pubblico), cartella `cataloghi/`, ma **cifrati** (`nome.pdf.enc`): chi conosce il link
  diretto scarica solo byte illeggibili. Vedi "Protezione dei PDF" sotto. Nomi file in minuscolo, senza spazi né accenti.
- L'elenco è `cataloghi.json` (letto a ogni apertura della scheda, `cache: "no-cache"`):
  `{ "categorie": [ordine di categorie e gruppi], "cataloghi": [ { "titolo", "fornitore", "categoria", "desc", "anno", "file", "tag": [] } ] }`.
  `file` è un percorso (`cataloghi/nome.pdf.enc`, cifrato) o un indirizzo completo (`https://…`, mai cifrato). `fornitore` può mancare.
  Categorie non elencate in `categorie` vanno in fondo; senza categoria = "Altri cataloghi".
- Categorie attuali: Marchi S.p.A., Carni e salumi, Pesce e frutti di mare, Pasta e pasta fresca, Farine e pizzeria,
  Patate e verdure, Latte panna e uova, Surgelati e gastronomia, Dolci colazione e gelati, Spezie sale e condimenti,
  Non food e monouso.
- Aggiungere un catalogo **dall'app**: pulsante "+ Aggiungi" (sezione sotto). Oppure dal PC: copiare il PDF in `cataloghi-originali/`, lanciare `node strumenti/cifra-cataloghi.mjs`
  (crea `cataloghi/nome.pdf.enc`), aggiungere la voce in `cataloghi.json` con `file: "cataloghi/nome.pdf.enc"` e fare push.
  Manuel manda i PDF a Claude, che propone fornitore/categoria dal contenuto (se il PDF è solo immagini va guardato
  a mano, per esempio aprendolo nel lettore).
- Il 18/11/2026 sono stati caricati 57 PDF (~220 MB). Fornitore di ostriche, caviale, alghe, cozze e di tutto il
  pesce fresco = **Ittica Center** (confermato da Manuel). **Demetra** è un fornitore (non un marchio Marchi): il suo
  "Catalogo generale 27" (152 pagine di sole immagini) copre funghi, carciofi, ortaggi, condimenti, frutti di mare,
  frutta e dessert; sta in "Patate e verdure".

### Protezione dei PDF (cifratura)

Obiettivo di Manuel: **chi conosce il link diretto di un PDF non deve poterlo aprire**, senza password da digitare
nell'app. Siccome il repository e GitHub Pages sono pubblici, i PDF sono cifrati e la chiave sta dietro il login.

- Cifratura **AES-256-GCM** con chiave casuale da 256 bit. Formato di `cataloghi/x.pdf.enc`: 12 byte iniziali (iv) +
  testo cifrato con sigillo. `cataloghi/cifratura.json` contiene solo un "sigillo" (`verifica`: la parola `catalogo-ok`
  cifrata) con cui l'app controlla che la chiave sia quella giusta. Nessun segreto su GitHub.
- **Chiave**: la crea `strumenti/cifra-cataloghi.mjs` la prima volta e la salva in
  `cataloghi-originali/chiave-cataloghi.txt` (solo sul PC di Manuel, la cartella è in `.gitignore`; la copia anche negli
  appunti). Le volte dopo la riusa. `--tutti` ricifra tutto, `--nuova` crea una chiave nuova (poi va incollata di nuovo).
- **Nell'app**: al primo catalogo cifrato l'app legge la chiave dal documento Firestore
  `utenti/{uid}/impostazioni/cataloghi` (campo `chiave`, stesse regole dei clienti: serve il login di un'email abilitata),
  la importa con Web Crypto e decifra da sola. Se il documento non c'è (prima volta su quell'account, es. il papà di
  Manuel), compare "Attiva i cataloghi": si incolla la chiave UNA volta, l'app la controlla col sigillo e la salva
  nell'account; da lì in poi nessuna domanda, su ogni dispositivo. La chiave in memoria si dimentica uscendo dall'account.
- **Non si recupera**: se si perdono sia `chiave-cataloghi.txt` sia il documento Firestore, i `.enc` non si aprono più e
  vanno ricifrati dagli originali (`--nuova`). Tenere una copia di `cataloghi-originali/` (PDF e chiave).
- Limiti da conoscere: il titolo dei cataloghi (`cataloghi.json`) resta pubblico; chi ha il telefono con l'accesso aperto
  vede i cataloghi come vede i clienti; chi condivide un catalogo manda il PDF in chiaro.
- I PDF in chiaro erano stati pubblicati il 18/11/2026 (6 commit). Lo stesso giorno la cronologia è stata riscritta
  (`git filter-branch`, poi push forzato) e ora nessun commit di `main` contiene PDF in chiaro; il vecchio indirizzo
  `clienti.malfer.it/cataloghi/x.pdf` dà 404. Restano però raggiungibili su GitHub, finché GitHub non elimina gli oggetti
  non più referenziati, tramite l'indirizzo completo dei vecchi commit (es. raw.githubusercontent.com/…/<sha di 40 caratteri>/…).
  Per eliminarli del tutto: chiedere a GitHub Support di rimuovere i dati sensibili / far girare la pulizia, oppure
  ricreare il repository. **Non rimettere mai PDF in chiaro in `cataloghi/`** (usare sempre `cataloghi-originali/` + lo strumento).

### Aggiungere cataloghi dall'app (servizio Cloudflare)

Pulsante **+ Aggiungi** nell'intestazione di Cataloghi: si sceglie un PDF (max 50 MB), titolo, fornitore, categoria
(esistente o nuova), descrizione, anno, parole di ricerca. L'app **cifra il PDF nel telefono** (stessa chiave degli altri, AES-GCM)
e lo manda al servizio; il catalogo compare subito qui ("In pubblicazione…", si apre dalla memoria) e agli altri dopo 1-2 minuti
(tempo di pubblicazione di GitHub Pages).

- **Perché un servizio**: il sito è statico e non può ricevere file; scrivere su GitHub richiede una chiave (token) che
  NON deve stare nell'app. Il **Cloudflare Worker** `strumenti/worker-cataloghi.js` tiene la chiave GitHub come segreto,
  controlla il login Firebase di chi chiama (firma RS256 di Google, scadenza, progetto) e che l'email sia in `ALLOWED_EMAILS`,
  poi scrive `cataloghi/<nome>.pdf.enc` e aggiunge la voce a `cataloghi.json` (con ripetizione se l'elenco cambia nel frattempo).
  Non vede mai il PDF in chiaro. CORS: solo `https://clienti.malfer.it`.
- **Percorsi**: `GET /ping` (l'app lo chiama aprendo Cataloghi: se risponde 200 mostra "+ Aggiungi"; per gli altri account
  resta nascosto), `PUT /file/<nome>.pdf.enc` (corpo = JSON dell'API GitHub `{message, content}`, inoltrato in streaming con
  `FixedLengthStream`), `POST /elenco` (voce validata: titolo, fornitore, categoria, desc, anno, tag; `file` deve essere
  `cataloghi/[a-z0-9-]+.pdf.enc` e già presente nel repository).
- **Impostazioni del Worker** (pannello Cloudflare > Worker > Settings > Variables and Secrets): `GITHUB_TOKEN` (Secret: token
  fine-grained solo per il repository `clienti`, permesso Contents: Read and write), `ALLOWED_EMAILS` (Secret: email dell'app,
  separate da virgola), `GITHUB_REPO` = `ManuelMalfer/clienti`, `GITHUB_BRANCH` = `main`, `FIREBASE_PROJECT` = `clienti-malfer`,
  `ALLOWED_ORIGINS` = `https://clienti.malfer.it` (facoltativa). Il token GitHub scade (scelta alla creazione): quando scade, solo
  l'upload dall'app smette di funzionare; si rigenera e si aggiorna il Secret.
- **Nell'app**: la costante `CAT_SERVIZIO` (in `index.html`, blocco Cataloghi) contiene l'indirizzo del Worker, oggi
  `https://cataloghi.webmalfer.workers.dev` (Worker `cataloghi` nell'account Cloudflare di Manuel, Workers & Pages); vuota =
  funzione spenta e pulsante nascosto.
- Prove fatte in locale: il vero codice del Worker con un finto GitHub (43 casi: login scaduto/falso/di altro progetto,
  email non abilitata, nomi file non validi, doppioni, troppo grande, conflitti sull'elenco, nessun segreto nelle risposte) e
  l'app completa con finto Firebase: caricamento, voce nell'elenco, file decifrabile, riapertura dal "sito", PDF finto rifiutato,
  titolo doppio (suffisso `-2`), account non autorizzato (nessun pulsante), servizio spento (messaggio e "Riprova").
- Sposta categoria ed elimina: icona cartella sulla riga (solo account autorizzati). Non c'è ancora la modifica di titolo/descrizione: si fa dal PC (`cataloghi.json`) o chiedendo a Claude. Un catalogo eliminato resta nella cronologia Git (cifrato).

### Lettore PDF dei cataloghi

Toccando un catalogo del sito (percorso locale `cataloghi/…`, cifrato o no) si apre un lettore a tutto schermo (`#pdfv`, codice
`lp*`/`LP` in `index.html`) con **pdf.js 3.11.174** (stesso script dei Preventivi, caricato solo al bisogno da cdnjs):
scorrimento continuo, zoom 50–400% (pizzico, doppio tocco, pulsanti −/+, Ctrl+rotella; il numero % riporta a 100%),
numero di pagina modificabile con avanti/indietro, **ricerca nel testo** con evidenziazione in giallo e risultato
attivo in arancione (nei PDF fatti solo di immagini, come Demetra, la ricerca non è possibile e l'app avvisa),
condivisione e "Apri originale". Il tasto Indietro del telefono chiude il lettore (`history.pushState`).

- Le pagine si disegnano solo se vicine alla schermata (circa 1 schermata sopra e sotto) e si liberano quando si
  allontanano: così reggono anche i cataloghi da 150 pagine. Canvas limitati a ~9 milioni di pixel (memoria iPhone).
- PDF non cifrati: si scaricano a pezzi (range requests, `disableAutoFetch`). PDF cifrati (tutti quelli veri): si
  scarica il file intero (con percentuale), si decifra in memoria e si passa a pdf.js come dati; un file da 23 MB
  si apre in circa 1,5 secondi.
- I link esterni (`https://…`, es. Drive) NON usano il lettore (CORS): restano un normale collegamento. Se pdf.js
  non si carica (offline) compare "Non riesco ad aprire il catalogo qui" con il pulsante "Apri il PDF".
- Per provarlo in locale senza login: copiare il progetto in una cartella di prova, sostituire i tre import Firebase
  con piccoli moduli finti (utente sempre collegato, Firestore in `localStorage`), cifrare 3-4 PDF di prova con lo
  strumento (`CATALOGHI_SENZA_APPUNTI=1`) e servire la cartella con un server che supporti `Range` e dia `text/javascript`
  ai `.js`. Così si prova anche "Attiva i cataloghi" senza toccare il vero account.

## Versioni dell'app (tag Git)

- **v1** = interfaccia precedente al rinnovo (barra in basso con 8 schede a scorrimento, elenco clienti a righe, categorie dei
  cataloghi come etichette). Tag Git `v1`.
- **v2** = rinnovo dell'interfaccia del 18/11/2026 (sezione "Interfaccia" qui sotto). Tag Git `v2`.
- **v3** = v2 + mappa delle zone più grande su iPad/iPhone + **versione per PC** (sezione "Versione per PC"). Tag Git `v3`.
- **v3.1** = v3 + nuovo **Giro** (mappa verde/gialla, niente elenco consegne, ordini con spunta). Tag Git `v3.1`.
- **v3.3** = v3.2 + periodo di chiusura dei clienti, "+" tolto dal Giro, più aria sotto filtri e ricerca, riga dei Preventivi sistemata, **sposta catalogo di categoria** dall'app (icona cartella sulla riga, solo account autorizzati; riusa POST /elenco del Worker, che sostituisce la voce con lo stesso `file`). Brochure Carni spostata in Marchi S.p.A. Tag Git `v3.3`; la scritta in Riepilogo dice 3.3.
- **v3.4** = v3.3 + **elimina catalogo** dall'app (finestra della cartella, pulsante Elimina; solo account autorizzati; percorso `POST /elimina {file}` del Worker: toglie la voce da `cataloghi.json` e cancella il `.enc`; **il Worker va ricaricato su Cloudflare** con il nuovo `strumenti/worker-cataloghi.js`, altrimenti l'app avvisa). Tag Git `v3.4`.
- **v4** = v3.4 con lo **stesso layout del PC anche su iPhone/iPad**: niente barra in basso, le 8 sezioni stanno in un **menu laterale a scomparsa** aperto dal tasto a tre lineette (`.menu-btn`, inserito da JS in ogni `.top-row h1`; velo `#menuVelo`; si chiude toccando una voce, il velo o Esc). Blocco CSS `/* ===== Menu a scomparsa (iPhone/iPad) ===== */`, attivo quando NON vale `(min-width:1100px) and (hover:hover) and (pointer:fine)`. Le regole di contenuto del PC (due colonne, mappa zone grande, ecc.) valgono ora da 1100 px in su anche senza mouse (iPad in orizzontale); sotto restano una colonna. Per tornare: `v3.4`. Tag Git `v4`.
- **v4.1** = v4 + sezione **Budget** (sotto) e Riepilogo con le schede allineate in cima su PC. Tag Git `v4.1`; la scritta in Riepilogo dice 4.1.
- **v4.2** = v4.1 + **target di categoria** (report Marchi per semestre) in Budget e fatturato per categoria nella scheda cliente (sezione Budget). Tag Git `v4.2`; la scritta in Riepilogo dice 4.2.
- **v4.3** = v4.2 + tasto **Collega** per i clienti dei report target senza scheda collegata. Tag Git `v4.3`; la scritta in Riepilogo dice 4.3.
- **v4.4** = v4.3 + Budget a **quattro schede** (Andamento, Target, Pressione, Provvigioni). Tag Git `v4.4`; la scritta in Riepilogo dice 4.4.
- **v4.5** = v4.4 + **unione delle schede doppie** (fatturazione + destinazione). Tag Git `v4.5`; la scritta in Riepilogo dice 4.5.
- **v4.6** = v4.5 + abbinamento manuale con ricerca tra destinazione e fatturazione. Tag Git `v4.6`; la scritta in Riepilogo dice 4.6.
- **v4.7** = v4.6 + nelle Provvigioni l'elenco per cliente mostrava tutti i clienti (poi cambiato in v4.8).
- **v4.8** = v4.7 con le Provvigioni: "Per cliente" mostra i primi 15 + **Mostra tutti**, "Per categoria" in un riquadro separato a fianco. Tag Git `v4.8`; la scritta in Riepilogo dice 4.8.
- **v4.9** = v4.8 + **una fatturazione con più destinazioni**. Tag Git `v4.9`; la scritta in Riepilogo dice 4.9.
- **v4.10** = v4.9 + si possono aggiungere altre destinazioni a una scheda **già unita** (caso Comune di Mori). Tag Git `v4.10`; la scritta in Riepilogo dice 4.10.
- **v4.11** = v4.10 + corretto il modulo cliente: toccando i giorni di ordine/consegna la schermata scorreva fino in fondo. Causa: l'input nascosto di `.day` era `position:absolute` senza un contenitore `position:relative` e finiva in fondo al modulo; ora `.day{position:relative}` e l'input sta dentro il pulsante. Tag Git `v4.11`; la scritta in Riepilogo dice 4.11.
- **v4.12** = v4.11 + la ricerca Clienti trova le schede unite anche per i codici (`codiceDest`, `codiceFatt`, `codiceReport`) e per i nomi che avevano prima (`altriNomi`; per le unioni vecchie si legge la riga di storico "Unita con la scheda «…»", `uniAlias`); sotto il nome le schede unite mostrano l'altro nome e i codici (`uniTag`). Tag Git `v4.12`; la scritta in Riepilogo dice 4.12.
- **v4.13** = v4.12 + **Annulla unione**. Tag Git `v4.13`; la scritta in Riepilogo dice 4.13.
- **v4.14** = v4.13 + **destinazioni collegate ma non unite**: la fatturazione è la scheda principale nell'elenco Clienti, con una freccia ▾ che apre le destinazioni come schede separate. Tag Git `v4.14`; la scritta in Riepilogo dice 4.14.
- **v4.15** = v4.14 + **pop-up di conferma prima di ogni eliminazione** ("Sei sicuro di voler eliminare …?"). Tag Git `v4.15`; la scritta in Riepilogo dice 4.15.
- **v4.16** = v4.15 + correzione dell'**import Excel**: una riga di fatturazione (es. ARIKI S.R.L., 1001090070) non viene più scambiata per una delle sue destinazioni collegate. Tag Git `v4.16`; la scritta in Riepilogo dice 4.16.
- **v4.17** = v4.16 + l'**import Excel non fonde più fatturazione e destinazione** nella stessa scheda e le **collega da solo**. Tag Git `v4.17`; la scritta in Riepilogo dice 4.17.
- **v4.18** = v4.17 + abbinamento fatturazione/destinazione con la **regola dei codici Marchi** e correzione delle schede create con il codice della fatturazione (caso ALPI). Tag Git `v4.18`; la scritta in Riepilogo dice 4.18.
- **v4.19** = v4.18 **senza più l'unione delle schede**: fatturazione e destinazione si possono solo **collegare** (richiesta di Manuel). Tag Git `v4.19`; la scritta in Riepilogo dice 4.19.
- **v4.20** = v4.19 + nella **Pressione** la vista **Anno** (tutti i mesi caricati sommati). Tag Git `v4.20`; la scritta in Riepilogo dice 4.20.
- **v5.0** = v4.20 + nuova pagina **Articoli** (tutto il catalogo prodotti di Marchi copiato da marchispa.it, con foto, categorie e ricerca). Tag Git `v5.0`; la scritta in Riepilogo dice 5.0.
- **v5.1** = v5.0 + Articoli con tasto **Indietro** in testa e vista **riquadri/elenco**; tasto **modalità chiara/scura** in basso a sinistra. Tag Git `v5.1`; la scritta in Riepilogo dice 5.1.
- **v5.2** = v5.1 + **preventivi dagli Articoli** (carrello negli Articoli, "+ Aggiungi da Articoli" nell'editor, prezzo proposto dai preventivi precedenti). Tag Git `v5.2`; la scritta in Riepilogo dice 5.2.
- **v5.3** = v5.2 + il **+ Articolo** del preventivo apre la finestra Articoli con **selezione multipla**; **foto piccola su ogni riga** del preventivo (anche nel PDF, con interruttore). Tag Git `v5.3`; la scritta in Riepilogo dice 5.3.
- **v5.4** = v5.3 + gli articoli aggiunti al preventivo vanno **da soli nella loro categoria** (non più in quella del "+" da cui si parte). Tag Git `v5.4`; la scritta in Riepilogo dice 5.4.
- **v5.5** = v5.4 + **schede tecniche** degli articoli (PDF cifrati su Cloudflare R2). Tag Git `v5.5`; la scritta in Riepilogo dice 5.5.
- **v5.6** = v5.5 + **più email per cliente**: nel modulo il tasto **+** accanto a Email aggiunge un altro campo (× per toglierlo). Si salvano sempre nel campo `email` come testo unico separato da ", " (compatibile con ricerca, import/export Excel, Rosario); nel modulo c'è un input nascosto `name=email` e le righe visibili `#emList .em-in` (`emRender`, `emValori`, `emSplit`). Nella scheda cliente ogni email è un collegamento e il tasto Email scrive a tutte. Tag Git `v5.6`; la scritta in Riepilogo dice 5.6.
- **v5.7** = v5.6 + **più categorie nei preventivi** (32 invece di 12), prese dai "capitoli" del listino Marchi (colonna Capitolo del file Provvigioni, es. A7 DROGHERIA, F6 UOVA, A9 ZUCCHERI E DOLCIF., B1 BEVANDE COLAZIONE): Uova, Gastronomia, Pasta fresca e ripiena, Pane e derivati, Linea rossa (pomodoro), Sott'aceti e sott'oli, Funghi conservati, Legumi e verdure al naturale, Creme e salse, Drogheria, Zuccheri e dolcificanti, Patate e derivati, Frutta secca, Frutta sciroppata, Bevande colazione, Confetture, Budini e cioccolato, Vini birre e liquori, Pulizia e igiene, Carta e monouso. Le 12 vecchie restano (i preventivi già fatti non cambiano). `PV_RULES` riscritte (regole prioritarie in testa); per gli articoli del catalogo `PVA_SICURE` (categorie Marchi da cui non si sposta: carni, pesce, salumi, latticini, uova, pasta fresca) e `PVA_SOLO` (Spezie, Creme e salse, Pasta e riso, Non food, Bevande: il nome può spostare solo verso alcune categorie); "senza zucchero"/"S/ZUCCHERO" non conta come zucchero; IVA 22% anche per Pulizia, Carta e monouso, Vini birre e liquori. Provato su tutti i 5.199 articoli (nessuno in "Altri prodotti"). Tag Git `v5.7`; la scritta in Riepilogo dice 5.7.
- **v5.8** = v5.7 + **Invia per email** nell'editor del preventivo: crea il PDF e apre la finestra `#dlgPvMail` dove si controllano e modificano destinatari (le email della scheda cliente collegata, `emSplit`), oggetto ("Offerta <cliente> del <data>") e testo (`pvMailTesto`, con validità e firma da "I tuoi dati"); "Vedi" apre il PDF. L'email parte dall'**app di posta di Manuel (Outlook)**, non da un servizio: sul PC "Apri in Outlook" scarica il PDF e apre `mailto:` già compilato (il PDF va trascinato nell'email), "Outlook sul web" apre `outlook.office.com/mail/deeplink/compose`; su iPhone/iPad (se `navigator.canShare` con file) "Invia con il PDF" apre il menu Condividi con PDF e testo già dentro e copia i destinatari negli appunti, "Senza allegato" usa `mailto:`. `pvMakePdf` ora usa `pvCreaPdf()` (crea il file senza mostrare nulla). Tag Git `v5.8`; la scritta in Riepilogo dice 5.8.
- **v5.9** = v5.8 + **Appuntamenti nel Giro**: sotto "Ordini da raccogliere" la sezione "Appuntamenti" (`giroRichiamiHTML`) mostra i richiami (`ricontattare`) del giorno scelto di clienti con **qualsiasi stato**, ordinati per ora; nel giorno corrente della barra (`giroData(todayIdx)`, la domenica è lunedì) anche quelli scaduti (data in rosso). Nessun filtro: Manuel li vuole sempre tutti (una prima versione con pillole per stato è stata tolta su sua richiesta). Tag Git `v5.9`; la scritta in Riepilogo dice 5.9.
- **v6.0** = v5.9 + nuovo stato **Cliente perso** (`CLIENTE PERSO`, viola) in `STATI` dopo Cliente: compare nelle pillole dei Clienti, nella scheda, nel modulo, nel Riepilogo e in Mappa (gruppo "Clienti persi", visibile di base, `ui.mapOn.persi`). Nel servizio Rosario (`Rosario/src/gemini.ts`, descrizione del campo `stato`) l'elenco degli stati va tenuto uguale. Tag Git `v6.0`; la scritta in Riepilogo dice 6.0.
- **v6.16** = v6.15 + **vista Giorno** nel Calendario: selettore **Mese / Giorno** nella barra (`[data-calv]`, `ui.calVista`, ricordato in `preferenze.calVista`); in vista Giorno le frecce e lo scorrimento col dito cambiano giorno (`calSposta`) e `calVistaGiorno` disegna una griglia con le ore (almeno 7–21, 60 px per ora, `CG_ORA`): impegni di iCloud/Google (colore del calendario), appuntamenti dei clienti con ora (arancione, 30 min) e ordini del giro con ora (verde, 15 min, sbarrati se raccolti), con icona 📞/💼; quelli che si sovrappongono stanno uno accanto all'altro (colonne `--k`/`--n`); in cima "Tutto il giorno", sotto "Senza orario" (appuntamenti in giornata, ordini senza orario HH:MM); linea rossa dell'ora attuale; la griglia si apre all'ora attuale (oggi) o al primo impegno. Toccare un blocco apre la finestra Appuntamento (stessi `data-evx`/`data-app`/`data-gir`). Tag Git `v6.16`.
- **v6.15** = v6.14 + correzione dell'errore "evento mancante" eliminando "Tre sapori": gli impegni iCloud copiati nell'app dalla versione vecchia del Worker non avevano il file (`h`). Ora il Worker li rilegge anche nel giro leggero se ne manca uno (`evPer[id].some(e => e.h === undefined)`), e l'app, se tocchi un impegno iCloud senza `h`, avvisa e lancia la sincronizzazione. Il Worker ha in testa `// @ts-nocheck` (l'editor di Cloudflare mostrava 28 avvisi di tipo TypeScript, innocui). Tag Git `v6.15`.
- **v6.14** = v6.13 + premendo **Elimina** la finestra Appuntamento si chiude subito (resta solo la conferma); gli errori della finestra restano visibili 10 secondi (`toast(msg, ms)`); nel Worker `eventoICloud` ritrova il file dell'evento anche se iCloud scrive il nome codificato diversamente. Segnalato da Manuel: errore eliminando "Tre Sapori" (messaggio non ancora visto). Tag Git `v6.14`.
- **v6.13** = v6.12 + nella finestra Appuntamento le **ferie del locale** (`chiusoDal`/`chiusoAl` della scheda, `evSalvaFerie`, riga nello storico; avviso se il giorno dell'appuntamento cade nelle ferie) quando l'appuntamento è di un cliente, e per gli impegni di iCloud/Google non collegati l'avviso "non collegato a nessun cliente" con il tasto **Collega** (cliente proposto per somiglianza del nome, `giroPunti`): un evento iCloud che si ripete ogni settimana entra nel giro (`/icloud/giro/abbina`); gli altri si ricordano in `utenti/{uid}/impostazioni/eventi_clienti` = `{mappa: {"g:<id o serie Google>" | "i:<UID iCloud>": idCliente}}` (`evChiave`) e mostrano "👤 Cliente" nella riga, le ferie e la Scheda cliente. Tag Git `v6.13`.
- **v6.12** = v6.11 + finestra **Appuntamento** nel Calendario (sezione "Finestra Appuntamento (v6.12)"): toccando un impegno di iCloud/Google, un appuntamento o un ordine del giro si cambiano nome, giorno, orario o si elimina, con le spunte 📞 telefono / 💼 di persona; per gli eventi che si ripetono "solo questa volta" o "tutte le settimane". Tag Git `v6.12`.
- **v6.11** = v6.10 + **giro dal calendario iCloud** (sezione "Giro dal calendario iCloud (v6.11)"): gli eventi ricorrenti di Manuel (📞 ordine al telefono, 💼 di persona) si abbinano ai clienti e giorni/ora/modo passano nei due sensi; niente doppioni nel Calendario; icona e ora del giorno nel Giro e nel Calendario. Tag Git `v6.11`.
- **v6.10** = v6.9 + **ricarica automatica alle 00:01** (blocco dopo `localISO`: `giornoAvvio`, `ricaricaSeNuovoGiorno`): un timer per le 00:01 del giorno dopo; se c'è una finestra (`dialog[open]`) o l'editor del preventivo aperti, o la pagina è in secondo piano, riprova ogni minuto; su iPhone/iPad (timer fermi quando l'app è in pausa) ricarica a `visibilitychange`/`pageshow` se il giorno è cambiato. Nello stesso commit la lettura più tollerante dei calendari iCloud nel Worker (`ICloud.calendari`: conta come calendario anche un elemento con VEVENT senza `resourcetype` calendar; scarta cartella principale, inbox/outbox/notification e i soli VTODO; rapporto `diag` più completo). Tag Git `v6.10`.
- **v6.9** = v6.8 + **rapporto tecnico** quando iCloud non mostra calendari (Worker: `ICloud.calendari` prepara `diag` con solo i nomi dei tag della risposta, l'errore "iCloud non mostra calendari. Dettagli per Claude: …" va nello stato `impostazioni/icloud.errore`; app: l'errore iCloud si vede sempre nel riquadro). Caso reale: con le credenziali di Rosario l'accesso riusciva ma il calendario "Lavoro" non compariva. Tag Git `v6.9`.
- **v6.8** = v6.7 + **iCloud nei due sensi** come Google (sezione "iCloud nei due sensi (v6.8)"): email Apple + password per app, scelta o creazione del calendario, impegni iCloud nel Calendario; gli appuntamenti vanno in **un solo** servizio (Google o iCloud). Tag Git `v6.8`; la versione nelle Impostazioni dice 6.8.
- **v6.7** = v6.6 + la scheda **Dati** del Riepilogo (Importa/Esporta Excel, Collega fatturazioni e destinazioni, account) è passata nelle **Impostazioni**; in "Collega fatturazioni e destinazioni" ogni voce ha **Ignora** (con "Mostra le voci ignorate" e Ripristina); nel **Calendario** il tasto **Nuovo** crea un **appuntamento** (non un cliente) e "Richiami" si chiama **Appuntamenti** (anche "Appuntamento il" nella scheda cliente e "Appuntamento gg/mm" sulle righe). Tag Git `v6.7`; la versione si legge ora nelle Impostazioni (6.7), non più nel Riepilogo.
- **v6.6** = v6.5 + **Impostazioni** (ingranaggio in basso a sinistra al posto del tasto sole/luna): account collegato con Esci, **tema** con scelta dello stile (**Classico** o **Livrea Marchi**) e della modalità (come il telefono / chiara / scura), **colori degli stati** dei clienti personalizzabili. Sezione "Impostazioni e stile Livrea Marchi (v6.6)". Tag Git `v6.6`; la scritta in Riepilogo dice 6.6.
- **v6.5** = v6.4 + nuova sezione **Reclami** (segnalazioni all'ufficio qualità con email scritta da Google Gemini, statistiche e report annuale; sezione "Reclami (v6.5)"). Tag Git `v6.5`; la scritta in Riepilogo dice 6.5.
- **v6.4** = v6.3 + sincronizzazione con Google **ogni minuto** (Cron Trigger `* * * * *`) con giro leggero nel Worker per non superare le letture gratuite di Firestore; nell'app la scritta dice "ogni minuto". Tag Git `v6.4`; la scritta in Riepilogo dice 6.4.
- **v6.3** = v6.2 + **Google Calendar nei due sensi** (sezione "Google Calendar nei due sensi (v6.3)"): permesso Google dall'app, scelta o creazione del calendario dei richiami, appuntamenti Google visibili nel Calendario dell'app. Tag Git `v6.3`; la scritta in Riepilogo dice 6.3.
- **v6.2** = v6.1 + tasto **Salva** nella scheda cliente (in basso, accanto a Modifica, che diventa secondario): stato, richiamo e chiusura si salvano già da soli; Salva conferma il campo ancora aperto, aggiunge allo storico la nota scritta ma non ancora aggiunta e chiude la scheda (`#dSalva`). Tag Git `v6.2`; la scritta in Riepilogo dice 6.2.
- **v6.1** = v6.0 + **Calendario** al posto di Richiami (mese con richiami e ordini del giro) e **collegamento a Google Calendar / iCloud** tramite il Worker
  `strumenti/worker-calendario.js` (sezione "Calendario (v6.1)"). Tag Git `v6.1`; la scritta in Riepilogo dice 6.1.
- **v3.2** = v3.1 con la mappa del Giro sulle consegne del **giorno dopo** e conteggi "ord." nella barra dei giorni. Tag Git `v3.2`. In
  Riepilogo (dalla v6.7 nelle Impostazioni), sotto l'email dell'account, compare "App versione 3.2 (v3.2)" (utile per capire se il dispositivo mostra ancora la versione vecchia; aggiornare
  la scritta a ogni nuova versione).
- **Tornare alla v2** (solo senza la parte PC): `git revert --no-edit <commit-di-v3>`. **Tornare alla v1** (se Manuel lo chiede): senza riscrivere la cronologia, con `git revert --no-edit <commit-di-v2>` (il commit
  a cui punta il tag `v2`) e push su `main`; il sito torna com'era e i dati non cambiano. Attenzione: i cataloghi aggiunti dall'app
  (commit "Cataloghi: aggiunto…") e le modifiche a `cataloghi.json` NON vanno persi, perché stanno in file diversi da quelli del
  rinnovo; verificare comunque con `git diff v1 HEAD --stat` prima del push. Per rivedere la v1 senza toccare nulla:
  `git checkout v1` (poi `git checkout main`).
- Per ogni nuovo grande cambio di aspetto o struttura: creare un tag (`v3`, …) *prima* di pubblicare.

## Interfaccia (rinnovata il 18/11/2026)

Obiettivo: stile **pulito e moderno alla iOS**, che entri bene su iPhone (provato a 375 px e 320 px, tema chiaro e scuro, nessuno
scorrimento laterale). Lo stile nuovo sta in un blocco CSS a fondo `<style>` delimitato da `/* ===== Aspetto moderno ===== */`
(sovrascrive le regole più vecchie sopra); variabili `--r-sm/--r-md/--r-lg` (raggi), `--sh1/--sh2` (ombre), `--glass`, `--tabbar`.

- **Barra in basso a 5 voci** con vetro sfocato e indicatore a pillola sulla voce attiva. La voce **Altro** (`data-view="altro"`,
  vista `#v-altro`) resta accesa quando sei in Mappa, Giro, Preventivi o Rosario; toccarla torna alla griglia. I riquadri hanno
  `data-go="vista"`. Il numero di proposte di Rosario compare sul riquadro (`#rosNum`) e sulla voce Altro (`#altroNum`);
  il numero dei richiami scaduti sulla voce Richiami (`#richNum`).
- **Clienti**: intestazione fissa solo con titolo, "Azzera" e ricerca; sotto, che scorre con l'elenco: **pillole dello stato** con
  conteggi (`#fStatoPills`; il vecchio `<select id="fStato">` resta nascosto per il resto del codice), filtri Località / Tipologia / Zone,
  mappa delle zone **compatta** (~130 px, chip su due righe che scorrono). Ogni cliente è una **scheda** (`rowHTML`): avatar con le
  iniziali colorato per stato, nome (fino a 2 righe), "Località · Tipologia", pillola dello stato e chip del richiamo con orologio
  (rosso se scaduto). Giro e Richiami usano lo stesso `rowHTML` (con `side` per l'orario).
- **Scheda cliente** (dialog): foglio arrotondato con maniglia su telefono, azioni a riquadri colorati (Chiama verde, WhatsApp,
  Email, Naviga), stato in barra, dati in un riquadro, richiami e storico.
- **Cataloghi**: prima schermata = **griglia di riquadri per categoria** con icona e colore (funzione `catStile`: la categoria si
  riconosce dalle parole del nome; categorie nuove → cartella grigia), più "Tutti i cataloghi". Dentro una categoria: titolo grande e
  tasto **‹ Categorie** per tornare. Scrivendo nella ricerca si vedono i risultati di tutte le categorie. Stato in `cat`
  (`cat.cat`, `cat.tutti`, `cat.q`).
- Provato con una copia dell'app con finto Firebase e 28 clienti inventati (vedi "Per provarlo in locale senza login"); altre schermate
  (Mappa, Riepilogo, Preventivi, Rosario) non sono state ridisegnate: solo ereditano intestazione, bottoni e campi nuovi.

## Versione per PC (v3)

Manuel usa l'app da iPad/iPhone e da PC Windows. Su iPad e iPhone resta la colonna con la barra in basso (la sua preferenza); sul PC
l'interfaccia cambia. Il blocco CSS è `/* ===== Versione PC ===== */`, dopo `Aspetto moderno`.

- **Quando si attiva**: `@media (min-width:1100px) and (hover:hover) and (pointer:fine)`. L'iPad, anche in orizzontale, ha il
  puntatore "grossolano" e NON la attiva (non si può provare con l'emulazione del browser: lì il mouse risulta "fine").
- **Menu laterale** fisso a sinistra (248 px) con **tutte e 8** le sezioni nell'ordine Clienti, Mappa, Giro, Richiami, Cataloghi,
  Preventivi, Riepilogo, Rosario (le 4 voci `.only-desk` stanno nello stesso `<nav class="tabs">`, nascoste su telefono; "Altro" è
  nascosto sul PC). `go()` accende sia la voce vera sia "Altro". Il numero di Rosario è anche in `#rosNumNav`.
- **Clienti**: elenco a sinistra, **mappa delle zone grande a destra** (460 px, sticky, tutti i chip visibili); il tasto "Zone" sparisce
  perché la mappa è sempre visibile e filtra l'elenco. Pulsante "+ Nuovo" in alto a destra (non più rotondo in basso).
- Altre schermate: contenuto fino a 1320 px; Giro, Richiami e Preventivi in 2 colonne; Cataloghi con griglia a 4 colonne e elenco in
  2 colonne; Riepilogo in 2 colonne bilanciate; Mappa a tutta altezza; finestre fino a 760 px; effetti al passaggio del mouse.
- Scorciatoia da tastiera: **/** porta alla ricerca della schermata aperta (Clienti, Cataloghi, Preventivi).
- **Mappa delle zone su iPad/iPhone**: 176 px su telefono (<600 px), 300 px su iPad (≥600 px, chip su 3 righe).

## Articoli (v5.0)

Pagina **Articoli** nel menu (subito dopo Cataloghi): il catalogo prodotti di Marchi S.p.A. copiato dal sito pubblico **www.marchispa.it** (PrestaShop in
"modalità catalogo": **non ci sono prezzi**). Decisioni di Manuel: foto **copiate** nel repository (non caricate da marchispa.it) e dati **in chiaro** (il repository è
pubblico, ma sono già pubblici sul sito di Marchi).

- **Scaricamento**: `node strumenti/articoli-marchi.mjs` (dal PC, cartella del progetto; nessuna libreria). Legge la sitemap pubblica `/1_index_sitemap.xml` → `1_it_0_sitemap.xml`
  (≈5.400 prodotti con nome e foto, ≈500 categorie), apre ogni pagina di categoria (nome e percorso dal breadcrumb) e ogni pagina prodotto (codice "Cod. XXXXX", nome h1,
  descrizione breve `product-description-short`, descrizione, marca se c'è, categoria principale dal breadcrumb), scarica la prima foto in formato **medium_default** (~30 KB)
  in `articoli/img/<id>.jpg` e scrive `articoli.json`. Va piano apposta (3 richieste alla volta, 250 ms di pausa: circa 30–40 minuti) e rispetta robots.txt. Riprende da dove
  si era fermato grazie alla memoria in `strumenti/.cache-articoli/` (in .gitignore); `--nuovo` rilegge tutte le pagine; `LIMITE=20` per una prova veloce.
  **Per aggiornare il catalogo** (nuovi articoli, foto cambiate): rilanciare lo strumento e fare commit + push di `articoli.json` e `articoli/img/`.
- **Primo scaricamento (19/11/2026)**: 5.199 articoli, 28 categorie, 445 sottocategorie, 4.447 foto (105 MB); 752 articoli non hanno foto nemmeno sul sito di Marchi (immagine generica `it-default`) e nell'app mostrano un'icona; 3 senza codice. Durata circa 35 minuti.
- La sottocategoria si ricava dal link del prodotto (es. `/sughi/5462-….html`); se due categorie hanno lo stesso nome (es. "Sughi" sotto Oli e condimenti e sotto Surgelati)
  si sceglie quella sotto la categoria principale del prodotto.
- `articoli.json` = `{ agg, fonte, top:[categorie principali], sub:[{n: nome (percorso), t: indice categoria}], a:[{ i: id prodotto, c: codice, n: nome, t, s (-1 = nessuna), b: descrizione breve, d: descrizione, m: marca, f: 0 se senza foto }] }`.
- **Nell'app** (`art*`): prima schermata = riquadri delle categorie (stile Cataloghi, `catStile`); dentro una categoria pillole delle sottocategorie; elenco a schede con foto
  (`loading="lazy"`), nome, codice; 60 per volta con "Mostra altri". **Ricerca** su codice (anche senza zeri iniziali: "1205" trova 01205), nome, descrizioni, marca e
  categorie, per pezzi di parola; prima i codici uguali e i nomi che iniziano con la parola cercata. Dentro una categoria la ricerca resta nella categoria ("Cerca in tutto il
  catalogo" per uscire). Dettaglio (`#dlgArt`): foto grande, codice con **Copia**, categoria, descrizioni, "Apri su marchispa.it" (`index.php?id_product=…&controller=product`).
  Tasto **/** porta alla ricerca anche qui.
- **v5.1**: dentro una categoria il tasto **‹ Indietro** sta nella testa fissa (`#arChips`, resta visibile scorrendo) e riporta alle categorie. In testa due tasti per la
  **vista a riquadri** (foto grandi) o **a elenco** (righe con miniatura, codice, marca e sottocategoria; su PC in due colonne): la scelta si ricorda nell'account
  (`preferenze.articoliVista`).

### Preventivi dagli Articoli (v5.2)

Riusa l'editor dei Preventivi (stesso PDF finale); blocco `pva*` in `index.html`.
- **Carrello negli Articoli**: ogni articolo (riquadri, elenco, dettaglio) ha il tasto **+** (`data-arsel`, diventa ✓); `art.sel` = id scelti in ordine. In basso la barra
  `#arCart` "N articoli scelti · ✕ · **Crea preventivo**" (resta cambiando categoria o ricerca; ✕ svuota con conferma). **Crea preventivo** chiede il cliente
  (`pvOpenPicker("art")`, anche "Continua senza cliente") e apre l'editor già pieno (`pvaCrea`); se si è partiti dalla scheda cliente ("Preventivi → **Dagli articoli**",
  `art.cliente`) il cliente è già deciso. Anche in Preventivi c'è "+ Dagli articoli" in testa.
- **Nell'editor**: tasto **+ Aggiungi da Articoli** (`#pvaBtn`, finestra `#dlgPvArt`): ricerca nel catalogo (stessa `artTrova` della pagina Articoli, da 2 lettere, primi 40),
  tocco = aggiunge l'articolo nella sua categoria; quelli già nel preventivo hanno ✓. Funziona anche sui preventivi nati dal PDF del gestionale.
- **Riga dal catalogo** (`pvDaArticolo`): codice e nome dal catalogo, nome pulito con `pvPrettyName`, formato con `pvFormat`, contenitore `pvContainer` (stesse regole
  del PDF); **categoria automatica** (v5.4): (1) gelati, sorbetti, semifreddi, tiramisù, croissant, brioche, cornetti, muffin, torte, crostate → sempre "Dolci e forno"
  (regex con ``, perché "SURGELATO" contiene "GELAT"); (2) per le categorie Marchi generiche (Non food, Oli e condimenti, Surgelati, Gastronomia pronta, Snack vari,
  Finger e dessert) decide prima il nome (`pvGuessCat`); (3) altrimenti la categoria Marchi (`PVA_CAT`); (4) infine vale la categoria corretta a mano in passato per quel codice (`pvApplyLearned`); IVA 22% per Non food, altrimenti 10%;
  "al kg" per carni e pesce freschi, salumi, formaggi stagionati (`PVA_AL_KG`), altrimenti "al pz"; poi le correzioni ricordate per codice (`pvApplyLearned`).
- **Prezzo proposto** (`pvaUltimo`): nessun dato in più salvato, si cerca nei preventivi già fatti (`preventivi`): prima l'ultimo prezzo dato **a quel cliente** per quel
  codice, altrimenti l'ultimo usato con chiunque (con unità, IVA e peso). L'editor dice quanti prezzi vengono dal cliente, quanti dall'ultimo uso e quanti sono da compilare.
  Marchi non pubblica prezzi: senza preventivi precedenti il prezzo resta vuoto.
- **v5.3 – finestra Articoli nell'editor** (`pvaApri(cat)`, stato `pva`): si apre dal **+ Articolo** di ogni categoria del preventivo, dal tasto "Aggiungi" del pannello e da
  "+ Aggiungi da Articoli". Senza ricerca mostra le categorie Marchi (in cima quelle che corrispondono alla categoria del preventivo, via `PVA_CAT`), dentro una categoria
  gli articoli (80 per volta); con 2+ lettere cerca in tutto il catalogo. Tocco = seleziona/deseleziona (✓, verde), anche più articoli e da categorie diverse; **Aggiungi N
  articoli** li mette nel preventivo, **ognuno nella sua categoria** (dalla v5.4; il "+" da cui si parte serve solo a mettere in cima le categorie Marchi giuste); **Articolo a mano** aggiunge la riga vuota come prima.
- **v5.3 – foto nelle righe** (`pvFoto(it)`): colonna da 44 px tra codice e nome; la foto è quella dell'articolo del catalogo con lo **stesso codice scritto nella riga**
  (`art.perCodice`, anche senza zeri iniziali), quindi vale anche per i preventivi nati dal PDF del gestionale; se il codice si cambia a mano la foto si aggiorna uscendo dal
  campo. L'editor carica il catalogo da solo all'apertura. Il PDF aspetta che le foto siano caricate prima della cattura (html2canvas, stesso sito). Interruttore
  **"Foto degli articoli nel preventivo"** nel pannello (`pvCur.foto`, di base sì; spento = classe `pv-nofoto`, colonna nascosta). Il tasto del tema si nasconde a editor aperto.
- Provato con finto Firebase, due preventivi finti e il catalogo vero: prezzo del cliente (18,50) preferito a quello più recente di un altro cliente (20), ultimo prezzo
  generale (9,90), articolo nuovo vuoto; "Aggiungi da Articoli" con guanti in Non food al 22%.

### Schede tecniche (v5.5)

Manuel ha le schede tecniche Marchi in PDF sul Desktop, cartella **"schede tecniche"** con 8 sottocartelle (MARCHI SPA _ ALIMENTARE GELO, NON FOOD, ALIMENTARE SECCO,
CARNE, ITTICO GELO, SALUMI E LATTICINI, ALIMENTARE FRESCO, BEVANDE): ~4.070 PDF, 1,3 GB; il **nome del file è il codice articolo** (es. `01205.pdf`).
- **Abbinate al catalogo**: 2.746 codici (≈ 880 MB cifrati): troppi per GitHub Pages (limite 1 GB del sito, già ~330 MB usati), quindi stanno su **Cloudflare R2**
  (scelta di Manuel), bucket `schede-tecniche`, letti dall'indirizzo pubblico `https://schede.malfer.it/<codice>.pdf.enc` (dominio collegato al bucket, CORS solo per clienti.malfer.it).
  **Cifrati** come i cataloghi (stessa chiave, AES-GCM, 12 byte iv + testo): chi ha il link scarica byte illeggibili.
- **Strumento** `node strumenti/schede-tecniche.mjs`: sceglie i file (ignora `-old`, `-old2`, `-temp`; "12044-12045.pdf" vale per i due codici; "13942-1.pdf" solo se manca
  13942.pdf; stesso codice in due cartelle → il più recente; solo codici presenti in `articoli.json`), cifra in `cataloghi-originali/schede-enc/`, carica su R2 con l'API S3
  (firma AWS v4 scritta a mano, 4 alla volta) e scrive **`schede.json`** nella radice del sito = `{agg, base, codici:[…]}`. Carica solo le schede nuove o cambiate
  (`cataloghi-originali/schede-caricate.json`). Credenziali R2 in `cataloghi-originali/r2.json` (`accountId`, `accessKeyId`, `secretAccessKey`, `bucket`, `pubblico`; cartella in
  .gitignore, mai su GitHub). `--cifra` solo cifratura, `--prova` carica una scheda e controlla lettura e CORS. **Per aggiornare**: rilanciare lo strumento e pubblicare `schede.json`.
- **Nell'app**: `schede.json` si legge con `articoli.json` (`art.schede`, `art.schedeBase`; se manca, nessuna scheda). Negli Articoli gli articoli con scheda hanno l'etichetta
  "scheda tecnica"; nel dettaglio il tasto **Scheda tecnica** (`artScheda`) apre il PDF nel lettore dei cataloghi (`catApri` con `file` = indirizzo R2, decifrato in memoria).
  `catEnsureKey` ora legge da sé `cataloghi/cifratura.json` se la pagina Cataloghi non è ancora stata aperta (prima falliva aprendo una scheda dagli Articoli).
- Provato in locale con un finto R2 (server sul PC) e la chiave vera: la scheda 01205 si apre decifrata nel lettore.

## Calendario (v6.1)

La sezione **Richiami** si chiama ora **Calendario** (voce del menu/barra, stessa vista `#v-richiami`).
- **Nell'app**: barra con ‹ mese ›, "Oggi" e la pillola rossa "N scaduti"; griglia del mese (lun–dom, `renderCalendario`) dove ogni giorno mostra il numero di
  **richiami** (arancione, da `ricontattare`) e di **ordini del giro** (verde, `calOrdini`: clienti con quel giorno in `giorniOrdine`, non chiusi); da 700 px si
  vedono anche i nomi dei primi due richiami. Toccando un giorno, sotto (a destra su PC) il dettaglio: richiami scaduti (solo su oggi), richiami del giorno con l'ora,
  ordini del giro (con "✓ raccolto" se spuntato nel Giro). Scorrimento a destra/sinistra sul mese = mese dopo/prima. Stato in `ui.calMese` / `ui.calSel`.
- **Collega a Google Calendar / iCloud** (`#dlgCal`, `calApri`): calendario **sottoscritto** in una direzione (l'app scrive, il calendario mostra). L'app crea un
  codice segreto casuale e lo salva in `utenti/{uid}/impostazioni/calendario` = `{token, giro, creato}`; il link è `CAL_SERVIZIO/cal/<uid>/<token>.ics`
  (`CAL_SERVIZIO` = `https://calendario.webmalfer.workers.dev`). Pulsanti: iPhone/iPad/Mac (`webcal://`, si sceglie l'account iCloud), Google Calendar
  (`calendar.google.com/calendar/r?cid=webcal://…`), Copia link (Outlook ecc.), interruttore "Metti anche i giri", **Crea un nuovo link** (il vecchio smette di
  funzionare), "Scarica i richiami (.ics)" (il vecchio export una tantum). Se `/ping` non risponde la finestra lo dice e resta solo lo scaricamento.
- **Servizio** `strumenti/worker-calendario.js` (Cloudflare Worker `calendario`): legge Firestore con la chiave di servizio (Secret `SERVICE_ACCOUNT` = contenuto
  del JSON della chiave di servizio Firebase del progetto clienti-malfer, la stessa di Rosario) e risponde con il file .ics: richiami dagli ultimi 60 giorni in
  avanti (30 min con avviso 15 min prima se c'è l'ora, altrimenti tutto il giorno; ora di Roma con VTIMEZONE) e, se `giro` non è false, un evento di tutto il giorno
  "Giro: N ordini" per ogni giorno con ordini (dalla settimana scorsa a 8 settimane avanti, nomi nella descrizione). Token sbagliato o mancante = 404.
  Google aggiorna i calendari sottoscritti ogni qualche ora (non si può forzare); Apple più spesso.
- Prove fatte: Worker con finto Firestore (18 casi: token giusto/sbagliato/mancante, altro utente, più pagine di clienti, giro spento, cliente chiuso, domeniche,
  righe ≤ 75 byte, Firestore irraggiungibile = 503); app con finto Firebase (griglia, giorno, mesi, finestra, nuovo link, link Google).

## Reclami (v6.5)

Sezione **Reclami** (menu, e riquadro in "Altro"; vista `#v-reclami`, codice `rc*` in `index.html`, blocco "Reclami (v6.5)"). Serve a mandare all'**ufficio qualità
di Marchi (qualita@marchispa.com)** le segnalazioni dei clienti, nello stile delle email vere di Manuel (brevi, cliente con "cod.", articoli con "cod.", "Attendo gentile
riscontro"), e a tenerne il conto.
- **Nuovo reclamo** (`#dlgRc`, pulsante Nuovo in basso nella sezione, oppure "Nuovo reclamo" nella scheda cliente): 1) **cliente** cercato come negli altri selettori;
  l'app prende il codice (`codice`, se manca `codiceFatt` o `codiceReport`), lo mostra modificabile e lo **copia negli appunti** (tasto Copia); 2) **prodotti** dal catalogo
  Articoli (riusa la finestra `#dlgPvArt` dei preventivi: `pvaApri(null, "rc")`, `pva.dest`) o "Articolo a mano", con quantità, lotto e scadenza facoltativi;
  3) **tipologia** (più di una: `RC_TIPI` = prodotto alterato/avariato, non conforme alla descrizione o scheda tecnica, lavorazione errata o non effettuata, merce mancante
  o consegna parziale, danneggiata nel trasporto, scadenza breve o superata, catena del freddo interrotta, corpo estraneo, peso/calibro, etichettatura, articolo sbagliato,
  confezione difettosa, altro) e **cosa chiedere** (`RC_RICH`: verifica e riscontro, nota di credito, sostituzione, ritiro e nota di credito, solo segnalazione);
  4) "Descrivi brevemente cosa è successo" e **foto** (restano solo in memoria per allegarle, NON si salvano); 5) **email** (A, CC, oggetto, testo, tutti modificabili);
  6) **stato** Aperto/Chiuso con l'esito.
- **Testo con l'IA**: "Scrivi l'email con l'IA" chiama il Worker `strumenti/worker-reclami.js` (Cloudflare, `RC_SERVIZIO` = `https://reclami.webmalfer.workers.dev`),
  che controlla il login Firebase e l'email abilitata (come il Worker dei cataloghi) e chiede il testo a **Google Gemini** (scelta di Manuel; modelli in ordine
  `gemini-3.5-flash, -lite, 3.6, 3.8` come Rosario; JSON {oggetto, testo}). Segreti del Worker: `GEMINI_API_KEY`, `ALLOWED_EMAILS`; variabili `FIREBASE_PROJECT` =
  clienti-malfer, `ALLOWED_ORIGINS` (facoltativa), `GEMINI_MODELLI` (facoltativa). **Ripiego senza IA**: se il servizio non risponde (o non è ancora creato) l'app
  scrive l'email con il modello `rcModello` (marcatori `RCMOD-START/END`) e lo dice. Nel piano gratuito Google può usare i testi inviati (nomi e codici dei clienti) per
  migliorare i suoi prodotti: Manuel lo sa e l'ha scelta lo stesso.
- **Invio** come i preventivi (v5.8), sempre dall'app di posta di Manuel: PC "Apri in Outlook" (`mailto:` con cc) o "Outlook sul web" (deeplink con cc); su
  iPhone/iPad con foto "Invia con le foto" (menu Condividi con foto e testo, l'indirizzo A copiato negli appunti) o "Senza foto" (`mailto:`). Inviando, il reclamo si salva
  come "inviato" e (la prima volta) il cliente riceve una riga nello storico "Reclamo all'ufficio qualità: …".
- **Impostazioni** (tasto in testa, `#dlgRcSet`): A (di base qualita@marchispa.com), CC sempre (es. il responsabile), CC in più per merce mancante/danneggiata/sbagliata
  (es. logistica, `RC_LOG`), firma (di base nome e telefono di "I tuoi dati" dei preventivi + "Agente di Zona"). Salvate in `utenti/{uid}/impostazioni/reclami`
  = `{a, cc, ccLog, firma}`: **gli indirizzi dei colleghi non vanno nel repository**.
- **Dati**: `utenti/{uid}/reclami/{id}` = `{data, clienteId, cliente, codice, luogo, prodotti:[{i, c, n, qta, lotto, scad, man}], tipi:[…], richiesta, descrizione, foto (numero),
  email:{a, cc, ogg, testo}, ia, inviato, stato: "aperto"|"chiuso", chiuso, esito, creato, aggiornato}`. **Regole Firestore**: se le regole non coprono già tutto `utenti/{uid}/…`, serve la regola per
  `utenti/{uid}/reclami` (read, write, stessa condizione di `clienti`), altrimenti il salvataggio dà "Account non autorizzato".
- **Elenco**: pillole Aperti / Chiusi / Tutti, ricerca (cliente, codice, articoli, tipologia, descrizione), etichetta "Da inviare" / "Inviato" / "Chiuso"; numero dei reclami
  aperti sul riquadro e nel menu (`#rcNum`, `#rcNumNav`). Eliminazione con `confermaElimina`.
- **Statistiche**: scelta dell'anno, riquadri (reclami, aperti, clienti coinvolti), grafico mese per mese (`bdgBarre`), poi per periodo (anno o mese) **tipologie**, **articoli
  più segnalati** (per codice, con quanti clienti) e **clienti** (toccandoli si apre la scheda); `rcAggrega`. **Report annuale**: PDF fatto con jsPDF (testo e tabelle, non
  html2canvas: riepilogo, mesi, tipologie, articoli, clienti, elenco completo) e Excel (SheetJS: fogli Reclami, Per mese, Per tipologia, Per articolo, Per cliente). Su
  iPhone il PDF esce dal riquadro "PDF pronto" dei preventivi (Condividi).
- Prove: Worker vero con finto Gemini e finto login Google (16 casi: senza login, origine, email non abilitata, token falso, prompt con codici/lotto/firma, primo modello
  sparito, Gemini giù = 503, troppo lungo, 30 articoli al massimo); app con finto Firebase (scelta cliente e copia codice, articoli dal catalogo, tipologie e CC della
  logistica, email dall'IA e dal modello di ripiego, invio Outlook sul web e menu Condividi con foto, storico del cliente, statistiche, PDF e Excel, scheda cliente,
  eliminazione, chiusura senza salvare, iPhone 375 px chiaro e scuro, preventivi dagli articoli ancora funzionanti).

## Google Calendar nei due sensi (v6.3)

Richiesta di Manuel: usare il suo Google Calendar esistente, con le modifiche che passano in entrambe le direzioni (il link .ics sottoscritto della v6.1
veniva aggiornato da Google solo ogni 8–24 ore). Il link .ics resta per iPhone/iCloud e altri calendari (sola lettura).
- **Servizio** `strumenti/worker-calendario.js` (stesso Worker `calendario`): OAuth Google (scope `calendar` + `openid email`, `access_type=offline`,
  `prompt=consent`), stato firmato HMAC con `GOOGLE_CLIENT_SECRET` (15 minuti), pagina di ritorno `/google/ritorno` che mostra "collegato" con il tasto
  "Torna all'app". Il permesso (refresh token) sta in `calendario_segreti/{uid}`, una raccolta che le regole di Firestore NON fanno leggere all'app (nessuna
  regola = negato); lo legge solo il servizio con la chiave di servizio. Segreti del Worker: `SERVICE_ACCOUNT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  Cron Trigger `* * * * *` (ogni minuto, scelta di Manuel). **Attenzione alle quote gratuite di Firestore** (50.000 letture al giorno): il cron fa un
  giro **leggero** (`{ leggero: true }`: legge da Google le modifiche e da Firestore, con `:batchGet`, solo i clienti degli eventi cambiati; riscrive
  `gcal_eventi` solo se l'impronta `evHash` cambia) e un giro completo solo allo scoccare di ogni ora. Mai rileggere tutti i clienti a ogni minuto.
- **Sincronizzazione** (`sincronizza`): (a) legge da Google le modifiche dal `syncToken` precedente (con 410 riparte da capo); un evento dell'app spostato in
  Google sposta il richiamo del cliente, uno cancellato lo toglie (riga nello storico "Richiamo spostato/tolto da Google Calendar"), ma solo se nell'app il
  richiamo non è cambiato nel frattempo (altrimenti vince l'app); (b) dall'app a Google: crea, aggiorna (PUT) o toglie gli eventi "Richiamare: <nome>"
  (30 min con avviso 15 min se c'è l'ora, altrimenti tutto il giorno; richiami più vecchi di 60 giorni non si creano); al massimo 25 scritture per giro, il resto
  al giro dopo; (c) copia gli appuntamenti dei calendari scelti da vedere (massimo 4, da 14 giorni fa a 120 giorni avanti, esclusi gli eventi dell'app) in
  `utenti/{uid}/impostazioni/gcal_eventi`; (d) salva mappa cliente→evento (`mappa`, con `k` = "data|ora" scritto in Google) e stato per l'app in
  `impostazioni/gcal`. **Un evento per cliente con id fisso** (`"cl" + base32hex(idCliente)`): se la mappa si perde, la creazione dà 409 e l'evento si riusa
  con PUT, quindi niente doppioni. Cambiando calendario gli eventi si tolgono dal vecchio e si creano nel nuovo.
- **Quando**: l'app chiama `/google/sincronizza` 2,5 secondi dopo che QUESTO dispositivo ha cambiato data/ora/nome di un richiamo o eliminato un cliente
  (`snap.metadata.hasPendingWrites` nello snapshot dei clienti, `gcPresto`); le modifiche fatte in Google arrivano con il cron (entro 1 minuto) o con
  "Sincronizza ora". I giri NON vanno su Google (scelta di Manuel).
- **Nell'app**: finestra `#dlgCal` con due riquadri. "Google Calendar nei due sensi": Collega (apre Google in una nuova finestra), account collegato, menu del
  calendario dei richiami (calendari scrivibili + "Crea un nuovo calendario…"), spunte dei calendari da vedere, stato/ultima sincronizzazione/errore,
  "Sincronizza ora", "Scollega Google" (revoca il permesso; gli eventi già creati restano in Google). "iPhone / iCloud e altri calendari": il link .ics di prima.
  Nel Calendario gli appuntamenti Google sono un numero blu nella griglia (con i titoli da 700 px) e la sezione "Appuntamenti Google" nel giorno scelto
  (tocco = apre l'evento in Google).
- **Configurazione Google** (una volta, console Google Cloud, progetto clienti-malfer): Google Calendar API attivata; schermata di consenso esterna e
  **pubblicata** (in "Test" il permesso scade dopo 7 giorni); client OAuth "Applicazione web" con URI di reindirizzamento
  `https://calendario.webmalfer.workers.dev/google/ritorno`. L'app non è verificata da Google: al collegamento compare l'avviso, si va avanti con
  Avanzate › Vai a….
- Prove: Worker con finto Google + finto Firestore + login Firebase firmato (36 casi: permesso, stato falsificato, creazione/aggiornamento/rimozione, spostamento
  e cancellazione in Google, conflitto, cliente eliminato, memoria persa senza doppioni, syncToken scaduto, cambio calendario, 32 richiami a rate, cron, permesso
  revocato, scollega, link .ics); app con finto Firebase (griglia e giorno con eventi Google, finestra, scelta/creazione calendario, sincronizzazione dopo un cambio).

## iCloud nei due sensi (v6.8)

Richiesta di Manuel: lo stesso collegamento di Google anche con il Calendario di iCloud. Apple non ha OAuth: si usa **CalDAV** (`caldav.icloud.com`) con
l'email del suo account Apple e una **password per app** (creata da lui su account.apple.com › Accesso e sicurezza › Password per le app).
- **Servizio** (stesso Worker `strumenti/worker-calendario.js`, sezione "3) iCLOUD", classe `ICloud`): scoperta `current-user-principal` →
  `calendar-home-set` (es. `https://pNN-caldav.icloud.com/<id>/calendars/`), elenco calendari con PROPFIND Depth 1 (solo quelli con VEVENT; sola lettura
  se manca il privilegio write; colore Apple; `getctag`), `MKCALENDAR` per crearne uno nuovo, `PUT`/`DELETE` di `clienti-<idCliente>.ics` (un file
  per cliente, UID `clienti-<id>@clienti.malfer.it`, `X-CLIENTI-ID`, 30 min con avviso o tutto il giorno, ora di Roma), modifiche con `sync-collection`
  (RFC 6578; token non valido → si riparte da capo) + `calendar-multiget`, impegni da mostrare con `calendar-query` con `expand` (ricorrenze già espanse).
  XML letto con espressioni regolari (nei Worker non c'è DOMParser). Le stesse regole di Google: spostato/cancellato sull'iPhone → cambia la scheda (riga
  "Appuntamento spostato/tolto da iCloud"), ma vince l'app se è cambiato anche lì.
- **Dati**: `calendario_segreti/{uid}.icloud` = `{user, pass, home, calId, calNome, mostra[], calendari[], mappa:{idCliente:{ev: percorso del file, k}}, syncToken,
  ctag:{url: ctag}, ev:{url: [impegni]}, evHash, pulizia[]}` (solo il servizio lo legge); per l'app `utenti/{uid}/impostazioni/icloud` (stato) e `icloud_eventi`.
  Percorsi: `POST /icloud/collega` `{user, pass}` o `{rosario: true}` (riusa `rosario_segreti/{uid}` se è `tipo: "icloud"`), `/icloud/scegli`, `/icloud/scollega`,
  `/icloud/sincronizza`. `/google/sincronizza` e il cron fanno **tutti e due** i servizi (`sincronizzaTutto`, un solo errore non ferma l'altro: le risposte hanno
  `errori: [{servizio, stato, msg}]`).
- **Un solo servizio per gli appuntamenti**: scegliendo il calendario in iCloud si tolgono da Google (e viceversa); dall'altro si vedono solo gli impegni.
  **Pulizia a rate**: quando si cambia calendario o servizio, gli eventi vecchi si tolgono 25 per volta (`pulizia` nel documento segreto, sia per Google sia per
  iCloud), il resto ai giri successivi.
- **Giro leggero**: un solo PROPFIND dei calendari per minuto; `sync-collection` e `calendar-query` solo per i calendari con `getctag` cambiato; da Firestore solo i
  clienti toccati. Il documento segreto si legge una volta per giro (`opz.S`).
- **Nell'app**: in `#dlgCal` il riquadro "iCloud (iPhone, iPad, Mac) nei due sensi" (`icRender`, `#icOff`/`#icOn`, `#icUser`, `#icPass`, "Usa quella già data a
  Rosario", `#icCal`, `#icMostra`, `#icSync`, `#icStacca`); il terzo riquadro ora si chiama "Link per altri calendari (sola lettura)". Nel Calendario gli
  impegni di Google e iCloud stanno insieme ("Dai tuoi calendari", con "· Google"/"· iCloud"; pallino quadrato per iCloud). `gcPresto` parte se c'è un
  calendario scelto in Google **o** in iCloud.
- Prove: Worker con finto iCloud CalDAV (server sul PC con namespace come iCloud), finto Google, finto Firestore e login Firebase firmato: 71 casi (31 nuovi:
  password sbagliata, email non valida, Rosario senza/con iCloud, calendari VTODO/inbox/sola lettura esclusi, password non nello stato, impegni con TZID/UTC/tutto
  il giorno, nuovo calendario, passaggio da Google a iCloud e ritorno con pulizia a rate, spostamenti nei due sensi, conflitto, Fatto, cliente eliminato,
  sync-token non valido, password revocata con Google che continua, scollega iCloud con Google che resta); prove solo-Google (40) e link .ics (18) ancora tutte ok;
  app con finto Firebase (collega con password e con Rosario, scelta calendario, impegni dei due servizi nel giorno, legenda, sincronizzazione dopo un cambio).
- **Dopo la pubblicazione**: il codice del Worker `calendario` va incollato di nuovo su Cloudflare (nessun segreto nuovo: la password Apple la scrive Manuel nell'app).

## Giro dal calendario iCloud (v6.11)

Manuel aveva già il giro nel suo calendario iCloud: **un evento ricorrente ogni settimana per cliente**, con 📞 nel titolo quando fa l'ordine al telefono
e 💼 quando passa di persona. Scelta di Manuel: abbinarli ai clienti e tenerli allineati **nei due sensi**.
- **Dati**: nel cliente `giro` = `[{g: "Lunedì", ora: "09:30", modo: "telefono"|"visita"|"", ev: UID dell'evento}]` (una voce per giorno; un cliente può avere più
  eventi, es. telefono il lunedì e visita il giovedì). `giorniOrdine`/`orarioOrdine` restano quelli che l'app usa da sempre e vengono tenuti allineati.
  Nel documento segreto `icloud.giro` = `{UID: {cal, href, cliente, k, nome}}` (`k` = "giorni|ora|modo" scritto per ultimo) e `icloud.giroTok` (sync-token per
  calendario); per l'app `impostazioni/icloud.giro` = `{UID: {cliente, nome}}`.
- **Servizio** (`worker-calendario.js`, blocco "GIRO DAL CALENDARIO iCLOUD"): `ICloud.serie(cal)` legge le serie settimanali (calendar-query senza expand,
  `serieIcs`: giorni da BYDAY, ora di Roma anche da UTC, modo dall'icona, titolo senza icone, serie finite escluse); `POST /icloud/giro/eventi` (serie dei
  calendari da vedere + quello degli appuntamenti) e `POST /icloud/giro/abbina` `{voci: [{uid, href, cal, cliente}], togli: [uid]}`. Nella sincronizzazione
  (`b2`): da iCloud (sync-collection solo se il `getctag` del calendario è cambiato) serie spostata → `giroSuCliente` (storico "Giro cambiato da iCloud…"),
  serie cancellata → giorni tolti (storico); dall'app (giro completo, cioè dopo una modifica nell'app o ogni ora) `chiaveClienteGiro` ≠ `k` → `cambiaSerie`
  riscrive solo DTSTART/DTEND (stessa durata, primo giorno valido dopo l'inizio della serie, UTC se era UTC), BYDAY e l'icona del titolo, lascia il resto
  (promemoria, note, eccezioni) e salva con `If-Match`. Giorni nuovi aggiunti nell'app vanno al **primo** evento abbinato del cliente (l'ordine delle voci resta
  stabile); `orarioOrdine` HH:MM vale per l'ora solo se il cliente ha un solo evento. Se nell'app si tolgono tutti i giorni di un evento, l'evento si **scollega** e
  resta sull'iPhone (non si cancella mai una serie dal servizio). Gli eventi abbinati non compaiono più tra gli impegni iCloud dell'app.
- **Nell'app**: nel riquadro iCloud di `#dlgCal` il tasto **Collega il tuo giro** (`#icGiro`) apre `#dlgGiro`: una riga per serie (icona, nome, giorni, ora,
  calendario) con il cliente proposto per somiglianza del nome (`giroPunti`, soglia 55; parole come bar/ristorante/srl non contano) in un campo con elenco
  (`#dlGiroCli`, "Nome · Località · cod."); campo vuoto = non collegare (o scollegare). `giroOra(c, giorno)` mostra "📞 09:30" / "💼 15:00" nel Giro e negli
  ordini del Calendario. Cambiare giorni/orario dell'ordine di un cliente fa partire la sincronizzazione (`gcPresto`, `giroCollegato`).
- Limiti: una ripetizione singola spostata sull'iPhone (eccezione) non cambia la scheda; le serie ogni 2+ settimane si abbinano ma il giro dell'app resta
  settimanale; un evento con più clienti nel titolo va abbinato a uno solo.
- Prove: finto iCloud con serie (19 casi nuovi, 90 in tutto con Google/iCloud: lettura serie e modo, UTC, serie finite escluse, abbinamento con giorni già
  presenti, nessun doppione tra gli impegni, serie spostata/cambiata d'icona/cancellata su iPhone, giorni e orario cambiati nell'app con durata tenuta e resto
  dell'evento intatto, nessun rimbalzo, scollegamenti); app con finto Firebase (proposte dei clienti, nome non valido, salvataggio).

## Finestra Appuntamento (v6.12)

Richiesta di Manuel: nel Calendario, toccando un impegno (es. "Tre Sapori" dal calendario iCloud) aprire una finestra per cambiare nome, data/ora o
eliminarlo, e lo stesso per gli ordini del giro e gli appuntamenti; due spunte **📞 Ordine al telefono** / **💼 Ci passo di persona** che mettono l'icona
all'inizio del nome; le spunte si accendono da sole se il nome ha già l'icona.
- **Nell'app** (`#dlgEv`, `evRiempi`, `evApriEsterno`, `evApriApp`, `evApriGiro`): nel giorno scelto le righe non aprono più la scheda ma la finestra
  (`data-evx` = indice in `calGiornoEv` per gli impegni, `data-app` per gli appuntamenti, `data-gir` per gli ordini del giro; dentro c'è "Scheda cliente").
  Campi: nome (fisso per appuntamenti e giro non collegati: è il nome del cliente), spunte telefono/visita (si escludono), "Solo questa volta / Tutte le
  settimane" per gli eventi che si ripetono (con "tutte le settimane" il giorno non si cambia, tranne per il giro collegato), giorno, dalle/alle, tutto il giorno,
  Elimina (con `confermaElimina`), "Apri in Google". Calendari di sola lettura: niente Salva/Elimina.
  - **Appuntamenti dei clienti**: nuovo campo `ricontattareModo` ("telefono" | "visita" | ""): icona nel titolo dell'evento ("📞 Richiamare: …"), nella chiave
    di sincronizzazione (`chiaveCliente` = "data|ora|modo", e `chiaveEvento`/iCloud leggono il modo dall'icona del titolo), quindi cambiare l'icona nel
    calendario cambia la scheda e viceversa. Righe con l'icona nel Calendario (`oraFlag`).
  - **Ordini del giro collegati a iCloud**: tutte le settimane → giorni (il giorno toccato diventa quello nuovo), orario, modo e nome della serie
    (`cambiaSerie` + `modificaIcs`), e la scheda si allinea alla sincronizzazione; solo questa volta → eccezione su iCloud (la scheda non cambia).
    **Non collegati**: cambia `giorniOrdine` e una voce di `giro` senza `ev` (`{g, ora, modo, ev: ""}`) per icona e orario di quel giorno; elimina = toglie il giorno.
- **Servizio**: `POST /icloud/evento` e `POST /google/evento` `{azione?: "elimina", cal, href|id, ri|r, occorrenza?, serie, titolo, data, dataFine?, inizio, fine,
  tutto, giorni?, modo?}` (`datiEvento` controlla i dati). iCloud: `modificaIcs` (evento singolo: SUMMARY/DTSTART/DTEND nello stesso formato di prima, UTC o
  TZID o data; serie: nome e orario; solo questa volta: blocco VEVENT con RECURRENCE-ID, riconosciuto anche se scritto in UTC o con TZID — `istante`;
  elimina solo questa volta: EXDATE e via l'eccezione; elimina un evento o tutta la serie: DELETE del file), salvataggio con If-Match. Per il giro la
  RECURRENCE-ID si calcola dalla serie (`occorrenza`). Google: PATCH dell'istanza o della serie (`recurringEventId`, salvato come `r` negli impegni),
  DELETE. Dopo ogni modifica `sincronizzaTutto`. Negli impegni salvati per l'app: `r` (Google), `h` (file) e `ri` (RECURRENCE-ID) per iCloud; nello
  stato `impostazioni/icloud.giro` anche `href` e `cal` di ogni serie collegata.
- Prove: 18 casi nuovi (108 in tutto) con finto iCloud e finto Google (nome/data/ore, tutto il giorno, eccezione e sua sostituzione in UTC, EXDATE, serie,
  eliminazioni, calendari di sola lettura, giro collegato tutte le settimane e solo questa volta, Google PATCH/DELETE, icona degli appuntamenti nei due
  sensi senza rimbalzi); app con finto Firebase (impegni iCloud/Google, serie, conferma eliminazione, appuntamento con telefono, giro non collegato con
  visita e orario, telefono 375 px).

## Impostazioni e stile Livrea Marchi (v6.6)

Il tasto rotondo **in basso a sinistra** è ora un **ingranaggio** (`#setBtn`, classe `tema-btn`) che apre `#dlgSet` (`setRender`, blocco "Impostazioni (v6.6)"):
- **Account**: "Accesso effettuato come <email>", versione dell'app, tasto Esci.
- **Tema**: due riquadri con anteprima, **Classico** (l'aspetto di sempre) e **Livrea Marchi**; sotto la **modalità** Come il telefono / Chiara / Scura.
  Lo stile si applica con `<html data-stile="marchi">` (`stileApplica`); la modalità con `data-theme` come prima (`temaApplica`).
- **Colori degli stati** (Da contattare, Contattato, Cliente, Cliente perso, Non servibile): un selettore di colore per stato; il colore scelto
  sovrascrive la variabile `--st-…` con lo stile in linea su `<html>` (`coloriApplica`, `stVar`), quindi vale in chiaro e scuro e in entrambi gli stili;
  anche i pallini della **Mappa** lo usano (`mapColore`, campo `st` in `MAP_GROUPS`). "Ripristina i colori originali" li toglie.
- Tutto in `utenti/{uid}/impostazioni/preferenze`: `tema` ("" | "light" | "dark"), `stile` ("" | "marchi"), `colori` ({STATO: "#rrggbb"},
  salvato con `mergeFields: ["colori"]` perché il merge normale non toglierebbe i colori ripristinati), `articoliVista`. Letto da `prefCarica()` dopo il login.
- **Livrea Marchi**: idea della fascia verde dei camion Marchi. Banda verde (verde del logo `#0F5A3D`) in testa a ogni sezione e finestra,
  titoli in **Archivo** corsivo stretto (richiama la scritta del logo; font aggiunto al link di Google Fonts), schede con un filo di bordo e senza ombre,
  angoli più asciutti, iniziali dei clienti in un quadratino pieno del colore dello stato, menu laterale verde, **corallo** di Marchi (`--coral`, `#E86A40`)
  solo per ciò che chiede attenzione (richiami scaduti, numeri nel menu, tasto +, reclami da inviare). Colori presi da marchispa.it (verde `#154531`,
  corallo `#F78761`). Blocco CSS `/* ===== Stile Livrea Marchi (v6.6) ===== */` in fondo a `<style>`: **ogni selettore inizia con
  `:root[data-stile="marchi"]`** (anche nelle regole del tema scuro, scritte in entrambi i modi), così lo stile Classico non cambia. Le regole nuove della
  Livrea vanno scritte allo stesso modo. Nel click delle impostazioni si usa `.set-stile` e non `[data-stile]`: anche `<html>` ha quell'attributo.
- **Dati (v6.7)**: nelle Impostazioni, sezione Dati con Importa da Excel (`#fileImport`), Esporta in Excel (`exportExcel`) e Collega fatturazioni e
  destinazioni (`uniApri("coppie")`, chiude prima le Impostazioni). Il Riepilogo non ha più la scheda Dati né l'account (che è in Impostazioni).
- **Ignora (v6.7)**: in "Fatturazioni e destinazioni" ogni coppia proposta ha **Ignora**; le coppie ignorate stanno in `preferenze.uniIgnora` =
  ["idDestinazione|idFatturazione", …] (salvate con `mergeFields`) e `uniCoppie` le salta (la destinazione può ricevere un'altra proposta). In fondo
  "Mostra le voci ignorate (N)" con **Ripristina**.
- **Appuntamenti (v6.7)**: nel Calendario il tasto Nuovo (`#fab`) apre `#dlgApp` (`appNuovo`): giorno (quello scelto nel calendario se non è passato,
  altrimenti oggi), ora facoltativa, cliente con ricerca, nota facoltativa che va nello storico ("Appuntamento fissato per il …: nota"). Scrive
  `ricontattare`/`ricontattareOra` del cliente come "Appuntamento il" della scheda (un solo appuntamento per cliente: se ce n'è già uno l'app avvisa che
  viene spostato). Testi: "Richiami" → **Appuntamenti** nel Calendario (sezione del giorno, scaduti, legenda), "Richiama il" → **Appuntamento il** nella
  scheda, chip delle righe "Appuntamento gg/mm"; gli eventi di Google si chiamano "Dal tuo Google Calendar". I nomi dei campi e il titolo degli eventi in
  Google ("Richiamare: …", Worker calendario) non cambiano.
- Reclami: "Inviato" ora è una cornice, "Da inviare" pieno (classe `rc-st inviato`).

## Tema chiaro/scuro e preferenze (v5.1)

(Dalla v6.6 il tasto sole/luna non c'è più: la modalità si sceglie in Impostazioni.)


Tasto rotondo **in basso a sinistra** (`#temaBtn`, sole/luna) per passare da modalità chiara a scura e viceversa. Di base l'app segue il telefono/PC
(`prefers-color-scheme`); scegliendo a mano si mette `data-theme="light"|"dark"` su `<html>` e le variabili scure valgono per `:root[data-theme="dark"]` e,
senza scelta, per `@media (prefers-color-scheme:dark) :root:not([data-theme="light"])`. **Ogni nuova regola per il tema scuro va scritta in entrambi i modi.**
La scelta si salva nell'account (non in localStorage), documento `utenti/{uid}/impostazioni/preferenze` (`tema`, `articoliVista`), letto da `prefCarica()` subito dopo
il login: vale su tutti i dispositivi dell'account; prima del login l'app segue il sistema.

## Conferma prima di eliminare (v4.15)

Richiesta di Manuel: ogni eliminazione chiede conferma con un pop-up dell'app (non il `confirm()` del browser). Funzione `confermaElimina(cosa, dettaglio, testoTasto)` → `Promise<boolean>`, finestra `#dlgSure` (icona cestino, titolo "Sei sicuro di voler eliminare …?", Annulla / Elimina rosso; Esc o tocco fuori = Annulla; si apre anche sopra la scheda cliente o il preventivo). Usata per: cliente, nota dello storico, preventivo (elenco e aperto), **articolo del preventivo** (prima si toglieva senza chiedere), promemoria di Rosario, collegamento al calendario di Rosario, catalogo, **unione di due schede in una** (elimina una scheda). **Ogni nuova eliminazione deve passare da `confermaElimina`.** Gli altri `confirm()` (P.IVA, importazione, collega, annulla unione…) restano quelli del browser.

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

## Budget (v4.1)

Scheda **Budget** nel menu (dopo Riepilogo). Manuel carica con **Carica scheda** il PDF "Scheda performance agente" di Marchi S.p.A. (una pagina, un
PDF nuovo a ogni mese). L'app lo legge **sul dispositivo** con pdf.js (`bdgLeggiPdf` + funzione pura `bdgAnalizza`, tra i marcatori
`BDG-PARSE-START/END`) e prende le righe **Fatturato AP** (anno precedente), **Fatturato AC** (anno in corso) e **Bdg** (budget): i mesi sono i
numeri della riga e l'ultimo è il totale (mesi senza dati restano vuoti; i delta del PDF si ignorano e si ricalcolano). Se la somma dei mesi non
quadra con il totale la lettura viene rifiutata. Salvataggio: `utenti/{uid}/impostazioni/budget` = `{anno, ap[12], ac[12], bd[12], agg, caricato}`
(null = mese senza dati). Ogni caricamento sostituisce il precedente.
Schermata: 3 riquadri (fatturato anno in corso, scarto sul budget, scarto sull'anno scorso, sui mesi con dati), **grafico a barre affiancate** mese
per mese (anno precedente grigio, anno in corso colore principale, budget con solo contorno arancione; SVG inline `bdgGrafico`) e tabella di dettaglio
con % sul budget. Nel PDF ci sono anche pressione, borsellino, perdite e obiettivi per famiglia (carni fresche, non food, pesce fresco): non usati
per ora. Provato col PDF vero (fatturato AC 479.755, budget 368.118, AP 319.825 per gen–ott 2026).

### Target di categoria (v4.2)

Lo stesso pulsante **Carica scheda** accetta anche il PDF **"Report Target N Semestre"** di Marchi (se il testo contiene "Fatturato AP" è la scheda
performance, se contiene "Target N semestre" è un report target; altrimenti errore). Lettura in `tgtAnalizza` (marcatori `TGT-PARSE-START/END`, usa `bdgNum`):
le **categorie** si leggono dall'intestazione maiuscola (cambiano a ogni report: 1° semestre = Pesce fresco, Ittico gelo, Latticini, Salumi; 2° semestre =
Carni fresche, Non food, Pesce fresco; nomi puliti da `tgtNomi`), poi righe "Totale Target" (target del semestre), "Target …" con i numeri (target fino alla data del
report; l'intestazione di pagina "Target 2° semestre AREA…" non ha numeri e si salta), "Fatturato progressivo / Progressivo fatturato" (con 2N numeri = coppie
anno scorso/anno in corso, con N+1 = categorie + totale) e una riga per cliente "codice - ragione sociale" con i valori (2N = con anno scorso).
Salvataggio: `utenti/{uid}/impostazioni/target`, campo `r["2026-S1"]` / `r["2026-S2"]` = `{key, anno, sem, cat[], tot[], oggi[], fatt[], fatt25[]|null, periodo, agg, clienti:[{c, n, v[], p[]|null}]}`
(un nuovo caricamento sostituisce solo lo stesso semestre). Budget mostra una scheda per semestre: barra di avanzamento per categoria (marcatore = target fino a
oggi, tratteggio = target del semestre; verde se raggiunto, arancione se no), clienti per categoria (pillole, primi 8, "Mostra tutti") con la crescita sull'anno
scorso e, se c'è il confronto, **"Da recuperare"** (compravano nell'anno scorso, ora zero). I clienti del report si collegano alle schede dell'app per
**codice cliente** (`codice`, uguale o terminante con quello del report se di almeno 5 cifre) oppure per ragione sociale (`tgtTrova`): se collegati, toccandoli si apre la scheda.
**Collega** (v4.3): le righe del report senza scheda hanno il pulsante "Collega" (e in fondo a ogni scheda c'è l'elenco "Clienti non collegati"): si sceglie il cliente dell'app da una lista con ricerca (ordinata per somiglianza del nome) e l'app scrive il codice del report nella scheda: nel campo `codice` se è vuoto, altrimenti in `codiceReport` (il codice esistente non si tocca). L'abbinamento è `tgtMatch(c, x)`: `codice` o `codiceReport` (uguali o terminanti con quello del report) oppure ragione sociale uguale.
Nella **scheda cliente** compare "Fatturato per categoria" (`tgtDetailHTML`) con i valori dei report caricati. Se un cliente non ha il codice nell'app, non si collega.
Provato con i due PDF veri (1° sem: 26 clienti, 2° sem: 25 clienti; scarti −319, −4.634, −2.402 e +729, +13.685, +27.700, +6.892).

### Budget a schede, Pressione e Provvigioni (v4.4)

Budget ha ora quattro pillole in cima (`bdgTab`: and / tgt / prs / prv; `renderBudget` sceglie la vista). **Carica scheda** accetta **più file insieme** (PDF e Excel) e riconosce
da solo il tipo (`bdgCaricaFile`): scheda performance, report target, **Analisi pressione**, **Provvigioni**. Il file non riconosciuto dà un errore per file.

- **Pressione** (un PDF al mese, "Sales Report Analysis… Analisi performance delle vendite"; `prsAnalizza`, marcatori `PRS-PARSE-START/END`): riga TOTALE (listino, sconto
  listino cliente, estemporaneo, borsellino, canvas, venduto netto, sconti totali) e una riga per cliente con 6 valori + % pressione. **Pressione = (sconto listino cliente + estemporaneo
  + borsellino) / valore a listino** (il canvas non conta); limite di Marchi **5%**. Mese e anno dalle righe MESE/ANNO (o dal titolo "aggiornamento del…"). Salvato in
  `utenti/{uid}/impostazioni/pressione`, campo `r["2026-10"]` = `{key, anno, mese, tot[7], clienti:[{c, n, v[6], p}]}` (un nuovo caricamento sostituisce solo quel mese). Schermata: tre
  riquadri (pressione del mese, sconti, media dell'anno), grafico a barre mensile con linea tratteggiata al 5%, elenco clienti del mese scelto dal più alto (sopra il limite in rosso); i clienti
  senza scheda hanno "Collega" (come nei target). Nella scheda cliente: pressione dell'ultimo mese e ultimi mesi (`prsDetailHTML`).
  **Vista Anno** (v4.20): la prima pillola è "Anno 2026" (`prsMese = "A2026"`, funzione `prsAnno`): somma listino e sconti di tutti i mesi caricati, per i totali e per ogni cliente, e ricalcola la pressione sui totali (non è la media delle percentuali). I riquadri diventano Pressione/Sconti di tutto l'anno e "Ultimo mese"; ogni cliente mostra in quanti mesi compare. Con i 10 PDF di gennaio–ottobre 2026: 5,50% (28.660 € di sconti su 521.055 € a listino), 35 clienti.
- **Provvigioni** (file Excel "Provvigioni Anno 2026 …", un foglio "Mese di …" per mese più "Riepilogo"; `prvAnalizza`, marcatori `PRV-PARSE-START/END`, usa SheetJS già caricato): per ogni
  riga di fattura legge cliente (col. C), capitolo (D, categoria merceologica), fatturato (H) e valore provvigione (J); controlla che la somma torni con la riga "Totale" del foglio. Si salvano solo
  i totali per mese, per cliente e per capitolo in `utenti/{uid}/impostazioni/provvigioni` = `{anno, tot:{f[12],p[12]}, cap:[{k,n,f[12],p[12]}], cli:[{c,n,f[12],p[12]}]}`. **Nel file i valori sono
  negativi** (es. −2,8%, totale annuo −19.080 €): nell'app si mostrano in positivo con la costante `PROV_SEGNO = -1` (da verificare con Manuel che sia il significato giusto; se no, cambiare la costante).
  Schermata: riquadri (provvigioni dell'anno, fatturato provvigionato, % media), grafico mensile, tabella, poi due riquadri affiancati su PC (uno sotto l'altro su telefono) con la scelta del periodo (anno o mese) sopra: **Per cliente** (primi 15 e tasto **Mostra tutti**, `prvTutti`) e **Per categoria** (tutte), con scelta del mese o dell'anno.
  Nella scheda cliente: provvigioni dell'anno su quel cliente.
- I report crediti settimanali (fino ad aprile) NON sono usati: l'azienda non li manda più (deciso con Manuel).
- Provato con i file veri: pressione gennaio–ottobre (totali e somme dei clienti coincidono; ottobre 6,46%), provvigioni (totali mensili uguali al foglio Riepilogo, −19.079,57 €).

### Fatturazione e destinazioni (dalla v4.19 solo COLLEGARE)

**Dalla v4.19 l'unione in una scheda non è più disponibile** (decisione di Manuel): si può solo **collegare** una o più destinazioni a una fatturazione. Il tasto `#uniOk` ("Unisci in una scheda") resta nel codice ma sempre nascosto; `unisciSchede`/`unisciDestinazione` non sono più raggiungibili dall'interfaccia. Nomi nuovi: Riepilogo → **"Collega fatturazioni e destinazioni"** (prima "Cerca doppioni"), finestra "Fatturazioni e destinazioni", tasti **Collega** / **Collega tutte** / **Cambia** / **Collega a mano…**; nella scheda cliente la riga si chiama **Fatturazione** con il tasto **Collega a…**. **Annulla unione** compare solo sulle schede unite con le versioni vecchie (`codiceDest`), per separarle; per togliere un collegamento c'è "Scollega dalla fatturazione". Le sezioni qui sotto descrivono anche il vecchio funzionamento.

### Unire le schede doppie (v4.5, non più disponibile dalla v4.19)

L'export del gestionale può creare **due clienti per lo stesso locale**: la **fatturazione** (codice che inizia per **100…**, ragione sociale e dati fiscali) e la **destinazione**
(codice che inizia per **120…**, di solito col nome vero del locale). Segnalato dal papà di Manuel. Funzioni (blocco "Unire due schede" in `index.html`, `unisciSchede` pura tra i marcatori `UNI-PARSE-START/END`):

- **Riepilogo → Dati → "Cerca doppioni"** (`uniCoppie`): per ogni scheda con codice 120… cerca una 100… con stessa P.IVA (+3), stesso indirizzo e località (+3), stessa coda di 6 cifre del codice (+2)
  o nome simile (+1/+3); propone le coppie con almeno 3 punti, con avviso se una fatturazione ha più destinazioni. **Nella scheda cliente → "Doppione? Unisci a…"**: si cerca a mano l'altra scheda.
- **Abbinamento manuale** (v4.6, perché il sistema non sempre abbina la coppia giusta): nell'elenco dei doppioni ogni riga ha **Unisci** e **Cambia** (sceglie un'altra scheda con la ricerca per nome, codice, ragione sociale, indirizzo), e in fondo c'è **Collega a mano…** (si cercano le due schede da zero). Nell'anteprima ci sono **Scambia i ruoli**, **Cambia la fatturazione** e **Cambia la destinazione**. Stato in `uni` (`modo`: coppie / scegli / conferma, `a`, `f`, `d`, `da`).
- **Una fatturazione, più destinazioni** (v4.9; `unisciDestinazione`, marcatori `UNI2-PARSE-START/END`): nell'anteprima **+ Aggiungi un'altra destinazione** (anche quante si vuole; **Togli** per rimuoverne) e nell'elenco dei doppioni **Collega tutte (N)** per le fatturazioni con più destinazioni. In questo caso le destinazioni (locali diversi) **restano schede separate**: ognuna tiene nome, indirizzo, codice 120…, posizione e giorni, e prende ragione sociale, P.IVA, codice fiscale, SDI, PEC e pagamento della fatturazione più il suo codice in `codiceFatt`; poi la scheda di fatturazione (che non è un locale) viene eliminata, e preventivi e proposte di Rosario passano alla prima destinazione. `tgtMatch` e l'import riconoscono `codiceFatt`: i report (fatturato, pressione, provvigioni) sono dell'intera fatturazione e compaiono uguali su tutte le sue destinazioni (la scheda cliente lo dice). **Fatturazione già unita** (v4.10): se la scheda scelta come fatturazione ha già `codiceDest` (è già anche un locale, perché unita a una destinazione in v4.5/4.6) NON viene toccata né eliminata: le nuove destinazioni diventano schede a parte con i suoi dati di fatturazione e `codiceFatt`. Si parte dalla sua scheda ("Unisci a…") o da "Collega a mano…" e si aggiungono le destinazioni. Con una sola destinazione e una fatturazione non ancora unita resta l'unione in una scheda (sotto).
- **Annulla unione** (v4.13, `uniAnnulla`, riga "Doppione?" della scheda cliente): su una scheda con `codiceDest` ricrea la scheda di fatturazione (nome = `altriNomi` o ragione sociale, `codice` = quello 100…, dati fiscali e amministrativi spostati lì, indirizzo copiato da quello attuale perché l'originale non si ricorda) e la scheda corrente torna la destinazione (`codice` = `codiceDest`, dati fiscali svuotati). Su una destinazione con `codiceFatt` toglie solo il collegamento. Si ricorda solo ciò che l'unione ha lasciato: l'indirizzo originale della fatturazione, il suo telefono ecc. non si recuperano. Le note e lo storico restano sulla destinazione.
- **Collegare senza unire** (v4.14, scelta di Manuel/papà: "collegate ma non unite"): nell'anteprima ci sono due azioni, **Collega (schede separate)** (principale) e **Unisci in una scheda** (solo per una coppia). Con più destinazioni c'è solo Collega. Collegare scrive su ogni destinazione `fattId` (id della scheda di fatturazione) e `codiceFatt` (suo codice) e non cambia altro; la fatturazione non si tocca. `uniPadre(c)` trova la fatturazione di una scheda (per `fattId` o per codice). **Elenco Clienti**: `uniGruppi`/`uniRigaGruppo` mostrano la fatturazione come scheda principale (le destinazioni collegate non sono più righe a sé) con il pulsante "N destinazioni collegate" e la freccia che apre le destinazioni, ognuna una scheda; con ricerca o filtri attivi il gruppo si apre da solo sulle destinazioni trovate (scelta manuale in `uniAperti`). **Scheda cliente**: la fatturazione elenca le "Destinazioni collegate", la destinazione mostra "Fatturazione" e **Scollega dalla fatturazione**. Report e import danno la precedenza alla scheda col codice proprio (`tgtTrova`, `trova`) sulle destinazioni che hanno lo stesso `codiceFatt`. Il vecchio modo di v4.9 (destinazioni che assorbono la fatturazione, poi eliminata) non è più nei pulsanti; le schede già fatte così (`codiceFatt` senza fatturazione) restano righe normali.
- **Import e fatturazioni (v4.16)**: nell'import (`trova`) una riga è "già presente" solo se una scheda ha lo stesso `codice` o `codiceDest`; il `codiceFatt` NON conta (quelle sono le destinazioni). Telefono, ragione sociale e nome uguali valgono solo se la scheda non ha un **altro** codice cliente (`libero`). Caso reale (papà di Manuel, Contatti_025.xlsx): con il vecchio "Collega tutte" della v4.9 la scheda ARIKI era stata eliminata e le destinazioni Niky's (1202900703/704/705) avevano preso ragione sociale e `codiceFatt` di Ariki, quindi ricaricando l'Excel Ariki veniva scartata. Ora viene ricreata e le destinazioni con `codiceFatt` = suo codice si mettono sotto di lei da sole (`uniPadre`).
- **Import e coppie fatturazione/destinazione (v4.17)**, caso reale di Manuel (Contatti_053.xlsx, 30 righe 100… e 12 righe 120…, nel file prima tutte le 100 poi le 120): prima la riga di fatturazione si abbinava per telefono alla scheda del locale fatta a mano (senza codice), poi anche la destinazione, e la scheda prendeva entrambi i dati (vinceva il codice 120…): la fatturazione non veniva mai creata. Ora: (1) si elaborano **prima le righe 120…** e poi le 100…; (2) una scheda già abbinata a una riga dello stesso file (`presi`) non si riabbina per somiglianza (telefono, ragione sociale, nome), ma solo per codice esatto; (3) dopo, ogni destinazione 120… del file viene **collegata** (`fattId`, `codiceFatt`) all'unica fatturazione 100… del file con lo stesso telefono o lo stesso indirizzo+località, se non è già collegata. Il messaggio di conferma dice quante destinazioni collega. Le nuove schede hanno l'id assegnato prima (`doc(col()).id`) per poterle collegare nello stesso import. Ricaricando lo stesso file dopo il danno, la fatturazione viene creata e collegata; restano solo eventuali dati della fatturazione (email, PEC) finiti nella scheda del locale, da togliere a mano.
- **Regola dei codici Marchi (v4.18)**: la destinazione `1202XXXXXN` appartiene alla fatturazione `10010XXXXX` (stesse 5 cifre XXXXX; N = numero della destinazione). Verificata su tutti gli abbinamenti di Contatti_053 e Contatti_025 (es. ALPI 1001006644 → Ristorante Pizzeria Firenze 1202066441; ARIKI 1001090070 → Niky's 1202900703/04/05). Funzioni `uniChiaveF` / `uniChiaveD`. Nell'import è il primo criterio per collegare (e **corregge** un collegamento diverso fatto prima: la v4.17 collegava per telefono e aveva messo Firenze sotto Alberghi Sicima); telefono/indirizzo restano solo come ripiego. In "Cerca doppioni" vale +6 punti. **Scheda del locale con il codice della fatturazione** (tipico delle schede create da screenshot, che prendono il codice 100…): se nessuna scheda ha il codice 120… della riga, ma c'è una scheda col codice della sua fatturazione e lo stesso nome (`uniNomeSimile`), quella scheda è la destinazione: prende il codice 120… e la fatturazione viene creata a parte e collegata. Il codice esatto non vale per una scheda già presa da un'altra riga dello stesso file (`presi`).
- Prima di unire si vede un'anteprima con i ruoli (si possono **scambiare**) e il risultato. L'unione tiene la scheda di **fatturazione** (stesso id, `codice` = quello di fatturazione) e mette il codice
  della destinazione in `codiceDest`. Per ogni campo: dati del locale (nome, indirizzo, cap, località, prov, tipologia, referente, telefoni, email, orari) prevale la **destinazione**; dati fiscali
  e amministrativi (ragione sociale, P.IVA, codice fiscale, SDI, PEC, pagamento) prevale la **fatturazione**; se uno è vuoto si prende l'altro. Fornitori e `ordiniFatti` si sommano, giorni dalla
  destinazione se presenti, stato = il più "avanzato" (Cliente > Contattato > Da contattare > Non servibile), richiamo = il più vicino, note e storico sommati (con una riga "Unita con la scheda…"),
  posizione = la più precisa (si ricalcola se l'indirizzo scelto non è quello della scheda da cui viene).
- Poi si **eliminano** la scheda della destinazione e si spostano sulla scheda unita i preventivi (`clienteId`) e le proposte di Rosario. Non si può annullare (l'anteprima lo dice).
- `tgtMatch` (report target/pressione/provvigioni) e l'importazione Excel (`trova`) riconoscono anche `codiceDest`, così un nuovo import non ricrea la scheda doppia.
- Provato con clienti inventati (coppie trovate, anteprima, unione, ricerca manuale). Con i dati veri conviene controllare la prima unione prima di farne molte.

## Rosario (assistente vocale)

Scheda **Rosario** nella barra in basso. Un servizio separato (repo `ManuelMalfer/rosario`, gira su GitHub Actions
+ una "sveglia" Cloudflare) è multiutente: per ogni utente legge il suo calendario (link iCal di Google/Outlook oppure
iCloud con password per app), gli scrive su Telegram (bot @Rosarioilbot) l'agenda e, dopo gli appuntamenti, gli
chiede com'è andato; dal vocale (Gemini) scrive **proposte** in Firestore: `utenti/{uid}/rosario/{id}` con `stato`
"in_attesa" | "approvata" | "rifiutata", `clienteId`, `clienteNome`, `campo`, `valoreProposto`, `motivo`,
`appuntamento`, `creato`.
Promemoria: un vocale "ricordami…" crea una proposta con `campo: "promemoria"` (`quandoTs`); "Approva" NON tocca schede ma crea
`utenti/{uid}/rosario_promemoria/{id}` che Rosario invia su Telegram alla scadenza (elenco "Promemoria programmati" nella scheda).
Rosario risponde anche a domande libere (clienti, fornitori, prodotti alimentari).
Il pulsante **Impostazioni** (nella scheda) apre il pannello `#dlgRos`: collega Telegram (codice monouso in
`rosario_collegamenti/{codice}` → `t.me/Rosarioilbot?start=codice`), collega il calendario (credenziali scritte in
`rosario_segreti/{uid}`, che il sito può solo SCRIVERE, mai leggere: regole Firestore dedicate) e preferenze in
`utenti/{uid}/rosario_config/impostazioni`; lo stato (✓ calendario/Telegram) lo scrive ROSARIO in
`rosario_config/stato` e `rosario_config/telegram`. Vedi `Rosario/docs/INTEGRAZIONE-SITO.md` per le regole.
Nell'app le proposte si approvano, modificano o rifiutano; **solo "Approva" scrive sulla scheda cliente**
(funzioni `rosModifica` / `rosApprova`, elenco campi consentiti `ROS_CAMPI`: deve coincidere con `CAMPI` del
servizio). Ogni modifica approvata aggiunge una riga allo storico. Servono le regole Firestore anche per
`utenti/{uid}/rosario` (read + update, stessa condizione di `clienti`).

## Idee aperte / possibili sviluppi

- Zona a colori calcolata solo sui clienti attivi invece che su tutti i locali (domanda posta, senza risposta).
- Vista "responsabile" in cui Manuel vede anche i clienti del papà.
- Automatismo screenshot → cartella OneDrive → creazione cliente (scartato per ora: richiede
  registrazione app Microsoft e probabilmente permessi IT aziendali; si è scelto il pulsante nell'app).
- Calendario sincronizzato (feed iCal in abbonamento) al posto dell'export `.ics`: richiede un piccolo
  servizio lato server (es. Cloudflare Worker).
- Adattare la lettura screenshot ad altri dispositivi se Manuel usa il gestionale anche altrove.
