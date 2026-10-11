# Stadtstack: Pipeline, Quellen und reproduzierbarer Lauf

## 1. Drei Dinge nicht vermischen

1. **Historische Reproduktion:** Der hier tatsächlich nachgewiesene Offline-Lauf rekonstruiert den eingefrorenen **0.3.0-Datenstand**, nicht nachträglich korrigierte 0.3.1-Semantik.
2. **Live-Patch:** 0.3.1 ist separat veröffentlicht. Fälle, Datumsrollen, Entitätsauflösung, Coverage v3 und Token-Profile haben eigene Release-Belege; diese dürfen nicht in alte Modellbelege hineingeschrieben werden.
3. **Neue Erwerbslane:** Die später am 11.10.2026 beschlossene globale Robots-/Herkunfts-/Widerspruchspolicy gehört zur 0.3.2-/Rebuild-Lane. Alte Replays werden nicht dadurch zu neuen Abruf- oder Modellfreigaben.

**off-site backup: deferred by owner**

Es wurde keine Storage Box bestellt, kein externer Backup-Speicher provisioniert und kein Off-Site-Upload durchgeführt. Die Rohdaten bleiben auf der Workstation. Die folgenden Exporte und Reproduktionsschritte funktionieren unabhängig davon. Ein weiterer Checkout oder Symlink ist ausdrücklich **kein** unabhängiges Backup.

## 2. Verbindliche Referenzen

| Gegenstand | Identität |
| --- | --- |
| Nachgewiesener Replay-Code | `7f9b8f12ee7c5de5833088d029799db3ff7f83b6` |
| Ursprünglich veröffentlichter 0.3.0-Code | `4cdf3a0231cc1d07dc8a501be44f8463ff69aeb5` |
| Ziel-Datenrelease | `f434203c14c82ea6b6814662e9b1e209d81d7921bee97aeefcd2269d83330415` |
| Exakte Ziel-Manifestdatei | SHA-256 `fbac3ebfd040b50c666afaaaa3d42ccc15a64336e6ec8111024bf20abc1ad633` |
| Replay-Receipt | SHA-256 `d929db4f9c17ae2bdd7f350598d3be04ab64af5db0f1e846f476ff89a34f9e15` |
| Korpus-JSONL | SHA-256 `9ac5c25357065637516485ccd0a16027e5e4451f09817b64c2925a5acc7cc829` |
| Vorheriger Stadt-Baseline-Commit | `ca92aa7ccda470d09564889db3edaeaea5e4f578` |
| Vorheriges Datenrelease | `cdd0e350be842c040dc77d13cc73bf2267cd0b9ae9bbf0a471a267b47938b6f4` |

Die maschinenlesbare Receipt bindet diese Referenzen; beim Ausführen werden ihre Werte und Dateihashes geprüft.

- [Quelleninventar](../reports/SOURCES.md) und [CSV](../reports/sources.csv).
- [Korpusmanifest](../reports/corpus-manifest.jsonl) und [Zusammenfassung](../reports/corpus-manifest-summary.json).
- [Exakte Replay-Receipt](../reports/offline-replay-receipt.json).
- [Tatsächlich ausgeführter Offline-Nachweis](../reports/offline-replay-proof.json).
- [Begrenzter Live-Neucrawl mit Diff](../reports/live-recrawl-hagenow.json).

Die Quellenexporte stammen aus der Registry, nicht aus einer handgeschriebenen Ortsliste: **319 eindeutige Gemeinden**, **331 AGS-tragende Objekte** einschließlich Kreis-/Pilotduplikaten. Im zugrunde liegenden Stand sind es **1.003 URL-Token-Vorkommen, 1.000 vollständige URL-Werte und 363 unterschiedliche URL-Token**. Das sind nicht 1.003 unterschiedliche Behörden-Endpunkte. Eine fehlende Amt-Zuordnung bleibt unbekannt; ein Verwaltungslabel oder eine Amt-ARS wird nicht als belegter Amtsname erfunden.

