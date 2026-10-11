# Pilotwert und Freigabebericht 0.3.0

## Ergebnis in einem Satz

Der erweiterte Datenstand liefert auf derselben festen Fragenbank **1 vollständige und 10 teilweise nützliche Antworten statt zuvor 0 und 4**. Er enthält **228 veröffentlichbare, datierte Evidenzdatensätze aus allen neun Pilotkommunen**. Der Graph hat **3 belegte Betreiberbeziehungen**, aber in den **7 direkten Vergleichen keinen nachgewiesenen zusätzlichen Antwortnutzen**.

**Stand dieses Commits:** lokal veröffentlichter und geprüfter Kandidat, noch kein Nachweis des öffentlichen 0.3.0-Rollouts. Der öffentliche Betrieb wird getrennt über den gouvernierten CivicMCP-Operator und dessen tatsächliche Image-/Pod-/Endpoint-Nachweise freigegeben. Paketversion, wörtlicher Git-Tag, Image-Tag und MCP-Version sollen dabei jeweils `0.3.0` sein. Ein älteres statisches `serverInfo.version:0.3.0` allein ist ausdrücklich kein Rolloutnachweis.

- Datenmanifest: `f434203c14c82ea6b6814662e9b1e209d81d7921bee97aeefcd2269d83330415`
- Umfang: **19 MCP-Tools**, 14.621 Datensätze insgesamt, davon 228 kommunale Wissensdatensätze; 8 unverändert übernommene Stadtsnapshots, 9 Wissenskommunen, 3 Landkreise.
- Maschinenlesbare Fakten und Hashbindungen: [pilot-value-release.json](pilot-value-release.json).
- Alle 30 Einzelantworten, Quellen, Lücken und Graphpaare: [PILOT_VALUE_ENHANCED.md](PILOT_VALUE_ENHANCED.md) und [vollständige MCP-Evidenz](pilot-value-enhanced.json).

## 1. Abdeckung, ohne Projekte zu erfinden

| Kommune | Datensätze | Davon mit datierter Verfahrensstufe | Zitierte unterschiedliche Dokumentbytes | Quellenbelegte Vorgangskennzeichen |
| --- | ---: | ---: | ---: | ---: |
| Strausberg | 39 | 37 | 26 | 10 |
| Hoppegarten | 37 | 37 | 5 | 1 |
| Rüdersdorf bei Berlin | 37 | 34 | 26 | 17 |
| Ratzeburg | 14 | 12 | 14 | 0 |
| Mölln | 28 | 23 | 25 | 1 |
| Schwarzenbek | 12 | 11 | 12 | 0 |
| Ludwigslust | 35 | 35 | 25 | 4 |
| Parchim | 18 | 17 | 18 | 17 |
| Hagenow | 8 | 7 | 4 | 2 |

**Datensätze sind keine unterschiedlichen Projekte.** Mehrere Auszüge können verschiedene Aussagen desselben Vorgangs belegen. Insbesondere sind Hoppegartens 37 Datensätze aus fünf Dokument-Bytegruppen nicht 37 Projekte. Quellenbasierte Ersatzschlüssel sind als solche gekennzeichnet; eine Gruppierung ersetzt keine unabhängige rechtliche Identitätsprüfung.

Das Ziel von ungefähr 10–15 sinnvollen Datensätzen wird für Hagenow **nicht** behauptet: Dort bleiben es acht. Alle zwölf verfügbaren Dokumentgruppen wurden versucht; acht Kandidaten aus vier Dokument-Bytegruppen bestehen die Veröffentlichungsregeln. Es wurde weder aufgefüllt noch ein Gate gelockert.

Die erlaubte Quellenvervollständigung betraf nur bereits registrierte Quellen von Hagenow, Parchim, Schwarzenbek, Ratzeburg und Mölln. Vorher/Nachher, Quellen und Einschränkungen stehen in [pilot-coverage-completion.json](pilot-coverage-completion.json):

