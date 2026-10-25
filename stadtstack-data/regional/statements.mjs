import {createHash} from 'node:crypto';
import {load} from 'cheerio';

// Product publication bounds, not a legal permission or an assessment of quotation rights.
export const REGIONAL_EXCERPT_LIMITS = Object.freeze({quoteCharacters: 600, statementCharacters: 1800, quotes: 6, sourceFraction: 0.5});

/** Select complete source blocks, never expand locator wording into asserted facts. */
export function extractRegionalStatement(html, anchors) {
  if (!Array.isArray(anchors) || !anchors.length || anchors.length > REGIONAL_EXCERPT_LIMITS.quotes || anchors.some(anchor => typeof anchor !== 'string' || !anchor.trim())) throw Error('Statement source anchors required within excerpt limit');
  const $ = load(html);
  $('script, style, nav, header, footer, form, aside').remove();
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const blocks = $('p, li, td, dd').toArray().map(element => ({element, text: normalize($(element).text())})).filter(block => block.text.length > 0);
  const quotes = [];
  for (const anchor of anchors) {
    const candidates = [...new Set(blocks.filter(block => block.text.includes(normalize(anchor))).map(block => block.text))];
    // Nested list/table blocks can repeat a smaller, more precise complete block.
    const smallest = candidates.filter(text => !candidates.some(other => other !== text && text.includes(other)));
    if (smallest.length !== 1) throw Error('Statement source anchor missing or ambiguous');
    const quote = smallest[0];
    if (quote.length > REGIONAL_EXCERPT_LIMITS.quoteCharacters) throw Error('Statement quote exceeds short-excerpt bound; do not truncate source qualifiers');
    if (!quotes.includes(quote)) quotes.push(quote);
  }
  const statement = quotes.join('\n\n');
  if (statement.length > REGIONAL_EXCERPT_LIMITS.statementCharacters) throw Error('Statement excerpts exceed publication bound');
  const scopes = new Map();
  for (const block of blocks.filter(block => quotes.includes(block.text))) {
    const article = $(block.element).closest('article').get(0);
    const scope = article ?? $(block.element).closest('main').get(0) ?? $('body').get(0);
    if (!scopes.has(scope)) scopes.set(scope, new Set());
    scopes.get(scope).add(block.text);
  }
  for (const [scope, selected] of scopes) {
    const texts = [...new Set($(scope).find('p, li, td, dd').toArray().map(element => normalize($(element).text())).filter(Boolean))];
    // Count only outer complete prose blocks, so nested list/table markup cannot inflate the denominator.
    const prose = texts.filter(text => !texts.some(other => other !== text && other.includes(text)));
    const total = prose.reduce((length, text) => length + text.length, 0);
    const excerpt = [...selected].reduce((length, text) => length + text.length, 0);
    if (!total || excerpt > total * REGIONAL_EXCERPT_LIMITS.sourceFraction) throw Error('Statement would reproduce a whole article or excessive source prose; select fewer complete excerpts');
  }
  const sourceSha256 = createHash('sha256').update(html).digest('hex');
  return {statement, statementEvidence: quotes.map(quote => ({quote, sourceSha256, textNormalization: 'html-whitespace-v1'}))};
}