Das JSONL enthält eine typisierte Metadaten-Kopfzeile und **8.969 Repräsentationskontexte**, darunter alle verlangten 2.842 eingefrorenen und 7.623 gecachten Repräsentationen. Zusätzlich ist der freigegebene 5.193-Repräsentationen-Pilotstand enthalten, damit die veröffentlichten Quellen vollständig anschließen. Überlappende Mitgliedschaften werden bewahrt, nicht doppelt als neue Dokumente gezählt. **5.167 unterschiedliche Bodies / 4.372.394.220 Bytes**, 8.969 gebundene historische HTTP-Beobachtungen, keine fehlenden Beobachtungsbindungen und 346 veröffentlichte Quellenzuordnungen wurden tatsächlich geprüft.

`fetchedAt` entspricht dem gespeicherten `retrievedAt`; ein 304 aktualisiert nur die Prüfung, nicht den ursprünglichen Abruf. ETag und Last-Modified kommen aus der unveränderten historischen Beobachtungsdatei, nie aus einem neueren veränderlichen Request-Zeiger. Größe und Hash beziehen sich auf dekodierte CAS-Bytes, nicht HTTP-Content-Length. Der Medientyp ist normalisiert bzw. erkannt; der ursprüngliche unveränderte Content-Type-Header wurde nicht dauerhaft gespeichert.

## 3. Umgebung und private Voraussetzungen

### Tatsächlich verwendete Umgebung

- Originale Veröffentlichung: macOS/arm64, Node **25.2.1**, ICU **78.1**, Locale `de-DE`, Zeitzone `Europe/Berlin`.
- Nachgewiesener frischer Linux-Checkout auf `codex-workstation`: Node **24.21.0**, ICU **78.3**, Unicode **17.0**, Locale `de-DE`, Zeitzone `Europe/Berlin`.
- Originale Textvorbereitung: Node 24.21.0, Poppler-Werkzeuge **24.02.0** (`pdfinfo`, `pdftotext`, `pdftoppm`), Tesseract **5.3.4**; Deutsch/Englisch für OCR. Der Replay verwendet die gebundenen vorbereiteten Textbelege, nicht neu gerenderte OCR.
- Exakter Dependency-Lock des Replay: SHA-256 `92a0641411bd3b6c8f3e899f62c22c67550a2005b6b78e879ff15afe1f9ea4ec`.
- Für neue PDF-Herkunftsklassifikation und deren echte PDF-Tests sind `pdfinfo` und `pdftotext` nötig. Fehlende Werkzeuge bedeuten `unknown`, keine erfundene offizielle Herkunft. Auf dem Entwicklungs-Mac wurde dafür später Poppler 26.10.0 installiert; das ändert nicht die historischen Toolbelege.

### Bestehende Workstation-Dateien

Auf `codex-workstation` liegt der erhaltene Bestand unter:

```sh
SOURCE_CACHE="$HOME/civic-knowledge-slice/stadtstack-data/cache"
```

Erforderlich sind:

- `districts/raw/sha256/HASH` sowie unveränderte `observations/*.json`;
- `repro-input/pins/`: autorisierter Index, ursprünglicher Vorbereitungsplan/Workplan, ursprüngliche Extraction-Run-Metadaten und eingefrorene Reassessment-Evidenz;
- `repro-input/contracts/generation-v8.json`: tatsächliche archivierte ursprüngliche Prompts, Schemata und Quellcode-Hashes;
- `repro-input/staging/`: die vollständigen 19 Nicht-Knowledge-Eingabedateien, einschließlich Stadtsignalen, Feeds, regionalem Stand und Core-Bundle;
- `repro-input/core-cache/`: genau zwei originale Core-PDFs und drei tatsächliche Judge-Receipts.

Kein Login-Verzeichnis und keine Token-Datei gehört in dieses Paket oder nach Git. Der eingefrorene Beleg enthält die versiegelten Antwort-Caches; vollständige rohe Provider-Transkripte wurden nicht aufbewahrt. Die Prüfung behauptet daher Antwort-Envelope-/Quell-/Promptbindungen, nicht eine nachträgliche Prüfung ungespeicherter Provider-Events.

