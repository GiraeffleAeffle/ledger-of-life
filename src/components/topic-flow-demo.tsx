'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, ChevronLeft, FileText, HelpCircle, Leaf, MapPin, MessageCircle, Route, Scale, ShieldCheck, Sparkles, Sprout, Sun, Users, Wallet } from 'lucide-react';
import { TOPIC_CITIZEN_PROBLEM, TOPIC_COMPARABLES, TOPIC_COUNCIL, TOPIC_DEMO_STAGES, TOPIC_ENERGY, TOPIC_FEED_ITEMS, TOPIC_FLOW_CASE_ID, TOPIC_FLOW_SNAPSHOT, TOPIC_SOURCE_TIMELINE, TOPIC_SOURCES, type TopicStageId } from '@/data/topic-flow-demo';
import { TOPIC_ADVISORY, TOPIC_AI, TOPIC_DEPARTMENTS, TOPIC_OPEN_QUESTIONS, TOPIC_OPTIONS, TOPIC_REVISIONS } from '@/data/topic-proposal';
import { TOPIC_ARGUMENTS } from '@/data/topic-discussion';
import { TopicDiscussion } from './topic-discussion';
import { TopicPlace } from './topic-place';
import { TopicExplainer } from './topic-explainer';
import { TopicAgriPv, TopicSolarBenefits } from './topic-solar-benefits';
import { moveTopicStage, topicSource } from './topic-flow-model';
import './topic-flow-demo.css';

const stageIcons = [MapPin, MessageCircle, Users, Sparkles, FileText, Scale, ShieldCheck];
const optionIcons = [ShieldCheck, Sprout, HelpCircle];
const revisionIcons = [Route, Leaf, Wallet];
const feedBriefs: Record<string, string> = {
  'feed-access': 'Die Gehrecht-Anregung wurde nicht aufgenommen: 7 Ja · 0 Nein · 1 Enthaltung.',
  'feed-recommendation': 'Der Ausschuss empfiehlt den nächsten Planungsschritt: 6 Ja · 2 Nein.',
  'feed-council': 'Der Rat billigt Entwurf und Veröffentlichung: 11 Ja · 5 Nein.',
  'feed-farmland': 'Die Unterlagen beschreiben landwirtschaftliche Vornutzung, keinen gebauten Solarpark.',
  'feed-energy': '5,46 MW registrierte Solar-Nettoleistung im Betrieb – Gemeinde gesamt, nicht B70.',
};
type Jump = (stage: TopicStageId, id?: string) => void;

function Fiction({ children = 'Beispiel, erfunden' }: { children?: React.ReactNode }) {
  return <span className="topic-fiction">{children}</span>;
}

function Sources({ ids }: { ids: readonly string[] }) {
  return <div className="topic-sources">{ids.map((id) => {
    const source = topicSource(id);
    return source ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer"><FileText size={12} aria-hidden="true" />{source.title}<ArrowUpRight size={12} aria-hidden="true" /></a> : null;
  })}</div>;
}

function SourceNote({ ids, children }: { ids: readonly string[]; children?: React.ReactNode }) {
  return <details className="topic-source-note"><summary>Quellen & Einordnung</summary>{children}<Sources ids={ids} /></details>;
}

function AiAttribution() {
  return <aside className="topic-ai-attribution"><span className="topic-kicker"><Sparkles size={13} /> GESPEICHERTER KI-ENTWURF · MENSCHLICH UNGEPRÜFT</span><p><strong>{TOPIC_AI.model}</strong> · {TOPIC_AI.operator}</p><details><summary>Ausführung & technische Grenzen</summary><p>{TOPIC_AI.whereRan} · {TOPIC_AI.generatedAt}</p><p>{TOPIC_AI.mode}</p><p>{TOPIC_AI.localBoundary}</p></details></aside>;
}

