'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { CityCard } from './city';
import { CityFeedList } from './city-feed';
import type { PlacesResult, LiveSection, PlaceSource } from '@/server/places-live';
import { strausbergSources as strausberg } from '@/data/cities/strausberg';
import { PersonalMap, CITY_CHANGED_EVENT } from './personal-map';
import { CityRegionTopics } from './region-topics';
import { useCitySignals } from './use-city-signals';
import './places.css';

type Request = <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>;
const checked = '26 Sep 2026';
const day = (value: string) => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const km = (value: number) => `${value.toFixed(1)} km`;

function Link({ url, children }: { url: string; children: React.ReactNode }) {
  return <a href={url} target="_blank" rel="noopener noreferrer">{children} <ArrowUpRight size={12} aria-hidden /></a>;
}
function Badge({ level }: { level: 'read_only_live' | 'illustration' }) {
  return <span className="places-level">{level === 'read_only_live' ? 'READ-ONLY LIVE' : 'ILLUSTRATION'}</span>;
}
function Source({ source, asOf, stale }: { source: PlaceSource; asOf: string; stale?: boolean }) {
  return <p className="places-meta"><Link url={source.url}>{source.name}</Link> · observed {asOf} · <Link url={source.licenceUrl}>{source.licence}</Link>{stale && <strong> · STALE: upstream unavailable; last good observation</strong>}</p>;
}
function Unavailable({ result }: { result: LiveSection<unknown> }) {
  return result.state === 'unavailable' ? <p className="places-unavailable">Temporarily unavailable · no verified reading available. No estimate is shown.</p> : null;
}

