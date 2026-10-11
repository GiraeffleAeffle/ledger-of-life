# MCP 0.3.1: konkrete Analysten-Korrekturen

**0.3.1 ist live.** Die konkreten Korrekturen wurden lokal und anschließend am öffentlichen Endpoint abgenommen. [Live-Provenienz](live-release-0.3.1.json) und [Hosting-Leitfaden](../docs/HOSTED_MCP.md) halten Image-/Pod-/HTTPS-Nachweise getrennt. Die eingefrorene 0.3.0-Wertstudie und die ursprüngliche lokale Patch-Evidenz bleiben unverändert; Ergebnisse werden nicht rückwirkend umetikettiert.

- Version: `0.3.1`, **20 schreibgeschützte MCP-Tools**.
- Datenmanifest: `25d99c9382ccbfeb3fbdef8541409950c8e4adc96852922f151e661d25c90eaf`.
- Unverändert **228 veröffentlichte Wissensdatensätze**, neun Pilotkommunen und drei belegte Relationskanten; keine neue Extraktion und keine neuen Judge-Aufrufe.
- Maschinenlesbare tatsächlich abgerufene Ergebnisse: [PATCH_0_3_1.json](PATCH_0_3_1.json).

## 1. Suche und Vergleich verwenden dieselbe Zulässigkeit

Die bisherige Abweichung zwischen `comparisonEligible` und `compare_topic` ist behoben. Die Definition gilt gemeinsam für Stadt-, Regional- und Wissensevidenz. Jeder als zulässig markierte passende Datensatz erscheint im Vergleich über seinen Fall; reine Veröffentlichungs-/Abrufdaten werden nicht zu Beschlussdaten umgedeutet.

| Wärmeplanung | Zulässige Suchdatensätze | Vergleich: Datensätze / Fälle | Weitester dokumentierter Stand / Datum |
| --- | ---: | ---: | --- |
| Strausberg | 1 | 1 / 1 | `draft`, Stufendatum nicht belegt |
| Hoppegarten | 1 | 1 / 1 | `planning`, Stufendatum nicht belegt |
| Rüdersdorf bei Berlin | 1 | 1 / 1 | `adopted`, 22.07.2025 |

Das sind die belegten strukturierten Regionalangaben im veröffentlichten Datensatz, keine neue Prüfung des heutigen Stands. Insbesondere bleibt der angenommene Rüdersdorfer Wärmeplan im Vergleich erhalten. Ein geplanter Beschluss ist weiterhin kein gefasster Beschluss. Hoppegartens 27.05.2026 ist als Veröffentlichung gekennzeichnet und wird deshalb nicht zum Planungsmeilenstein; auch Strausbergs 12.04.2026 ist nicht ausdrücklich an die Entwurfsstufe gebunden. Für abgeschlossene Beteiligungen zählt deren belegtes Ende, nicht das Eröffnungsdatum. Bekannt abgelehnte, zurückgezogene oder zukünftige Stufen gelten nicht bloß wegen fehlenden positiven Meilensteins als unbekannt.

## 2. Fälle statt wiederholter Auszüge

Vergleich und Ähnlichkeit arbeiten nun auf **Fällen bzw. ausdrücklich verbundenen Verfahrensbündeln**. Quellenbelegte Plan-/Vorlagennummern und DiPlan-Verfahren begründen die Gruppierung, nicht bloße Titelähnlichkeit. Die Originaldatensätze bleiben abrufbar.

Für „Solarpark am Flugplatz“ ergibt der tatsächliche MCP-Vergleich **18 passende Datensätze in einem Fall**: die 16 Wissensauszüge und zwei weitere veröffentlichte Nachweise. Der gemeinsame, unter beiden DiPlan-Verfahren veröffentlichte Quellenbeleg verbindet das Bündel. vB-Plan 68/23 und die 10. FNP-Änderung bleiben als rechtlich verschiedene Instrumente mit eigenen Ständen erhalten. Ein abweichender Quellverweis 63/23 wird sichtbar bewahrt, nicht stillschweigend auf 68/23 korrigiert.

`caseCount` zählt auch ausdrücklich ungelöste datensatzbezogene Ersatzfälle. `identifiedCaseCount` und `unresolvedCaseCount` verhindern, dass diese als sicher identifizierte Projekte ausgegeben werden. Der weiteste belegte Meilenstein ist kein Beweis aktueller Umsetzung, Fertigstellung oder Wirkung.

