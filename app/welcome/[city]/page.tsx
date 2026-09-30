import type { Metadata } from 'next';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { arrivalGuideFor } from '@/data/arrival';
import { ArrivalGuideView } from '@/components/arrival-guide';
import { readWelcomeFeed } from '@/server/welcome-feed';
import '@/components/arrival.css';

export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const guide = arrivalGuideFor((await params).city);
  if (!guide) return {};
  return {
    title: `Welcome to ${guide.cityName} · Ledger of Life`,
    description: `A community guide for your first months in ${guide.cityName}: what to do, who to ask and what is on. Every item cites its source. Not an official city service.`,
  };
}

export default async function WelcomePage({ params }: { params: Promise<{ city: string }> }) {
  const guide = arrivalGuideFor((await params).city);
  if (!guide) notFound();
  await connection(); // Event dates and the published feed must be read at request time.
  const feed = await readWelcomeFeed(guide.cityId);
  return <ArrivalGuideView guide={guide} feed={feed} now={new Date().toISOString()} />;
}
