'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  TOPIC_ADVISORY_OPTIONS,
  TOPIC_ARGUMENTS,
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

function Sources({ ids }: { ids: readonly string[] }) {
  return <ul className="topic-sources">{ids.flatMap((id) => {
    const item = topicSource(id);
    return item ? [<li key={id}><a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`${item.title} (öffnet neuen Tab)`}>{item.title} <span aria-hidden="true">↗</span></a><span>{item.authority} · {item.dateLabel}</span></li>] : [];
  })}</ul>;
}

function SourceCards({ ids }: { ids?: readonly string[] }) {
  const selected = ids ? TOPIC_SOURCES.filter((item) => ids.includes(item.id)) : TOPIC_SOURCES;
  return <ul className="topic-source-cards">{selected.map((item) => <li key={item.id}>
    <span className="topic-evidence-label">{item.authority}</span>
    <h3><a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`${item.title} (öffnet neuen Tab)`}>{item.title} <span aria-hidden="true">↗</span></a></h3>
    <p>{item.fact}</p>
    {item.quote && <blockquote>{item.quote}</blockquote>}
    <time>{item.dateLabel}</time>
    <p className="topic-source-identity"><span>Fall-ID:</span> <code>{item.caseId}</code><span>Quell-ID:</span> <code>{item.evidenceSourceId}</code></p>
  </li>)}</ul>;
}

