// Official references retrieved 16 November 2026; scenario inputs are not B70 facts.
export const SOLAR_REFERENCE = {
  annualKwhPerKwp: 995.63,
  householdAnnualKwh: 3383,
  maximumEuroPerEligibleKwh: 0.002,
  minimumMwp: 1,
  maximumMwp: 50,
  initialMwp: 10,
  captionMilliseconds: 4500,
} as const;

export const EXPLAINER_CAPTIONS = [
  { title: 'Sonne rein. Strom raus.', text: 'Mehr angenommene Solarleistung bedeutet im Modell mehr Jahresstrom.', scene: 'sun' },
  { title: 'Jahresmenge ≠ Dauerstrom.', text: 'Haushaltsäquivalente vergleichen Mengen – nicht Versorgung oder Autarkie.', scene: 'homes' },
  { title: 'Geld fürs Dorf? Nicht automatisch.', text: '§ 6 EEG erlaubt ein freiwilliges Angebot bis 0,2 Cent je eingespeister kWh.', scene: 'town' },
  { title: 'Jetzt bist du dran.', text: 'Schiebe die Beispiel-Leistung – für B70 ist die tatsächliche MWp-Zahl hier unbekannt.', scene: 'slider' },
] as const;

export const EXPLAINER_SOURCES = {
  yield: {
    title: 'EU-Kommission / JRC · PVGIS 5.3 · Modellabfrage',
    url: 'https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=53.480926&lon=10.616482&peakpower=1&loss=14&angle=35&aspect=0&mountingplace=free&pvtechchoice=crystSi&raddatabase=PVGIS-SARAH3&outputformat=json',
    detail: 'Büchen-Referenzpunkt 53,480926° N / 10,616482° E, nicht die B70-Anlagenfläche: 1 kWp kristallines Silizium, frei aufgestellt, fest 35° geneigt, Süd (Azimut 0°), 14 % Systemverluste, modellierter Geländehorizont. PVGIS-SARAH3 / ERA5, Wetterjahre 2005–2023. Ergebnis E_y: 995,63 kWh/Jahr; jährliche wetterbedingte Standardabweichung SD_y: 52,82 kWh. Keine konkrete Anlagenplanung oder Ertragsgarantie.',
  },
  method: {
    title: 'JRC · PVGIS API-Dokumentation',
    url: 'https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en',
    detail: 'PVcalc berechnet mittlere jährliche Stromerzeugung für die eingegebenen Anlagenannahmen. Die gespeicherte Referenz wird hier linear skaliert; im Browser findet kein API-Aufruf statt.',
  },
  households: {
    title: 'Destatis · Stromverbrauch privater Haushalte · 2021',
    url: 'https://www.destatis.de/DE/Themen/Gesellschaft-Umwelt/Umwelt/UGR/private-haushalte/Tabellen/stromverbrauch-haushalte.html',
    detail: 'Deutschland, 2021: 3.383 kWh Strom je Haushalt im Durchschnitt aller Haushaltsgrößen; einschließlich Raumwärme, Warmwasser (Hygienezwecke), Beleuchtung und Elektrogeräten. Tabellenstand 27. September 2023. Kein heutiger Büchener Verbrauchswert. Das Ergebnis sind rein rechnerische Jahresverbrauchsäquivalente, keine tatsächlich versorgten Haushalte.',
  },
  law: {
    title: '§ 6 EEG · insbesondere Absätze 1, 3 und 4',
    url: 'https://www.gesetze-im-internet.de/eeg_2014/__6.html',
    detail: 'Betreiber sollen Kommunen beteiligen; das Angebot nach § 6 ist freiwillig und begründet keinen automatischen Zahlungsanspruch. Bei Freiflächenanlagen insgesamt bis 0,2 Cent je tatsächlich eingespeister kWh an betroffene Standortgemeinden; gegebenenfalls zwischen ihnen aufzuteilen. Vereinbarung schriftlich oder elektronisch; bei einem erforderlichen Bebauungsplan nicht vor dessen Beschluss. Ein Entwurfs-/Veröffentlichungsbeschluss ist kein abschließender Planbeschluss.',
  },
  cooperative: {
    title: 'Umweltbundesamt · Energiegenossenschaft',
    url: 'https://denkwerkstatt-konsum.umweltbundesamt.de/energiegenossenschaft',
    detail: 'Bürger können Anlagen gemeinsam über eine Genossenschaft finanzieren und sind damit an Gewinnen und Verlusten beteiligt. Das wäre ein eigenständiges Beteiligungsmodell, keine Folge dieser Rechnung und für B70 hier nicht belegt.',
  },
  grid: {
    title: 'Bundesnetzagentur · Netzentgelte',
    url: 'https://www.bundesnetzagentur.de/Netzentgelte/start',
    detail: 'Ein Ortstarif bräuchte ein eigenes Lieferangebot; er ist hier nicht belegt. Die Nähe zum Solarpark macht Strom nicht automatisch billiger: Netzentgelte sind Teil des Endkundenpreises und nicht von der Leitungslänge zwischen Einspeisung und Entnahme abhängig. Diese Rechnung ermittelt keinen Stromtarif.',
  },
} as const;