function Comparisons() {
  return <section className="topic-comparisons"><div className="topic-section-heading"><span className="topic-kicker">ANDERE ORTE · ANDERE VERFAHREN</span><h2>Was wurde wo entschieden?</h2></div><div className="topic-comparison-grid">{TOPIC_COMPARABLES.map((item) => <article key={item.id} className={`topic-comparison-card${item.id === 'lichtenow' ? ' topic-comparison-agri' : ''}`}><span className="topic-kicker"><MapPin size={12} /> {item.municipality}</span><h3>{item.title}</h3><p className="topic-comparison-step">{item.stage}</p><time>{item.date}</time><p className="topic-comparison-result">{item.decision}</p><blockquote>„{item.reasonQuote}“<a href={item.reasonUrl} target="_blank" rel="noopener noreferrer" aria-label={`Quellenzitat für ${item.municipality} lesen`}>Vorlage <ArrowUpRight size={12} /></a></blockquote><p className="topic-small">{item.id === 'gruenelinde' ? 'Ablehnungsgrund nicht erfasst.' : item.id === 'lichtenow' ? 'Agri-PV geplant; Partnerschaft ist der Anlass, kein erfasster Abstimmungsgrund.' : 'Zitiertes Planungsziel, kein erfasster Abstimmungsgrund.'}</p><SourceNote ids={item.sourceIds}><p>{item.reasonLimit}</p><p>{item.reasonDate} · {item.caveat}</p></SourceNote></article>)}</div><p className="topic-small">Die Ergebnisworte sind überliefert, der verabschiedete Volltext nicht; Lichtenow und Grünelinde bleiben getrennte Fälle trotz gleicher B-Plan-Nummer.</p></section>;
}

function Proposal({ jump, version, setVersion }: { jump: Jump; version: 1 | 2; setVersion: (version: 1 | 2) => void }) {
  const [diff, setDiff] = useState(false);
  return <><div className="topic-section-heading"><span className="topic-kicker">KI ORDNET · MENSCHEN ENTSCHEIDEN</span><h2>Ein Dorf-Paket statt eines Blankoschecks.</h2><Fiction>Beispiel, erfunden · KI-Entwurf, ungeprüft</Fiction></div><div className="topic-option-grid">{TOPIC_OPTIONS.map((option, index) => { const Icon = optionIcons[index]!; return <article className="topic-option-card" key={option.id}><span className="topic-card-icon"><Icon size={23} /></span><span className="topic-kicker">OPTION 0{index + 1}</span><h3>{option.title}</h3><p>{option.brief}</p><div className="topic-option-arguments">{option.argumentIds.map((id) => <button key={id} className="topic-text-button" onClick={() => jump('discussion', id)}>{TOPIC_ARGUMENTS.find((argument) => argument.id === id)?.title}<ArrowRight size={12} /></button>)}</div><SourceNote ids={option.sourceIds}><p>{option.text}</p></SourceNote></article>; })}</div>
    <section className="topic-revision-summary" id={`contribution-proposal-v${version}`}><div className="topic-section-heading"><span className="topic-kicker">VOM WUNSCH ZUM PRÜFAUFTRAG</span><h2>Was das Fachfeedback verändert.</h2></div><div className="topic-version-bar" id="contribution-proposal"><div role="group" aria-label="Vorschlagsversion"><button aria-pressed={version === 1} onClick={() => setVersion(1)}>v1 · vorher</button><button aria-pressed={version === 2} onClick={() => setVersion(2)}>v2 · nachher</button></div><button className="topic-text-button" aria-expanded={diff} onClick={() => setDiff(!diff)}>Originaltext-Diff {diff ? 'schließen' : 'zeigen'}</button></div><div className="topic-change-grid">{TOPIC_REVISIONS.map((change, index) => { const Icon = revisionIcons[index]!; return <article className="topic-change-card" key={change.id}><span className="topic-kicker"><Icon size={14} /> {change.department} · {change.field}</span><div className={`topic-change-before${version === 1 ? ' selected' : ''}`}><span>VORHER · V1</span><p>{change.beforeBrief}</p></div><ArrowRight className="topic-change-arrow" size={17} /><div className={`topic-change-after${version === 2 ? ' selected' : ''}`}><span>NACHHER · V2</span><p>{change.afterBrief}</p></div></article>; })}</div>{diff && <section className="topic-diff" aria-label="Änderungen von Version 1 zu Version 2">{TOPIC_REVISIONS.map((change) => <article key={change.id}><h3>{change.field}</h3><del>{change.before}</del><ins>{change.after}</ins><p>{change.reason}</p><Sources ids={change.sourceIds} /></article>)}</section>}</section>
    <section className="topic-visible-facts"><h3>Fest steht – und offen bleibt</h3><div className="topic-fact-grid"><article><Sprout size={20} /><strong>Landwirtschaftliche Vornutzung</strong><p>Eine Nutzung ist beschrieben; welche Doppelnutzung hier möglich wäre, bleibt zu prüfen.</p><SourceNote ids={['farmland']} /></article><article><Scale size={20} /><strong>Entwurf beschlossen</strong><p>14. Oktober 2025 · 11–5–0; keine finale Genehmigung.</p><SourceNote ids={['minutes']} /></article><article><Sun size={20} /><strong>Solarkontext im Ort</strong><p>5,46 MW registrierte Nettoleistung im Betrieb – nicht die Leistung dieses Projekts.</p><SourceNote ids={TOPIC_ENERGY.sourceIds}><p>{TOPIC_ENERGY.summary}</p><p>{TOPIC_ENERGY.detail}</p></SourceNote></article></div><ol className="topic-question-list">{TOPIC_OPEN_QUESTIONS.map((question) => <li key={question}><HelpCircle size={15} />{question}</li>)}</ol></section><Comparisons /><AiAttribution /></>;
}

