'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import proposalRecord from '@/data/ai-proposal-generation.json';
import departmentAiRecord from '@/data/topic-ai-feedback.json';
import {
  TOPIC_ADVISORY_OPTIONS,
  TOPIC_ARGUMENTS,
  TOPIC_CITIZEN_PROBLEM,
  TOPIC_DEMO_STAGES,
  TOPIC_FEEDBACK_ROUNDS,
  TOPIC_FLOW_CASE_ID,
  TOPIC_FLOW_SNAPSHOT,
  TOPIC_FLOW_TITLE,
  TOPIC_SOURCES,
  TOPIC_SOURCE_TIMELINE,
  type TopicStageId,
} from '@/data/topic-flow-demo';
import './topic-flow-demo.css';
import { moveTopicStage, topicSource } from './topic-flow-model';

type ProposalVersion = (typeof proposalRecord.versions)[number];

function Sources({ ids }: { ids: readonly string[] }) {
  return <ul className="topic-sources">{ids.flatMap((id) => {
    const item = topicSource(id);
    return item ? [<li key={id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a><span>{item.authority} · {item.dateLabel}</span></li>] : [];
  })}</ul>;
}

function SourceCards({ ids }: { ids?: readonly string[] }) {
  const selected = ids ? TOPIC_SOURCES.filter((item) => ids.includes(item.id)) : TOPIC_SOURCES;
  return <ul className="topic-source-cards">{selected.map((item) => <li key={item.id}>
    <span className="topic-evidence-label">{item.authority}</span><h3><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title} ↗</a></h3>
    <p>{item.fact}</p>{item.quote && <blockquote>{item.quote}</blockquote>}<time>{item.dateLabel}</time>
    <p className="topic-source-identity">Fall-ID: <code>{item.caseId}</code> · Quell-ID: <code>{item.evidenceSourceId}</code></p>
  </li>)}</ul>;
}

function Discussion() {
  return <section aria-labelledby="topic-arguments-title">
    <p className="topic-demo-fiction">Beispiel, erfunden · nach dem historischen Ratsbeschluss</p>
    <h2 id="topic-arguments-title">Wie sollte der öffentliche Status zum Beschluss belegt werden?</h2>
    <div className="topic-argument-layout"><div><h3>Argumentbaum · vier Beiträge</h3>
      <ol className="topic-tree">{TOPIC_ARGUMENTS.filter((item) => item.parent === null).map((root) => <li key={root.id}>
        <article id={`contribution-${root.id}`} className={root.side === 'Dafür' ? 'topic-side-pro' : 'topic-side-con'}>
          <strong>{root.side} · {root.id}</strong><p>{root.text}</p><p className="topic-note">{root.date} · {root.actor}</p><Sources ids={root.sourceIds} />
        </article>
        <ul>{TOPIC_ARGUMENTS.filter((child) => child.parent === root.id).map((child) => <li key={child.id}>
          <article id={`contribution-${child.id}`} className={child.side === 'Dafür' ? 'topic-side-pro' : 'topic-side-con'}>
            <strong>{child.side} · Antwort · {child.id}</strong><p>{child.text}</p><p className="topic-note">{child.date} · {child.actor}</p><Sources ids={child.sourceIds} />
          </article>
        </li>)}</ul>
      </li>)}</ol>
    </div><figure className="topic-sunburst"><figcaption><h3>Sunburst</h3><p>Vier Argumentbeiträge · gleiche Struktur wie der Baum</p></figcaption>
      <svg viewBox="0 0 200 200" role="img" aria-label="Strukturdiagramm mit zwei Dafür- und zwei Dagegen-Beiträgen; es zeigt keine Stimmen oder Mehrheiten.">
        <path d="M100 48 A52 52 0 0 1 100 152 L100 124 A24 24 0 0 0 100 76Z" fill="#407f59"><title>Dafür · 2 Argumente</title></path>
        <path d="M100 152 A52 52 0 0 1 100 48 L100 76 A24 24 0 0 0 100 124Z" fill="#a74e47"><title>Dagegen · 2 Argumente</title></path>
        <path d="M100 18 A82 82 0 0 1 100 182 L100 156 A56 56 0 0 0 100 44Z" fill="#83a987" />
        <path d="M100 182 A82 82 0 0 1 100 18 L100 44 A56 56 0 0 0 100 156Z" fill="#d5948e" />
        <circle cx="100" cy="100" r="23" fill="#f8f6f0" /><text x="100" y="104" textAnchor="middle">4 Beiträge</text>
      </svg>
      <ul className="topic-chart-legend"><li><span className="topic-dot pro" /> Dafür · 2 Beiträge</li><li><span className="topic-dot con" /> Dagegen · 2 Beiträge</li></ul>
      <p className="topic-note">Flächen zeigen ausschließlich Beitragsstruktur, nicht Gewichtung, Zustimmung, Stimmen oder Wahrheit.</p>
    </figure></div>
  </section>;
}