- ursprünglicher eingefrorener Korpus: 2.842 Repräsentationen / 1.822 Dokumentgruppen;
- vervollständigter freigegebener Pilotkorpus: 5.193 Repräsentationen / 4.119 Dokumentgruppen;
- 417 ausgewählte Gruppen, davon 376 vorbereitet und 41 wegen fehlender bzw. zu hoher PDF-Seitenzahl zurückgehalten;
- 3.702 weitere verfügbare Gruppen wurden in diesem Lauf nicht verarbeitet;
- neun mehrdeutige Parchimer PDF-Inhalte wurden wegen unklarer Öffentlichkeit ausgeschlossen; eine spätere, nicht vollständig abgeschlossene Crawling-Welle wurde nicht hineingemischt;
- echte Ratsinformations-/Robots-/Anmeldebarrieren bleiben sichtbar. Die registrierten BOB-SH-Quellen lieferten für die drei exakt abgegrenzten Gemeinden null zugeordnete Verfahren. Das ist keine Behauptung über alle möglichen Planungen.

Die zwischenzeitliche Anzeige Hoppegarten 26 → 3 verglich einen vollständigen früheren Lauf mit einem noch unvollständigen neuen Lauf. Der abgeschlossene Lauf hat 37 veröffentlichte Datensätze. Die konkrete Spur ist in [hoppegarten-count-trace.json](hoppegarten-count-trace.json) dokumentiert.

## 2. Modelle, Gates und tatsächliche Verarbeitung

| Native Ausführung | Primäre Dokumentgruppen | Abgeschlossene zusätzliche Vergleichsaufgaben | Veröffentlichte Datensätze |
| --- | ---: | ---: | ---: |
| Codex CLI 0.160.0, `gpt-6-luna` | 197 | 7 | 68 |
| Claude CLI 2.1.284 / Max, `claude-haiku-5-5` | 179 | 14 | 160 |

Beide nutzten dieselben Quellbytes, Prompts, Schemata und Gates. Die Verteilung der Primärgruppen ist ungefähr hälftig; die unterschiedlich vielen veröffentlichten Datensätze sind wegen unterschiedlicher Dokumente **kein Modellqualitätsranking**. Max war tatsächlich angemeldet und lieferte echte Produktaufrufe. Der erlaubte Betrieb mit vier Haiku- und einem Codex-Worker erfolgte unter ausdrücklicher Besitzerbeobachtung der Quote; fehlende maschinenlesbare Quotenfenster wurden nicht als bekannte freie Kapazität ausgegeben.

Die Vergleichsstichprobe ist vollständig: 21/21 zusätzliche Aufgaben, acht primär und vierzehn sekundär zugelassene Kandidaten. Nur zwei ausgewählte Fälle ließen sich nach dem engen Vergleichsschlüssel direkt zuordnen; ihre Unterschiede betreffen Themen/Entitäten bzw. Entitäten. Sechs primär und zwölf sekundär ausgewählte Fälle waren nicht zugeordnet. Unterschiedliche Fallauswahl ist nicht automatisch ein Widerspruch; zwei Modelle auf derselben Quelle sind keine unabhängige Quellenbestätigung.

Alle ursprünglichen **17 Faktengates**, vier Graph-Evidenzgates und der tatsächliche separate Modelljudge mit Schwelle **0,8** bleiben bestehen. Veröffentlichung setzt zusätzlich eine belegte Dokument-, Verfahrens- oder historische Verfahrensdatierung voraus. Der Mengenweg ist transparent:

1. 430 ursprünglich zugelassene Kandidaten;
2. 429 nach erneuter Relationsprüfung; ein zuvor undatierter Implementierungs-Kandidat bleibt nun im Hold;
3. 229 mit belegter Datierung;
4. **228 nach dem unveränderten öffentlichen URL-Gate**: ein weiterer Rüdersdorfer Datensatz enthält durch OCR beschädigte URLs in Originalzitaten und wird vollständig zurückgehalten, nicht durch Zitatänderung „repariert“.

