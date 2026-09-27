import { load } from 'cheerio';
import { TOPICS } from './taxonomy.mjs';

// Three publicly listed September 2026 council meetings, not a bulk archive.
// SessionNet permits this generic research UA according to its robots.txt.
const MEETINGS = [4422, 4599, 4600];
const HOST = 'https://buergerinfo.gemeinde-hoppegarten.de/';

export async function collectCouncil({ fetchSource, warnings }) {
  const items = [];
  let fetched = 0;
  for (const id of MEETINGS) {
    const url = new URL(`si0057.asp?__ksinr=${id}`, HOST).href;
    try {
      const $ = load(await fetchSource(url));
      const dateMatch = $('title').text().match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (!dateMatch) throw Error('Meeting date not found in title');
      const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
      const seen = new Set();
      for (const row of $('tr').toArray()) {
        const anchor = $(row).find('a[href^="to0050.asp?"]').first();
        const href = anchor.attr('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const title = anchor.text().replace(/\s+/g, ' ').trim();
        if (!TOPICS.some(topic => topic.pattern.test(title))) continue;
        const top = $(row).find('.tofnum').text().replace(/\s+/g, ' ').trim();
        const decision = $(row).find('.smc_field_smcdv0_box2_beschluss').text().replace(/\s+/g, ' ').trim();
        const reference = $(row).find('a[href^="vo0050.asp?"]').first().text().trim();
        const stage = /(?:ungeändert|geändert) beschlossen/i.test(decision) ? 'decision_recorded' : /verwiesen/i.test(decision) ? 'referred' : 'agenda';
        items.push({ municipalityId: 'hoppegarten', title, url: new URL(href, HOST).href, date, sourceType: 'councilAgenda', locator: `${top} · Sitzung ${date}${reference ? ` · ${reference}` : ''}${decision ? ` · ${decision}` : ''}`, stage });
      }
      fetched++;
    } catch (error) { warnings.push(`Council agenda ${url}: ${error.message}`); }
  }
  return { items, coverage: { checkedMeetings: fetched, meetingsRequested: MEETINGS.length, topicItems: items.length }, sources: [{ id: 'hoppegarten-sessionnet', type: 'councilAgenda', url: `${HOST}si0040.asp`, licence: 'unknown', reuse: 'facts_with_attribution', checkedMeetings: fetched }] };
}
