import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSyndication,parseICalendar} from '../src/feeds.ts';
const retrieved='2026-09-27T12:00:00.000Z';
const source={id:'test',kind:'press' as const,publisher:'Test',url:'https://example.org/feed'};
test('parses RSS CDATA and entities with pubDate and GUID',()=>{
 const items=parseSyndication(`<rss><channel><item><title><![CDATA[Wetter &amp; Stadt]]></title><link>https://example.org/a?x=1&amp;y=2</link><guid>unique-1</guid><pubDate>Sat, 26 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`,source,retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(items.length,1);assert.equal(items[0].title,'Wetter & Stadt');assert.equal(items[0].url,'https://example.org/a?x=1&y=2');assert.equal(items[0].publishedAt,'2026-09-26T10:00:00.000Z');assert.equal(items[0].eventStart,null);assert.match(items[0].id,/^test:[a-f0-9]{64}$/);
});
test('parses Atom alternate link and updated timestamp',()=>{
 const items=parseSyndication(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Neu</title><link rel="alternate" href="https://example.org/post"/><id>tag:example.org,2026:1</id><updated>2026-09-26T09:00:00+02:00</updated></entry></feed>`,source,retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(items.length,1);assert.equal(items[0].url,'https://example.org/post');assert.equal(items[0].publishedAt,'2026-09-26T07:00:00.000Z');
});
test('parses folded iCalendar URL and timezone DTSTART, filters past events',()=>{
 const events=parseICalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:upcoming\r\nSUMMARY:Köln\r\nDTSTART;TZID=Europe/Berlin:20261001T183000\r\nDTSTAMP:20260920T100000Z\r\nURL:https://example.org/a-long-\r\n url\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:past\r\nSUMMARY:Alt\r\nDTSTART;TZID=Europe/Berlin:20260901T183000\r\nURL:https://example.org/past\r\nEND:VEVENT\r\nEND:VCALENDAR`,{...source,kind:'events'},retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(events.length,1);assert.equal(events[0].url,'https://example.org/a-long-url');assert.equal(events[0].eventStart,'2026-10-01T16:30:00.000Z');
});
