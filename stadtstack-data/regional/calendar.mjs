// The public iCal feed has meeting names, not agenda subjects; count coverage,
// but never invent a policy topic from the committee's name.
const URL = 'https://wriezen.ratsinfomanagement.net/termine/ics/SD.NET_RIM.ics';

export async function checkWriezenCalendar({ fetchSource, cutoffDate, warnings }) {
  try {
    const text = await fetchSource(URL);
    const events = text.split('BEGIN:VEVENT').slice(1);
    const dated = events.map(event => /^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})/m.exec(event)).filter(Boolean).map(match => `${match[1]}-${match[2]}-${match[3]}`);
    return { coverage: { allMeetings: events.length, meetingsSinceCutoff: dated.filter(date => date >= cutoffDate).length, topicalItems: 0 }, source: { id: 'wriezen-ical', type: 'councilCalendar', url: URL, licence: 'unknown', reuse: 'coverage_only', note: 'Meeting titles do not identify policy topics' } };
  } catch (error) {
    warnings.push(`Wriezen council calendar ${URL}: ${error.message}`);
    return { coverage: { allMeetings: 0, meetingsSinceCutoff: 0, topicalItems: 0 }, source: { id: 'wriezen-ical', type: 'councilCalendar', url: URL, status: 'unavailable', licence: 'unknown' } };
  }
}
