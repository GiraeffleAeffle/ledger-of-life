export function DemoContext() {
  return <details className="demo-context">
    <summary>Test networks · no real money{process.env.NEXT_PUBLIC_DEMO_SKIP_RECOVERY === '1' ? ' · demo' : ''}</summary>
    <div className="demo-context-popover">
      <strong>Explore the possibilities</strong>
      <p>This workspace demonstrates proposed projects and actions on test networks. Public city records and connected services keep their own sources; check each record and transaction review for details.</p>
    </div>
  </details>;
}