## 4. Nachgewiesenen Offline-Replay aus frischem Clone ausführen

Diese Befehle laufen auf `codex-workstation`. Git-/Dependency-Vorbereitung ist von der anschließend netzgesperrten Verarbeitung getrennt. Bei leerem npm-Cache ist ein ausdrücklich vorbereitender `npm ci --ignore-scripts --no-audit --no-fund` nötig; während des Offline-Laufs gibt es keinen solchen Fallback.

**Aktuelle Freigabe bleibt Voraussetzung:** Der historische Code-Pin kennt spätere Einwendungen nicht. Die Befehle dokumentieren den tatsächlich ausgeführten Nachweis, erteilen aber keine Erlaubnis, alte Volltext-/Antwortarchive an der heutigen Policy vorbei erneut zu lesen. Vor einer späteren Wiederholung müssen deren exakte Dateihashes und sämtliche Quellenbindungen ausdrücklich unter der provisionierten Workstation-Autorität inventarisiert und aktuell freigegeben sein. Fehlende Bindung oder ein aktueller Widerspruch sperrt den Lauf; alte Cache-Wurzeln werden nicht automatisch übernommen. Die neue Lane wird mit dieser technischen Sperre getrennt integriert und erst nach Prüfung für neue Läufe freigegeben. Der erhaltene historische Erfolgsbeleg wird dadurch nicht nachträglich umgeschrieben.

```sh
set -euo pipefail
umask 077
NODE="$HOME/.local/share/mise/installs/node/24.21.0/bin/node"
export PATH="$(dirname "$NODE"):$PATH"
SOURCE_CACHE="$HOME/civic-knowledge-slice/stadtstack-data/cache"
REPLAY_CLONE="$HOME/civic-repro-$(date -u +%Y%m%dT%H%M%SZ)"

git clone --branch pilot-reproducibility --single-branch \
  https://github.com/GiraeffleAeffle/ledger-of-life.git "$REPLAY_CLONE"
git -C "$REPLAY_CLONE" checkout --detach 7f9b8f12ee7c5de5833088d029799db3ff7f83b6
ROOT="$REPLAY_CLONE/stadtstack-data"
npm --prefix "$ROOT" ci --offline --ignore-scripts --no-audit --no-fund

mkdir -p "$ROOT/cache/replay-input"
ln -s "$SOURCE_CACHE/districts/raw" "$ROOT/cache/raw"
cp -a "$SOURCE_CACHE/repro-input/pins" \
      "$SOURCE_CACHE/repro-input/contracts" \
      "$SOURCE_CACHE/repro-input/staging" "$ROOT/cache/replay-input/"
cp -a "$SOURCE_CACHE/repro-input/core-cache/pdf" \
      "$SOURCE_CACHE/repro-input/core-cache/core-evidence" "$ROOT/cache/"

env LANG=de_DE.UTF-8 TZ=Europe/Berlin \
  strace -f -qq -e trace=network -e raw=network \
    -e inject=socket,connect:error=EPERM \
    -o "$ROOT/cache/offline-network.trace" \
    "$NODE" --experimental-strip-types "$ROOT/src/replay-pipeline.ts" \
    "$ROOT/reports/offline-replay-receipt.json" \
    d929db4f9c17ae2bdd7f350598d3be04ab64af5db0f1e846f476ff89a34f9e15
```

Ein vorhandenes Replay-Arbeitsverzeichnis wird nicht überschrieben. Für einen weiteren Lauf einen neuen Clone verwenden, nicht fremde Caches oder Belege löschen. Die Quelldaten werden nur gelesen. Vorherige Stadtänderungen kommen aus dem lokal vorhandenen, gepinnten älteren Git-Commit; die Ziel-`out/`-Dateien werden **nicht** als Rekonstruktionsinput kopiert. Ausschließlich das Zielmanifest dient dem Vergleich.

### Tatsächlich beobachtetes Ergebnis