function arc(inner: number, outer: number, start: number, end: number) {
  const polar = (radius: number, angle: number) => ({ x: 100 + radius * Math.cos(angle), y: 100 + radius * Math.sin(angle) });
  const a = polar(outer, start), b = polar(outer, end), c = polar(inner, end), d = polar(inner, start);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 ${large} 0 ${d.x} ${d.y} Z`;
}

function Discussion() {
  return <section aria-labelledby="topic-arguments-title" className="topic-demo-section">
    <p className="topic-demo-fiction">Beispiel, erfunden · hypothetische Anschlussfrage nach dem dokumentierten Ratsbeschluss</p>
    <h2 id="topic-arguments-title">Wie sollte der öffentliche Status zum Beschluss belegt werden?</h2>
    <div className="topic-argument-layout">
      <div>
        <h3>Argumentbaum</h3>
        <ol className="topic-tree">{TOPIC_ARGUMENTS.filter((item) => item.parent === null).map((root) => <li key={root.id}>
          <article className={root.side === 'Dafür' ? 'topic-side-pro' : 'topic-side-con'}><strong>{root.side} · Beispiel, erfunden</strong><p>{root.text}</p><Sources ids={root.sourceIds} /></article>
          {TOPIC_ARGUMENTS.filter((child) => child.parent === root.id).map((child) => <ul key={child.id}><li><article className={child.side === 'Dafür' ? 'topic-side-pro' : 'topic-side-con'}><strong>{child.side} · Antwort · Beispiel, erfunden</strong><p>{child.text}</p><Sources ids={child.sourceIds} /></article></li></ul>)}
        </li>)}</ol>
      </div>
      <figure className="topic-sunburst">
        <figcaption><h3>Sunburst</h3><p>Gleicher Argumentbaum · Struktur, keine Mehrheit</p></figcaption>
        <svg viewBox="0 0 200 200" role="img" aria-label="Sunburst mit einem gleich großen Dafür- und Dagegen-Zweig und je einer erfundenen Antwort. Die Flächen zeigen Struktur, keine Stimmen oder Mehrheiten.">
          <path d={arc(28, 52, -Math.PI / 2, Math.PI / 2)} fill="#407f59"><title>Dafür · Beispiel, erfunden</title></path>
          <path d={arc(28, 52, Math.PI / 2, 3 * Math.PI / 2)} fill="#a74e47"><title>Dagegen · Beispiel, erfunden</title></path>
          <path d={arc(54, 82, -Math.PI / 2, Math.PI / 2)} fill="#83a987"><title>Antwort auf Dafür · Beispiel, erfunden</title></path>
          <path d={arc(54, 82, Math.PI / 2, 3 * Math.PI / 2)} fill="#d5948e"><title>Antwort auf Dagegen · Beispiel, erfunden</title></path>
          <circle cx="100" cy="100" r="25" fill="#f8f6f0" />
          <text x="100" y="104" textAnchor="middle">Thema</text>
        </svg>
        <ul className="topic-chart-legend"><li><span className="topic-dot pro" /> Dafür · erfundener Zweig</li><li><span className="topic-dot con" /> Dagegen · erfundener Zweig</li></ul>
        <p className="topic-note">Die Radialfläche zeigt Argumentstruktur. Sie zählt weder Unterstützung noch Stimmen und bewertet keine Wahrheit.</p>
      </figure>
    </div>
  </section>;
}

function DemoStage({ id, onVote }: { id: TopicStageId; onVote: (value: string) => void }) {
  const [choice, setChoice] = useState('');
  const [response, setResponse] = useState('');
  if (id === 'feed') return <>
    <p className="topic-demo-fiction">Öffentlicher Fall · gespeicherte Live-API-Auswertung · kein zusätzlicher Abruf</p>
    <h2>{TOPIC_FLOW_TITLE}</h2>
    <p>Gemeinde Tramm · Kreis Herzogtum Lauenburg · Schleswig-Holstein · AGS 01053126</p>
    <div className="topic-status-note"><strong>Belegt:</strong> Die Gemeindevertretung beschloss am 1. Juni 2026 den Bürgermeister mit dem Abschluss eines städtebaulichen Vertrags zur Übernahme der Bauleitplanungskosten zu beauftragen. Die Niederschrift nennt außerdem die Rechtsanwaltskosten für den Durchführungsvertrag beim Vorhabenträger.</div>
    <p className="topic-fact-boundary"><strong>Kein Bau- oder Genehmigungsbeschluss belegt.</strong> Der gespeicherte Entscheidungsschritt belegt diesen Vertragsauftrag, nicht Vertragsunterzeichnung, B-Plan-Rechtskraft, Errichtung oder Betrieb. Der Datensatz enthält keinen Eurobetrag.</p>
    <p className="topic-metadata">Fall-ID <code>{TOPIC_FLOW_CASE_ID}</code> · {TOPIC_FLOW_SNAPSHOT} · Gemeindevertretung Tramm · Entscheidung 1. Juni 2026 · Abstimmung 7 Ja / 1 Nein / 0 Enthaltungen</p>
    <SourceCards ids={['paper', 'minutes']} />
  </>;
  if (id === 'problem') return <>
    <p className="topic-demo-fiction">Beispiel, erfunden · kein historischer Trammer Problembericht</p>
    <h2>Wie lassen sich die belegten nächsten Schritte zum Beschluss nachvollziehen?</h2>
    <p>Die Vorlage und Niederschrift belegen einen Auftrag zum Vertragsabschluss. Ob der Vertrag unterzeichnet wurde, welcher Betrag anfiel und welche Umsetzungsschritte folgten, ist in diesem Datensatz nicht belegt.</p>
    <div className="topic-status-note"><strong>Beispiel, erfunden · Themenvorschlag:</strong> In einer echten Anwendung würde eine Bürgerin hier eine Frage ausformulieren und einreichen. Diese Demo zeigt nur einen festen Beispieltext; es wird nichts eingereicht.</div>
    <Sources ids={['minutes', 'paper']} />
  </>;
  if (id === 'discussion') return <Discussion />;
  if (id === 'proposal') return <>
    <p className="topic-demo-fiction">Strukturierter Beispielentwurf · kein Modell ausgeführt · Beispiel, erfunden</p>
    <h2>Öffentlichen Status zum Vertragsauftrag nachvollziehbar machen</h2>
    <div className="topic-proposal-grid">
      <article><h3>Problem</h3><p>Der gespeicherte Ratsdatensatz dokumentiert einen Auftrag zum Vertragsschluss, aber keinen Beleg über dessen spätere Ausführung.</p><Sources ids={['minutes']} /></article>
      <article><h3>Optionen</h3><ol><li>Belegte Ratsbeschlüsse mit Datum und Originalbeleg verlinken.</li><li>Vertragsschluss und Umsetzung nur ergänzen, wenn ein datierter Nachweis veröffentlicht ist.</li><li>Unbekannte Beträge als unbekannt markieren, nicht schätzen.</li></ol></article>
      <article><h3>Kosten und Rechtsstatus</h3><p>Die Niederschrift nennt die vertragliche Kostenzuständigkeit. Eine tatsächliche Euro-Summe und ein Nachweis des Vertragsschlusses liegen in diesem Datensatz nicht vor.</p><Sources ids={['minutes']} /></article>
      <article><h3>Vergleichsfälle</h3><p>Roseburg und Witzeeze zeigen ähnlich dokumentierte Planungs-Kostenübernahmen bei Windenergie-Verfahren. Die Vergleiche belegen keine Wirksamkeit oder einen Erfolg.</p><Sources ids={['roseburg', 'witzeeze']} /></article>
    </div>
    <p className="topic-note"><strong>Modell:</strong> keines ausgeführt · <strong>Betrieben von:</strong> niemand; redaktioneller Prototyptext. In einer späteren echten KI-Antwort müssen Modell und Betreiber sichtbar sein.</p>
  </>;
  if (id === 'feedback') return <>
    <p className="topic-demo-fiction">Zwei Fachbereiche · zwei Runden · alles „Beispiel, erfunden“</p>
    <h2>Fiktive Prüfung und Überarbeitung des Statusvorschlags</h2>
    <p>In der echten Anwendung wären alle Fachantworten öffentlich. Diese erfundenen Rollen behaupten weder, dass Tramm diese Fachbereiche hat, noch dass dort Mitarbeitende den Fall geprüft haben.</p>
    {[1, 2].map((round) => <section key={round} className="topic-round" aria-labelledby={`topic-round-${round}`}>
      <h3 id={`topic-round-${round}`}>Runde {round} · Beispiel, erfunden</h3>
      <ol>{TOPIC_FEEDBACK_ROUNDS.filter((item) => item.round === round).map((item) => <li key={item.department}>
        <p><strong>{item.department}</strong> · {item.date}</p><p>{item.response}</p><p className="topic-note">Bearbeitet: {item.revision}</p><Sources ids={item.sourceIds} />
      </li>)}</ol>
    </section>)}
    <p className="topic-note">Keine echte Abgabe, interne Verwaltungssitzung, Personalposition oder Verwaltungsantwort.</p>
  </>;
  if (id === 'decision') return <>
    <h2>Ratsentscheidung und beratendes Meinungsbild sind getrennt</h2>
    <article className="topic-decision-record"><span className="topic-evidence-label">Quellenbeleg · bereits dokumentiert</span><h3>Gemeindevertretung Tramm · 1. Juni 2026</h3><p>7 Ja · 1 Nein · 0 Enthaltungen. Auftrag zum Abschluss des Kostenübernahme-Vertrags. Das ist der aufgezeichnete Ratsbeschluss; er ist kein Nachweis für spätere Vertragsunterzeichnung oder Umsetzung.</p><Sources ids={['minutes']} /></article>
    <section className="topic-advisory" aria-labelledby="topic-advisory-title">
      <span className="topic-demo-fiction">Beispiel, erfunden · beratende Ansicht · keine echte Mitmachen-Runde</span>
      <h3 id="topic-advisory-title">Welche Statusangabe sollte eine öffentliche Übersicht zuerst belegen?</h3>
      <p>Fiktive Frage zur Transparenz des Status, nicht zur Windenergienutzung und nicht zur Wiederholung des Ratsbeschlusses. Diese Auswahl ist keine Abstimmung, kein Bürgerentscheid und kein bindender Ratsbeschluss.</p>
      <fieldset><legend>Nur lokale Demo-Auswahl · nicht gespeichert oder übertragen</legend>{TOPIC_ADVISORY_OPTIONS.map((option) => <label key={option}><input type="radio" name="topic-demo-choice" checked={choice === option} onChange={() => { setChoice(option); setResponse(''); }} />{option}</label>)}</fieldset>
      <button type="button" disabled={!choice} onClick={() => { onVote(choice); setResponse('Deine Auswahl bleibt nur in dieser Seite sichtbar. Sie wurde nicht gespeichert, gezählt oder versendet.'); }}>Demo-Auswahl vormerken</button>
      {response && <p role="status" className="topic-status-note">{response}</p>}
      <p className="topic-note">Ein echtes Mitmachen-Meinungsbild braucht einen aktuellen, geprüften Citizen Brief und eine separat geöffnete Runde. Diese Seite öffnet kein solches Meinungsbild.</p>
    </section>
  </>;
  return <>
    <h2>Der ganze Weg: Quelle bis zur getrennten Entscheidung</h2>
    <p>Quellenfakten und die erfundene Transparenz-Übung bleiben in zwei klar markierten Spuren. Der Ratsbeschluss ist bereits am 1. Juni 2026 dokumentiert; der Beispiel-Dialog hat ihn nicht vorbereitet oder verändert.</p>
    <ol className="topic-trace">
      {TOPIC_SOURCE_TIMELINE.map((event) => <li className="source-event" key={event.date}><time>{event.date}</time><span className="topic-event-kind">{event.reality === 'source' ? 'Quellenereignis' : 'Bestandsaufnahme · kein Quellenereignis'}</span><p>{event.event}</p><Sources ids={[event.sourceId]} /></li>)}
      <li className="demo-event"><time>Beispiel-Datum, erfunden · 20. November 2026</time><span className="topic-event-kind">Problem und redaktioneller Text · kein Modell ausgeführt · fiktive Anschlussübung</span><p>Eine Person schlägt eine nachweisbare Statusübersicht vor; der redaktionelle Prototypentwurf verlinkt Quellen und weist die unbekannten Umsetzungsdaten aus.</p><Sources ids={['minutes', 'paper']} /></li>
      <li className="demo-event"><time>Beispiel-Datum, erfunden · 20. November 2026</time><span className="topic-event-kind">Fachfeedback · Runde 1 · Rollen fiktiv</span><p>Planung und Haushalt schlagen Änderungen vor. Kein echter Fachbereich hat geantwortet.</p><Sources ids={['minutes']} /></li>
      <li className="demo-event"><time>Beispiel-Datum, erfunden · 25. November 2026</time><span className="topic-event-kind">Überarbeitung · Runde 2 · Rollen fiktiv</span><p>Der Beispielentwurf trennt belegte Kostenregeln von unbekannten tatsächlichen Beträgen und späterem Vollzug.</p><Sources ids={['minutes', 'paper']} /></li>
      <li className="demo-event"><time>Beispiel-Datum, erfunden · 27. November 2026</time><span className="topic-event-kind">Mitmachen · beratende Demo-Ansicht</span><p>Eine denkbare, lokale Demo-Frage ordnet öffentliche Statusinformationen. Kein Ergebnis, keine Mitmachen-Runde und keine tatsächliche Teilnahme.</p></li>
    </ol>
    <section className="topic-source-summary"><h3>Alle verwendeten Quellen</h3><SourceCards /></section>
  </>;
}

export function TopicFlowDemo() {
  const [stage, setStage] = useState<TopicStageId>('feed');
  const [localChoice, setLocalChoice] = useState('');
  const current = TOPIC_DEMO_STAGES.findIndex((item) => item.id === stage);
  return <main className="topic-walkthrough">
    <header className="topic-walkthrough-hero">
      <span className="topic-eyebrow">LEDGER OF LIFE · BÜRGER-THEMENWEG · LOKALE DEMO</span>
      <h1>Vom Stadthinweis bis zur nachvollziehbaren Entscheidung</h1>
      <p>Eine echte, quellengebundene Trammer Ratsvorlage zeigt den Ausgangspunkt. Diskussion, Entwurfstext, Fachfeedback und Mitmachen-Frage sind eine erfundene Transparenz-Übung, keine historischen Ereignisse.</p>
      <div className="topic-truth-banner"><strong>Lokaler Prototyp · Nur lesen und durchklicken</strong><span>Keine Anmeldung · keine Übertragung · keine echte Abgabe, Fachantwort oder Abstimmung.</span></div>
      <p className="topic-data-provenance">{TOPIC_FLOW_SNAPSHOT} · Tramm, Schleswig-Holstein · Fall-ID {TOPIC_FLOW_CASE_ID}</p>
      <nav className="topic-stage-nav" aria-label="Sieben Schritte im Themenweg">{TOPIC_DEMO_STAGES.map((item, index) => <button type="button" key={item.id} aria-current={stage === item.id ? 'step' : undefined} onClick={() => setStage(item.id)}><span>{index + 1}</span><strong>{item.label}</strong></button>)}</nav>
      <p className="topic-stage-owner">Schritt {current + 1} von 7 · Zuständig: {TOPIC_DEMO_STAGES[current]?.owner}</p>
    </header>
    <section className="topic-stage-content" aria-live="polite" aria-atomic="false"><DemoStage id={stage} onVote={setLocalChoice} />{localChoice && stage !== 'decision' && <p className="topic-note">Lokale Demo-Auswahl: {localChoice} · nicht gespeichert und nicht versendet.</p>}</section>
    <nav className="topic-stage-controls" aria-label="Weiter im Themenweg"><button type="button" disabled={current === 0} onClick={() => setStage(moveTopicStage(stage, -1))}>← Zurück</button><button type="button" onClick={() => setStage(moveTopicStage(stage, 1))} disabled={current === TOPIC_DEMO_STAGES.length - 1}>Weiter →</button></nav>
    <footer className="topic-walkthrough-footer"><p><strong>Fakten und Grenzen:</strong> Der Live-API-Datensatz belegt einen Ratsbeschluss zum Vertragsabschluss und eine Kostenzuständigkeit; keine konkrete Euro-Summe, Vertragsausführung oder Umsetzung. Die Vergleichsfälle sind deterministische Quellvergleiche, keine Wirkungsnachweise.</p><nav aria-label="Weitere Ledger-Seiten"><Link href="/story">Fiktive Ledger-Stadtgeschichte</Link><Link href="/replay">Aufgezeichnete Testnetz-Mietgeschichte</Link><Link href="/">Ledger of Life</Link></nav></footer>
  </main>;
}
