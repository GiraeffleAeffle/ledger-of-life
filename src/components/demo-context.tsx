import './thread-public.css';

export function DemoContext() {
  return <details className="demo-context">
    <summary>Test networks · no real money</summary>
    <div className="demo-context-popover">
      <strong>What is real here</strong>
      <p>Money features run on test networks with test tokens. Nothing you hold here has monetary value, and test tokens cannot be sold or withdrawn for real money.</p>
      <dl className="demo-availability">
        <div><dt>Available on this site</dt><dd>You can do it here with test tokens. Check current deployment and service status before acting.</dd></div>
        <div><dt>Needs a local setup</dt><dd>Runs only when you run the app yourself, where test tools can play the other people.</dd></div>
        <div><dt>Planned</dt><dd>An idea on the Roadmap.</dd></div>
      </dl>
      <p>Public city records and connected services keep their own sources; check each record and transaction review for details.</p>
      {/* A full navigation on purpose: the workspace reads ?area= when the page loads, and this link also appears on /library. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/?area=ideas">What is built and what is planned → Roadmap</a>
    </div>
  </details>;
}