- Frischer Clone bei `7f9b8f1`; Ausführung **2026-10-11 13:49:04.741Z bis 13:51:41.091Z**.
- **376** abgeschlossene primäre Dokumentresultate rekonstruiert/geprüft.
- **1.630** ursprüngliche Extraktionsantwort-Verwendungen und **501** tatsächliche Judge-Antwort-Verwendungen geprüft; Original-Modell-/Prompt-/Zeitbelege erhalten.
- **0 neue Modellaufrufe, 0 Readiness-Aufrufe, kein Live-Fallback**.
- **228** veröffentlichte Wissensdatensätze aus neun Gemeinden rekonstruiert.
- **Alle 42 Release-Mitglieder** haben identische Pfade, Bytezahlen und SHA-256; auch die Manifestdatei selbst ist byteidentisch. Daten-ID und Manifest-Dateihash entsprechen Tabelle und Receipt.
- Netzwerktrace: **0 `socket`- und 0 `connect`-Aufrufe**; nur lokale IPC (`socketpair`, `setsockopt`, `shutdown`). Eine separate Negativprobe erhielt beim Netzwerkversuch `EPERM`, während ein lokaler Git-Unterprozess funktionierte.

Es wurde keine Kernel-Netznamespace behauptet: unprivilegierte Namespace-/Docker-Zugriffe waren in dieser Umgebung nicht verfügbar. Die tatsächlich eingesetzte Absicherung war `strace`-Syscall-Injektion für neue Sockets/Verbindungen. Rohtraces bleiben privat; veröffentlicht sind nur Hash und Zählwerte.

Zwei frühere Versuche wurden nicht als Erfolg gezählt: eine zu breite Netzwerk-Injektion sperrte auch notwendige lokale IPC; danach fiel ein falscher Git-Pfad relativ zum Monorepo auf. Der Reader nutzt nun `REV:./out/PATH` aus dem Datenpaket. Beide Fehlversuche blieben privat nachvollziehbar; die endgültige neue Clone-Ausführung bestand mit unveränderten historischen Daten/Gates.

## 5. Kleiner Live-Neucrawl und Diff

Der dokumentierte Neucrawl wurde im ersten frischen Checkout bei `3ab0076` ausgeführt. Der einzige spätere Replay-Repair betrifft den Git-Baseline-Reader, nicht den Crawler. Die folgenden Grenzen entsprechen dem tatsächlich ausgeführten Aufruf; ein späterer Live-Lauf darf naturgemäß andere Beobachtungen liefern.

```sh
"$NODE" --experimental-strip-types "$ROOT/src/district-crawl.ts" \
  --registry "$ROOT/sources/district-registry.json" \
  --municipality hagenow \
  --out "$ROOT/cache/live-hagenow/index.json" \
  --cache "$ROOT/cache/live-hagenow/raw" \
  --max-documents 2 --max-pages 1 --max-requests 8 --max-rounds 1
```

Beobachtet wurden **zwei Gazette-Dokumente mit bereits bekannten, unveränderten Bytes**. Zehn bekannte Quellen-URLs wurden nicht erneut besucht; das sind **keine Löschungen**. Gazette-/Website-/Beteiligungsfrontiers blieben ausdrücklich partiell, der Ratszugang blockiert. Es gab keine Modellaufrufe, keine Authentifizierung und keine Umgehung. Der [Diff](../reports/live-recrawl-hagenow.json) bindet den ursprünglichen JSONL-Hash, neuen Indexhash, konkrete URLs/Bytes/Abrufzeiten und die tatsächlichen Source-Checks. Der Korpusmanifest-Stand bleibt sein ausdrücklich gepinnter Vorher-Snapshot; die zwei neuen Beobachtungen sind separat dokumentiert, keine neuen Dokumentbytes.

Für einen Diff nach demselben Verfahren: nach `(municipalityId, sourceId, URL)` verbinden und den neuen SHA mit der Menge aller früher beobachteten SHAs vergleichen. Ergebnis ist `unchanged_known_bytes`, `changed_bytes_at_known_url` oder `newly_observed_url`. Nicht erneut besuchte Schlüssel als `not_revisited`, niemals als entfernt ausgeben.