function Proposal({ version, expanded, onContribution }: { version: ProposalVersion; expanded: boolean; onContribution: (id: string) => void }) {
  return <details className="topic-proposal-version" id={`contribution-${version.id}`} open={expanded}>
    <summary><strong>{version.id}</strong> · {version.exampleDateLabel}<span className="topic-note">KI-Beitrag · Modell {proposalRecord.modelId} · betrieben von {proposalRecord.operatorLabel}</span></summary>
    <div className="topic-proposal-grid">
      <article><h4>Problem</h4><p>{version.problem}</p></article>
      <article><h4>Quellenbasierte Fakten</h4><ul>{version.facts.map((fact, index) => <li key={index}>{fact.text}<Sources ids={fact.sourceIds} /></li>)}</ul></article>
      <article><h4>Diskussionsgründe und Optionen</h4><ol>{version.options.map((option) => <li key={option.id}><strong>{option.title}</strong><p>{option.text}</p><p>Greift auf: {option.argumentIds.map((id) => <button className="topic-link-button" type="button" key={id} onClick={() => onContribution(id)}>{id}</button>)}</p></li>)}</ol></article>
      <article><h4>Kosten (unbekannt, wo nicht belegt)</h4><p>{version.costs.text}</p><Sources ids={version.costs.sourceIds} /></article>
      <article><h4>Rechtsstatus</h4><p>{version.legalStatus.text}</p><Sources ids={version.legalStatus.sourceIds} /></article>
      <article><h4>Empfehlung des Beispielentwurfs</h4><p>{version.recommendation}</p><h4>Vergleichsfälle</h4><p>Roseburg-Wotersen und Witzeeze sind nur belegte Vergleichsreferenzen, keine Wirkungs- oder Erfolgsnachweise.</p><Sources ids={version.sourceIds.filter((id) => id === 'roseburg' || id === 'witzeeze')} /></article>
    </div>
    {version.changes.length > 0 && <section><h4>Änderungen gegenüber vorher</h4><ul>{version.changes.map((change) => <li key={change}>{change}</li>)}</ul></section>}
    {version.statusFields && <section><h4>Getrennte Verfahrensstände</h4><dl>{version.statusFields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{field.state === 'recorded' ? `Belegt · ${field.date}` : 'Nicht belegt · unbekannt'}<Sources ids={field.sourceIds} /></dd></div>)}</dl></section>}
    {version.costFields && <section><h4>Getrennte Kostenangaben</h4><dl>{version.costFields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{field.state === 'unknown' ? 'Unbekannt · kein Eurobetrag belegt' : 'Quellenbelegt · keine Aussage über erfolgte Zahlung'}<Sources ids={field.sourceIds} /></dd></div>)}</dl></section>}
  </details>;
}