Insgesamt sind 1.443 Quellen-/Kandidatenfälle quarantänisiert. Das ist keine Zahl unterschiedlicher Dokumente und kein Fehler- oder Präzisionsmaß.

## 3. Relationskorrektur und Graphnutzen

Die neue Semantik trennt `plans/planned`, `decides/decided`, `approves/decided` und `implements/implemented`. Planung wird niemals als Umsetzung veröffentlicht. Bedingung, Verneinung, Vorschlag und historische Einordnung bleiben erhalten; Ko-Erwähnung, Datum, Rollenrichtung und die ursprünglichen Faktengates werden nicht aufgeweicht.

28 bestehende materialisierte Relationskandidaten wurden ohne neue Extraktion erneut geprüft. Vier wurden quellengebunden zu `plans/planned` normalisiert. Beim gewünschten Strausberger Beispiel „plant den Ausbau“ bestehen nun alle 21 deterministischen Gates. **Es fehlt aber ein belegtes Datum im Kandidaten:** Die Relation bleibt zurückgehalten. Die drei anderen normalisierten Kandidaten scheitern weiterhin an ursprünglichen Faktengates. Vier zusätzliche rohe, nicht materialisierte Relationskandidaten wurden ebenfalls geprüft; keiner besteht die ursprünglichen Gates.

Deshalb waren **0 neue Extraktions- und 0 neue Judge-Aufrufe** erforderlich. Es wurde kein unbewerteter geänderter Kandidat zugelassen. Ursprüngliche Modell-, Prompt-, Zeit- und Antwort-Hash-Provenienz bleibt unverändert. Nach den abschließenden Laufzeitkorrekturen ergab ein erneuter rein lokaler Replay byteidentische Records und Quarantäne; das ist noch nicht der separat beauftragte Fresh-Clone-Nachweis.

| Zugelassener Relationstyp | Anzahl |
| --- | ---: |
| `operates` | 3 |
| `funds` | 0 |
| `implements` | 0 |
| `plans` | 0 |
| `decides` | 0 |
| `approves` | 0 |
| `amends` | 0 |
| `located_in` | 0 |
| `cooperates_with` | 0 |
| `cites` | 0 |

Der Graph enthält 170 Entitäten. Die drei Betreiberbeziehungen sind quellendatierte Aussagen, keine Garantie des heutigen Betriebs. `graph_path` lässt nur passende faktische Typ-/Modalitätskombinationen zu; geplante, vorgeschlagene, bedingte, verneinte und historische Beziehungen bleiben außerhalb faktischer Pfade. Pfade beweisen weder Kausalität noch Ausgaben oder Erfolg. Konkrete frühere Ablehnungsgründe stehen in [relation-rejections.json](relation-rejections.json).

## 4. Fester Werttest statt Trefferzahl

Die Fragenbank blieb bytegleich: `2e74ab25477c83ed58a34e1a57ae76c16ed7f524fe7e6865106bfcc32bad18cc`. Die aktuelle Sammlung umfasst 784 tatsächliche MCP-Aufrufe und 230 abgerufene Datensätze einschließlich der bestehenden Regional-/Stadtevidenz. Jede Frage erhielt eine explizite **KI-gestützte Quellenbewertung**, keine behauptete menschliche oder kommunale Abnahme.

| Ergebnis ohne Graph | Baseline, 16 Tools | Aktueller Datenstand, 19 Tools |
| --- | ---: | ---: |
| Vollständige nützliche Antworten | 0 | 1 |
| Teilweise nützliche Antworten | 4 | 10 |
| Korrekte Enthaltungen | 26 | 19 |
| Fragen mit verbleibenden Datenlücken | 30 | 29 |
| Nutzenpunkte, höchstens 60 | 4 | 12 |
| Quellenpunkte, höchstens 60 | 23 | 46 |
| Korrektheitspunkte, einschließlich Enthaltungen | 60 | 60 |

