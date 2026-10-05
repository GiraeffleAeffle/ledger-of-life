'use client';

import { useEffect, useState } from 'react';
import { deriveAiProgress, type ProgressRequest } from './local-ai-progress-state.ts';
import { HostKindBadge } from './home-node-host-badge';

const labels = {
  review: 'Review before starting', authorized: 'Payment authorised · waiting for an available host',
  waiting_host: 'Waiting for the host', host_awake: 'Host reports ready · waiting to start',
  answering: 'Host received your question · preparing the answer', confirming: 'Answer received · confirming payment',
  paid: 'Paid · answer ready', complete: 'Answer ready · no payment', failed: 'Request stopped',
};
const time = (at: string) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

export function LocalAiProgress({ request }: { request: ProgressRequest }) {
  const progress = request.progress ?? deriveAiProgress({ request });
  const terminal = ['failed', 'paid', 'complete'].includes(progress.stage);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!progress.startedAt || progress.endedAt || terminal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.startedAt, progress.endedAt, terminal]);
  if (progress.stage === 'review') return null;
  const events = progress.events;
  const elapsed = progress.startedAt && (!terminal || progress.endedAt) ? Math.max(0, Math.floor(((progress.endedAt ? Date.parse(progress.endedAt) : now) - Date.parse(progress.startedAt)) / 1000)) : null;
  const title = progress.stage === 'answering' && !request.host ? 'Local model answering' : labels[progress.stage];
  return <section className="local-ai-payment-review" aria-label="Answer progress" data-testid="ai-answer-progress">
    <p role="status"><strong>{title}</strong></p>
    {request.host && <p><strong>{request.host.name}</strong> <HostKindBadge kind={request.host.kind} /></p>}
    {elapsed !== null && <p className="local-ai-meta">{elapsed} s elapsed{terminal ? ' · finished' : ' · no completion estimate'}</p>}
    <ol>
      {events.authorizedAt && <li>Payment authorised at <time dateTime={events.authorizedAt}>{time(events.authorizedAt)}</time> · not charged</li>}
      {events.queuedAt && <li>Question queued for the host at <time dateTime={events.queuedAt}>{time(events.queuedAt)}</time></li>}
      {request.host && !events.pickedUpAt && !terminal && <li>Your question is waiting. We have not heard that the host has started it yet.</li>}
      {events.hostAwakeAt && <li>Host reported awake at <time dateTime={events.hostAwakeAt}>{time(events.hostAwakeAt)}</time></li>}
      {events.modelReachableAt && <li>AI service available at <time dateTime={events.modelReachableAt}>{time(events.modelReachableAt)}</time></li>}
      {events.pickedUpAt && <li>Host received your question at <time dateTime={events.pickedUpAt}>{time(events.pickedUpAt)}</time> · it may still need to load the AI model</li>}
      {events.answerReceivedAt && <li>Answer received at <time dateTime={events.answerReceivedAt}>{time(events.answerReceivedAt)}</time>{progress.money === 'pending' ? ' · withheld until payment confirmation' : ''}</li>}
      {progress.money === 'paid' && <li>Paid {new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(Number(request.payment.amountAtomic) / 1e6)} {request.solanaReview ? 'tUSDC' : 'tUSDG'} · {request.usage?.outputTokens ?? 'unknown'} output tokens{events.finishedAt ? ` · confirmed at ${time(events.finishedAt)}` : ''}</li>}
    </ol>
    <p className="local-ai-meta">{progress.money === 'none' ? 'No service payment: free or own compute.' : progress.money === 'pending' ? 'The answer is saved privately. Payment confirmation is pending; the charge is not yet confirmed. Do not authorise again.' : progress.money === 'paid' ? 'Payment confirmed. The answer is now available.' : progress.money === 'not_charged' ? 'No answer charge. An incomplete answer is not charged; any separate access-budget transaction may have a network fee.' : 'Authorisation is not a charge. Nothing is charged unless an answer completes and payment settles.'}</p>
    {progress.settlementTransaction && <p>Receipt{progress.money !== 'paid' ? ' · pending confirmation' : ''}{request.host && <> · {request.host.name} <HostKindBadge kind={request.host.kind} /></>}: <a href={request.solanaReview ? `https://explorer.solana.com/tx/${progress.settlementTransaction}?cluster=devnet` : `https://explorer.testnet.chain.robinhood.com/tx/${progress.settlementTransaction}`} target="_blank" rel="noopener noreferrer"><code>{progress.settlementTransaction}</code></a></p>}
  </section>;
}
