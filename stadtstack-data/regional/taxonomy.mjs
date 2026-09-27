// Ordered, auditable title matching. Generic B-Plan / FNP words are not topics.
// One title can match multiple subjects (e.g. a school and a cycle route).
export const TOPICS = [
  { id: 'waermeplanung', label: 'Kommunale Wärmeplanung', keywords: ['Wärmeplanung', 'Wärmeplan'], pattern: /w[äa]rmeplan|w[äa]rmenetz/iu, summary: 'Gemeinden untersuchen künftige Wärmeversorgung; ein Wärmeplan ist keine Bauzusage und kein Heizungsgebot.' },
  { id: 'solarpark', label: 'Freiflächen-Photovoltaik', keywords: ['Solarpark', 'Agri-PV', 'Freiflächen-Photovoltaik'], pattern: /solarpark|solarfeld|agri[ -]?(?:pv|photovoltaik)|freifl[äa]chen[ -]?(?:pv|photovoltaik|solaranlage)|photovoltaik[ -]?(?:anlage|park|freifl[äa]che)|sonnenenergie/iu, summary: 'Mehrere Orte bearbeiten Flächen für Photovoltaik; eine Beteiligung ist noch keine Genehmigung oder Inbetriebnahme.' },
  { id: 'windenergie', label: 'Windenergie', keywords: ['Windenergie', 'Windpark', 'Windkraft'], pattern: /wind(?:energie|kraft|park|anlagen?)/iu, summary: 'Kommunen befassen sich mit Flächen für Windenergie; Planverfahren sind nicht mit gebauten Anlagen gleichzusetzen.' },
  { id: 'wohnbau', label: 'Wohnbau und Quartiere', keywords: ['Wohnbebauung', 'Wohngebiet', 'Quartier'], pattern: /wohn(?:bebauung|gebiet|quartier|siedlung|baufl[äa]che|ungsbau)|neues? (?:stadt|wohn)quartier|einfamilienh[äa]user/iu, summary: 'An mehreren Orten werden neue oder veränderte Wohnbauflächen beraten; Umfang und Baubeginn bleiben projektabhängig.' },
  { id: 'gewerbe', label: 'Gewerbe und Industrieflächen', keywords: ['Gewerbegebiet', 'Industriegebiet', 'Gewerbepark'], pattern: /gewerbe(?:gebiet|park|fl[äa]che|standort)|industrie(?:gebiet|park|fl[äa]che)|wirtschaftspark|rechenzentrum/iu, summary: 'Kommunen planen Flächen für Gewerbe oder Industrie; eine Flächenplanung belegt noch keine Ansiedlung.' },
  { id: 'bioenergie', label: 'Bioenergie und Biogasanlagen', keywords: ['Biogasanlage', 'Biomassezentrum', 'Biogasaufbereitung'], pattern: /biogas(?:anlage|aufbereitung)|biomasse(?:zentrum|anlage|kraftwerk)/iu, summary: 'Mehrere Gemeinden bearbeiten die Nutzung von Biomasse und Biogas; Bauleitplanungen belegen weder Bauabschluss noch Anlagenbetrieb.' },
  { id: 'kita', label: 'Kita und Kinderbetreuung', keywords: ['Kita', 'Kindertagesstätte', 'Kinderbetreuung'], pattern: /\bkita\b|kindertagesst[äa]tte|kindergarten|kinderbetreuung/iu, summary: 'Mehrere Verfahren betreffen Einrichtungen für Kinderbetreuung; Pläne sind noch keine fertigen Plätze.' },
  { id: 'schule', label: 'Schule und Hort', keywords: ['Schule', 'Schulstandort', 'Hort'], pattern: /\b(?:grund|ober|gesamt|fach|berufs)?schule\b|\bschul(?:entwicklungsplanung|standort|campus)\b|\bhort\b/iu, summary: 'Kommunen befassen sich mit Schul- und Hortstandorten; Kapazitäten und Termine müssen separat geprüft werden.' },
  { id: 'radverkehr', label: 'Radwege und Radverkehr', keywords: ['Radweg', 'Radverkehr', 'Fahrrad'], pattern: /radweg|radverkehr|fahrrad|radschnell/iu, summary: 'Mehrere Orte beraten Radverbindungen; der Verfahrensstand sagt noch nichts über den Bautermin.' },
  { id: 'strassenverkehr', label: 'Straßen und Verkehr', keywords: ['Straßenausbau', 'Ortsumgehung', 'Bahnhofsumfeld'], pattern: /stra[ßs]en(?:ausbau|bau|verkehr)|orts(?:umgehung|durchfahrt)|bahnhofsumfeld|verkehrsanbindung|verkehrsfl[äa]che|park\s?&\s?ride/iu, summary: 'Planungen betreffen Straßen oder Verkehrsräume; weder Sperrungen noch Baubeginn ergeben sich automatisch daraus.' },
  { id: 'feuerwehr', label: 'Feuerwehr und Rettung', keywords: ['Feuerwehr', 'Rettungswache', 'Brandschutz'], pattern: /feuerwehr|rettungswache|brandschutz/iu, summary: 'Kommunen planen Standorte und Infrastruktur für Feuerwehr oder Rettung.' },
  { id: 'haushalt', label: 'Haushalt und Finanzen', keywords: ['Haushalt', 'Haushaltssicherung'], pattern: /haushalts?(?:satzung|plan|sicherung|entwurf|berat)/iu, summary: 'Mehrere Kommunen beraten ihre Haushalte; Planansätze sind keine Ist-Ausgaben.' },
  { id: 'hochwasser', label: 'Starkregen und Hochwasser', keywords: ['Starkregen', 'Hochwasser', 'Regenwasser'], pattern: /starkregen|hochwasser|regenwasser(?:bewirtschaftung|r[üu]ckhalt)|[üu]berschwemmung/iu, summary: 'Gemeinden befassen sich mit Schutz vor Starkregen und Hochwasser.' },
  { id: 'klimaschutz', label: 'Klimaschutz und Anpassung', keywords: ['Klimaschutz', 'Klimaanpassung'], pattern: /klimaschutz|klimaanpassung|klimaneutralit[äa]t/iu, summary: 'Mehrere Gemeinden bearbeiten lokale Klimaschutz- oder Anpassungskonzepte.' },
  { id: 'oepnv', label: 'Bus, Bahn und Tram', keywords: ['ÖPNV', 'Straßenbahn', 'Busverkehr'], pattern: /\b[öo]pnv\b|stra[ßs]enbahn|bus(?:verkehr|linie|bahnhof)|bahnhof(?:sumbau|svorplatz)|schienenverkehr/iu, summary: 'Verfahren betreffen öffentliche Verbindungen; Fahrplanänderungen sind damit noch nicht bestätigt.' },
  { id: 'sport', label: 'Sport und Freizeitflächen', keywords: ['Sportstätte', 'Sportplatz', 'Skateanlage', 'Freizeitanlage'], pattern: /sport(?:platz|halle|anlage|st[äa]tten?)|skate(?:r)?anlage|freizeit(?:anlage|gel[äa]nde|fl[äa]che)/iu, summary: 'Mehrere Orte beraten Sport- oder Freizeitflächen; ein Haushaltsantrag ist keine Eröffnung und ein Plan noch kein Bau.' },
  { id: 'aerzte', label: 'Ärztliche Versorgung', keywords: ['Ärztehaus', 'Gesundheitszentrum', 'Arztpraxis'], pattern: /[äa]rztehaus|gesundheitszentrum|arzt(?:praxis|versorgung)|medizinisches? versorgungszentrum/iu, summary: 'Gemeinden befassen sich mit Räumen für medizinische Versorgung; konkrete Praxen sind gesondert nachzuweisen.' }
];