function DepartmentAiDraft({ replyId }: { replyId: string }) {
  const draft = departmentAiRecord.drafts.find((item) => item.replyId === replyId);
  if (!draft) return null;
  return <details className="topic-ai-assist" id={`contribution-${draft.id}`}>
    <summary>KI-Hilfe für die erfundene Fachrolle · {draft.id}</summary>
    <p className="topic-note">Modell {departmentAiRecord.modelId} · betrieben von {departmentAiRecord.operatorLabel} · erstellt {departmentAiRecord.generatedAt}</p>
    <p>{draft.draft}</p><p><strong>Quellenabgleich:</strong> {draft.sourceCheck}</p><Sources ids={draft.sourceIds} />
    <p className="topic-note">{departmentAiRecord.checkBoundary} Menschliche Prüfung: nicht erfolgt. Die daneben gezeigte menschliche Rückmeldung ist ausschließlich ein erfundenes Rollenbeispiel.</p>
  </details>;
}

function DepartmentAiTraceLink({ replyId, onContribution }: { replyId: string; onContribution: (id: string) => void }) {
  const draft = departmentAiRecord.drafts.find((item) => item.replyId === replyId);
  return draft ? <p><button className="topic-link-button" type="button" onClick={() => onContribution(draft.id)}>KI-Hilfe öffnen · {draft.id}</button><span className="topic-note"> Modell {departmentAiRecord.modelId} · betrieben von {departmentAiRecord.operatorLabel}</span></p> : null;
}

