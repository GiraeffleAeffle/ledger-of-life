'use strict';
// Ephemeral tab memory only: no cookies, localStorage, IndexedDB or service worker.
const form = document.querySelector('#chat-form');
const question = document.querySelector('#question');
const ask = document.querySelector('#ask');
const clear = document.querySelector('#clear');
const conversation = document.querySelector('#conversation');
const status = document.querySelector('#chat-status');
const encoder = new TextEncoder();
let history = [];
let pending;

function boundedHistory(messages) {
  const recent = messages.slice(-6);
  while (recent.length && recent.reduce((bytes, item) => bytes + encoder.encode(item.content).length, 0) > 6000) recent.splice(0, 2);
  return recent;
}
function appendMessage(label, content) {
  const article = document.createElement('article');
  article.className = 'message';
  const title = document.createElement('h3');
  title.textContent = label;
  const paragraph = document.createElement('p');
  paragraph.textContent = content; // Never render model/user HTML, Markdown or clickable URLs.
  article.append(title, paragraph);
  conversation.append(article);
  while (conversation.children.length > 8) conversation.firstElementChild.remove();
}
clear.addEventListener('click', () => {
  pending?.abort('cleared');
  history = [];
  conversation.replaceChildren();
  question.value = '';
  status.textContent = 'Conversation cleared from this tab. The model operator may have its own logs.';
  question.focus();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) return;
  const text = question.value.trim();
  if (!text || encoder.encode(text).length > 2000) {
    status.textContent = 'Please use a question of 1–2,000 UTF-8 bytes (some characters use more than one byte).';
    question.focus();
    return;
  }
  const controller = new AbortController();
  pending = controller;
  ask.disabled = true;
  question.disabled = true;
  status.textContent = 'Connecting to the local AI…';
  const timeout = setTimeout(() => controller.abort(), 220000);
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try {
      const response = await fetch('/api/status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (response.ok) {
        const data = await response.json();
        const labels = { connecting: 'Connecting to the local AI…', waking: 'Waking the local AI… This can take up to 90 seconds.', answering: 'The local AI is answering… This can take up to two minutes.' };
        if (labels[data.stage] && !controller.signal.aborted) status.textContent = labels[data.stage];
      }
    } catch { /* The answer request reports connectivity errors; status has no independent success claim. */ }
    finally { polling = false; }
  }, 1000);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ question: text, history: boundedHistory(history) }), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The local model is unavailable. City information above still works.');
    if (controller.signal.aborted) return;
    appendMessage('You', text);
    appendMessage(`AI-generated · ${data.model} · can be wrong`, data.answer);
    history = boundedHistory([...history, { role: 'user', content: text }, { role: 'assistant', content: data.answer }]);
    question.value = '';
    status.textContent = `Snapshot ${data.snapshotVersion}; sources checked ${data.sourceDates.join(', ')}. Check the source details above.`;
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = error.message === 'Failed to fetch' ? 'The local node could not be reached. Check your local connection; no hosted fallback is used.' : error.message;
    else if (controller.signal.reason !== 'cleared') status.textContent = 'Question cancelled or timed out. City information still works.';
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    controller.abort();
    pending = undefined;
    ask.disabled = false;
    question.disabled = false;
    question.focus();
  }
});