function Feedback({ revise }: { revise: () => void }) {
  const [round, setRound] = useState<1 | 2>(1);
  return <><div className="topic-section-heading"><span className="topic-kicker">ÖFFENTLICH PRÜFEN</span><h2>Drei Fachblicke. Drei sichtbare Änderungen.</h2><Fiction>Beispiel, erfunden · keine Verwaltungsantwort</Fiction></div><div className="topic-version-bar" role="group" aria-label="Feedbackrunde"><button aria-pressed={round === 1} onClick={() => setRound(1)}>Runde 1 · Einwände</button><button aria-pressed={round === 2} onClick={() => setRound(2)}>Runde 2 · v2 prüfen</button></div><div className="topic-departments">{TOPIC_DEPARTMENTS.map((department, index) => <article className="topic-department" key={department.id} id={`contribution-${department.id}`}><header><span className={`topic-avatar avatar-${index}`}>{department.initials}</span><div><h3>{department.department}</h3><span className="topic-small">{department.person}</span></div><Fiction /></header><h4>{department.focus}</h4><p>{round === 1 ? department.response : department.round2}</p><div className="topic-feedback-change"><span>IN V2</span><strong>{TOPIC_REVISIONS[index]?.afterBrief}</strong></div><details className="topic-ai-draft" id={`contribution-ai-${department.id}`}><summary>KI-Originaltext & Quellen zur Fachrolle</summary><p className="topic-small">Lokale-KI-Ansicht: Interface-Konzept, kein lokaler Modellaufruf.</p><blockquote>{department.draft}</blockquote><p className="topic-small">{TOPIC_AI.model} · {TOPIC_AI.operator}<br />{TOPIC_AI.whereRan} · {TOPIC_AI.generatedAt} · menschlich ungeprüft.</p><Sources ids={department.sourceIds} /></details></article>)}</div><button className="topic-primary" onClick={revise}>Vorher und nachher vergleichen <ArrowRight size={15} /></button><AiAttribution /></>;
}

