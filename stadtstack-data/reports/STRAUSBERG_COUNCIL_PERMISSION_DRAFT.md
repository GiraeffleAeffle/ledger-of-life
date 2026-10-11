# Strausberg: Anfrage zu OParl und automatisierten Abrufen

**Entwurf für den Betreiber von Stadtstack – nicht versandt.**

**Nachträgliche Betreiberentscheidung vom 11.10.2026:** Nach Risikobesprechung hat der Eigentümer für die neue Erwerbslane eine globale, protokollierte Robots-Ausnahme für registrierte öffentliche kommunale Quellen angeordnet. Sie ist keine Zustimmung der Stadt. Anmeldung, CAPTCHA, Paywall und Verschleierung bleiben ausgeschlossen; kommunale Hosts erhalten mindestens fünf Sekunden Abstand und eine Verbindung. Dokumentherkunft und explizite TDM-Reservierungen bleiben sichtbar: Drittanbieter-/unklare Werke werden bei Robots-Verbot oder ausdrücklicher Reservierung nicht extrahiert und neue Rohkopien verworfen. Diese Änderung gehört zur getrennten 0.3.2-/Rebuild-Lane, nicht zu den 0.3.1-Korrekturen. Der Entwurf wurde weiterhin nicht versandt.

Betreff: Öffentlicher OParl-Zugang und begrenzte Datenauswertung

Sehr geehrte Damen und Herren,

für Stadtstack möchten wir öffentliche Sachinformationen aus dem Strausberger Ratsinformationssystem ausschließlich lesend auswerten und mit Quellenlink und Abrufdatum bereitstellen. Die robots.txt Ihres ALLRIS-Angebots weist derzeit eine allgemeine Sperre automatisierter Abrufe aus. Wir möchten deshalb den vorgesehenen öffentlichen Zugang und die geltenden Nutzungsbedingungen ausdrücklich mit Ihnen klären.

Gibt es einen öffentlichen OParl-Endpunkt? Bitte nennen Sie uns die genaue URL und die geltenden Nutzungsbedingungen. Sind begrenzte automatisierte Abrufe und Text-und-Data-Mining für diesen Zweck erlaubt? Welche Pfade, Abrufintervalle und Datenarten dürfen wir nutzen?

Vorgesehen sind niedrige Abrufraten, Zwischenspeicherung und ausschließlich belegte Sachinformationen mit Attribution – keine Veröffentlichung vollständiger Dokumente oder privater personenbezogener Angaben und kein Zugriff auf nichtöffentliche Inhalte. Bitte nennen Sie uns die dafür zulässigen Pfade und Lizenz-/TDM-Bedingungen.

Vielen Dank und freundliche Grüße
Stadtstack

## Grundlage und Grenze der Prüfung

- Die [offizielle Stadtseite](https://www.stadt-strausberg.de/stadtverordnetenversammlung/) verlinkt den [ALLRIS-Sitzungskalender](https://strausberg.allris.cloud/public/si010), aber in der gelesenen Fassung keinen OParl-Endpunkt. Die gesperrten ALLRIS-Inhaltsseiten wurden nicht erneut abgerufen.
- Die einmalig für diese Prüfung gelesene [robots.txt](https://strausberg.allris.cloud/robots.txt) enthält `User-agent: *` und `Disallow: /`, ohne angezeigte Ausnahme. Der Reader lieferte keinen exakten Abrufzeitpunkt oder Rohbyte-Hash; ältere Cache-Hashes werden diesem neuen Abruf nicht zugeschrieben.
- Die [Herstellerbeschreibung zu ALLRIS 4](https://www.cc-egov.de/allris-4/) belegt keine konkrete Strausberger OParl-URL. Es wurden keine üblichen API-Pfade geraten oder getestet.
- Ergebnis: **Kein OParl-Endpunkt in den geprüften Belegen gefunden; Existenz und zulässiger Zugriff bleiben ungeklärt.** Das ist kein Nachweis, dass OParl nicht existiert. Der bekannte HTML-Zugang bleibt `robots_blocked` mit `ask_municipality`. Ein anderer Ursprung müsste separat geprüft werden.