function DemoStage({ id, onVote, onContribution }: { id: TopicStageId; onVote: (value: string) => void; onContribution: (id: string) => void }) {
  const [choice, setChoice] = useState('');
  const [response, setResponse] = useState('');
  if (id === 'feed') return <>
    <p className="topic-demo-fiction">Öffentlicher Fall · gespeicherte Live-API-Auswertung · kein zusätzlicher Abruf</p><h2>{TOPIC_FLOW_TITLE}</h2>
    <p>Gemeinde Tramm · Kreis Herzogtum Lauenburg · Schleswig-Holstein · AGS 01053126</p>
    <div className="topic-status-note"><strong>Belegt:</strong> Am 1. Juni 2026 beauftragte die Gemeindevertretung den Bürgermeister, den städtebaulichen Vertrag zur Übernahme der Bauleitplanungskosten abzuschließen. Die Niederschrift nennt Rechtsanwaltskosten zum Durchführungsvertrag beim Vorhabenträger.</div>
    <p className="topic-fact-boundary"><strong>Keine Ausführung belegt.</strong> Kein Nachweis der Vertragsunterzeichnung, B-Plan-Rechtskraft, Errichtung oder des Betriebs; kein tatsächlicher Eurobetrag in den gespeicherten Quellen.</p>
    <p className="topic-metadata">Fall-ID <code>{TOPIC_FLOW_CASE_ID}</code> · {TOPIC_FLOW_SNAPSHOT} · Entscheidung 1. Juni 2026 · 7 Ja / 1 Nein / 0 Enthaltungen</p><SourceCards ids={['paper', 'minutes']} />
  </>;
  if (id === 'problem') return <>
    <p className="topic-demo-fiction">Beispiel, erfunden · kein historischer Trammer Problembericht</p><h2 id={`contribution-${TOPIC_CITIZEN_PROBLEM.id}`}>{TOPIC_CITIZEN_PROBLEM.text}</h2>
    <p className="topic-metadata">Beitrags-ID <code>{TOPIC_CITIZEN_PROBLEM.id}</code> · {TOPIC_CITIZEN_PROBLEM.date} · {TOPIC_CITIZEN_PROBLEM.actor}</p>
    <div className="topic-status-note">Fester Beispieltext zur Frage, welche belegten Schritte auf den Ratsauftrag folgten. Er wurde nicht eingereicht; Vertragsabschluss, Betrag und Umsetzung sind in diesem Datensatz nicht belegt.</div><Sources ids={['minutes', 'paper']} />
  </>;
  if (id === 'discussion') return <Discussion />;
  if (id === 'proposal') return <>
    <p className="topic-demo-fiction">Gespeicherter, einmalig verfasster KI-Beispieldatensatz · keine Live-Generierung</p><h2>Strukturierter Vorschlag · drei überprüfbare Versionen</h2>
    <div className="topic-status-note"><strong>Attribution:</strong> Modell {proposalRecord.modelId} · betrieben von {proposalRecord.operatorLabel} · erstellt {proposalRecord.generatedAt} · Eingabe-SHA-256 <code>{proposalRecord.inputSha256}</code>. Menschliche Prüfung: nicht erfolgt. Offline von einer KI verfasst; keine Provider-API oder integrierte Inferenzfunktion.</div>
    <p className="topic-note">Die Versionen sind hypothetisch und nicht freigegeben. KI-Beiträge zeigen Modell und Betreiber aus ihrem Datensatz; die Oberfläche ist nicht an einen Anbieter gebunden.</p>
    {proposalRecord.versions.map((version, index) => <Proposal key={version.id} version={version} expanded={index === proposalRecord.versions.length - 1} onContribution={onContribution} />)}
  </>;
  if (id === 'feedback') return <>
    <p className="topic-demo-fiction">Zwei fiktive Fachrollen · zwei Runden · alle Beiträge erfunden</p><h2>Öffentlich nachvollziehbares Beispiel-Feedback</h2>
    <p>Kein realer Fachbereich in Tramm hat geantwortet. Die KI-Hilfen wurden offline für diese Demo erstellt, nicht von einer Verwaltung. Eine echte menschliche Prüfung ist nicht erfolgt; die Antworten der menschlichen Rollenfiguren sind erfunden.</p>
    {[1, 2].map((round) => <section key={round} className="topic-round"><h3>Runde {round} · Beispiel, erfunden</h3><ol>{TOPIC_FEEDBACK_ROUNDS.filter((item) => item.round === round).map((item) => <li key={item.id} id={`contribution-${item.id}`}>
      <p><strong>{item.department}</strong> · {item.actor} · {item.date}</p><p className="topic-note">Beitrags-ID <code>{item.id}</code> · geprüft: <button className="topic-link-button" type="button" onClick={() => onContribution(item.proposalId)}>{item.proposalId}</button> · führt zu <button className="topic-link-button" type="button" onClick={() => onContribution(item.nextProposalId)}>{item.nextProposalId}</button></p>
      <p><strong>Fiktive menschliche Rückmeldung:</strong> {item.response}</p><p>Änderungsbezug: {item.revision}</p><DepartmentAiDraft replyId={item.id} /><Sources ids={item.sourceIds} />
    </li>)}</ol></section>)}
    <p className="topic-note">Keine echte Abgabe, Verwaltungssitzung, Personalposition oder Verwaltungsantwort.</p>
  </>;
  if (id === 'decision') return <>
    <h2>Historischer Ratsbeschluss und unverbindliches Meinungsbild bleiben getrennt</h2><article className="topic-decision-record"><span className="topic-evidence-label">Quellenbeleg · historisch</span><h3>Gemeindevertretung Tramm · 1. Juni 2026</h3><p>7 Ja · 1 Nein · 0 Enthaltungen. Auftrag zum Abschluss des Kostenübernahme-Vertrags; kein Nachweis späterer Unterzeichnung oder Umsetzung.</p><Sources ids={['minutes']} /></article>
    <section className="topic-advisory"><span className="topic-demo-fiction">Beispiel, erfunden · beratende Ansicht · keine echte Mitmachen-Runde</span><h3>Welche Statusangabe sollte eine öffentliche Übersicht zuerst belegen?</h3><p>Fiktive Frage zur Transparenz, keine Abstimmung zur Windenergienutzung und keine Wiederholung oder Änderung des Ratsbeschlusses. Eine App-Abstimmung wäre beratend, nicht bindend.</p>
      <fieldset><legend>Lokale Auswahl · nicht gespeichert oder übertragen</legend>{TOPIC_ADVISORY_OPTIONS.map((option) => <label key={option}><input type="radio" name="topic-demo-choice" checked={choice === option} onChange={() => { setChoice(option); setResponse(''); }} />{option}</label>)}</fieldset>
      <button type="button" disabled={!choice} onClick={() => { onVote(choice); setResponse('Deine Auswahl bleibt nur in dieser Seite sichtbar. Sie wurde nicht gespeichert, gezählt oder versendet.'); }}>Demo-Auswahl vormerken</button>
      {response && <p role="status" className="topic-status-note">{response}</p>}
    </section>
  </>;
  return <>
    <h2>Der ganze Weg: Quelle bis zur getrennten Entscheidung</h2><p>Der Ratsbeschluss vom 1. Juni ist historisch. Problem, Diskussion, KI-Beispiel, Fachfeedback und beratende Frage sind erfundene spätere Fortsetzungen; nichts davon hat den Ratsbeschluss verursacht oder geändert.</p>
    <ol className="topic-trace">{TOPIC_SOURCE_TIMELINE.map((event) => <li key={event.date}><time>{event.date}</time><span className="topic-event-kind">{event.reality === 'source' ? 'Quellenereignis' : 'Bestandsaufnahme · kein Quellenereignis'}</span><p>{event.event}</p><Sources ids={[event.sourceId]} /></li>)}
      <li className="demo-event"><time>{TOPIC_CITIZEN_PROBLEM.date}</time><span className="topic-event-kind">Problem · Beispiel, erfunden</span><p>{TOPIC_CITIZEN_PROBLEM.actor} · {TOPIC_CITIZEN_PROBLEM.text}</p><button className="topic-link-button" type="button" onClick={() => onContribution(TOPIC_CITIZEN_PROBLEM.id)}>Öffnen · {TOPIC_CITIZEN_PROBLEM.id}</button></li>
      {TOPIC_ARGUMENTS.map((argument) => <li className="demo-event" key={argument.id}><time>{argument.date}</time><span className="topic-event-kind">Diskussion · Beitrag {argument.id} · Beispiel, erfunden</span><p>{argument.actor} · {argument.text}</p><button className="topic-link-button" type="button" onClick={() => onContribution(argument.id)}>Öffnen · {argument.id}</button><Sources ids={argument.sourceIds} /></li>)}
      {proposalRecord.versions.map((version) => <Fragment key={version.id}>
        <li className="demo-event"><time>{version.exampleDateLabel}</time><span className="topic-event-kind">KI-Vorschlag · {version.id} · menschlich ungeprüft</span><p>Modell {proposalRecord.modelId} · betrieben von {proposalRecord.operatorLabel}</p><p>{version.changes.join(' ') || version.problem}</p><button className="topic-link-button" type="button" onClick={() => onContribution(version.id)}>Öffnen · {version.id}</button></li>
        {TOPIC_FEEDBACK_ROUNDS.filter((reply) => reply.proposalId === version.id).map((reply) => <li className="demo-event" key={reply.id}><time>{reply.date}</time><span className="topic-event-kind">Fachfeedback · {reply.id} · Beispiel, erfunden</span><p>{reply.department} · {reply.actor}: {reply.response}</p><p>Version {reply.proposalId} → {reply.nextProposalId}</p><button className="topic-link-button" type="button" onClick={() => onContribution(reply.id)}>Öffnen · {reply.id}</button><DepartmentAiTraceLink replyId={reply.id} onContribution={onContribution} /></li>)}
      </Fragment>)}
      <li className="demo-event"><time>Beispiel-Datum, erfunden · 27. November 2026</time><span className="topic-event-kind">Mitmachen · beratende lokale Demo</span><p>Beispielrolle: Bürger:in der Stadt. Keine echte Runde, Abgabe oder Teilnahme.</p><button className="topic-link-button" type="button" onClick={() => onContribution('advisory-question')}>Zur beratenden Ansicht</button></li>
    </ol><section><h3>Alle verwendeten Quellen</h3><SourceCards /></section>
  </>;
}

