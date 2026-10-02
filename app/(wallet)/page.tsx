import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Workspace } from '@/components/workspace';
import { areaLabel } from '@/components/areas';
import { areaFromSearch } from '@/components/workspace-location';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
async function locationFrom({ searchParams }: Props) {
  const values = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') search.set(key, value);
    else if (value?.length) search.set(key, value[0]);
  }
  return { area: areaFromSearch(search.toString()), tab: search.get('tab') ?? undefined };
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const { area } = await locationFrom(props);
  return { title: { absolute: `${areaLabel(area)} · Ledger of Life` } };
}
export default async function Home(props: Props) {
  const { area, tab } = await locationFrom(props);
  const sessionHint = (await cookies()).get('ledger-session')?.value === '1';
  return <Workspace initialArea={area} initialTab={tab} sessionHint={sessionHint} />;
}
