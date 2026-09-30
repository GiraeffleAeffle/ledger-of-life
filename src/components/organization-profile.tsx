import { strausbergOrganizationRelations, strausbergOrganizations, type OrganizationProfile } from '@/data/cities/strausberg-organizations';
import { openLocalAi, type Area } from './areas';

const channelName = { visit: 'Visit', buy: 'Products & services', contact: 'Contact', work: 'Careers', training: 'Training', supply: 'Supply', partner: 'Partner network' };

/** Public organization channels are not a map of suppliers, partners or investable issuers. */
export function OrganizationShelf({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  return <section className="civic-organizations" aria-label="Strausberg organizations"><div><span className="eyebrow">ORGANIZATION SOURCES · STRAUSBERG</span><h3>Who does what here?</h3></div>
    <div className="civic-organization-cards">{strausbergOrganizations.map((profile) => <button key={profile.id} type="button" aria-pressed={selectedId === profile.id} onClick={() => onSelect(profile.id)}>
      <strong>{profile.name}</strong><span>{profile.productsAndServices.join(' · ')}</span><small>{profile.signalId ? 'OpenStreetMap place · view on map' : 'Profile card · no verified map point'} →</small>
    </button>)}</div>
  </section>;
}

export function OrganizationDetail({ profile, matchedSignal, go }: { profile: OrganizationProfile; matchedSignal: boolean; go: (area: Area) => void }) {
  const relation = strausbergOrganizationRelations.find((item) => item.fromId === profile.id || item.toId === profile.id);
  const related = relation && strausbergOrganizations.find((item) => item.id === (relation.fromId === profile.id ? relation.toId : relation.fromId));
  return <><header className="civic-detail-header"><div><span className="eyebrow">PUBLIC ORGANIZATION PROFILE · {profile.sector.replaceAll('_', ' ')}</span><h3>{profile.name}</h3>
    <p>{matchedSignal ? 'Linked to its OpenStreetMap place.' : 'Profile · map location not yet linked.'}</p></div></header>
    <p><strong>Provides</strong> · {profile.productsAndServices.join('; ')}.</p>
    <div className="civic-organization-channels"><strong>Explore &amp; participate</strong>{profile.participation.map((channel) => <a key={`${channel.kind}:${channel.url}`} href={channel.url} target="_blank" rel="noopener noreferrer">
      {channelName[channel.kind]} · {channel.label} ↗{channel.detail && <small>{channel.detail}</small>}{channel.status !== 'verified_channel' && <small>{channel.status === 'published_opportunity' ? 'Organization-published opportunity · confirm availability directly' : 'Information & enquiry'}</small>}
    </a>)}</div>
    {related && relation && <p>Shared Stadtwerke Gruppe with {related.name} · <a href={relation.source.url} target="_blank" rel="noopener noreferrer">group source ↗</a>.</p>}
    {profile.sector === 'public_library' && <div className="civic-detail-actions"><button type="button" className="civic-view-button" onClick={() => openLocalAi(go, 'library')}>Try public-access AI in this app →</button><a href="/library">Open public AI access ↗</a></div>}
    <details className="civic-evidence"><summary>Organization sources · checked {profile.sources[0]?.checkedAt}</summary>{profile.sources.map((source) => <p key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.publisher} ↗</a> · checked {source.checkedAt}</p>)}<p>These publications describe services and participation channels, not supplier contracts with the project examples.</p></details>
  </>;
}
