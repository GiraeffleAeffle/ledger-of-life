import Link from 'next/link';
import { Library } from 'lucide-react';
import { DemoContext } from '@/components/demo-context';
import { LocalAiWorkspace } from '@/components/local-ai';

export default function LibraryPage() {
  return <main className="library-page">
    <header className="library-page-header"><Link href="/"><Library size={25} />Ledger of Life · Library desk</Link><DemoContext /></header>
    <div className="library-page-intro"><span className="eyebrow">SHARED INFRASTRUCTURE, EVERYDAY USE</span><h1>Local intelligence,<br />shared.</h1><p>A free-access example for libraries and community spaces, running on this workspace&apos;s local node. Bring a question—not a wallet.</p></div>
    <LocalAiWorkspace initialMode="library" publicAccess />
    <footer className="library-page-footer">Avoid entering private information on a shared desk. <Link href="/">Return to your personal workspace →</Link></footer>
  </main>;
}