## 6. Regulärer Vorwärtsbetrieb – nicht der Offline-Replay

Alle npm-Befehle beziehen sich auf `stadtstack-data`. Die Reihenfolge ist bewusst getrennt:

```sh
npm run knowledge:registry -- validate --registry sources/district-registry.json
npm run knowledge:crawl -- --registry sources/district-registry.json \
  --municipality hagenow --out cache/districts/index.json --cache cache/districts/raw \
  --max-documents 2 --max-pages 1 --max-requests 8 --max-rounds 1
```

`knowledge:registry` validiert bzw. aktualisiert beobachtete konfigurierte Endpunkte; es erfindet keine fehlenden 319 Gemeindeseiten und keinen unbekannten Amt-Bezug. Registry-Refresh ist ein eigener bewusster Netzwerkvorgang (`knowledge:registry -- refresh --registry ... --out ... --cache ...`).

Vor Text/OCR wird ein Korpus **als konkrete Bytefolge freigegeben**. Ein neu erzeugter Live-Index ist nicht automatisch für Modellverarbeitung zugelassen. Der belegte historische autorisierte Index hat Hash `fb4e08eee8bf1a3bf036433893553b5ebb0e7ae4dec1fea6ce702a8f66642992`; die Registry `9095c7a241fa5cc1a2d75030286d8690cc5bf6d3e05990c56f7a5199c304b554`.

Auf dem konfigurierten Linux-Vorbereitungshost:

```sh
npm run knowledge:prepare-text -- \
  --index cache/pilot-coverage-completion/index-authorized.json \
  --corpus-sha256 fb4e08eee8bf1a3bf036433893553b5ebb0e7ae4dec1fea6ce702a8f66642992 \
  --registry sources/district-registry.json --raw-root cache/districts/raw \
  --max-documents-per-municipality 60
```

Der Befehl gibt den neu erstellten Planpfad und `planSha256` aus. **Diese** Werte müssen zusammen und bytegebunden an den Koordinator übergeben werden; ein neuer Planzeitpunkt darf nicht mit einem alten Planhash bezeichnet werden. Im historischen Lauf waren es 417 ausgewählte Gruppen, 376 vorbereitete und 41 Vorbereitungs-Holds. Vorbereitungs-Fingerprint (Text/OCR) und Extraktor-Fingerprint (Modell/Gates) sind verschiedene Domänen.

Die folgende Befehlsfolge dokumentiert die historische, hostübergreifende Pipeline und ihre gebundenen Eingaben; sie ist **keine aktuelle Betriebserlaubnis** und kein Replay. Neue Erwerbs-, Vorbereitungs- und Extraktionsläufe laufen ausschließlich auf `codex-workstation` im Codex-only-Modus. Die neue Lane muss dafür zuerst separat freigegeben sein:

```sh
npm run knowledge:extract -- \
  --prepared-plan cache/district-joint/preparation-4f98089a55ce3fcdd34b263bbb904935cd9f8006518a754215189854e2d49810.json \
  --prepared-sha256 4f98089a55ce3fcdd34b263bbb904935cd9f8006518a754215189854e2d49810 \
  --registry sources/district-registry.json --assignment-mode balanced \
  --out cache/district-joint --anthropic-workers 1
npm run knowledge:assemble -- --out cache/district-joint
npm run knowledge:prepare -- --records cache/district-joint/records.json \
  --quarantine cache/district-joint/quarantine.json \
  --extraction-run cache/district-joint/extraction-run.json
npm run publish
npm run evaluate:pilot -- collect --server-root "$PWD" \
  --release f434203c14c82ea6b6814662e9b1e209d81d7921bee97aeefcd2269d83330415 \
  --tools 19 --output cache/pilot-value/replay-observation.json
```

