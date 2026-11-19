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
`chiusoDal`/`chiusoAl` (periodo di chiusura, YYYY-MM-DD, entrambi facoltativi: nel periodo il cliente non compare nel Giro, né ordini né mappa; funzione `chiusoIl(c, iso)`; campi nel modulo e nella scheda cliente, etichetta "Chiuso fino al…" nell'elenco), `note`, `codiceDest` (codice di destinazione, dopo l'unione di due schede), `altriNomi` (nomi che la scheda aveva prima dell'unione, per la ricerca), `codiceFatt` (codice di fatturazione, nelle destinazioni di una fatturazione con più locali), `codiceReport` (codice del report target collegato a mano, se la scheda ha già un altro `codice`), `ordiniFatti` (date in cui l'ordine del giorno è stato raccolto, dal Giro), `storico` (array di `{d: "YYYY-MM-DD", t: "testo"}`), `lat`, `lng`, `approx` (posizione al
centro paese), `geoFail`, `creato`, `aggiornato` (ISO).

Stati: `DA CONTATTARE`, `CONTATTATO`, `CLIENTE`, `NON SERVIBILE`.
Le vecchie categorie `CLIENTE MAX` e `CLIENTE LUTTERI` sono state eliminate: vengono convertite in
`NON SERVIBILE` con nota "Cliente di Massimiliano" / "Cliente di Lutteri" (funzione `migraExClienti`,
eseguita automaticamente, e anche all'importazione Excel).

Ogni cambio di stato aggiunge automaticamente una riga allo storico.

## Funzioni presenti

Barra in basso (5 voci): **Clienti, Richiami, Cataloghi, Riepilogo, Altro**; in **Altro** (griglia di riquadri) stanno **Mappa, Giro,
Preventivi, Rosario**. Pulsante flottante rotondo **+** (nuovo cliente / nuovo preventivo). Vedi "Interfaccia" più sotto.

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
- **v3.2** = v3.1 con la mappa del Giro sulle consegne del **giorno dopo** e conteggi "ord." nella barra dei giorni. Tag Git `v3.2`. In
  Riepilogo, sotto l'email dell'account, compare "App versione 3.2 (v3.2)" (utile per capire se il dispositivo mostra ancora la versione vecchia; aggiornare
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
- **Provvigioni** (file Excel "Provvigioni Anno 2026 …", un foglio "Mese di …" per mese più "Riepilogo"; `prvAnalizza`, marcatori `PRV-PARSE-START/END`, usa SheetJS già caricato): per ogni
  riga di fattura legge cliente (col. C), capitolo (D, categoria merceologica), fatturato (H) e valore provvigione (J); controlla che la somma torni con la riga "Totale" del foglio. Si salvano solo
  i totali per mese, per cliente e per capitolo in `utenti/{uid}/impostazioni/provvigioni` = `{anno, tot:{f[12],p[12]}, cap:[{k,n,f[12],p[12]}], cli:[{c,n,f[12],p[12]}]}`. **Nel file i valori sono
  negativi** (es. −2,8%, totale annuo −19.080 €): nell'app si mostrano in positivo con la costante `PROV_SEGNO = -1` (da verificare con Manuel che sia il significato giusto; se no, cambiare la costante).
  Schermata: riquadri (provvigioni dell'anno, fatturato provvigionato, % media), grafico mensile, tabella, poi due riquadri affiancati su PC (uno sotto l'altro su telefono) con la scelta del periodo (anno o mese) sopra: **Per cliente** (primi 15 e tasto **Mostra tutti**, `prvTutti`) e **Per categoria** (tutte), con scelta del mese o dell'anno.
  Nella scheda cliente: provvigioni dell'anno su quel cliente.
- I report crediti settimanali (fino ad aprile) NON sono usati: l'azienda non li manda più (deciso con Manuel).
- Provato con i file veri: pressione gennaio–ottobre (totali e somme dei clienti coincidono; ottobre 6,46%), provvigioni (totali mensili uguali al foglio Riepilogo, −19.079,57 €).

### Unire le schede doppie (v4.5)

L'export del gestionale può creare **due clienti per lo stesso locale**: la **fatturazione** (codice che inizia per **100…**, ragione sociale e dati fiscali) e la **destinazione**
(codice che inizia per **120…**, di solito col nome vero del locale). Segnalato dal papà di Manuel. Funzioni (blocco "Unire due schede" in `index.html`, `unisciSchede` pura tra i marcatori `UNI-PARSE-START/END`):

- **Riepilogo → Dati → "Cerca doppioni"** (`uniCoppie`): per ogni scheda con codice 120… cerca una 100… con stessa P.IVA (+3), stesso indirizzo e località (+3), stessa coda di 6 cifre del codice (+2)
  o nome simile (+1/+3); propone le coppie con almeno 3 punti, con avviso se una fatturazione ha più destinazioni. **Nella scheda cliente → "Doppione? Unisci a…"**: si cerca a mano l'altra scheda.
- **Abbinamento manuale** (v4.6, perché il sistema non sempre abbina la coppia giusta): nell'elenco dei doppioni ogni riga ha **Unisci** e **Cambia** (sceglie un'altra scheda con la ricerca per nome, codice, ragione sociale, indirizzo), e in fondo c'è **Collega a mano…** (si cercano le due schede da zero). Nell'anteprima ci sono **Scambia i ruoli**, **Cambia la fatturazione** e **Cambia la destinazione**. Stato in `uni` (`modo`: coppie / scegli / conferma, `a`, `f`, `d`, `da`).
- **Una fatturazione, più destinazioni** (v4.9; `unisciDestinazione`, marcatori `UNI2-PARSE-START/END`): nell'anteprima **+ Aggiungi un'altra destinazione** (anche quante si vuole; **Togli** per rimuoverne) e nell'elenco dei doppioni **Collega tutte (N)** per le fatturazioni con più destinazioni. In questo caso le destinazioni (locali diversi) **restano schede separate**: ognuna tiene nome, indirizzo, codice 120…, posizione e giorni, e prende ragione sociale, P.IVA, codice fiscale, SDI, PEC e pagamento della fatturazione più il suo codice in `codiceFatt`; poi la scheda di fatturazione (che non è un locale) viene eliminata, e preventivi e proposte di Rosario passano alla prima destinazione. `tgtMatch` e l'import riconoscono `codiceFatt`: i report (fatturato, pressione, provvigioni) sono dell'intera fatturazione e compaiono uguali su tutte le sue destinazioni (la scheda cliente lo dice). **Fatturazione già unita** (v4.10): se la scheda scelta come fatturazione ha già `codiceDest` (è già anche un locale, perché unita a una destinazione in v4.5/4.6) NON viene toccata né eliminata: le nuove destinazioni diventano schede a parte con i suoi dati di fatturazione e `codiceFatt`. Si parte dalla sua scheda ("Unisci a…") o da "Collega a mano…" e si aggiungono le destinazioni. Con una sola destinazione e una fatturazione non ancora unita resta l'unione in una scheda (sotto).
- **Annulla unione** (v4.13, `uniAnnulla`, riga "Doppione?" della scheda cliente): su una scheda con `codiceDest` ricrea la scheda di fatturazione (nome = `altriNomi` o ragione sociale, `codice` = quello 100…, dati fiscali e amministrativi spostati lì, indirizzo copiato da quello attuale perché l'originale non si ricorda) e la scheda corrente torna la destinazione (`codice` = `codiceDest`, dati fiscali svuotati). Su una destinazione con `codiceFatt` toglie solo il collegamento. Si ricorda solo ciò che l'unione ha lasciato: l'indirizzo originale della fatturazione, il suo telefono ecc. non si recuperano. Le note e lo storico restano sulla destinazione.
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
