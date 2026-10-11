import {server} from './mcp.ts';
import {loadedRelease,type ReleasedData} from './mcp-release.ts';
import {publicData} from './mcp-query.ts';
export {loadRelease} from './mcp-release.ts';

export function releasedResponse(data:unknown,release:ReleasedData) {
  const output={source:{publisher:'Stadtstack',dataset:'stadtstack-data',release:release.dataManifest.id},releasedAt:release.dataManifest.generatedAt,respondedAt:new Date().toISOString(),status:'candidate',statusMeaning:'The lookup is not a verified assertion. Text stage/event dates and nativeDate/datePrecision/dateRole/financialRole remain distinct from retrieval/publication/response time. Native year/month calendarRange is derived for search overlap only, never a legal/stage date; unknown periods are not guessed. Primary/supporting field locators keep separate source hashes and policy/scope receipts, never invented quotes/model provenance. Graph asOf is release-pinned or an explicit returned override; respondedAt never selects graph validity. Automated verification is not human review or independent truth certification.',data:publicData(data)};
  return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
}
export function hostedServer() {
  const release=loadedRelease();
  return server({transformResult:data=>releasedResponse(data,release),release});
}