Der letzte feste Release-Hash/19-Tool-Aufruf gehört ausschließlich zum historischen 0.3.0-Beispiel. Für eine neue Veröffentlichung wird die tatsächlich ausgegebene Daten-ID und deren tatsächliche Toolzahl verwendet; ein falscher Hash wird abgewiesen. Im gegenwärtigen 0.3.1 sind es 20 Tools. Vergleiche dürfen die feste Fragenbank nicht ändern und benötigen neue Einzelbewertungen, wenn der fragebezogene Evidenzhash geändert ist.

`publish` benötigt außerdem die vollständig geprüften Stadtsnapshots/Feeds, Regionaldaten und Core-Evidenz. `quality:refresh -- --retain-city-snapshot` erhält ausdrücklich die bisherigen Großstadtstände; es ist kein erneuter Großstadtcrawl. Niemals fehlende Produktionsstaging-Dateien durch einen Ziel-`out/`-Fallback als angeblich frischen Wiederaufbau ausgeben.

### Modellanmeldung und Kosten

- Historisch: Codex CLI **0.160.0** mit `gpt-6-luna` auf `codex-workstation`; Claude CLI **2.1.284**, angemeldetes **Max**, `claude-haiku-5-5` auf dem Mac. Die nativen interaktiven Anmeldungen sind `codex login` bzw. `claude auth login`; nicht in CI oder Logs nachbilden.
- Historisch brauchte der Koordinator übereinstimmenden Quellcode/Registry-Stand auf beiden Hosts. Aktuell bleibt die Mac-/Haiku-Lane gesperrt, bis R1 tatsächlich eine gemeinsame autoritative PostgreSQL-Policy und rechnerbezogene Purge-Bestätigungen bereitstellt. Keine API-Key-Ersatzroute, kein Modelltausch und keine kopierten Login-Verzeichnisse. Readiness-/Usage-Ausgaben nur in der vorgesehenen redigierten Projektion nutzen, keine Account-/Request-Dumps.
- Normalfall: konservative Quotensteuerung. Vier Haiku-Worker plus ein Codex-Worker waren ein **ausdrücklich vom Besitzer überwachter** historischer Lauf mit `--anthropic-workers 4 --owner-watches-quota`, keine pauschale Annahme freier Quote. Native Auth-/Rate-/Usage-Fehler stoppen die Lane; explizite Wiederaufnahme statt Retry-Sturm.
- Historischer erster echter Haiku-Stundenabschnitt: 174 erfolgreiche, fünf angehaltene Versuche; CLI-API-Preisindikator **21,4011012 USD**. Das ist **keine Max-Rechnung**, keine sichere Quotenanzeige und kein vollständiger Gesamtlaufpreis. Nicht erhaltene Codex-Tokens/Kosten bleiben unbekannt.
- Der hier bewiesene Offline-Replay und der kleine Live-Neucrawl verwendeten **keine neuen Modelle** und kauften keine neue Infrastruktur. Bestehende Workstation-/Abonnementkosten werden damit nicht als null erklärt. Messungen und ausdrücklich hypothetische API-/319-Kommunen-Szenarien stehen in [PIPELINE_PERFORMANCE.md](../reports/PIPELINE_PERFORMANCE.md).

## 7. Neue Eigentümerpolicy vom 11.10.2026

Diese Regeln beschreiben die neue Erwerbslane, nicht eine nachträgliche Änderung historischer Belege:

