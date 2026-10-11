export function extractRegionalStatement(html:string,anchors:string[]):{statement:string;statementEvidence:Array<{quote:string;sourceSha256:string;textNormalization:'html-whitespace-v1'}>};
export const REGIONAL_EXCERPT_LIMITS:Readonly<{quoteCharacters:600;statementCharacters:1800;quotes:6;sourceFraction:0.5}>;
