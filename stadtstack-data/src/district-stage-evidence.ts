import type { DistrictExtractionClaims } from './district-schema.ts';

/** Literal finalization precheck; independent of private processing and custody. */
export function stageEvidenceSupports(stage: DistrictExtractionClaims['stage'], quote: string): boolean {
  if (!['adopted', 'in_force', 'implemented'].includes(stage)) return true;
  const finalAction = '(?:Satzungsbeschluss|Feststellungsbeschluss|als Satzung beschlossen|endgültig beschlossen|abschließend beschlossen|in Kraft getreten|rechtsverbindlich|rechtskräftig|wirksam geworden|fertiggestellt|abgeschlossen|in Betrieb genommen|eröffnet|umgesetzt|abgenommen)';
  if (new RegExp(`(?:soll(?:en)?|wird|werden|voraussichtlich|geplant|beabsichtigt|künftig|noch nicht|nicht)[^!?]{0,140}${finalAction}`, 'iu').test(quote)) return false;
  if (/(?:Entwurf|Vorlage|Vorschlag)[^!?]{0,40}(?:Satzungsbeschluss|Feststellungsbeschluss)|(?:Satzungsbeschluss|Feststellungsbeschluss)[^!?]{0,40}(?:soll|ist geplant|ist vorgesehen|wird[^!?]{0,20}gefasst)/iu.test(quote)) return false;
  if (stage === 'adopted') return /Satzungsbeschluss|Feststellungsbeschluss|als Satzung beschlossen|endgültig beschlossen|abschließend beschlossen/iu.test(quote);
  if (stage === 'in_force') return /in Kraft getreten|rechtsverbindlich|rechtskräftig|wirksam geworden/iu.test(quote);
  if (/(?:Beteiligung|Auslegung|Planverfahren|Planung|Vergabe|Ausschreibung|Beratung)[^!?]{0,60}(?:abgeschlossen|beendet)/iu.test(quote)) return false;
  return /fertiggestellt|abgeschlossen|in Betrieb genommen|eröffnet|umgesetzt|abgenommen/iu.test(quote);
}