- Robots ist unter der expliziten globalen Betreiberentscheidung für registrierte öffentliche kommunale Quellen kein Sperrgrund mehr. Pro Host und Dokument bleiben **tatsächlicher Status** (`allowed`, `disallowed`, `unavailable`) und separat `override: owner-approved 2026-10-11` nachvollziehbar. Unverfügbarkeit wird nicht als Verbot oder Erlaubnis erfunden; ein Override ist keine Zustimmung der Kommune.
- Nie Anmeldung, CAPTCHA, Paywall, Auth-Token oder IP-/User-Agent-Tarnung umgehen. Identifikation und Kontakt bleiben ehrlich: `StadtstackData` mit `https://stadtstack.eu/kontakt`.
- Mindestens zwei Sekunden zwischen Starts pro Host, bei kommunalen/kleinen Servern mindestens fünf; eine Verbindung, auch über Prozesse hinweg. Conditional GET, persistente Sperr-/Backoff-Zustände, Stop bei 403/429 bzw. 5xx-Bursts. Keine angesammelten Anfrageguthaben oder Tageszeit-Spitzen.
- Herkunft wird vor Modellübertragung und Rohdatenbeibehaltung klassifiziert. Amtliche Werke nach der operativen Eigentümerpolicy können auch bei aufgezeichneter expliziter TDM-Reservierung verarbeitet werden. Drittanbieter-, gemischte und unklare Werke werden bei tatsächlichem Robots-Verbot oder expliziter Reservierung von Extraktion/Modellübertragung ausgeschlossen; neue Rohkopien werden verworfen. Unklar ist bis zur Klärung wie Drittanbieter zu behandeln.
- Eine Gemeindeseite oder ein Software-Producer wie Adobe macht einen fremden Bericht nicht automatisch amtlich. Titel/Linktext, institutionelle Herausgeberschaft, erste Seite und PDF-Metadaten liefern nur begrenzte Klassifikationsevidenz; bei Unsicherheit keine erfundene Rechtsfeststellung.
- Es werden Fakten, kurze Zitate und Quellenlinks veröffentlicht, **keine vollständigen Dokumentkopien**. Deklarierte TDM-Reservierungen bleiben gespeichert, auch wenn die Eigentümerpolicy für einen gebundenen amtlichen Fall Verarbeitung gestattet.
- Gültiger Widerspruch einer Kommune/eines Rechteinhabers: Host sofort stoppen; verwaltete Roh-/Volltextkopien spätestens binnen sieben Tagen löschen. Sichere Metadaten/Tombstones bleiben, unabhängige zulässige gemeinsame Provenienz wird ausdrücklich ausgewiesen. Teilweises/fehlgeschlagenes Löschen ist kein vollständiger Purge-Nachweis.
- Neue Lanes benötigen explizite Entscheidung und einen gebundenen Managed-Root-Marker. Ein passend benannter Ordner ist keine Freigabe; nichtleere unmarkierte alte Caches werden nicht automatisch umgedeutet. Aktuelle Opt-out-Prüfungen bleiben an Abruf-, Text-, Modell-, Cache- und Publikationsgrenzen nötig; ein Snapshot-Hash ersetzt sie nicht. Mehrere Rechner brauchen denselben autoritativen Einwendungsstand, keine unabhängigen stillschweigenden Leerlisten.
- Für den nächsten Lauf ist ausschließlich `codex-workstation` autoritativ: Erwerb, Vorbereitung und Codex-only-Extraktion dort; separat provisionierter Policy-/Opt-out-Zustand unter `/home/max/.local/state/stadtstack-data/civic-policy`, Authority-ID `owner-2026-10-11-codex-workstation`. Fehlender, fremder oder nicht erreichbarer Zustand sperrt die Verarbeitung. Ein späterer R1-Mehrrechnerbetrieb benötigt echte gemeinsame Autorität und Purge-Bestätigungen, nicht kopierte Marker.

Die globale Lane wird getrennt integriert/geprüft; ihre späteren Betriebsbefehle müssen die dort tatsächlich freigegebenen neuen Korpus-/Code-Pins und Pfade verwenden. Dieses historische Runbook erteilt keine automatische neue Korpusfreigabe.

## 8. Reihenfolge nach diesen Nachweisen

Die festgehaltene Reihenfolge bleibt: Werttestbericht und reproduzierbare Belege; danach der genehmigte Rebuild mit Jev-/Decisions-Triage, span-gebundener Evidenz, Batch-APIs, inkrementeller Verarbeitung und codebasiertem Runner. Anschließend konzentrische Erweiterung/Graph-Communities, danach Braid-Import. Geocodierte Rats-/Baustellen-/Planverknüpfungen und zusätzliche strukturierte Quellen sind nicht als bereits bewiesene Wirkung dieses historischen Replays ausgegeben.
