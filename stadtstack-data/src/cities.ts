export const slug = (name: string) => name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface City { id: string; name: string; state: string; endpoint?: string; status?: string; councilBodyId?: string; councilBodyAliases?: string[]; center: [number, number]; bbox: [number, number, number, number]; osmRelation: number; roads: string[] }
// Coordinates are bootstrap bounds; Nominatim boundary results supersede them in the cache.
export const cities: City[] = [
  {id:'strausberg',name:'Strausberg',state:'Brandenburg',center:[13.887,52.58],bbox:[13.75,52.49,14.03,52.69],osmRelation:1332939,roads:['A10','A11','A12']},
  {id:'koeln',name:'Köln',state:'Nordrhein-Westfalen',endpoint:'https://buergerinfo.stadt-koeln.de/oparl/system',status:'verified',councilBodyId:'https://buergerinfo.stadt-koeln.de/oparl/bodies/stadtverwaltung_koeln',councilBodyAliases:['Stadt Köln, kreisfreie Stadt'],center:[6.96,50.94],bbox:[6.76,50.83,7.16,51.09],osmRelation:62578,roads:['A1','A3','A4','A57','A59','A555']},
  {id:'muenster',name:'Münster',state:'Nordrhein-Westfalen',endpoint:'https://oparl.stadt-muenster.de/system',status:'verified',councilBodyId:'https://oparl.stadt-muenster.de/bodies/0001',councilBodyAliases:['Stadt Münster'],center:[7.63,51.96],bbox:[7.47,51.84,7.81,52.07],osmRelation:62591,roads:['A1','A43']},
  // These vendor labels are approved only for the pinned single Body of the city-named official System.
  {id:'wuppertal',name:'Wuppertal',state:'Nordrhein-Westfalen',endpoint:'https://oparl.wuppertal.de/oparl/system',status:'verified',councilBodyId:'https://oparl.wuppertal.de/oparl/bodies/0001',councilBodyAliases:['Instance 0001'],center:[7.18,51.26],bbox:[7.02,51.17,7.36,51.34],osmRelation:62478,roads:['A1','A46']},
  {id:'castrop-rauxel',name:'Castrop-Rauxel',state:'Nordrhein-Westfalen',endpoint:'https://castroprauxel.gremien.info/oparl',status:'verified',councilBodyId:'https://castroprauxel.gremien.info/oparl/body/CAS',councilBodyAliases:['Stadt Castrop-Rauxel'],center:[7.31,51.55],bbox:[7.22,51.49,7.43,51.61],osmRelation:56664,roads:['A2','A42','A45']},
  {id:'duesseldorf',name:'Düsseldorf',state:'Nordrhein-Westfalen',endpoint:'https://ris-oparl.itk-rheinland.de/Oparl/system',status:'verified',councilBodyId:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015',councilBodyAliases:['Stadt Duesseldorf'],center:[6.77,51.23],bbox:[6.69,51.12,6.94,51.32],osmRelation:62539,roads:['A3','A44','A46','A52','A57','A59']},
  {id:'dresden',name:'Dresden',state:'Sachsen',endpoint:'https://oparl.dresden.de/system',status:'verified',councilBodyId:'https://oparl.dresden.de/bodies/0001',councilBodyAliases:['Instance 0001'],center:[13.74,51.05],bbox:[13.57,50.98,13.97,51.18],osmRelation:191645,roads:['A4','A17']},
  {id:'freiburg',name:'Freiburg',state:'Baden-Württemberg',endpoint:'https://ris.freiburg.de/oparl',status:'verified',councilBodyId:'https://ris.freiburg.de/oparl/body/FR',councilBodyAliases:['Stadtverwaltung Freiburg'],center:[7.85,48],bbox:[7.7,47.9,8.02,48.1],osmRelation:62768,roads:['A5']},
];
export const endpointRegistry = [...cities.filter(c => c.endpoint).map(c => ({id:c.id,name:c.name,state:c.state,endpoint:c.endpoint!,status:c.status!,bodyId:c.councilBodyId})),
  // Verified council candidates only: not enabled as city/map/feed coverage.
  {id:'neuss',name:'Neuss',state:'Nordrhein-Westfalen',endpoint:'https://ris-oparl.itk-rheinland.de/Oparl/system',bodyId:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009',status:'verified'},
  {id:'moenchengladbach',name:'Mönchengladbach',state:'Nordrhein-Westfalen',endpoint:'https://ris-oparl.itk-rheinland.de/Oparl/system',bodyId:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0011',status:'verified'},
  {id:'krefeld',name:'Krefeld',state:'Nordrhein-Westfalen',endpoint:'https://ris.krefeld.de/webservice/oparl/v1.1/system',status:'verified'},
  {id:'solingen',name:'Solingen',state:'Nordrhein-Westfalen',endpoint:'https://sdnetrim.kdvz-frechen.de/rim4957/webservice/oparl/v1.1/system',status:'verified'},
  {id:'kerpen',name:'Kerpen',state:'Nordrhein-Westfalen',endpoint:'https://sdnetrim.kdvz-frechen.de/rim4770/webservice/oparl/v1.0/system',status:'verified'}];