## 3. Ein Entitätsknoten, erhaltene Typ-/Namensbelege

„Stadtwerke Strausberg“ liefert jetzt **einen Knoten** mit Anzeigetyp `company`; alle drei ursprünglichen Erwähnungen mit den Typen `company` und `organization` bleiben als Herkunftsbelege erhalten.

Die Regel ist deterministisch: gleicher normalisierter benannter Gegenstand in derselben Kommune, unabhängig vom ursprünglichen Erwähnungstyp. Die Anzeigetyp-Priorität lautet Kommune → Behörde → Unternehmen → Organisation → Förderprogramm → Projekt → Einrichtung → Rechtsinstrument → Ort. Sie ist keine neue rechtliche Identitätsfeststellung. Anonyme Bezeichnungen, unterschiedliche Rechtsformen, Änderungsstände und widersprüchliche vollständige Kennzeichen bleiben getrennt; reine Namensgleichheit verbindet keine verschiedenen Kommunen.

Graphformat v2 enthält **169 Entitäten und drei Kanten**. Die Identitätsmigration erfasste 831 vorhandene Kandidaten einschließlich zurückgehaltener Fälle. Nur abgeleitete Entitäts-/Endpunkt-IDs und die davon abhängigen Evidenzhashes änderten sich; ursprüngliche Behauptungen, Quellen, Record-IDs, Modell-/Prompt-/Zeitangaben und Judge-Belege blieben bytevergleichbar unverändert. Der private Migrationsnachweis hat SHA-256 `1693e188eeb4ea81a05937e64f08bce004918cb404c93d89bee0cb7f423b7b5f`. Alte Entitäts-IDs werden nicht als parallele Kompatibilitäts-API weitergeführt; Clients entdecken sie im neuen Release erneut.

## 4. Warum Strausberg 384 Quarantänefälle hat

`get_release_status.knowledgeCoverage` und `list_cities.knowledgeCoverage` zeigen veröffentlichte und zurückgehaltene Evidenz mit sicheren Grundkategorien. Rohantworten, verworfene Zitate und private Diagnoseinhalte werden nicht veröffentlicht.

Strausberg: **39 veröffentlicht, 384 zurückgehalten**. Die größten Kategorien sind:

| Grundkategorie | Einträge |
| --- | ---: |
| Beleg-/kritische-Behauptungs-Gates nicht bestanden | 142 |
| Kein gestützter Fall im Auszug | 90 |
| Keine belegte Dokument-/Verfahrens-/Historien-Datierung | 87 |
| Ungültige strukturierte Ausgabe | 55 |
| Faithfulness-/Judge-Gate nicht bestanden | 8 |
| Text-/Dokumentvorbereitung fehlgeschlagen | 3 |

Die Kategorien können sich auf demselben Eintrag überschneiden; ihre Summe ist **keine** weitere Zahl von Fällen, Dokumenten oder Projekten. Unter den konkreten fehlgeschlagenen Prüfschritten stehen exakte Zitate (52), Graph-Erwähnungen (39), Kommunenzuordnung (27), vom tatsächlichen Judge als kritisch ungestützt markierte Aussagen (26), Entitätsbezeichnungen (21) und Zahlen in Zusammenfassungen (21). Die kritischen Judge-Markierungen gehören zu den gespeicherten nachgelagerten Prüf-Gates und sind nicht als rein lexikalische Regelprüfung zu verstehen.

Die Nenner sind sichtbar: **9 versucht/veröffentlicht von 319 Inventarkommunen**, nicht Vollabdeckung. Für Märkisch-Oderland sind es **3 von 45**, für Lauenburg 3 von 132 und für Ludwigslust-Parchim 3 von 142. Konfiguriert, geprüft, ausgewählt, textvorbereitet, versucht und veröffentlicht bleiben getrennte Größen. Die belegten Vorbereitungszahlen stammen aus dem gepinnten Plan, nicht aus einer Schätzung.

## 5. Bulk-Lesen und getrennte Token-Kontingente

`export_records(topic?, municipality?, cursor?, limit?)` liefert vollständige normalisierte Datensätze einschließlich `originalRecord`, die Quellen dieser Seite und seitenbezogene Fallbelege. Standard sind 20, höchstens 50 Datensätze je Seite; Cursor sind an Release und Filter gebunden. `caseId` verbindet Fallmitglieder über Seiten, ohne eine Einzelseite als vollständigen Fall auszugeben.

