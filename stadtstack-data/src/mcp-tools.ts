import {server} from './mcp.ts';
import {loadedRelease} from './mcp-release.ts';
import {publicData} from './mcp-query.ts';
export {loadRelease} from './mcp-release.ts';

export function releasedResponse(data:unknown) {
  const release=loadedRelease();
  const output={source:{publisher:'Stadtstack',dataset:'stadtstack-data/out',release:release.dataManifest.id},releasedAt:release.dataManifest.generatedAt,respondedAt:new Date().toISOString(),status:'candidate',statusMeaning:'The lookup is not a verified assertion. Original eventDate/documentDate and observation asOf are separate from publication/response timestamps. Individual verification evidence is preserved; automated verification is not human review.',data:publicData(data)};
  return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
}
export function hostedServer() {
  return server({transformResult:releasedResponse,release:loadedRelease()});
}
