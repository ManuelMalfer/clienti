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
`note`, `ordiniFatti` (date in cui l'ordine del giorno è stato raccolto, dal Giro), `storico` (array di `{d: "YYYY-MM-DD", t: "testo"}`), `lat`, `lng`, `approx` (posizione al
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
- Non c'è ancora modifica/eliminazione di un catalogo dall'app: si fa dal PC (`cataloghi.json` + file) o chiedendo a Claude.

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