Der tatsächliche Strausberg-Aufruf mit Limit 1 enthält einen vollständigen Datensatz und drei zugehörige Quellen, weist 189 Datensätze / 152 Fälle für den gewählten Umfang aus und liefert einen Folgecursor. Das ersetzt viele einzelne Record-/Quellenaufrufe.

Die Defaults bleiben **60 authentifizierte HTTP/RPC-Anfragen pro Minute und vier gleichzeitige Anfragen je Token**. Nur explizite, validierte Betreiberprofile für `max` und `buzz` erhalten **300/min und acht gleichzeitig**; die globale Gleichzeitigkeit 32 sowie Body-/Zeitlimits bleiben bestehen. Initialisierung, Discovery und ungültige authentifizierte Anfragen zählen ebenfalls – etwa 35 fachliche Aufrufe sind deshalb nicht zwingend nur 35 HTTP-Anfragen. Eine 429-Antwort nennt das tatsächlich geltende Token-Limit und die passende Wartezeit.

Der gouvernierte Limit-Update-Pfad bewahrt alle vorhandenen Token-IDs und Digests, erzeugt keine Ersatz-Zugangsdaten und prüft Secret-UID sowie ResourceVersion atomar, bevor nur der benannte Hash-Schlüssel ersetzt wird. Die neue Konfiguration wirkt nach dem kontrollierten Neustart, nicht durch ein kontingentlöschendes Hot-Reload je Anfrage. Die öffentliche Quote wird für die Abnahme nicht absichtlich erschöpft.

## 6. ALLRIS und die neue Erwerbspolicy

Die offizielle Stadtseite und Herstellerinformationen ergaben keinen belegten Strausberger OParl-Endpunkt. Das ist **kein** Beweis seiner Nichtexistenz. Die gelesene robots.txt erklärte `Disallow: /`; ein neuer Rohbyte-Hash oder genauer Abrufzeitpunkt wurde daraus nicht erfunden. Kein konventioneller API-Pfad wurde geraten, keine gesperrte Inhaltsseite zur bloßen Bestätigung erneut abgerufen und keine Anfrage an die Stadt versandt. Der [Entwurf](STRAUSBERG_COUNCIL_PERMISSION_DRAFT.md) ist ausdrücklich unversandt.

Der Eigentümer hat danach eine globale, auditierte Robots-Ausnahme mit Herkunftsklassifikation, strenger Höflichkeit und Widerspruchs-/Löschprozess für die **getrennte 0.3.2-/Rebuild-Lane** beschlossen. Sie verändert diese 0.3.1-Daten und -Sicherheitskorrekturen nicht. Anmeldung, CAPTCHA, Paywall und Verschleierung bleiben dort ebenfalls verboten; Drittanbieter-/unklare Werke werden bei Robots-Verbot oder expliziter TDM-Reservierung von Extraktion und Modellübertragung ausgeschlossen. Rohkopien werden nicht veröffentlicht.

## Prüfung

- **400 Node-Tests bestanden**, TypeScript-Prüfung bestanden.
- **Acht isolierte Release-/Token-Grenztests bestanden**, Shell-Syntaxprüfung bestanden.
- Regressionen decken Wärme-Suche/Vergleich, reale Solarpark-Gruppierung, Entitätsalias-Provenienz, Abdeckung/Quarantäne, Bulk-Cursor und Token-Isolation/300er-Profil/Gleichzeitigkeit ab.
- Robots-/OParl-Tests benutzen Mock-Transport und beweisen, dass bloße Adapterwahl keine Sperre umgeht; sie sind keine neu entdeckten Live-Endpunkte.
- Abschließende statische Sicherheitsprüfung ohne konkrete offene Befunde; beide im Semantikreview gefundenen Datums-/Statusprobleme wurden korrigiert und in der Nachprüfung geschlossen.
- Die bekannte PDF-Schriftwarnung wurde nicht unterdrückt.

Geografische Verknüpfungen, Ausweitung über die drei MOL-Pilotkommunen, strukturierte Zusatzquellen, Communities und Braid gehören nicht zu diesem Patch. Die eingefrorene 0.3.0-Reproduktionsarbeit und der Runbook-Nachweis bleiben davon getrennt; **off-site backup: deferred by owner**.
