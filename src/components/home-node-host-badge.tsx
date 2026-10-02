import { hostKindLabel } from './home-node-logic';
import './home-node.css';
export function HostKindBadge({ kind }: { kind: 'operator' | 'community' | undefined }) {
  return <span className={`home-node-host-kind ${kind ?? 'unknown'}`}>{hostKindLabel(kind)}</span>;
}
