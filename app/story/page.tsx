import type { Metadata } from 'next';
import { CityStoryView } from '@/components/city-story';
import { loadCityStory } from '@/server/city-story';

export const metadata: Metadata = {
  title: 'A city story · Ledger of Life',
  description: 'Two fictional people, one city: follow Mara and Jonas in Strausberg with real test-network receipts, clearly labelled fiction and illustrative calculations. No account needed.',
};

export default function StoryPage() {
  return <CityStoryView story={loadCityStory()} />;
}
