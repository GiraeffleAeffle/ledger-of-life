# Pipeline-Performance: Pilot, ETA und Skalierung auf 319 Kommunen

Stand: **11. Oktober 2026, 07:36 UTC / 09:36 Berlin**. Extraktion läuft weiter. Die Optimierungen in diesem Bericht sind **Planung nach dem Werttest**; nur die ausdrücklich beauftragte Haiku-Parallelisierung wird jetzt aktiviert. Es wurde keine 319-Kommunen-Erhebung gestartet.

**Leseregel:** „Gemessen“ bezeichnet tatsächliche Receipts, Zähler oder Tool-Laufzeiten. „Berechnet“ ist daraus nachvollziehbare Arithmetik. „Schätzung/Szenario“ nennt Annahmen und ist keine Zusage. Fehlende Messwerte bleiben unbekannt. Maschinenlesbare Zahlen und Annahmen stehen in [pipeline-performance-evidence.json](pipeline-performance-evidence.json); Quellenumfang und Grenzen in [pilot-coverage-completion.json](pilot-coverage-completion.json).

## 1. Kurzantwort und ETA

Der Engpass ist gegenwärtig **die serielle, mehrteilige LLM-Verarbeitung**, nicht das Schreiben des Graphen oder das Ausführen der 30 MCP-Fragen. Dokumente unterscheiden sich stark: im aktuellen vorbereiteten Korpus sind es im Median ein, im Mittel 4,34 und maximal 59 Textabschnitte pro Dokumentgruppe. Eine Gruppe ist hier **Kommune + identische Quelldatei-Bytes**, nicht jede URL-Kopie und nicht ein gelöstes Projekt.

### Gemessener Rückstand am 07:11:47 UTC

| Lane | Primärgruppen fertig / zugeteilt | Vereinbarungsprobe fertig / zugeteilt | Offene Aufgaben | Verbleibende Abschnitte |
| --- | ---: | ---: | ---: | ---: |
| Codex `gpt-6-luna` | 172 / 197 | 6 / 7 | 26 | 92 |
| Haiku `claude-haiku-5-5` | 27 / 179 | 1 / 14 | 165 | 664 |

Laufende Gruppen sind bei den verbleibenden Abschnitten vollständig enthalten; der Rückstand kann deshalb etwas überschätzt sein. Die 21 Doppelmodell-Aufgaben sind in diesen Zahlen enthalten. Alte erfolgreiche Codex-Ergebnisse werden wiederverwendet und sind **keine neuen Aufrufe**.

- **Mit einer Haiku-Lane:** 84 abgeschlossene Haiku-Abschnitte seit dem ersten echten Aufruf um 06:38:44 UTC ergeben bis zum Rückstandssnapshot rund **152 Abschnitte/h**. 664 / 152 ergibt **4,36 h Restlaufzeit** für Haiku. Für Codex ergibt die vorher gemessene neue Antwort-Rate von etwa 510 Extraktionsabschnitten/h ungefähr **0,18 h**. Das ist eine Mix-Schätzung, kein statistisches Konfidenzintervall.
- **Mit vier Haiku-Lanes:** rein lineare Rechnung **1,09 h Haiku-Restlaufzeit** für denselben Rückstand. **Vierfache Beschleunigung ist noch nicht gemessen.** Als Arbeitsreserve nach erfolgreicher Aktivierung sind **1,5–3 h Extraktion** vernünftig; Ausfälle, Authentifizierungs- oder Quotastopps haben keine endliche Garantie.
- **Aktueller Umbau:** Der Viererpool ist implementiert und getestet, ohne den aktiven Promptvertrag `174d4f5b…` zu verändern. Der erste Start pausierte korrekt bei unbekannt gewordener Quotenmetadaten-Frische. Die lokale OMP-Usage-Cache-Invalidierung vor der koordinierten Abfrage wurde korrigiert; zwölf dazugehörige Tests und die frische Abfrage bestanden. Der frische Messwert war **28 % maximale Nutzung über drei gemeldete Fenster**, ohne Warnstatus. Der Viererpool wurde danach erneut gestartet. Das ist noch kein belastbarer Parallelitäts-Benchmark.
- **Nachtrag 07:35 UTC:** Die frische Usage-Abfrage liefert inzwischen keine Limitberichte für das konfigurierte Anthropic-Konto (`accountsWithoutUsage`, keine gemeldete Rate-/Auth-Fehlermeldung). Der konservative Monitor hält deshalb aktuell **einen Worker**, nicht vier; ein laufender Haiku-Worker wurde beobachtet. Das ist keine belegte Quotenüberschreitung, aber auch kein Nachweis gesunder aktueller Limits. Die Vierer-ETA bleibt ausdrücklich bedingt; ohne erfolgreiche Hochskalierung gilt die langsamere Ein-Lane-Projektion.
- **Owner-Entscheidung nach diesem Befund:** Vier Haiku-Worker plus ein Codex-Worker sind ausdrücklich auch bei fehlenden OMP-Limitfenstern erlaubt, während der Owner die Limits selbst beobachtet. Der neue explizite Modus `--owner-watches-quota` behauptet keine gesunden unbekannten Metadaten; native Rate-/Usage-Limit-/Auth-Fehler und Owner-Stop pausieren weiterhin unmittelbar. Die Freigabe hebt den selbst gesetzten Metadaten-Blocker auf, nicht die Fakten-/Sicherheitsgates. Eine tatsächlich gemessene Vierer-Rate folgt erst aus dem laufenden Betrieb.
- **Rebalancing:** Weitere Codex-Arbeit auf Haiku zu schieben würde bei obiger Warteschlange den Engpass verschärfen. Zunächst vier Haiku-Worker und einen Codex-Worker nutzen; erst anhand neuer Abschnitts-/Tokenraten umverteilen, nicht anhand gleicher Dokumentanzahl.

### Die übrigen Phasen

| Phase | Messbasis | Rest / Planung |
| --- | --- | --- |
| Fakten **und Relationen** | Gemeinsamer Modellpass | Keine zweite vollständige Relationsextraktion einplanen. Relationstyp, Richtung, Modalität, Zeit und Zitate werden gemeinsam geprüft. |
| Gates, Datumsfilter, Graph-Artefakt, Manifest | Vorherige lokale Staging-/Publikationskette: **2,71 s** für den 86-Record-Kandidaten | Mechanik ist klein; für Prüfung neuer Beziehungen/Identitätsgruppen **5–15 min Planreserve**, nicht gemessen. Keine positiven Links erzwingen. |
| Erneute 30 Fragen | Tatsächliche 19-Tool-MCP-Abfrage des Zwischenstands: **541 Aufrufe in 1,51 s** über lokalen stdio-Prozess | Die Abfrage selbst dauert Sekunden. Einzelbewertungen, Quellenprüfung und gepaarter Graphvergleich sind der größere Teil; **30–90 min Arbeitsreserve**, bisher nicht separat gemessen. |
| Image-Build | Vorheriger erfolgreicher Multiarch-Job: **147 s**, davon Build/Push **118 s** | Keine Zusage für den nächsten Build. Neue Versionsbindung muss zusätzlich bestehen. |
| Review, exakte Image-/Live-Abnahme, governter Rollout | Frühere Abnahme vorhanden, aber kein vollständiger exklusiver Review-/Rollout-Timer | **30–90 min Arbeitsreserve nach Freigabe**, bei fehlendem privilegierten Slot oder einem Befund unbestimmt. |