function Decision() {
  const [choice, setChoice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return <><div className="topic-section-heading"><span className="topic-kicker">ZWEI SPUREN · KLAR GETRENNT</span><h2>Der Rat beschließt.<br />Das Dorf gibt Orientierung.</h2></div><div className="topic-decision-lanes"><section className="topic-council-lane"><span className="topic-real"><Scale size={14} /> RAT · QUELLENBELEGT</span><h3>{TOPIC_COUNCIL.body}</h3><time>{TOPIC_COUNCIL.date}</time><div className="topic-council-votes"><strong>11</strong><span>Ja</span><strong>5</strong><span>Nein</span><strong>0</strong><span>Enthaltungen</span></div><p className="topic-council-summary">Entwurf und Veröffentlichung beschlossen.</p><div className="topic-status-steps"><span><Check size={14} /> Abwägung</span><span><Check size={14} /> Ausgleichsfläche A2</span><span><Check size={14} /> Entwurf + Beteiligung</span><span className="not-established">Satzungsrechtskraft / Bau / Betrieb nicht belegt</span></div><SourceNote ids={TOPIC_COUNCIL.sourceIds}><p>{TOPIC_COUNCIL.summary}</p><p>{TOPIC_COUNCIL.limits}</p></SourceNote></section><section className="topic-mitmachen" id="contribution-advisory"><span className="topic-kicker"><Users size={14} /> APP · NUR BERATEND</span><Fiction>Frage und Ergebnisse · Beispiel, erfunden</Fiction><h3>Wie sollte Büchen weitergehen?</h3><fieldset><legend>Lokale Demo-Auswahl · keine echte Abgabe</legend>{TOPIC_ADVISORY.map((option) => <label key={option.id} className={choice === option.id ? 'selected' : ''}><input type="radio" name="b70-advisory" checked={choice === option.id} onChange={() => { setChoice(option.id); setConfirmed(false); }} /><span>{option.label}</span></label>)}</fieldset><button className="topic-primary" disabled={!choice} onClick={() => setConfirmed(true)}>Demo-Auswahl ansehen <ArrowRight size={14} /></button>{confirmed && <p role="status" className="topic-local-choice"><Check size={15} /> Nicht gespeichert, gezählt oder gesendet.</p>}<section className="topic-demo-results"><h4>Erfundenes Beispielergebnis</h4><p className="topic-small">140 erfundene Stimmen · deine Auswahl ändert diese Zahlen nicht.</p>{TOPIC_ADVISORY.map((option) => <div className="topic-result" key={option.id}><div><span>{option.label}</span><strong>{option.percent} %</strong></div><div className="topic-result-track"><span style={{ width: `${option.percent}%` }} /></div><small>{option.count} erfundene Stimmen</small></div>)}</section><p className="topic-small">Kein Bürgerentscheid, keine Repräsentativität, kein Ersatz für Rat oder förmliche Beteiligung.</p></section></div></>;
}

function Trace({ jump }: { jump: Jump }) {
  const demoEvents: { id: string; label: string; stage: TopicStageId }[] = [
    { id: TOPIC_CITIZEN_PROBLEM.id, label: 'Mara stellt die Frage', stage: 'problem' },
    { id: 'discussion', label: '18 Perspektiven antworten', stage: 'discussion' },
    { id: 'proposal-v1', label: 'KI ordnet den Vorschlag', stage: 'proposal' },
    { id: 'department-plan', label: 'Drei Fachrollen prüfen', stage: 'feedback' },
    { id: 'proposal-v2', label: 'v2 zeigt die Änderungen', stage: 'proposal' },
    { id: 'advisory', label: 'Ein beratendes Meinungsbild', stage: 'decision' },
  ];
  const shortEvents = ['Gehrecht nicht aufgenommen', 'Ausschussempfehlung', 'Entwurf & Veröffentlichung'];
  const votes = ['7 Ja · 0 Nein · 1 Enthaltung', '6 Ja · 2 Nein · 0 Enthaltungen', '11 Ja · 5 Nein · 0 Enthaltungen'];
  return <><div className="topic-section-heading"><span className="topic-kicker">JEDER SCHRITT HINTERLÄSST EINE SPUR</span><h2>Die Geschichte bleibt nachvollziehbar.</h2><p>Erst die echte Vorgeschichte, dann eine erfundene Fortsetzung.</p></div><ol className="topic-trace">{TOPIC_SOURCE_TIMELINE.slice(0, 3).map((event, index) => <li key={event.date}><span className="topic-trace-dot" /><time>{event.date}</time><h3>{shortEvents[index]}</h3><p>{votes[index]}</p><SourceNote ids={[event.sourceId]}><p>{event.event}</p></SourceNote></li>)}</ol><section className="topic-demo-trace"><h3>So könnte Beteiligung anschließen</h3><Fiction>Keine realen Ereignisse oder Einreichungen</Fiction><ol className="topic-step-cards">{demoEvents.map((event, index) => <li key={event.id}><span>0{index + 1}</span><button className="topic-text-button" onClick={() => jump(event.stage, event.id)}>{event.label}<ArrowRight size={13} /></button></li>)}</ol></section><details className="topic-disclosure topic-all-sources"><summary>Alle Quellen & Herkunft</summary><p className="topic-small">{TOPIC_FLOW_SNAPSHOT} · AGS 01053020 · Fall-ID {TOPIC_FLOW_CASE_ID}. Fehlende Daten bleiben unbekannt; Erfassung ist kein Beschlussdatum.</p>{TOPIC_SOURCES.map((source) => <details key={source.id}><summary>{source.title}</summary><p>{source.fact}</p>{source.quote && <blockquote>{source.quote}</blockquote>}<p className="topic-small">{source.authority} · {source.dateLabel}<br />Quell-ID: <code>{source.evidenceSourceId}</code>{source.caseId && <><br />Fall-ID: <code>{source.caseId}</code></>}</p><Sources ids={[source.id]} /></details>)}</details></>;
}

export function TopicFlowDemo() {
  const [stage, setStage] = useState<TopicStageId>('feed');
  const [version, setVersion] = useState<1 | 2>(2);
  const [argumentId, setArgumentId] = useState<string | undefined>();
  const current = TOPIC_DEMO_STAGES.findIndex((item) => item.id === stage);
  const jump: Jump = (nextStage, id) => {
    if (nextStage === 'discussion') setArgumentId(TOPIC_ARGUMENTS.find((item) => item.id === id)?.id);
    if (nextStage === 'proposal' && id) setVersion(id === 'proposal-v1' ? 1 : 2);
    setStage(nextStage);
    requestAnimationFrame(() => {
      const target = (id && document.getElementById(`contribution-${id}`)) || document.getElementById('topic-current-stage');
      if (!target) return;
      for (let parent: HTMLElement | null = target; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  };
  return <main className="topic-walkthrough topic-round4" lang="de"><header className="topic-topbar"><Link href="/story" className="topic-brand"><span className="topic-brand-mark"><Sprout size={20} /></span><strong>Ledger<span>Dein Ort. Deine Zukunft.</span></strong></Link><span className="topic-location"><MapPin size={14} /> Büchen</span><details className="topic-truth-chip"><summary>Echt + Beispiel</summary><p>Planung und Ratsbelege sind real; Beiträge, Fachrollen, KI-Vorschlag und App-Ergebnis sind „Beispiel, erfunden“.</p><p>Kein Konto, keine Übertragung, keine echte Einreichung oder Abstimmung.</p></details></header><nav className="topic-stage-nav" aria-label="Sieben Schritte im Themenweg">{TOPIC_DEMO_STAGES.map((item, index) => { const Icon = stageIcons[index]!; return <button key={item.id} aria-current={stage === item.id ? 'step' : undefined} onClick={() => jump(item.id)}><Icon size={16} aria-hidden="true" /><strong>{item.label}</strong></button>; })}</nav><section className="topic-stage-content" id="topic-current-stage"><p className="topic-stage-owner">SOLAR & LANDWIRTSCHAFT <span>0{current + 1} / 07</span></p>
    {stage === 'feed' && <><div className="topic-section-heading"><span className="topic-kicker">B-PLAN 70 · GEMEINDE BÜCHEN</span><h1>Hier könnte sich etwas verändern.</h1></div><div className="topic-feed-overview"><TopicPlace /><article className="topic-citizen-post"><Fiction /><h3>„Was bringt das unserem Dorf?“</h3><p>Mara möchte Strom, Landwirtschaft und Dorfnutzen zusammen verstehen.</p><button className="topic-primary" onClick={() => jump('problem')}>Maras Thema öffnen <ArrowRight size={15} /></button></article></div><section className="topic-feed"><h3>Was die Quellen schon sagen</h3><div className="topic-feed-grid">{TOPIC_FEED_ITEMS.filter((item) => item.kind !== 'example').map((item, index) => { const Icon = [Route, MessageCircle, Scale, Sprout, Sun][index]!; return <article key={item.id} className="topic-feed-item"><span className="topic-card-icon"><Icon size={20} /></span><time>{item.dateLabel}</time><h4>{item.title}</h4><p>{feedBriefs[item.id]}</p><SourceNote ids={item.sourceIds}><p>{item.text}</p></SourceNote></article>; })}</div></section></>}
    {stage === 'problem' && <><div className="topic-section-heading"><span className="topic-kicker">EINE NACHBARIN FRAGT</span><h2>Was bleibt für unser Dorf?</h2><Fiction /></div><article className="topic-problem" id={`contribution-${TOPIC_CITIZEN_PROBLEM.id}`}><div className="topic-post-author"><span className="topic-avatar">MJ</span><div><strong>Mara · junge Familie</strong><span>Beispiel, erfunden</span></div></div><p className="topic-problem-quote">„Ich will sauberen Strom – und einen guten Ort für unsere Kinder.“</p><div className="topic-question-chips"><span><Sprout size={16} /> Landwirtschaft erhalten?</span><span><Users size={16} /> Gemeinsam profitieren?</span><span><Leaf size={16} /> Natur schützen?</span></div><SourceNote ids={['farmland', 'paper']}><p>{TOPIC_CITIZEN_PROBLEM.body}</p><p>{TOPIC_CITIZEN_PROBLEM.date} · nicht Teil der damaligen Ratsberatung.</p></SourceNote></article><TopicSolarBenefits /><TopicAgriPv /><TopicExplainer /><div className="topic-question-actions"><button className="topic-primary" onClick={() => jump('discussion')}>Wer sieht das anders? <ArrowRight size={15} /></button></div></>}
    {stage === 'discussion' && <TopicDiscussion initialArgumentId={argumentId} />}
    {stage === 'proposal' && <Proposal jump={jump} version={version} setVersion={setVersion} />}
    {stage === 'feedback' && <Feedback revise={() => jump('proposal', 'proposal-v2')} />}
    {stage === 'decision' && <Decision />}
    {stage === 'trace' && <Trace jump={jump} />}
    </section><nav className="topic-stage-controls" aria-label="Weiter im Themenweg"><button className="topic-back" disabled={current === 0} onClick={() => jump(moveTopicStage(stage, -1))}><ChevronLeft size={15} /> Zurück</button><span>{current + 1} / 7</span><button className="topic-primary" disabled={current === 6} onClick={() => jump(moveTopicStage(stage, 1))}>{current === 6 ? 'Nachvollzogen' : TOPIC_DEMO_STAGES[current + 1]?.label}<ArrowRight size={15} /></button></nav><footer className="topic-footer"><span><Sprout size={15} /> Echte Quellen. Erfundenes Mitmachen.</span><details><summary>Datenstand & Grenzen</summary><p>Gemeinde Büchen · AGS 01053020 · Live-API-Erfassung 16. November 2026; allgemeine Fakten und Modellannahmen haben eigene Quellen. Kein Nachweis von Satzungsrechtskraft, Bau oder Betrieb.</p><Link href="/story">Mehr über Ledger <ArrowUpRight size={12} /></Link></details></footer></main>;
}
