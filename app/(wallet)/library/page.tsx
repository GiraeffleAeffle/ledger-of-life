import Link from 'next/link';
import { Library } from 'lucide-react';
import { DemoContext } from '@/components/demo-context';
import { LocalAiWorkspace } from '@/components/local-ai';
import { libraryCityFromParam } from '@/components/local-ai-availability';

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ city?: string | string[] }> }) {
  const cityId = libraryCityFromParam((await searchParams).city);
  return <main className="library-page">
    <header className="library-page-header"><Link href="/"><Library size={25} />Ledger of Life · Library desk</Link><DemoContext /></header>
    <div className="library-page-intro"><span className="eyebrow">SHARED INFRASTRUCTURE, EVERYDAY USE</span><h1>Local intelligence,<br />shared.</h1><p>City AI infrastructure anyone can use: free within a shared allowance, or paid per generated token (0.0001 test tUSDG per output token, at most 192 tokens or 0.0192 tUSDG, charged only for a complete answer). Free questions need no account or wallet. Residence cannot be checked yet.</p></div>
    <LocalAiWorkspace initialMode="library" publicAccess cityId={cityId} />
    <footer className="library-page-footer">Avoid entering private information on a shared desk. <Link href="/">Return to your personal workspace →</Link></footer>
  </main>;
}