Damit ist ein Release **nicht gleich dem Ende der Extraktion**. Unter stabiler Viererparallelität ist nach Aktivierung grob **weitere 2,5–6 h bis Werttest und Release** ein Planungsfenster, keine veröffentlichte Terminverpflichtung. Der Bericht wird nicht durch Erfinden fehlender Quellen, Aufweichen von Gates oder Zählen korrekter Enthaltungen als Nutzennachweis „grün“ gemacht.

Die letzte vollständig veröffentlichte **lokale** Kandidatenbasis hatte 86 datierte/gated Records aus allen neun Städten, aber keine zugelassene Relation. Das ist nicht mit dem bereits live stehenden 16-Tool-Release zu verwechseln. Neue private Kandidaten sind noch keine veröffentlichten Fakten.

## 2. Gemessenes Stufenprofil

### Umfang und Vorverarbeitung

- Autorisierter, publicness-geprüfter Gesamtkorpus: **5.193 Repräsentationen, 4.119 Kommune/Byte-Gruppen, 3.990 PDF-Repräsentationen**, neun Kommunen und 41 unveränderte Quellenidentitäten.
- Aktuell ausgewählt: **417 Gruppen / 677 Repräsentationen**; **376 vorbereitet**, **41 zurückgehalten** wegen fehlender bzw. über 80 liegender PDF-Seitenzahl. Das sind **9,83 % der ausgewählten Gruppen**, keine Irrelevanzlabels.
- Vorbereitete Gruppen: **73 HTML, 206 PDF-Text, 97 PDF mit OCR**. OCR betrifft **25,8 % aller vorbereiteten Gruppen**, bzw. **32,0 % der vorbereiteten PDFs**; nicht alle Seiten dieser PDFs wurden notwendigerweise OCR-behandelt.
- Quelldateien der vorbereiteten Auswahl: **404.819.050 Bytes**; Median 250.671 Bytes, Mittel 1.077 MB. Extrahierter Text: **5.888.420 UTF-16-Codeeinheiten**.
- Abschnittszahl: Median **1**, Mittel **4,34**, p90 **13**, p95 **22**, Maximum **59**. Aktuelle Segmentierung: höchstens 4.800 UTF-16-Einheiten, Zeilenbruchpräferenz und **800 Einheiten Überlappung**.

