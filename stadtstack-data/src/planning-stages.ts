/** Source-supported BauGB milestones, not a chronology inferred from document age. */
export const planningStages=['initiation','pre_draft','early_consultation','draft','formal_consultation','evaluation','adopted','approved','in_force'] as const;
export type PlanningStage=typeof planningStages[number];
export const positiveStages=['planning','agenda','motion','initiation','pre_draft','early_consultation','draft','consultation','formal_consultation','consultation_closed','evaluation','decision_pending','decision','adopted','approved','in_force','implemented'] as const;
export const stageSemanticsVersion='stadtstack-stage-semantics-0.3.2';
/** Generic civic ordering remains separate from legally ordered BauGB milestones. */
export function milestoneRank(stage:string,planning:boolean):number|null {
 if(planning&&planningStageRank(stage)===null)return null;
 const rank=(positiveStages as readonly string[]).indexOf(stage);
 return rank<0?null:rank;
}
export type PlanningStageAssertion={stage:string;quote:string;originalStatus?:string|null};
export type StageRankingContext='baugb'|'civic';
export function stageRankingContext(input:{title:string;titleQuote?:string|null;caseQuote?:string|null;summaryQuote?:string|null;instrument?:string|null}):StageRankingContext {
 return isPlanningInstrument(`${input.titleQuote??input.title}\n${input.caseQuote??''}\n${input.summaryQuote??''}`)||Boolean(input.instrument?.match(/^(?:bplan|fnp|teilfnp):/))?'baugb':'civic';
}
/** Shared by milestone, vocabulary and filter consumers; raw assertions stay intact. */
export function normalizeStageAssertion(assertion:PlanningStageAssertion,context:StageRankingContext):string {
 return context==='baugb'?normalizePlanningStage(assertion):assertion.stage;
}
export type CanonicalStageDateAssertion={stage:string;date:string|null};
/** A stage and its date bounds must refer to one and the same sourced assertion. */
export function matchesStageDateAssertions(assertions:readonly CanonicalStageDateAssertion[],stage:string,dateFrom?:string,dateTo?:string):boolean {
 return assertions.some(assertion=>assertion.stage===stage&&(!dateFrom||assertion.date!==null&&assertion.date.slice(0,10)>=dateFrom)&&(!dateTo||assertion.date!==null&&assertion.date.slice(0,10)<=dateTo));
}
const early=/(?:frühzeitig\w*\s+(?:Beteiligung|Unterrichtung|Öffentlichkeitsbeteiligung)|§{1,2}\s*[34]\s*(?:Abs\.?\s*1|\(\s*1\s*\)))/iu;
const formal=/(?:§{1,2}\s*[34]\s*(?:Abs\.?\s*2|\(\s*2\s*\))|öffentliche\s+Auslegung|öffentlich\s+ausgelegt)/iu;
const unsettledEvent=/\b(?:geplant|vorgesehen|beabsichtigt|beantragt|voraussichtlich|künftig|zukünftig|soll|sollen|sollte|sollten|würde|würden|nicht|kein\w*|versagt|ausstehend|aufgehoben|zurückgenommen|zurückgestellt|abgelehnt|erwartet|historisch\w*|früher\w*|damalig\w*)\b|Rückblick|steht\s+noch\s+aus|(?:wird|werden)[\s\S]{0,80}(?:erteilt|beschlossen|gefasst|genehmigt|erfolgen)/iu;
/** Refine only the asserted milestone; a historical mention cannot promote another claim. */
export function normalizePlanningStage(assertion:PlanningStageAssertion):string {
 const {stage}=assertion,quote=assertion.quote;
 if(!quote.trim())return 'unknown';
 if(stage==='consultation'||stage==='consultation_closed'||stage==='early_consultation'||stage==='formal_consultation'){
  if(unsettledEvent.test(quote))return 'consultation';
  const earlySupported=early.test(quote)||/frühzeitig[\s\S]{0,35}öffentlich\s+ausgelegt/iu.test(quote);
  const formalSupported=formal.test(quote);
  // Two phases in one quotation do not bind a particular phase to this claim/date.
  // Explicit early public display is one phase, unless section (2) is also cited.
  const earlyDisplay=/frühzeitig[\s\S]{0,35}öffentlich\s+ausgelegt/iu.test(quote)&&! /§{1,2}\s*[34]\s*(?:Abs\.?\s*2|\(\s*2\s*\))/iu.test(quote);
  if(earlySupported&&formalSupported&&!earlyDisplay)return 'consultation';
  if(earlySupported)return 'early_consultation';
  // Public display of a Vorentwurf alone does not establish section 3(2)/4(2).
  if(formalSupported&&! /Vorentwurf/iu.test(quote))return 'formal_consultation';
  return 'consultation';
 }
 if(stage==='draft'||stage==='pre_draft'){
  const preliminary=/\bVorentwurf\b/iu.test(quote),draft=/\bEntwurf\b/iu.test(quote);
  if(preliminary&&draft){
   const asserted=assertion.originalStatus?.trim();
   if(asserted&&/^(?:Vorentwurf|Entwurf)$/iu.test(asserted))return /^Vor/iu.test(asserted)?'pre_draft':'draft';
   if(/^\s*(?:Begründung\s+zum\s+)?Entwurf\b(?!\s+(?:und|oder)\b)/iu.test(quote)&&/(?:gegenüber|nach|bisher|vorher|früher)/iu.test(quote))return 'draft';
   return 'unknown';
  }
  if(preliminary)return 'pre_draft';
  return draft?'draft':'planning';
 }
 if(stage==='decision'||stage==='adopted'||stage==='initiation'||stage==='approved'||stage==='evaluation'){
  const unresolved=stage==='decision'?'decision':'unknown';
  if(unsettledEvent.test(quote))return unresolved;
  const approval=/Genehmigungsbescheid|Genehmigung[\s\S]{0,60}erteilt|wurde[\s\S]{0,60}genehmigt/iu.test(quote);
  const evaluation=/Abwägungsbeschluss|Abwägung[\s\S]{0,60}beschlossen/iu.test(quote);
  const initiation=/Aufstellungsbeschluss|Aufstellung[\s\S]{0,60}beschlossen/iu.test(quote);
  const adoption=/Satzungsbeschluss|Feststellungsbeschluss|als\s+Satzung\s+beschlossen/iu.test(quote);
  if(Number(approval)+Number(evaluation)+Number(initiation)+Number(adoption)>1)return unresolved;
  // Accept isolated event headings or bounded affirmative passive main clauses.
  // An auxiliary elsewhere in a conditional/question is not completion evidence.
  if(approval&&(/^\s*Genehmigungsbescheid(?:\s+(?:am|vom)\s+[\d. -]+)?[.!]?\s*$/iu.test(quote)||/^\s*(?:(?:Die\s+)?Genehmigung\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?erteilt|(?:Der\s+)?(?:Bebauungsplan|Flächennutzungsplan|Plan)(?:\s+Nr\.?\s*[\d/-]+)?\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?genehmigt)[.!]?\s*$/iu.test(quote)))return 'approved';
  if(evaluation&&(/^\s*Abwägungsbeschluss(?:\s+(?:am|vom)\s+[\d. -]+)?[.!]?\s*$/iu.test(quote)||/^\s*(?:(?:Die\s+)?Abwägung\s+(?:wurde|ist)\s+beschlossen|(?:Der\s+)?Abwägungsbeschluss\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?gefasst)[.!]?\s*$/iu.test(quote)))return 'evaluation';
  if(initiation&&(/^\s*Aufstellungsbeschluss(?:\s+(?:am|vom)\s+[\d. -]+)?[.!]?\s*$/iu.test(quote)||/^\s*(?:(?:Die\s+)?Aufstellung\s+(?:wurde|ist)\s+beschlossen|(?:Der\s+)?Aufstellungsbeschluss\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?gefasst)[.!]?\s*$/iu.test(quote)))return 'initiation';
  if(adoption&&(/^\s*(?:Satzungsbeschluss|Feststellungsbeschluss)(?:\s+(?:am|vom)\s+[\d. -]+)?[.!]?\s*$/iu.test(quote)||/^\s*(?:(?:Der\s+)?(?:Satzungsbeschluss|Feststellungsbeschluss)\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?gefasst|(?:Der\s+)?(?:Bebauungsplan|Flächennutzungsplan|Plan)(?:\s+Nr\.?\s*[\d/-]+)?\s+(?:wurde|ist)\s+(?:am\s+[\d. -]+\s+)?als\s+Satzung\s+beschlossen)[.!]?\s*$/iu.test(quote)))return 'adopted';
  return unresolved;
 }
 return stage;
}
export function planningStageRank(stage:string):number|null {
 const index=(planningStages as readonly string[]).indexOf(stage);
 return index<0?null:index;
}
export function isPlanningInstrument(text:string):boolean {
 return /BauGB|Bebauungsplan|Flächennutzungsplan|Vorhaben\s*[-–]?\s*und\s+Erschließungsplan|\b(?:v?B[- ]?Plan|FNP)\b/iu.test(text);
}