/** Places joins published city signals and city news with clearly labelled live source gaps. */
export function PlacesArea({ request }: { request: Request }) {
  const [places, setPlaces] = useState<PlacesResult | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    request<{ places: PlacesResult | null; reason?: string }>('/api/places')
      .then(({ places: result, reason: unavailable }) => { if (active) { setPlaces(result); setReason(unavailable ?? ''); } })
      .catch(() => { if (active) { setPlaces(null); setReason('Places data is temporarily unavailable.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, version]);
  const { cityId } = useCitySignals(request);
  const strausbergCity = places?.cityId === 'strausberg';
  return <div className="places-area">
    <CityCard request={request} onCityChange={() => { window.dispatchEvent(new Event(CITY_CHANGED_EVENT)); setPlaces(null); setLoading(true); setVersion((current) => current + 1); }} />
    <CityFeedList request={request} cityId={cityId} />
    <CityRegionTopics request={request} cityId={cityId} />
    <PersonalMap request={request} />
    {loading && <p className="places-loading"><Loader2 size={16} className="spin" /> Reading public city sources…</p>}
    {!loading && !places && <p className="places-unavailable">{reason === 'choose' ? 'Choose your city above to discover public sources.' : reason}</p>}
    {places && <>
      <section className="card places-section">
        <div className="places-heading"><div><span className="eyebrow">LIVE SOURCE OBSERVATIONS</span><h2>A measurable city</h2></div><Badge level="read_only_live" /></div>
        <p className="small-copy">Nearby observations for {places.city}; not a measurement for every address in the city.</p>
        {places.coordinates.state === 'available' && <p className="places-meta">Location: <Link url={places.coordinates.value.url}>{places.coordinates.value.source}</Link> · source as of {places.coordinates.value.observedAt} · location reuse terms: {places.coordinates.value.source.startsWith('OpenStreetMap') ? 'OSM ODbL' : 'atlas research preview; no open-data licence established'}{places.coordinates.stale && ' · STALE'}</p>}
        <div className="places-measures">
          <div className="places-measure">
            <h3>Weather · DWD</h3>
            {places.weather.state === 'available' ? <>
              <strong className="places-value">{places.weather.value.temperature.toFixed(1)} °C</strong>
              <p>{places.weather.value.condition} · {places.weather.value.humidity ?? '—'} % humidity</p>
              <p>Station for temperature: {places.weather.value.station} · {km(places.weather.value.distanceKm)} from map centre{places.weather.value.fallback && ' · Bright Sky fallback station'}</p>
              <Source source={places.weather.value.source} asOf={day(places.weather.value.timestamp)} stale={places.weather.stale} />
            </> : <Unavailable result={places.weather} />}
          </div>
          <div className="places-measure">
            <h3>Nearby particulate sensors</h3>
            {places.air.state === 'available' ? <>
              <p><strong>{places.air.value.sensors.length}</strong> outdoor sensors with PM2.5 within 5 km (not an average)</p>
              {places.air.value.sensors.length === 0 && <p>No outdoor PM2.5 reading returned within 5 km.</p>}
              <ul>{places.air.value.sensors.map((sensor) => <li key={sensor.id}>
                <Link url={sensor.url}>Sensor {sensor.id}</Link> · {km(sensor.distanceKm)} · PM2.5 {sensor.pm25} µg/m³{sensor.pm10 !== null && ` · PM10 ${sensor.pm10} µg/m³`} · {day(sensor.timestamp)}
              </li>)}</ul>
              <p className="places-caveat">{places.air.value.caveat}</p>
              <Source source={places.air.value.source} asOf={day(places.air.observedAt)} stale={places.air.stale} />
            </> : <Unavailable result={places.air} />}
          </div>
        </div>
      </section>
      <section className="card places-section">
        <div className="places-heading"><div><span className="eyebrow">OSM PLACES BEYOND PUBLISHED CITY SIGNALS</span><h2>Additional sports facilities</h2></div><Badge level="read_only_live" /></div>
        {places.clubs.state === 'available' ? <>
          <p><strong>{places.clubs.value.total} named leisure facilities</strong> in the matched administrative city boundary · {places.clubs.value.caveat}</p>
          {places.clubs.value.groups.length === 0 && <p>No additional named sports facilities returned for this city. Published club and sport places are in the map above.</p>}
          <div className="places-groups">{places.clubs.value.groups.map((group) => <details key={group.type}>
            <summary>{group.type} <span>{group.count}</span></summary>
            <ul>{group.items.map((item) => <li key={item.id}><Link url={item.url}>{item.name}</Link></li>)}</ul>
          </details>)}</div>
          <Source source={places.clubs.value.source} asOf={day(places.clubs.observedAt)} stale={places.clubs.stale} />
        </> : <Unavailable result={places.clubs} />}
        {strausbergCity && <div className="places-directories"><h3>Official directories · links, not imported listings</h3><ul>{strausberg.directories.map((item) => <li key={item.url}><Link url={item.url}>{item.label}</Link></li>)}</ul><p className="places-meta">Sources: city and district websites · checked {checked} · page reuse licence not established · illustration (outbound links).</p></div>}
      </section>
      <section className="card places-section">
        <div className="places-heading"><div><span className="eyebrow">BUDGET PLANS · NOT YOUR TAX RECEIPT</span><h2>Where the money goes</h2></div><Badge level="illustration" /></div>
        <p>Published budget figures below are plans, not actual spending or a receipt for your own taxes.</p>
        <details><summary>How municipal money flows · legal explainer</summary>
          <p>German law allocates 15% of wage and assessed income tax nationally to municipalities by statutory keys, <strong>not</strong> 15% of your own income-tax bill paid directly to your city.</p>
          <ul className="places-flow">
            <li><strong>Residence → municipality</strong> · Municipalities receive 15% of wage and assessed income tax, allocated by statutory keys. <Link url="https://www.gesetze-im-internet.de/gemfinrefg/__1.html">GemFinRefG § 1</Link></li>
            <li><strong>Businesses → operating municipality</strong> · Trade tax belongs to the municipality where business operations take place. <Link url="https://www.gesetze-im-internet.de/gewstg/__4.html">GewStG § 4</Link></li>
            <li><strong>Trade-tax levy</strong> · A statutory portion of gross trade tax is transferred to the federal and state levels. <Link url="https://www.gesetze-im-internet.de/gemfinrefg/__6.html">GemFinRefG § 6</Link></li>
            <li><strong>State → municipalities in Brandenburg</strong> · BbgFAG defines fiscal equalisation, including key allocations based on fiscal capacity and assessed need; this rule is specific to Brandenburg. <Link url="https://bravors.brandenburg.de/gesetze/bbgfag">BbgFAG §§ 7–10</Link></li>
          </ul>
          <p className="places-meta">Sources: linked primary laws · researched {checked} · legal-text reuse licence not established · illustration (statutory flow, no individual estimate).</p>
        </details>
        <div className="places-publications"><h3>What {places.city} publishes</h3>
          {strausbergCity ? <>
            <ul>
              <li><Link url="https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf">2025/26 budget ordinance, § 1, PDF page 1</Link> · <strong>planned investment outlays:</strong> €17,941,270 in 2025 and €12,609,320 in 2026. These are adopted plan amounts, <strong>not money spent</strong> and not a project-by-project allocation. Adopted 7 Nov 2024; published in the city gazette 23 Nov 2024. The detailed plan and annexes are offered for inspection at the Kämmerei; a full online plan was not found. <Link url={strausberg.inspectionLaw}>BbgKVerf § 69</Link></li>
              <li><Link url={strausberg.gazette}>2018 annual account</Link> · adopted 26 Sep 2024, gazette p. 2. This is the latest whole-city adopted annual account found in the examined sources, <strong>not</strong> a claim that none was adopted since.</li>
              <li><Link url={strausberg.informationAccessLaw}>Request the complete 2025/26 plan and annexes electronically</Link> from Stadt Strausberg Kämmerei under Brandenburg&apos;s AIG; access may be subject to exclusions, fees and redaction.</li>
              <li>Comparison: <Link url={strausberg.bernau}>Bernau</Link> and <Link url={strausberg.brandenburg}>Brandenburg an der Havel</Link> publish detailed budget material online; this does not establish Strausberg&apos;s detailed plan allocations or actual spending.</li>
            </ul>
            <p className="places-meta">Source: Stadt Strausberg 2025/26 budget ordinance, § 1, PDF page 1; city Amtsblatt pp. 24–25 · publication 23 Nov 2024; research checked {checked} · no explicit open-data licence found for city PDFs; linked source with attributed headline figures only · illustration, not actual spending.</p>
          </> : <p>Not researched yet for {places.city}. No city budget figures or publication claims available.</p>}
        </div>
      </section>
      <section className="card places-section">
        <div className="places-heading"><div><span className="eyebrow">FROM YOUR STREET OUTWARD</span><h2>From your street to the world</h2></div><Badge level="illustration" /></div>
        <p className="small-copy">A navigation map, not a live feed at every level. The personal map above shows published street and neighbourhood signals where covered; district, state and world feeds are not integrated.</p>
        <ol className="places-scales">{(strausbergCity ? strausberg.hierarchy : [
          { level: `City · ${places.city}`, available: 'City atlas (if researched); other levels not researched yet', url: '' },
          { level: 'District · not researched yet', available: 'No verified local link', url: '' },
          { level: 'State · not researched yet', available: 'No verified local link', url: '' },
          ...strausberg.hierarchy.slice(3),
        ]).map((level) => <li key={level.level}><strong>{level.level}</strong><span>{level.available}{level.url && <> · <Link url={level.url}>Official portal</Link></>}</span></li>)}</ol>
        <p className="places-meta">Sources: linked official city, district, state, Bundestag and EU portals · checked {checked} · link-only; page reuse licences not established · illustration.</p>
      </section>
      <section className="card places-section">
        <div className="places-heading"><div><span className="eyebrow">OFFICIAL COUNCIL LINKS</span><h2>Council papers &amp; meetings</h2></div><Badge level="illustration" /></div>
        {strausbergCity ? <>
          <p>Strausberg’s public ALLRIS portal exposes a calendar and document search. No working public OParl endpoint was confirmed; meeting names and dates are not mirrored here.</p>
          <div className="places-links"><Link url={strausberg.calendar}>Open meeting calendar</Link><Link url={strausberg.documents}>Search public documents</Link></div>
          <p className="places-meta">Source: Stadt Strausberg ALLRIS public portal · checked {checked} · portal reuse licence not established · illustration (outbound links only).</p>
        </> : <p>Not researched yet for {places.city}. No council feed or official directory claimed.</p>}
      </section>
    </>}
  </div>;
}