const STOP = new Set('der die das ein eine einer eines und oder zum zur von des den fuer für bei mit nr stadt gemeinde amt landkreis bebauungsplan b plan bplan flächennutzungsplan flächennutzungsplans flaechennutzungsplan flaechennutzungsplans entwurf vorentwurf teil aenderung änderung plan verfahren gebiet öffentlichkeitsbeteiligung beteiligung auslegung öffentlichkeit 2025 2026 2027 nach gem baugb straße strasse'.split(' '));
export function tokens(title) {
  return [...new Set(title.toLocaleLowerCase('de').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').match(/[a-z]{4,}/g) || [])].filter(token => !STOP.has(token) && !STOP.has(token.replace(/ae/g, 'ä')));
}

// TF-IDF on titles, then connected components above cosine threshold; only
// titles without a taxonomy hit enter this exploratory (candidate) track.
export function titleClusters(items, threshold = 0.62) {
  const docs = items.map(item => tokens(item.title));
  const df = new Map();
  for (const doc of docs) for (const word of doc) df.set(word, (df.get(word) || 0) + 1);
  const vectors = docs.map(doc => new Map(doc.map(word => [word, Math.log((1 + docs.length) / (1 + df.get(word))) + 1])));
  const norm = vectors.map(vec => Math.hypot(...vec.values()));
  const parent = items.map((_, i) => i);
  const find = i => parent[i] === i ? i : parent[i] = find(parent[i]);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (items[i].municipalityId === items[j].municipalityId) continue;
    let dot = 0;
    for (const [word, weight] of vectors[i]) dot += weight * (vectors[j].get(word) || 0);
    if (norm[i] && norm[j] && dot / (norm[i] * norm[j]) >= threshold) parent[find(i)] = find(j);
  }
  const components = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(item);
  });
  return [...components.values()].filter(group => new Set(group.map(item => item.municipalityId)).size >= 2);
}