export function TopicFlowDemo() {
  const [stage, setStage] = useState<TopicStageId>('feed');
  const [localChoice, setLocalChoice] = useState('');
  const current = TOPIC_DEMO_STAGES.findIndex((item) => item.id === stage);
  const openContribution = (contributionId: string) => {
    const nextStage: TopicStageId = contributionId === TOPIC_CITIZEN_PROBLEM.id ? 'problem'
      : TOPIC_ARGUMENTS.some((item) => item.id === contributionId) ? 'discussion'
        : proposalRecord.versions.some((item) => item.id === contributionId) ? 'proposal'
          : TOPIC_FEEDBACK_ROUNDS.some((item) => item.id === contributionId) || departmentAiRecord.drafts.some((item) => item.id === contributionId) ? 'feedback' : 'decision';
    setStage(nextStage);
    requestAnimationFrame(() => {
      const target = document.getElementById(`contribution-${contributionId}`);
      if (!target) return;
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  };
  return <main className="topic-walkthrough">
    <header className="topic-walkthrough-hero"><span className="topic-eyebrow">LEDGER OF LIFE · BÜRGER-THEMENWEG · LOKALE DEMO</span><h1>Vom Stadthinweis bis zur nachvollziehbaren Entscheidung</h1>
      <p>Ein echter, quellengebundener Trammer Ratsbeschluss ist der Ausgangspunkt. Problem, Diskussion, gespeicherter KI-Entwurf, Fachfeedback und Beratungsfrage sind erfundene, spätere Beispiele.</p>
      <div className="topic-truth-banner"><strong>Lokaler Prototyp · Nur lesen und durchklicken</strong><span>Keine Anmeldung · keine Übertragung · keine echte Abgabe, Fachantwort oder Abstimmung.</span></div>
      <p className="topic-data-provenance">{TOPIC_FLOW_SNAPSHOT} · Tramm, Schleswig-Holstein · Fall-ID {TOPIC_FLOW_CASE_ID}</p>
      <nav className="topic-stage-nav" aria-label="Sieben Schritte im Themenweg">{TOPIC_DEMO_STAGES.map((item, index) => <button type="button" key={item.id} aria-current={stage === item.id ? 'step' : undefined} onClick={() => setStage(item.id)}><span>{index + 1}</span><strong>{item.label}</strong></button>)}</nav>
      <p className="topic-stage-owner">Schritt {current + 1} von 7 · Zuständig: {TOPIC_DEMO_STAGES[current]?.owner}</p>
    </header>
    <section className="topic-stage-content" aria-live="polite" aria-atomic="false" id={stage === 'decision' ? 'contribution-advisory-question' : undefined}><DemoStage id={stage} onVote={setLocalChoice} onContribution={openContribution} />{localChoice && stage !== 'decision' && <p className="topic-note">Lokale Demo-Auswahl: {localChoice} · nicht gespeichert und nicht versendet.</p>}</section>
    <nav className="topic-stage-controls" aria-label="Weiter im Themenweg"><button type="button" disabled={current === 0} onClick={() => setStage(moveTopicStage(stage, -1))}>← Zurück</button><button type="button" onClick={() => setStage(moveTopicStage(stage, 1))} disabled={current === TOPIC_DEMO_STAGES.length - 1}>Weiter →</button></nav>
    <footer className="topic-walkthrough-footer"><p><strong>Fakten und Grenzen:</strong> Quellen belegen den Ratsauftrag zur Vertragsunterzeichnung und vertragliche Kostenzuständigkeit, nicht tatsächliche Kosten, Vertragsschluss oder Umsetzung. Vergleichsfälle sind keine Wirkungsnachweise.</p><nav aria-label="Weitere Ledger-Seiten"><Link href="/story">Fiktive Ledger-Stadtgeschichte</Link><Link href="/replay">Aufgezeichnete Testnetz-Mietgeschichte</Link><Link href="/">Ledger of Life</Link></nav></footer>
  </main>;
}
