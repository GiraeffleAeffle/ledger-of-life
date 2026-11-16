import type { Metadata } from 'next';
import { TopicFlowDemo } from '@/components/topic-flow-demo';

export const metadata: Metadata = {
  title: 'Solarpark statt Acker · Büchen · Ledger of Life',
  description: 'B-Plan 70 in Büchen: echte Quellen, 18 erfundene Perspektiven und ein nachvollziehbarer Weg vom Bürgeranliegen zum beratenden Meinungsbild.',
};

export default function TopicDemoPage() {
  return <TopicFlowDemo />;
}