Korrektheit von 60/60 ist **keine Erfolgsquote**: eine richtige Enthaltung beantwortet die Sachfrage nicht. Die vollständige Antwort B01 belegt konkrete Strausberger Aufstellungsbeschlüsse mit Plan, Gremium, Datum und Verfahrensstufe; sie behauptet weder ein vollständiges Planinventar noch heutige Rechtskraft. Nicht belegte Kredite, Zahlungen, Betreiberidentitäten oder Vorher-Nachher-Wirkungen bleiben offen. Bewertungen ohne zitierte Quelle erhielten entsprechend dem Validator null Quellenpunkte.

**Alle sieben Graphpaare haben eine Nutzendifferenz von null.** Nur dieser Vergleich hält den Datenstand gleich. Der Zuwachs zwischen Baseline und aktuellem Release umfasst zugleich mehr Quellen und andere Extraktionsergebnisse und darf nicht dem Graphen zugerechnet werden. Die Bewertungen sind nachvollziehbare, aber subjektive KI-Reviews, keine verblindete Studie oder adjudizierte Präzisions-/Recall-Messung.

## 5. Prüfung und Freigabegrenzen

- `npm test`: **318 bestanden, 0 fehlgeschlagen**; `npx tsc --noEmit`: bestanden.
- Vier isolierte Python-Regressionsprüfungen bestanden: eingeschleuste Betreiber-JSON abgewiesen, Python-Optimierung abgewiesen, fehlgeschlagener Smoke-Produzent trotz `passed:true` abgewiesen, öffentliches Endpoint-Ergebnis attestiert keinen nur übergebenen Image-Digest.
- Shell-Syntaxprüfung des Session-Wrappers bestanden.
- Abschließende statische Sicherheitsprüfung ohne offene konkrete Befunde. Zwei Laufzeitbefunde zur Behandlung ganzer Dokument-Budget-Holds und zur Readiness-Abbruchweitergabe wurden behoben und erneut ohne offenen Befund geprüft.
- Die bekannte PDF-Schriftwarnung `TT: undefined function: 21` wurde beobachtet und nicht unterdrückt.

Der gouvernierte Dispatcher erzeugt seine eigene frische private Exact-Image-Evidenz aus dem freigegebenen Git-Stand. Öffentliches HTTPS-Smoke prüft dagegen Version und Datenidentität des Endpoints, nicht eigenständig dessen laufendes Image. Diese beiden Nachweise dürfen nicht vermischt werden; die Pod-/Rollout-Bindung bleibt gesondert erforderlich.

## 6. Kosten, Nachvollziehbarkeit und nächste Reihenfolge

Zeitmessungen, tatsächliche Token-/Cache-Beobachtungen, die Grenzen von CLI-API-Preisindikationen gegenüber Max-Abrechnung, offizielle Preise sowie die 319-Kommunen-Szenarien stehen in [PIPELINE_PERFORMANCE.md](PIPELINE_PERFORMANCE.md) und [pipeline-performance-evidence.json](pipeline-performance-evidence.json). Szenarien sind keine zugesagten Kosten oder Laufzeiten; CodeX-Tokens ohne erhaltene Telemetrie werden nicht erfunden.

Nach dem 0.3.0-Rollout, ohne diesen zu verzögern, folgen die zusätzlich beauftragten Nachweise: generierter Quellenexport, vollständiges Dokumentmanifest ohne Roh-PDFs in Git, ein kostenbeziffertes verschlüsseltes Off-Workstation-Backup **erst nach Besitzerfreigabe einer Ausgabe**, dokumentierter Restore sowie Fresh-Clone-Replay auf `codex-workstation` und ein kleiner Live-Neucrawl einer Pilotkommune mit Diff.

Die geplante Pipeline-Umstellung bleibt **nach dem Werttestbericht** eingeordnet: Jev-/Decisions-Triage, span-gebundene Evidenz, Batch-APIs, inkrementelle Verarbeitung und ein codebasierter Job-Runner. Darauf folgen konzentrische Erweiterung und Graph-Communities; danach der Braid-Import. Dieser Bericht behauptet keine schon implementierte oder gemessene Wirkung dieser späteren Schritte.
