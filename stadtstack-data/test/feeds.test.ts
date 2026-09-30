import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSyndication,parseICalendar,enrichFromOfficialCalendar} from '../src/feeds.ts';
import {feedItemSchema} from '../src/schema.ts';
const retrieved='2026-09-27T12:00:00.000Z';
const source={id:'test',kind:'press' as const,publisher:'Test',url:'https://example.org/feed'};
test('parses RSS CDATA and entities with pubDate and GUID',()=>{
 const items=parseSyndication(`<rss><channel><item><title><![CDATA[Wetter &amp; Stadt]]></title><link>https://example.org/a?x=1&amp;y=2</link><guid>unique-1</guid><pubDate>Sat, 26 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`,source,retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(items.length,1);assert.equal(items[0].title,'Wetter & Stadt');assert.equal(items[0].url,'https://example.org/a?x=1&y=2');assert.equal(items[0].publishedAt,'2026-09-26T10:00:00.000Z');assert.equal(items[0].eventStart,null);assert.match(items[0].id,/^test:[a-f0-9]{64}$/);
});
test('strips tracking parameters and hashes canonical URL GUIDs',()=>{
 const item=(url:string,guid:string)=>parseSyndication(`<rss><channel><item><title>Neu</title><link>${url}</link><guid>${guid}</guid><pubDate>Sat, 26 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`,source,retrieved,new Date('2026-09-27T12:00:00Z'))[0];
 const first=item('https://example.org/post?utm_source=newsletter&keep=1','https://example.org/post?utm_campaign=launch&utm_source=mail');
 const second=item('https://example.org/post?utm_medium=social&keep=1','https://example.org/post?utm_term=campaign');
 assert.equal(first.url,'https://example.org/post?keep=1');assert.equal(second.url,first.url);assert.equal(second.id,first.id);
});
test('parses Atom alternate link and updated timestamp',()=>{
 const items=parseSyndication(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Neu</title><link rel="alternate" href="https://example.org/post"/><id>tag:example.org,2026:1</id><updated>2026-09-26T09:00:00+02:00</updated></entry></feed>`,source,retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(items.length,1);assert.equal(items[0].url,'https://example.org/post');assert.equal(items[0].publishedAt,'2026-09-26T07:00:00.000Z');
});
test('parses folded iCalendar URL and timezone DTSTART, filters past events',()=>{
 const events=parseICalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:upcoming\r\nSUMMARY:Köln\r\nDTSTART;TZID=Europe/Berlin:20261001T183000\r\nDTSTAMP:20260920T100000Z\r\nURL:https://example.org/a-long-\r\n url\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:past\r\nSUMMARY:Alt\r\nDTSTART;TZID=Europe/Berlin:20260901T183000\r\nURL:https://example.org/past\r\nEND:VEVENT\r\nEND:VCALENDAR`,{...source,kind:'events'},retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(events.length,1);assert.equal(events[0].url,'https://example.org/a-long-url');assert.equal(events[0].eventStart,'2026-10-01T16:30:00.000Z');
});
test('iCalendar GEO is latitude/longitude but GeoJSON is longitude/latitude; missing GEO stays unknown',()=>{
 const events=parseICalendar(`BEGIN:VEVENT
UID:pin-1
SUMMARY:Outdoor event
DTSTART;TZID=Europe/Berlin:20261030T150000
DTSTAMP:20260920T100000Z
GEO:52.5801295;13.8804803
LOCATION:Vor der Kirche\\, Altstadt
URL:https://example.org/event
END:VEVENT
BEGIN:VEVENT
UID:pin-2
SUMMARY:Unlocated event
DTSTART:20261031T120000Z
GEO:;
URL:https://example.org/other
END:VEVENT`,{...source,kind:'events'},retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.deepEqual(events[0].geometry,{type:'Point',coordinates:[13.8804803,52.5801295]});
 assert.equal(events[0].venue,'Vor der Kirche, Altstadt');
 assert.equal(events[0].locationSource?.method,'ics_geo');
 assert.equal(events[1].geometry,null);
 assert.equal(events[1].geometryPrecision,'none');
 assert.equal(events[1].locationSource,null);
});

test('official event calendar resolves dated matching title and exact venue without replacing publication or identity',()=>{
 const eventSource={id:'strausberg-events',kind:'events' as const,publisher:'Stadt Strausberg',url:'https://www.stadt-strausberg.de/veranstaltungen/feed/'};
 const [event]=parseSyndication(`<rss><channel><item><title>Kürbisfest</title><link>https://www.stadt-strausberg.de/veranstaltungen/kuerbisfest/</link><guid>https://www.stadt-strausberg.de/?post_type=rb_events&amp;p=30366</guid><pubDate>Tue, 22 Sep 2026 06:45:22 GMT</pubDate></item></channel></rss>`,eventSource,retrieved);
 const html=`<article class="rb-event-item rb-event-item-id-30366-2026-10-30"><h3>Kürbisfest</h3><time datetime="2026-10-30">30. Oktober</time><span class="rb-event-item-time">15:00 Uhr</span><address class="rb-event-item-location"><a href="https://maps.google.com/?q=Predigerstr.">Vor der Marienkirche in Strausberg<br />Predigerstr. 2<br />15344 Strausberg</a></address></article>`;
 const [located]=enrichFromOfficialCalendar([event],html,'strausberg','https://www.stadt-strausberg.de/veranstaltungen/',retrieved);
 assert.equal(located.id,event.id);
 assert.equal(located.publisherRecordId,'30366');
 assert.equal(located.publishedAt,'2026-09-22T06:45:22.000Z');
 assert.equal(located.eventStart,'2026-10-30T14:00:00.000Z');
 assert.equal(located.venue,'Vor der Marienkirche in Strausberg, Predigerstr. 2, 15344 Strausberg');
 assert.deepEqual(located.geometry,{type:'Point',coordinates:[13.8804803,52.5801295]});
 assert.equal(located.geometryPrecision,'approximate');
 assert.equal(located.locationSource?.geometrySourceUrl,'https://www.openstreetmap.org/way/38496130');
 const differentPublisher={...event,sourceId:'another-events',publisher:'Other publisher'};
 assert.deepEqual(enrichFromOfficialCalendar([differentPublisher],html,'strausberg','https://www.stadt-strausberg.de/veranstaltungen/',retrieved),[differentPublisher]);
 const wrongRecord={...event,publisherRecordId:'30334'};
 assert.deepEqual(enrichFromOfficialCalendar([wrongRecord],html,'strausberg','https://www.stadt-strausberg.de/veranstaltungen/',retrieved),[wrongRecord]);
 assert.deepEqual(enrichFromOfficialCalendar([event],html+html,'strausberg','https://www.stadt-strausberg.de/veranstaltungen/',retrieved),[event]);
});
test('feed boundary rejects fake or untraceable event pins',()=>{
 const [event]=parseICalendar(`BEGIN:VEVENT
UID:boundary
SUMMARY:Event
DTSTART:20261001T120000Z
GEO:52.5;13.8
URL:https://example.org/event
END:VEVENT`,{...source,kind:'events'},retrieved,new Date('2026-09-27T12:00:00Z'));
 assert.equal(feedItemSchema.safeParse(event).success,true);
 assert.equal(feedItemSchema.safeParse({...event,geometryPrecision:'none'}).success,false);
 assert.equal(feedItemSchema.safeParse({...event,locationSource:null}).success,false);
 assert.equal(feedItemSchema.safeParse({...event,geometry:{type:'Point',coordinates:[181,52.5]}}).success,false);
 assert.equal(feedItemSchema.safeParse({...event,kind:'news'}).success,false);
});
