import type { Metadata } from 'next';
import { TopicFlowDemo } from '@/components/topic-flow-demo';

export const metadata: Metadata = {
  title: 'Bürger-Themenweg · Ledger of Life',
  description: 'Schreibgeschützter lokaler Themenweg mit Trammer Ratsbelegen. Erfunden markierte Beispiele sind keine echten Beiträge oder Abstimmungen.',
};

export default function TopicDemoPage() {
  return <TopicFlowDemo />;
}