| Stufe / beobachteter Lauf | Tatsächliche Walltime | Ergebnis / zulässige Interpretation |
| --- | ---: | --- |
| Quellenzugriff / gezielte Ergänzung | Kein exklusiver HTTP-/Crawler-Timer rekonstruierbar | Zusammengeführte Checks melden 1.438 Requests bei 40/41 Quellen und 123 Runden bei 38 Checks. Das sind heterogene Zähler, **nicht nachweislich eindeutige kumulative Requests**. Keine erfundene Crawl-docs/h-Zahl. |
| Kleine Textvorbereitung | 42,40 s | 16 vorbereitet, 1 gehalten; ca. 1.358 vorbereitete Gruppen/h, Warm-/Kaltmix unbekannt. |
| 30-Dokumente-Auswahl je Kommune | 966,28 s | 209 vorbereitet / 18 gehalten; ca. **779 Gruppen/h**, keine isolierte OCR-Messung. |
| 60-Dokumente-Auswahl, ursprünglicher Korpus | 877,28 s | 365 vorbereitet / 42 gehalten; ca. 1.498 Gruppen/h, Cache-Wiederverwendung enthalten. |
| V8-Vorbereitung des ergänzten Korpus | 253,32 s | 376 vorbereitet / 41 gehalten; ca. **5.343 Gruppen/h im warmen Mischlauf**. Dies ist ausdrücklich kein kalter OCR-Durchsatz. |
| Deterministische Auswahl, Hash-Dedup, Typ-/Titelpriorität | In Vorbereitung enthalten, nicht separat getimt | Kein bezahlter Klassifikator läuft derzeit davor. Auswahl ist Priorisierung, kein bewiesener Relevanzfilter. |
| V7 Codex-Hälfte | 2.746,84 s | 108 Primärgruppen + 4 Proben; vorhandene Ergebnisse enthalten. Nicht alle Abschlüsse sind neue Inferenz. |
| V7 temporär Codex-only | 2.195,84 s, dann expliziter Resume 1.009,42 s | Erst 127/209, danach 209/209 vollständig; 165 Kandidaten, 86 nach Datumsfilter. Ein echter Modellfehler blieb in seiner inneren Ursache unbestimmt. |
| Weitere 60er-Auswahl V7 | 1.465,98 s | Bei 127/365 durch Tool-Versuch angehalten; kein unsafe Ergebnis übernommen. |
| V8 Codex-only bis zum beauftragten Splitwechsel | 5.878,15 s | 185/376 Aufgaben abgeschlossen; dann bewusst für den wieder verfügbaren Haiku-Split angehalten. |
| V8 echte Haiku-Aufrufe, erstes Messfenster | 677,217 s Start bis letzte Fertigmeldung | 44 erfolgreiche Aufrufe, sechs fertige Gruppen inkl. Probe, 28 Abschnitte; knapp **149 Abschnitte/h**. |
| Deterministische/semantische Gates | Inline, keine eigene Dauer gespeichert | Ablehnungen sind Qualitätsbefunde, nicht automatisch Ausführungsfehler oder irrelevante Dokumente. |
| Staging, Datumsfilter und Publikation des 86er-Kandidaten | 2,71 s | Echte lokale Publikation; keine manuelle Prüfung oder Live-Ausrollung darin. |
| Tests und Typprüfung | 7,14 s für 230 Tests + tsc; 2,98 s für 104 fokussierte Tests + tsc | Entwicklungs-Verifikation, keine Produktions-Inferenz. Weitere Pool-/Versionschecks wurden separat ausgeführt. |
| 30-Fragen-MCP-Erhebung, 19 Tools | 1,51 s / 541 erfolgreiche Aufrufe | Nur Retrieval, nicht die Einzelbewertung. Baseline hatte 373 erfolgreiche Aufrufe. |
| Vorheriger Image-Workflow | 147 s Job / 118 s Build+Push | [GitHub-Lauf 38094316300](https://github.com/GiraeffleAeffle/ledger-of-life/actions/runs/38094316300), 23:14:19–23:16:46 UTC am 10.10.2026. |

Nicht addieren: Vorbereitung, Crawl, Codex/Haiku und Entwicklungsarbeit liefen teilweise gleichzeitig. Die Summe von Prozess-Walltimes ist weder Projektzeit noch CPU-Zeit.

### Entwicklung gegenüber Produktionsverarbeitung

Eine **exakte Prozentaufteilung der Arbeitszeit** ist nicht vorhanden: keine durchgehende exklusive Zeiterfassung für Schreiben/Fixen, Reviews, menschliche Wartezeit und Authentifizierungsunterbrechungen. Sie wird hier nicht erfunden.

Für das enger belegte Fenster **01:00:42–06:50:11 UTC** lassen sich die protokollierten datenverarbeitenden Jobintervalle überlappungsfrei vereinigen: **15.442,784 s von 20.968,575 s = 73,65 % Fensterabdeckung**. Die übrigen **26,35 % sind nicht durch diese Jobintervalle zugeordnet**. Das ist **keine 74/26-Aufteilung „Produktion/Entwicklung“**: Entwicklung und Reviews können während laufender Modelle stattgefunden haben; separate Crawlzeiten fehlen, und Diagnose-/Vertragsänderungsläufe sind enthalten.

Die sachliche Folgerung ist dennoch klar: Schema-/Auth-/Adapter-/Versionskorrekturen und wiederholte Entwicklungsrunden gehören nicht in den Preis eines späteren unveränderten Code-Jobs. Künftig jedes Step-Receipt mit `startedAt`, `finishedAt`, Cache-Hit, Input-/Output-Hashes, Modell-Usage und Kategorie `production`/`evaluation`/`development` versehen; Parallelität als Intervalle und CPU-/Agentenzeit getrennt ausweisen.

## 3. Aufrufe, Tokens, Latenz, Quarantäne und Wiederholung

### Haiku: echtes erstes Messfenster, nicht repräsentativ für alle Kommunen

Die 44 Aufrufe zerfallen in **25 Primär-Extraktionen, 16 Primär-Judgments und 3 Proben-Extraktionen**. Fünf Primärgruppen und eine Probengruppe sind vollständig zuordenbar; die laufende Gruppe ist nicht eingerechnet.

| Metrik | Gemessener Wert |
| --- | ---: |
| Aufrufe pro fertiger Primärgruppe | **8,2** |
| Ungecachte Input-Tokens pro Primärgruppe | 16,4 |
| Cache-Write-Tokens pro Primärgruppe | **40.138,2** |
| Cache-Read-Tokens pro Primärgruppe | **35.430,6** |
| Output-Tokens pro Primärgruppe | **32.318,6** |
| Latenz pro CLI-Aufruf, Mittel | **15,325 s** |
| Median / p95 / Maximum | **8,151 / 36,325 / 61,089 s** |
| Abschnittsdurchsatz des ersten Fensters | **148,84/h** |
| Fertige Gruppen/h inkl. Probe | 31,90/h |

Die sechs Gruppen hatten **1 / 5 / 15 / 2 / 2 / 3 Abschnitte**. Die 15-Abschnitt-Gruppe allein benötigte 29 Aufrufe und rund 498 s. Ein ungewichteter Mittelwert über fünf Primärgruppen ist deshalb kein belastbarer Kommunenmittelwert.

Gesamtwerte der 44 Aufrufe: **88 ungecachte Input-, 217.187 Cache-Write-, 195.084 Cache-Read- und 162.203 Output-Tokens**. Die Top-Level- und `claude-haiku-5-5`-Sichten stimmen überein; **nicht addieren**. Fast null ungecachter Input heißt nicht fast null Kontext. Output kann abrechenbares Reasoning/Formatierungsarbeit einschließen, nicht nur sichtbare Zitat-JSONs.

Die CLI meldete hierfür **USD 5,0209248 API-Preisschätzung**. Das ist weder eine Max-Rechnung noch ein Quotenanteil. Mit aktuellen offiziellen API-Tarifen ergeben dieselben gemeldeten Kategorien unter Short-Context-Annahmen und je nach Cache-Write-TTL rechnerisch **USD 0,11021–0,12650 Standard**, bzw. **0,05510–0,06325 Batch bei identischer Usage**. Die Abweichung zur CLI-Schätzung ist nicht erklärt; sie ist **kein bewiesener Faktor-45-Kostenvorteil**. Cache-TTL, tatsächliche Rechnungspositionen und Batch-Hit-Verhalten müssen getrennt verifiziert werden.

### Codex: welche Messwerte fehlen

Bis 06:50 waren 142 Codex-Aufgabenergebnisse vorhanden, davon **104 schon vor dem Splitwechsel**. 38 neu materialisierte Ergebnisse enthielten 96 neue Extraktionsantworten und 15 wiederverwendete Extraktionsantworten. Im Zeitfenster lagen insgesamt **120 neue erfolgreiche Antwort-Caches: 96 Extraktion + 24 Judge**.

**Codex-Input-/Output-Tokens und echte Latenz je Aufruf sind unbekannt.** 2.455 untersuchte Antwort-Caches speicherten weder Usage noch Start/Dauer. Eine Antwortgröße oder Haiku-Tokenisierung wird nicht als Codex-Usage ausgegeben. Erfolgreiche neue Caches sind außerdem nur eine Untergrenze aller Aufrufe; abgebrochene/fehlgeschlagene Anfragen fehlen darin. Die etwa **510 neuen Extraktionsabschnitte/h** sind ein beobachteter Pipeline-Durchsatz, keine API-Latenz- oder Tokenmessung.

### Gates und Re-runs mit klaren Nennern

Der vollständig abgeschlossene historische 209-Gruppen-Lauf enthält **802 Abschnittsergebnisse**:

- **165 zugelassen**: 20,57 %.
- **280 „kein belegter Fall“**: 34,91 %.
- **357 sonstige Ablehnungen**: 44,51 %.
- Zusammen im Quarantänepfad: **637/802 = 79,43 %**, obwohl „kein Fall“ ein zulässiger Befund und kein Crash ist.
- Von 165 zugelassenen Kandidaten fehlte 79 eine ausreichend belegte vollständige Datumsrolle: **47,88 %** vor Publikation zurückgehalten; **86 veröffentlicht**.
- Dokumentebene: **65/209 Gruppen mit mindestens einem gated Record**, 24 ausschließlich „kein Fall“, 120 gemischt/andere Quarantäne.

Über sieben Pläne wurden 801 abgeschlossene Task-Verweise, aber nur **504 unterschiedliche Task-IDs und 331 Gruppen-IDs** gezählt. **297/801 = 37,08 % doppelte Task-Verweise sind Wiederverwendung**, nicht neue Modellkosten. Andere IDs können Modell, Zweck, Vorbereitung oder Promptvertrag unterscheiden; das ist nicht pauschal „Retry-Verschwendung“. Ein historischer Task hatte explizit `attempts=2`; daraus ist keine allgemeine Modell-Retryrate ableitbar.

## 4. Priorisierte Optimierung nach dem Werttest

| Maßnahme | Wirkung / Entwurf | Messung und Risiko |
| --- | --- | --- |
| **Freie Regeln und Dedup zuerst** | OParl-/Portal-Metadaten, Dokumenttyp, MIME, Dateiname, Titel, explizite öffentliche Beschluss-/Vorlagenkennung; exakte Inhalts-Hashes vor LLM. Canonical IDs/Versionen und Repräsentationen erhalten. | Nicht aus fehlendem Schlagwort auf Irrelevanz schließen. HTML-Vorlagen sind oft relevant. Gemeinsame PDF-Bytes sind keine unabhängige Bestätigung und müssen kommunal korrekt gebunden bleiben. |
| **Extraktive Referenzen statt Textkopieren** | Deterministisch nummerierte Sätze/Absätze/Datums- und Zahlenspannen. Modell liefert IDs und Typentscheidungen; Code rekonstruiert Originalzitat und UTF-16-Offsets aus gehashtem Quelltext. | Verhindert erfundene/umformatierte Zeichenfolgen, nicht die Auswahl der falschen Aussage oder falsche Akteurs-/Zeitrolle. Details in Abschnitt 5. |
| **Kaskade** | Billiger Klassifikator/Decision-Modell zuerst; unsicher, widersprüchlich, neues Format, schlechte OCR oder Modelle uneinig → Extraktion bzw. stärkeres Modell. | Kalibrierte Schwellen und gemessene Fehlkosten statt selbst gemeldeter LLM-Sicherheit. Bestehende Produktionsgates bleiben bis zu einem explizit evaluierten neuen Vertrag erhalten. |
| **Weniger wiederholter Kontext** | Mehrere unabhängige Entscheidungen mit gemeinsamem State; Generator/Judge pro logisch zusammengehörigem Abschnitt bzw. Dokument bündeln, statt unnötig viele Kleinstaufrufe. | Große Kontexte können teurer werden und falsche Fallvermischung fördern. Pro Record weiterhin eigenständige belegte Felder und tatsächliche Faithfulness-Bewertung. |
| **Prompt-Cache** | Stabile Tool-/Schema-/Systempräfixe; wechselnde Dokumentdaten hinten; keine unnötig wechselnden Arbeitsverzeichnis-/Sessiontexte im Cachepräfix. Provider-Usage messen. | Treffer sind nicht garantiert. Lokaler Antwortcache spart den ganzen Aufruf; Provider-Cache spart nur einen Tokenanteil. Wöchentliche Updates profitieren nicht automatisch vom Cache der Vorwoche. |
| **Inkrementell statt Vollneuaufbau** | Belegtes `modified_since`, ETags/Last-Modified, Content-Hashes und Parser-/Modell-/Promptversionen; unveränderte Dokumente nicht erneut modellieren. Rechte-/Policy-Checks bleiben aktuell. | API-Filter müssen tatsächlich unterstützt und getestet sein. Reine Betriebs-/Loggingänderungen sollten keine semantisch unveränderte Extraktion neu auslösen; alte Generationsprovenienz dabei niemals umetikettieren. |
| **Crawling nach Host parallelisieren** | Gemeinsamer Host-Limiter und faire Warteschlangen; mehrere unabhängige Hosts parallel, pro Host bestehende Politeness. Anonyme öffentliche Wicket-Sitzung korrekt erhalten. | Nicht pro Kommune einen unabhängigen Limiter auf denselben Amts-/Portalhost setzen. Kein Robots-/TDM-/Auth-Bypass und keine Vermischung von Amt und Gemeinde. |
| **OCR gezielt** | Textschicht zuerst; OCR nur auf tatsächlich textarmen Seiten, nicht pauschal ganzen PDFs. Empfangene Bytes, Text, OCR-Methode und Version hashen. | VM: 4 vCPU, ca. 7,75 GiB RAM, kein GPU-Benchmark. Mac: M4/10 logische CPUs/16 GiB. GPU-OCR bzw. Metal/GPU-Embeddings erst mit deutschem Scan-Sample messen; kein erfundener GPU-Durchsatz. |
| **Code-only Jobs** | Dauerhafte Queue, idempotente Zustandsübergänge, CAS für Bytes/Text, explizite Providerlimits, leases/cancellation, reproduzierbare Gates und manifest-last Publication. | Agenten nur für Entwicklung/Fehleranalyse, nicht als permanente Verarbeitungsschleife. Vorschlag in Abschnitt 8. |

## 5. Triage: hoher Recall und Belegauswahl als Entscheidung

### Reihenfolge

1. **Quellen-/Rechte-/Öffentlichkeitsgrenzen vor Inhalts-KI.** Nichtöffentliche oder reservierte Quellen sind keine „irrelevanten“ Trainingsbeispiele; ihre Sperre kann kein Klassifikator überstimmen.
2. **Kostenlose eindeutige Regeln:** exakte Duplikate überspringen und verknüpfen; eindeutig technische Login-/Kontakt-/Navigationseiten aussortieren; verlässliche OParl-/Vorlagentypen, Titel und Kennungen nutzen. Fehlendes Schlüsselwort allein verwirft keinen Fall.
3. **Billiger Klassifikator für den Rest**, mehrlabelige Themen und Relevanzwahrscheinlichkeit. **Grenzfälle gehen in die Extraktion.** Präzision wird später durch die Fakten-/Zitat-/Datums-/Faithfulness-Gates hergestellt.
4. **Stufe und Belege nicht aus bloßer Themenähnlichkeit ableiten.** Falls Dokument mehrere Fälle/Termine enthält oder eine Rollenentscheidung unsicher ist, an vollständige Extraktion eskalieren.

### Vergleich der fünf Optionen

| Option | Fehlklassifikationsrisiko | Kosten | Geschwindigkeit / Voraussetzung |
| --- | --- | --- | --- |
| **Lokale Embeddings + kleiner trainierter Klassifikator** | Seltene kommunale Begriffe, neue Quellen, OCR und Drift; falsche Negativlabels aus Quarantäne würden Fehler systematisieren. | Embeddings einmal pro Content-/Modellhash, kleine Klassifikatorinferenz, Label-/Training-/Auditkosten. Vollkosten nicht gemessen. | Encoder dominiert; lineare Klassifikation ist klein. Eigentümer-GPU/Metal-Modell und Batchgröße noch nicht benchmarked, daher kein seriöser konkreter docs/h-Wert. |
| **Zero-shot über Embeddings** | Cosinus ist keine kalibrierte Wahrscheinlichkeit. Negation, Zeitpunkt und „beschlossen“ versus „umgesetzt“ werden leicht verwechselt; Prototypenwahl erzeugt Bias. | Gleicher Encoderaufwand, kein überwachtes Training; Kalibrierung und Audit bleiben nötig. | Schnell nach vorhandenen Embeddings, aber Korpus-/GPU-Latenz ungemessen. Für grobe Kandidatensuche, nicht allein für finale Stufen. |
| **Nano/Mini-LLM-Klassifikation** | Generative Fehler, Selbstsicherheit und zusätzliche Reasoning-/Outputtokens; kleine Modellnamen garantieren weder geringsten Preis noch besseren Recall. | Synthetischer Vergleich: 1.000 Aufrufe mit je 10k Input + 200 Output kosten laut aktueller Preistabelle etwa **USD 2,25 (`gpt-5.4-nano`) / 8,40 (`gpt-5.4-mini`)**; kein Qualitätsgleichstand behauptet. | Eigene Korpus-Latenz ungemessen; deutlich mehr Freiheit als nötige Entscheidungs-IDs. [OpenAI-Preise](https://developers.openai.com/api/docs/pricing). |
| **OpenAI Decisions API** | Typisierte Antwort kann trotzdem falsches Thema, falschen Satz oder falsche Stufe wählen. Domain-Kalibrierung bleibt nötig. | **USD 0,10/M Input**, keine Output-/Cache-Zeilenkosten; >272k Input zweifacher Inputpreis für den ganzen Request. Keine dokumentierte Batch-Unterstützung dieses Endpunkts. | `POST /v1/decisions`, Public Beta, **nur `gpt-6-luna`**. Predicate/Choice/Score mit Wahrscheinlichkeiten. „Etwa 10× schneller als Responses“ ist Anbieterangabe, kein Pilotbenchmark. API-Key mit Spend-Cap erforderlich. |
| **TypeSafe Jev** | Primär englische Trainingsausrichtung, deutsches Kommunalrecht/OCR/Datumsordnung, Auswahlreihenfolge und indirekte Aussagen müssen auditiert werden. Typensicherheit ist keine Wahrheit. | **USD 0,042/M Input, Outputs frei**. Keine angenommene Batch-/Cacheermäßigung. | Anbieter nennt **70–500 ms**, meist West-Coast-nahe Messung; nicht in Berlin mit unseren Dokumenten gemessen. Early Access; aktuell `jev-1.13.0` pinnen. Text-only, dynamische 100k Tokens/s und 80 Requests/s laut Doku, keine Owner-Quota-Zusage. |

Primärquellen: [Decisions Guide](https://developers.openai.com/api/docs/guides/decisions), [Decisions Reference](https://developers.openai.com/api/reference/resources/decisions), [Jev-Ankündigung](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Jev API](https://docs.typesafe.ai/api), [Jev Modelle](https://docs.typesafe.ai/models), [Jev Grenzen](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

### Extraktive Grounding-Choices für beide Decision APIs

**Beide** Choice-Interfaces erlauben höchstens **255 Optionen**. Drei Plätze für `none`, `missing` und `uncertain` reservieren: höchstens **252 echte Span-IDs pro Frage**.

- Der Parser erzeugt deterministische Satz-/Absatz-IDs mit Originaltext-Hash, Seiten-/Abschnittsbezug und UTF-16-Start/Ende. Das Decision-Modell wählt IDs, keine selbst geschriebenen Zitate.
- Für längere Dokumente: zuerst relevante Abschnittsgruppen auswählen, dann Sätze/Spannen innerhalb dieser Gruppen. Kandidaten-Retrieval-Recall zählt zum End-to-End-Recall; ein zu kleines Top-k darf seltene Belege nicht unsichtbar machen.
- Mehrere Belege: wiederholte Choice mit Entfernen bereits gewählter IDs und `stop`, oder unabhängige Kandidaten-Predicates mit kalibrierten Schwellen. Abhängige Entscheidungen brauchen getrennte Wellen; Kontext/Selektoren jeder Welle werden mitgerechnet.
- Thema, Stufe, Datum **und Datumsrolle** als getrennte Entscheidungen; Quelle kann auch `unknown` ergeben. Für Relationen nur tatsächlich im selben Satz/Zitat verbundene Kandidaten mit Richtung, Modalität und Bedingungen erzeugen.
- Code rekonstruiert jede Zeichenfolge aus dem Original. **Damit besteht die wörtliche Substring-Prüfung durch Konstruktion.** Ob der Satz den behaupteten Sachverhalt trägt, die richtige Kommune/Akteursrolle meint und einen Plan statt tatsächlicher Umsetzung beschreibt, bleibt eine semantische Prüfung.
- Bei Jev wird der Frage-Key nicht dem eigentlichen Modell übergeben: Bedeutung, Ziel und Kandidaten müssen ausdrücklich in Instructions/State/Criteria stehen. Maximal 64k Tokens gesamt und 32k für State plus längste Frage beachten.
- Nur residuale oder strittige Fälle gehen in generative Extraktion/stärkere Modelle. Ein neuer Decision-basierter Verifikationsvertrag benötigt vor Produktion eine eigene Evaluation und ehrliche Provenienz; kein erfundener bisheriger LLM-Judge-Score.

### Präzision/Recall: jetzt verfügbare Labels und ehrlicher Messplan

Bestehende Gate-Ergebnisse werden als **Weak Labels** verwendet: **65 positive Gruppen**, **24 Kandidaten für negative Labels**, **120 unklare/gemischte Gruppen** im abgeschlossenen 209er-Lauf. „Kein Fall“ muss vor Verwendung als Gold-negativ geprüft werden. Schema-/Zitat-/Datumsfehler, technische Holds und fehlende Veröffentlichungsdaten sind **keine Irrelevanzlabels**.

**Für keinen der fünf Triage-Vergleiche liegen momentan gepaarte Predictions und unabhängig adjudizierte Goldlabels vor. Gemessene Präzision, Recall und Korpuslatenz sind daher nicht verfügbar.** Sie werden nicht aus Gate-Pass-Raten erfunden. Die 30 Praxisfragen sind kein Dokumentklassifikations-Goldset.

Nach dem Werttest:

1. Die 24 Kandidaten-negativen vollständig prüfen, positive/unklare Gruppen stratifiziert ergänzen; menschliche Kriterien für Relevanz, Themen, Fall/Stufe und genügende Belegspannen einfrieren. Ambiguitäten doppelt prüfen, blind gegenüber Modellvorhersagen.
2. Train/Kalibrierung/Test nach **Content-Hash und Dokument-/Fallfamilie** trennen, damit Kopien und Abschnitte nicht leaken. Kommune-/Quellenfamilien-Holdout und zeitlich neuere Fälle zusätzlich ausweisen.
3. Auf Kalibrierungsdaten die aggressivste Ablehnungsschwelle wählen, deren **einseitige 95%-Untergrenze des Recalls** das vorab beschlossene Ziel hält. Beispielziel 99 % ist noch nicht erreicht. Selbst 65 unabhängige echte Positive ohne einen Fehler belegten nur etwa 95,5 % Untergrenze; für 99 % wären bei null Fehlern mindestens **299 unabhängige Positive** nötig.
4. TP/FP/FN/TN, Präzision `TP/(TP+FP)`, Recall `TP/(TP+FN)`, Ablehnungsquote, Abstention, Kosten und Laufzeit berichten. Themen-Makro/Mikro-Recall, Stufen-Verwechslungen/falsche Finalisierung sowie Beleg-Kandidatenrecall und Auswahlpräzision getrennt messen. Wilson/exakte Intervalle bzw. gruppierten Bootstrap, Brier/Log-Loss und Reliability-Plots ergänzen.
5. **In jedem Lauf** reproduzierbar zufällige verworfene Dokumente mit bekannten Ziehungswahrscheinlichkeiten auditieren; zusätzlich seltene Themen/neue Quellen/Grenzfälle überschichten. Gefundene relevante Verluste oder verfehlte Untergrenze stoppen harte Ablehnung; Originale bleiben für Wiederaufnahme erhalten. Null gefundene Fehler heißt nicht Nullrisiko.

**Präzisions-/Recall-Messung blockierende Voraussetzungen:** ausdrücklich autorisierter OpenAI-Key mit Endpointzugang und festem Spend-Cap; Jev-Early-Access-Zugang/API-Key, Zustimmung zur Verarbeitung geeigneter öffentlicher Dokumente in den USA und akzeptierte Retention/DPA; ein adjudiziertes Testset. Keine Anmeldung, kein Key-Zugriff und kein kostenpflichtiger Test wurden dafür vorgenommen. Öffentliche Dokumente können weiterhin personenbezogene Daten enthalten.

## 6. Batch APIs und Prompt-Caching statt CLI-Abrechnung

### Aktuelle dokumentierte Short-Context-Preise

USD pro Million Tokens; Cache-Kategorien sind exklusiv, kein Aufschlag zusätzlich auf dieselben Input-Tokens.

| Modell / Modus | Normaler Input | Cache Write | Cache Read | Output |
| --- | ---: | ---: | ---: | ---: |
| `gpt-6-luna` Standard | 0,10 | 0,125 | 0,01 | 0,50 |
| `gpt-6-luna` Batch | 0,05 | 0,0625 | 0,005 | 0,25 |
| `claude-haiku-5-5` Standard | 0,10 | 0,125 (5 min) / 0,20 (1 h) | 0,01 | 0,50 |
| `claude-haiku-5-5` Batch | 0,05 | 0,0625 (5 min) / 0,10 (1 h) | 0,005 | 0,25 |
| `claude-sonnet-5-5` als stärkeres Beispiel, Batch | 1,00 | 1,25 (5 min) / 2,00 (1 h) | 0,05 | 5,00 |

Exakte aktuelle Modelle sind in den offiziellen Batch-Unterlagen unterstützt. Luna hat oberhalb 272k Input einen ganzheitlichen Long-Context-Aufschlag; Haiku oberhalb **100k Prompt-Tokens inklusive Cache Read/Write** einen **5×-Aufschlag auf alle Tokenpreise**. Geografieaufschläge und verfügbare Regionen kommen ggf. hinzu. [OpenAI-Modelldoku](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI-Preise](https://developers.openai.com/api/docs/pricing), [Anthropic-Preise](https://platform.claude.com/docs/en/about-claude/pricing).

| Thema | OpenAI Batch | Anthropic Message Batches |
| --- | --- | --- |
| Preis | 50 % der entsprechenden Standardraten | 50 %, mit dokumentierten Cache-/Kontext-/Geografie-Multiplikatoren |
| Größe | 50.000 Requests / 200 MB je Datei | 100.000 Requests / 256 MB, erste Grenze zählt |
| Zeit | Derzeit `completion_window=24h`; unerledigte Requests können auslaufen | „Die meisten innerhalb einer Stunde“ ist Best Effort; Ablauf nach 24 h |
| Limits | Separate per-model Queue in Input-Tokens; veröffentlichte Luna-Build-Beispielquota 20 Mio. Tokens | Separate Batch-RPM und Queue-Request-Limits; veröffentlichte Start-Beispiele 1.000 HTTP-RPM / 200.000 wartende Requests |
| Owner-Entitlement | Nicht verifiziert | Nicht verifiziert; Organisation/Workspace/Acceleration-Limits gelten |
| Daten | Batch nicht ZDR-fähig; Output-Dateien typischerweise 30 Tage abrufbar, sonstige State-/Dateiregeln getrennt | Batch nicht ZDR/HIPAA-fähig; Requests/Ergebnisse bis 29 Tage, früheres Löschen möglich |

Quellen: [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch), [OpenAI Datenkontrollen](https://developers.openai.com/api/docs/guides/your-data), [Anthropic Batch](https://platform.claude.com/docs/en/build-with-claude/batch-processing), [Anthropic Limits](https://platform.claude.com/docs/en/api/rate-limits), [Anthropic Retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).

**24 h sind keine verifizierte vertragliche Erfolgsgarantie für jeden Request oder die gesamte Pipeline.** Generator und abhängiger Judge können zwei Wellen benötigen; ein Vollprozess kann also mehr als 24 h beanspruchen. Eingabedateigröße und tatsächliche Queue-Quota erfordern ggf. weitere Shards. Ergebnisse nach stabiler `custom_id` zuordnen, Teilerfolge behalten und nicht ganze Batches blind neu senden.

**Decisions ist hiervon getrennt:** `/v1/decisions` fehlt auf der dokumentierten Batch-Endpointliste. Deshalb dafür **keinen 50%-Batchrabatt** rechnen. Jev-Multiquestion-Packing ist ebenfalls kein nachgewiesener asynchroner Batchdienst.

Caching: Luna braucht ein identisches cachefähiges Präfix ab 1.024 Tokens; aktueller dokumentierter Mindest-TTL 30 min. Haiku ab 512 Tokens, 5-min-/1-h-Schreibklassen. Batch-Reihenfolge und Nebenläufigkeit garantieren keinen Treffer. [OpenAI Cache](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic Cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

**Abo ist nicht API-Abrechnung.** [ChatGPT und API haben getrennte Abrechnung](https://help.openai.com/en/articles/9039756). Für Max sind inzwischen [monatliche API-Credits dokumentiert](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans), aber nur bei Berechtigung und ausdrücklicher Verknüpfung/Beanspruchung; sie ändern nicht die CLI-Quoten. Owner-Tier, Anspruch und Guthaben wurden nicht geprüft. Die folgenden Preise sind daher **brutto modellierte API-Listenpreise**, ohne Abzug hypothetischer Credits und nicht zusätzlich behauptete reale Aboausgaben.

## 7. Rechenplan für 319 Kommunen

### Nicht beobachtete, explizite Szenarioannahmen

Ein repräsentatives Dokumentvolumen oder eine Wochenänderungsrate für 319 Kommunen ist **nicht gemessen**. Der Pilot ist gezielt ausgewählt und unterschiedlich vollständig; die Ergänzung von 2.842 auf 5.193 Repräsentationen ist Backfill/Discovery, nicht eine Wochenwachstumsrate.

Drei Szenarien verwenden 100 / 250 / 1.000 **eindeutige, policy-zulässige** Dokumentgruppen je Kommune initial und 2 / 5 / 20 geänderte Gruppen pro Woche. Nach kostenlosen Regeln gehen alle restlichen Gruppen in eine billige Triage. Annahmen pro Gruppe:

- 2.000 Input-Tokens für Triage; **70 %** gehen weiter.
- 8.000 weitere Input-Tokens pro weitergeleiteter Gruppe für Beleg-/Stufenwahl; sämtliche Selektoren/Fragen müssen in diesem Budget enthalten sein.
- **20 %** der weitergeleiteten Gruppen benötigen zusätzlich generative Residualarbeit: zusammen 16k Input und 1k abrechenbarer Output über Extraktion + Judge. Batch-Kalkulation konservativ mit Cache-Write-Inputpreis: **USD 0,00125 pro Residualgruppe**.
- **10 % der Residualgruppen** erhalten zusätzlich einen stärkeren Sonnet-5.5-Batch-Aufruf mit 8k Write-Input + 1k Output: **USD 0,015**.
- Kein garantierter Cache-Hit, kein Long-Context-/Geografieaufschlag, keine Retries. **70/20/10 sind ungeprüfte Planannahmen, keine erreichte Klassifikatorleistung.** Vor validiertem Recall wird nicht aggressiv verworfen.

Mit `p=0,7`, `r=0,2`, `s=0,1` und Decision-Inputpreis `q` ergibt sich je Ausgangsgruppe:

`C = (2000 + p×8000)×q/1.000.000 + p×r×0,00125 + p×r×s×0,015`.

Das sind **USD 0,0007042 mit Jev** oder **0,001145 mit OpenAI Decisions** unter exakt diesen Annahmen.

| Szenario | Initial / wöchentlich je Kommune | Initiale Gruppen gesamt | Jev: initial je Kommune / gesamt | Decisions: initial je Kommune / gesamt | Wöchentlich alle 319: Jev / Decisions |
| --- | --- | ---: | ---: | ---: | ---: |
| Klein | 100 / 2 | 31.900 | USD 0,070 / 22,46 | USD 0,115 / 36,53 | USD 0,45 / 0,73 |
| Mittel | 250 / 5 | 79.750 | USD 0,176 / 56,16 | USD 0,286 / 91,31 | USD 1,12 / 1,83 |
| Groß | 1.000 / 20 | 319.000 | USD 0,704 / 224,64 | USD 1,145 / 365,26 | USD 4,49 / 7,31 |

Mittleres Szenario, erstes Jahr einschließlich 52 unveränderter Wochenannahmen: etwa **USD 114,57 Jev-Variante / 186,28 Decisions-Variante** an modellierten API-Tokenkosten. Nicht mit tatsächlichen Gesamtkosten verwechseln.

**Sensitivität:** Müssen statt 20 % alle behaltenen Gruppen generativ bearbeitet werden, steigt die Jev-Rechnung unter denselben übrigen Tokenannahmen auf etwa USD 0,0022442 je Ausgangsgruppe, also **USD 178,97 initial** im mittleren Szenario. Bleiben die heutigen langen freien Outputs erhalten, liegt allein die konditionale Batch-Kalkulation aus dem kleinen Haiku-Sample bei rund **USD 0,0108–0,0123 pro vollständig verarbeiteter Gruppe**; dieser nicht repräsentative Workload darf nicht mit der span-basierten Zielarchitektur gleichgesetzt werden.

Nicht enthalten und aktuell nicht seriös pro Kommune bezifferbar: Strom/Server, Speicher/Traffic, Entwicklung, Daten-/Quellenpflege, menschliche Adjudikation und Fehlerfolgekosten. Vollkosten separat rechnen:

`API + CPU/GPU-Stunden×Stundensatz + GB-Monate/Traffic + Auditzeit×Stundensatz + amortisierte Entwicklung/319`.

### Erwarteter Durchsatz: bedingtes Kapazitätsmodell, kein Versprechen

- Beobachtete Abschnittsraten umgerechnet mit dem gemessenen Mittel von 4,34 Abschnitten: ungefähr **34–35 Dokumentgruppen/h pro einzelner Haiku-Lane**, ungefähr **118/h Codex**. Vier Haiku-Lanes plus eine Codex-Lane ergeben rechnerisch **ca. 250–260 vollständige LLM-Dokumentäquivalente/h**, sofern Parallelität linear trägt. Das ist noch keine gemessene Fünf-Lane-Rate.
- Wenn in obigem Szenario nur `0,7×0,2=14 %` solche Residualarbeit benötigen, ergibt die LLM-Stufe allein ungefähr **1.800 Ausgangsdokumente/h**. Ein **Planungsziel von 1.000–2.000/h** für die Code-Pipeline ist deshalb rechnerisch nachvollziehbar, aber nur wenn Crawl/OCR/Decision-API/Quota nachweislich mithalten. Keine gemessene Leistung der Zielpipeline.
- Mittlerer Backfill 79.750 Gruppen: bei diesem Ziel **ca. 40–80 Betriebsstunden**; wöchentlich 1.595 Änderungen **ca. 0,8–1,6 h**, jeweils plus ungelöste Quellen-/OCR-/Reviewwartezeit. Kalte OCR kann der Engpass werden; der warme 5.343/h-Wert ist dafür kein Beleg.
- Bei Batch APIs ist eine pauschale garantierte docs/h-Zahl nicht ableitbar. Pro Welle mit bis zu 24 h und möglichem Ablauf planen, tatsächliche Erfolgsquote und Durchsatz anschließend messen; nicht Queuegröße durch einen behaupteten SLA teilen.
- Für jede synchrone Decision-Stufe gilt als Obergrenze: `min(Parallelität / mittlere Latenz, Requestlimit, Tokenlimit / Inputtokens je Request)`, anschließend durch Requests pro Dokument teilen. Vendor-Latenz, Kontextgrenzen und Owner-Quota ersetzen keinen lokalen Test.

## 8. Code-only Betrieb ohne Agenten im Verarbeitungsloop

Empfohlene Zustandsmaschine:

`Discovery → Policy/Publicness → Hash/CAS → Text/OCR → Regeln/Triage → Belegwahl/Extraktion → Gates/Judge → Graph/Manifest → MCP-Release`.

- Auf der Workstation zunächst dauerhafte SQLite-/Postgres-Queue und CAS; im Cluster dieselben Steps als begrenzte Worker/CronJobs mit dauerhafter Datenbank und Objektstore. Kein Agent muss Dokument für Dokument steuern.
- Idempotency-Key aus Quellbytes, relevantem Parser-/Prompt-/Schema-/Modellvertrag und Policy-Proof. Semantische Antwort-Caches von Betriebsinstrumentierung unterscheiden; alte Generationsprovenienz bewahren und neue Gates explizit neu prüfen.
- Eigene Queues für host-limitiertes Fetching, CPU-OCR, billige Decisions und generative Residualfälle. Globale Provider-/Host-Limits, Lease/Heartbeat, kontrollierte Pause, Dead-letter/Quarantäne und **keine stillen Retries/Modellwechsel**.
- Versions-/ETag-Änderungen lösen nur betroffene Stufen aus. Änderungen von Parser oder Gates führen zu gezielter Neubewertung, nicht pauschal erneutem Download und erneutem Modellaufruf jedes Dokuments.
- Veröffentlichung atomar und manifestgebunden. Die 19-Tool-Version bindet **Git-/Image-Tag, `serverInfo.version` und `get_release_status.release.version` auf denselben Wert `0.3.0`**, zusätzlich `release.dataManifestId == dataManifest.id`; Image- und Live-Smoke müssen dies beweisen. Noch keine neue Live-Abnahme behauptet.
- Quotenschutz: angeforderte vier Haiku-Worker nur mit frischen gesunden Metadaten; Warnung, mindestens 80 % gemeldete Fensternutzung, verlorene/stale Metadaten nach Skalierung oder tatsächlicher nativer Ratefehler pausieren. Ein nicht exponierter erfolgreicher nativer Advisory, der auch nicht in den Quotenmetadaten erscheint, ist eine ausdrücklich dokumentierte Beobachtungslücke; kein universelles Warnungsversprechen.

## 9. Entscheidung nach dem Werttest

Zuerst die laufende, unveränderte Fakten-/Relationsqualität und die 30 echten Praxisfragen fertigstellen. Danach denselben adjudizierten, recall-orientierten Test für lokale Embeddings, Zero-shot, Nano/Mini, **Decisions und Jev** durchführen. Auswahl anhand **verpasster relevanter Fälle, falscher finaler Stufen, ausreichender Belege, Kosten und p95-Latenz**, nicht anhand typensicherer Demoausgabe oder eines niedrigen Listenpreises.

Der größte plausible Hebel ist: **weniger unnötige Dokumente und weniger frei generierte Wiederholungen pro relevantem Dokument**, gefolgt von inkrementellem Wiederverwenden und passender Parallelität. Der noch fehlende Nachweis ist die gemessene Recall-/Qualitätskurve dieser Zielarchitektur auf unserem Material. Dieser Bericht ersetzt sie nicht.

## 10. Nachtrag: Hoppegarten-Zählung und drei konkrete Relationsablehnungen

Stand dieser Nachprüfung: **08:07–08:11 UTC am 11.10.2026**. Es handelt sich um den laufenden v8-Plan, nicht um eine neue Veröffentlichung.

### Hoppegarten: 26 → 3 war kein nachgewiesener Datenverlust

Die 26 stammten aus dem vollständig publizierten lokalen v7-Kandidaten; die 3 aus einem **noch unvollständigen v8-Snapshot abgeschlossener Primäraufgaben**. Bei der frühen Momentaufnahme gehörten 25 der alten Records zu noch nicht fertigen Dokumenten: 24 zum Schulcampus-PDF und einer zu einer Beteiligungsbekanntmachung. Diese Ergebnisse wurden um 07:54:35 bzw. 08:03:06 UTC abgeschlossen.

Um 08:07 waren für Hoppegarten **14 Primärgruppen abgeschlossen, zwei ausstehend**, mit **37 gated Kandidaten, davon 36 datumsgeeignet**. Die alte Schulcampus-Quelle hat nun 32 statt 24 datumsgeeignete Records. Die lokale `out/`-Publikation blieb währenddessen unverändert bei 26 Hoppegarten-Records.

- Die ursprünglichen **19 Repräsentationen / 18 Byte-Gruppen und vier Quellenchecks sind exakt erhalten**. Beide Vorbereitungen enthalten dieselben 16 Gruppen; dieselben zwei PDFs scheitern bereits an der bestehenden 80-Seiten-Grenze.
- Alle neun Publicness-Ausschlüsse betreffen Parchim, keinen Hoppegarten-Inhalt.
- Ein alter Schulcampus-Abschnitt wurde tatsächlich neu abgelehnt: Faithfulness **0,72 < 0,8**, weil Themen aus einem anderen benannten Plan zugeschrieben wurden. Ein alter Reitschul-Abschnitt scheiterte am Schema; der Fall ist in einem anderen Abschnitt weiter vertreten. Das ist nicht die Behauptung, jede alte Aussage sei identisch zurückgekehrt.
- **Recordanzahl ist nicht Projektanzahl:** Die alten 24 Schulcampus-Records umfassten 23 wiederholte `source_document`-Fallschlüssel plus eine Behördenreferenz; die neuen 32 sind 30 + 2. Ein langes Quelldokument kann mehrere belegte Aussagen liefern, aber daraus werden nicht 32 Projekte.

Kein Public-Record-Entfernungsbug wurde für den temporären Rückgang festgestellt; kein Filter wurde deshalb abgeschwächt. Vollständige Quell-/Task-/Hash-Zuordnung: [hoppegarten-count-trace.json](hoppegarten-count-trace.json).

### Was der Relationsvertrag tatsächlich prüft

Ja: **beide unterschiedlichen benannten Endpunkte und die `predicateQuote` müssen in derselben exakten zusammenhängenden `relation.quote` stehen**. Zusätzlich gibt es eine typbezogene lexikalische Vorprüfung sowie gequotete Zeit/Bedingungen, Modalität und anschließend die tatsächliche semantische Faithfulness-Prüfung. Es ist nicht bloß Co-Occurrence und auch kein späterer Graph aus Zusammenfassungen. Die lexikalische Zusatzprüfung kann ihrerseits False Negatives erzeugen; sie ist deshalb hier ausdrücklich sichtbar.

Die drei folgenden v8-Kandidaten bestanden die ursprünglichen 17 Checks, `graph_mentions`, `graph_identifiers` und `graph_modality`, scheiterten jedoch an **`graph_relations`**. Für alle drei gilt die gespeicherte Begründung **„Not evaluated: deterministic gate failed“**: **kein Judge-Aufruf, kein erfundener Judge-Score**.

#### Beispiel A — Hoppegarten: Name und Rolle nicht vollständig in der Relation belegt

[Artenschutzrechtlicher Fachbeitrag zum Schulcampus](https://bb.beteiligung.diplanung.de/file/eb568622-04ec-41e7-8069-fd8204fa88d8/d9fc08f0-745a-44de-8f7a-a103b05fca42), Quell-SHA `c85920d0e960…`.

```text
in der
Gemeinde Hoppegarten sollen die planungsrechtlichen Voraussetzungen für die
Realisierung eines Schulcampus geschaffen werden
```

Extrahiert wurde `Gemeinde Hoppegarten → Schulcampus Lindenallee / Virchowstraße`, Typ `implements`, Modalität `planned`, Prädikat `Realisierung`. **Der vollständige Zielname steht nicht in diesem Relationszitat**, nur „eines Schulcampus“. Außerdem nennt es die Schaffung planungsrechtlicher Voraussetzungen in der Gemeinde, nicht ausdrücklich die Gemeinde als Bauausführende. `Realisierung` ist zusätzlich nicht in der bisherigen Verb-Vorprüfung. Das ist ein nicht ausreichend belegter eingereichter Link, keine Widerlegung des öffentlichen Projekts.

#### Beispiel B — Rüdersdorf: falscher/ungeklärter Endpunkt und außerhalb liegendes Verb

[B-Plan 53 Biomassezentrum Hennickendorf](https://bb.beteiligung.diplanung.de/file/bplan53biomassezentrum/e6faed08-e753-4817-b275-3ba37c937150), Quell-SHA `13c1dbe60a835…`.

```text
die Berliner
Stadtreinigungsbetriebe AöR (BSR) die Kompostier- und Biogasanlage Hennickendorf
```

Extrahiert wurde `Berliner Stadtreinigungsbetriebe AöR → Biomassezentrum Hennickendorf`, Typ `operates`, Modalität `asserted`, Prädikat `betreiben`. **Weder der gewählte Zielname noch `betreiben` stehen in genau diesem Relationszitat.** Das Verb kommt irgendwo im größeren Ausschnitt vor, was die allgemeine Zitatprüfung nicht zur richtigen Relationsbindung macht. „Kompostier- und Biogasanlage“ und „Biomassezentrum“ dürfen nicht ohne Identitätsbeleg gleichgesetzt werden. Hier ist die eingereichte Extraktion falsch gebunden; der zugrunde liegende reale Betreiberzusammenhang ist damit nicht widerlegt.

#### Beispiel C — Strausberg: plausible lexikalische Vertragsgrenze, noch keine semantische Freigabe

[B-Plan 66/21 Hegermühlenstraße Ost](https://bb.beteiligung.diplanung.de/file/strausberg-hegermuehlenstrasse-ost/cca2b6b6-728b-47f2-8543-04cb4ecaa52b), Quell-SHA `cd2dd4d16f485…`.

```text
Die Stadt Strausberg plant den Ausbau der Hegermühlenstraße mit der Anlage beidseitiger Geh- und
Radwege
```

Extrahiert wurde `Stadt Strausberg → Hegermühlenstraße`, Typ `implements`, Modalität `planned`, Prädikat `plant den Ausbau`. **Beide Namen und die tatsächliche Handlungsphrase stehen im selben Zitat; Modalität ist geplant.** Die zusätzliche `implements`-Whitelist enthält diese Phrase aber nicht. Das ist ein **plausibler False Negative der Vorprüfung**, nicht bereits ein nachgewiesener Modellfehler. Ob eine planende Kommune und das als `place` typisierte Straßenziel semantisch einen zulässigen geplanten `implements`-Link ergeben, wurde noch nicht vom Judge beurteilt. Kein automatisches Nachpromovieren und keine Umdeutung zu fertigem Ausbau.

Alle vollständigen Pins, Endpunkte, Gate-IDs und Begründungen: [relation-rejections.json](relation-rejections.json). Die vorherige Ergänzung `errichten/errichtet` repariert nicht automatisch diese drei Fälle.

### Aktualisierte Relationenzählung

Die frühere Null war ebenfalls zeitgebunden. Um **08:11 UTC** lagen in abgeschlossenen Primärergebnissen zwei zugelassene Relationsvorkommen vor: ein geplanter Strausberger `implements`-Link **ohne irgendein belegtes Datum** bleibt von Publikation ausgeschlossen; ein Ratzeburger **`operates` / `asserted`** mit belegtem Stufendatum **29.03.2021** ist datumsgeeignet. Das ist **ein datumsgeeigneter Link**, noch keine neue Veröffentlichung, kein Nachweis heutiger Verhältnisse und kein bewiesener Netzwerk-/Transfernutzen.
