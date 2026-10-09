'use client';
import { cityGameDestination } from '@/data/stadtstack-services';
import { MoreRow } from './blocks';

/** Plain outbound links only: opening a row does not contact the other service. */
export function CityGameRow({ cityId }: { cityId: string | null | undefined }) {
  const destination = cityGameDestination(cityId);
  return <MoreRow title="Explore the city through play" meta={destination.status}>
    <p>Stadtstack-Spiel lets you explore a city and try out ideas in a browser game. Its workshop and council scenarios are simulations, not public consultations or municipal decisions.</p>
    {destination.kind === 'chooser' && <p>There is no confirmed game edition for your selected city. The edition chooser lists the separately available cities; it does not change your city in Ledger.</p>}
    <p className="small-copy">No game account is needed. Game progress stays in that site&apos;s browser storage, separate from Ledger. A game stamp is not proof of attendance or civic participation. Published pages were checked on 9 October 2026; full gameplay was not verified.</p>
    <a className="button secondary" href={destination.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {destination.kind === 'edition' ? `Open ${destination.cityName} game` : 'Choose a game edition'} ↗
    </a>
  </MoreRow>;
}

export function LocalOfflineDeskRow() {
  return <MoreRow title="Local offline city desk" meta="Home Node · nearby LAN website · no account or payment">
    <p>A Home Node can serve a small local website with dated public city basics and a chat that calls its local model directly. Open the node&apos;s HTTP address on the same trusted Wi-Fi, hotspot or LAN; the public Ledger website and internet are not required. The node and model still need power and local connectivity.</p>
    <p><a className="button secondary" href="https://github.com/GiraeffleAeffle/ledger-of-life/blob/main/home-node/README.md" target="_blank" rel="noopener noreferrer">Home Node local desk setup ↗</a></p>
    <p className="small-copy">Plain local HTTP and model questions are visible to the local operator/network; do not enter private tenancy or identity data. Online pairing remains a separate mode. The owner&apos;s September Reticulum/LXMF/Qwen radio lab is historical evidence, not this website&apos;s transport or town coverage. Bluetooth PAN, mesh transaction relay and Myotis are roadmap; Myotis targets Ethereum-family networks, not Solana.</p>
  </MoreRow>;
}
