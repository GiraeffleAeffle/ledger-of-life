import {createServer} from 'node:http';
import {join} from 'node:path';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {jsonFile,outDir} from './common.ts';
import type {Catalogue,FeatureCollection,Signal} from './schema.ts';
import type {Changes} from './changes.ts';
type Coord=[number,number];
const radians=Math.PI/180;
function distance(a:Coord,b:Coord){const lat=(a[1]+b[1])*radians/2,dx=(a[0]-b[0])*111195*Math.cos(lat),dy=(a[1]-b[1])*111195;return Math.hypot(dx,dy);}
function segmentDistance(p:Coord,a:Coord,b:Coord){const scale=111195*Math.cos((p[1]+a[1]+b[1])/3*radians);const x=(b[0]-a[0])*scale,y=(b[1]-a[1])*111195;if(!x&&!y)return distance(p,a);const t=Math.max(0,Math.min(1,((p[0]-a[0])*scale*x+(p[1]-a[1])*111195*y)/(x*x+y*y)));return distance(p,[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
function inside(point:Coord,ring:Coord[]){let result=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])result=!result;}return result;}
function ringDistance(point:Coord,rings:Coord[][]){if(rings.length&&inside(point,rings[0])&&!rings.slice(1).some(r=>inside(point,r)))return 0;return Math.min(...rings.flatMap(r=>r.slice(1).map((b,i)=>segmentDistance(point,r[i],b))));}
export function geometryDistance(feature:Signal,point:Coord):number{const g=feature.geometry;if(!g)return Infinity;if(g.type==='Point')return distance(point,g.coordinates);if(g.type==='LineString')return Math.min(...g.coordinates.slice(1).map((b,i)=>segmentDistance(point,g.coordinates[i],b)));if(g.type==='Polygon')return ringDistance(point,g.coordinates);return Math.min(...g.coordinates.map(p=>ringDistance(point,p)));}
export function near(features:Signal[],point:Coord,radius:number,kinds?:string[]){return features.filter(f=>(!kinds||kinds.includes(f.properties.kind))&&geometryDistance(f,point)<=radius);}
export function searchText(features:Signal[],query?:string,topic?:string){
 const terms=(query??'').toLocaleLowerCase('de').split(/\s+/).filter(Boolean);
 return features.filter(f=>(!topic||f.properties.category.toLocaleLowerCase('de').includes(topic.toLocaleLowerCase('de'))||f.properties.kind===topic||(topic==='water'&&f.properties.id.startsWith('lake:')))&&terms.every(term=>`${f.properties.title} ${f.properties.statement} ${f.properties.category} ${f.properties.id}`.toLocaleLowerCase('de').includes(term)));
}
export function along(features:Signal[],line:Coord[],buffer:number,kinds?:string[]){return features.filter(f=>(!kinds||kinds.includes(f.properties.kind))&&line.some((b,i)=>i>0&&geometryNearSegment(f,line[i-1],b,buffer)));}
function geometryNearSegment(feature:Signal,a:Coord,b:Coord,buffer:number){if(feature.geometry?.type==='Point')return segmentDistance(feature.geometry.coordinates,a,b)<=buffer;if(geometryDistance(feature,a)<=buffer||geometryDistance(feature,b)<=buffer)return true;const g=feature.geometry;if(!g)return false;const lines:Coord[][]=g.type==='LineString'?[g.coordinates]:g.type==='Polygon'?g.coordinates:g.coordinates.flat();for(const line of lines)for(let i=1;i<line.length;i++){const c=line[i-1],d=line[i];if(segmentDistance(c,a,b)<=buffer||segmentDistance(d,a,b)<=buffer)return true;const cross=(u:Coord,v:Coord,w:Coord)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0)return true;}return false;}
async function collection(cityId:string){return jsonFile<FeatureCollection>(join(outDir,'cities',cityId,'signals.geojson'));}
export function server(options:{transformResult?:(data:unknown)=>{content:{type:'text';text:string}[];structuredContent?:Record<string,unknown>}}={}) {
 const mcp=new McpServer({name:'stadtstack-data',version:'0.2.0'});
 const tool=options.transformResult??((data:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:typeof data==='object'&&data!==null&&!Array.isArray(data)?data as Record<string,unknown>:undefined}));
 const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 const cityId=z.string().regex(/^[a-z0-9-]{1,80}$/), id=z.string().min(1).max(256), text=z.string().max(200);
 const page={offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(50).default(20)};
 const kinds=z.array(z.string().max(40)).max(20).optional();
 mcp.registerTool('list_cities',{description:'List public whole-city datasets and coverage',inputSchema:{},annotations},async()=>tool(await jsonFile<Catalogue>(join(outDir,'catalogue.json'))));
 mcp.registerTool('get_core_bundle',{description:'Read the shared Strausberg core fact bundle and release manifest, including automated gate evidence. Auto-verified is not human review or independent truth certification.',inputSchema:{},annotations},async()=>tool({bundle:await jsonFile(join(outDir,'core','strausberg-facts.json')),manifest:await jsonFile(join(outDir,'core','release-manifest.json'))}));
 mcp.registerTool('search_signals',{description:'Search whole-city facts by text/topic, including null geometry; no coordinates required. Paginated.',inputSchema:{cityId,query:text.optional(),topic:text.optional(),...page},annotations},async({cityId,query,topic,offset,limit})=>{
   const features=searchText((await collection(cityId))?.features??[],query,topic);
   return tool({features:features.slice(offset,offset+limit),total:features.length,offset});
 });
 mcp.registerTool('search_signals_near',{description:'Search geometry near a point. Null-geometry citywide records do not match. Paginated.',inputSchema:{cityId,lon:z.number().min(-180).max(180),lat:z.number().min(-90).max(90),radius_m:z.number().positive().max(100000),kinds,...page},annotations},async({cityId,lon,lat,radius_m,kinds,offset,limit})=>{
   const features=near((await collection(cityId))?.features??[],[lon,lat],radius_m,kinds);
   return tool({features:features.slice(offset,offset+limit),total:features.length,offset});
 });
 mcp.registerTool('search_signals_along',{description:'Search signals intersecting a buffered line, at most 32 vertices. Paginated.',inputSchema:{cityId,line:z.array(z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)])).min(2).max(32),buffer_m:z.number().positive().max(50000),kinds,...page},annotations},async({cityId,line,buffer_m,kinds,offset,limit})=>{
   const features=along((await collection(cityId))?.features??[],line,buffer_m,kinds);
   return tool({features:features.slice(offset,offset+limit),total:features.length,offset});
 });
 mcp.registerTool('get_signal',{description:'Fetch a public signal by stable id',inputSchema:{id},annotations},async({id})=>{const cat=await jsonFile<Catalogue>(join(outDir,'catalogue.json'));for(const c of cat?.cities??[]){const f=(await collection(c.id))?.features.find(f=>f.properties.id===id);if(f)return tool(f);}return tool({error:'not found'});});
 mcp.registerTool('get_sources',{description:'Fetch original attribution and exact source locators',inputSchema:{id},annotations},async({id})=>{const cat=await jsonFile<Catalogue>(join(outDir,'catalogue.json'));for(const c of cat?.cities??[]){const f=(await collection(c.id))?.features.find(f=>f.properties.id===id);if(f)return tool({id,sources:f.properties.sources,source:f.properties.sources,date:f.properties.asOf,status:f.properties.verification?.status==='auto-verified'?'auto-verified':'candidate',reviewState:f.properties.reviewState,verification:f.properties.verification,assertion:f.properties.assertion,geometryPrecision:f.properties.geometryPrecision,asOf:f.properties.asOf});}return tool({error:'not found'});});
 mcp.registerTool('get_changes',{description:'Added, changed and removed stable ids since the prior publication; use get_signal for current details',inputSchema:{cityId},annotations},async({cityId})=>tool(await jsonFile<Changes>(join(outDir,'cities',cityId,'changes.json'))??{error:'unknown city'}));
 return mcp;
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){if(process.argv.includes('--http')){const port=Number(process.env.STADTSTACK_MCP_PORT??'4318');const http=createServer(async(req,res)=>{if(!req.url?.startsWith('/mcp')){res.writeHead(req.url==='/health'?200:404,{'content-type':'application/json'});res.end(JSON.stringify({ok:req.url==='/health'}));return;}const instance=server(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});try{await instance.connect(transport);await transport.handleRequest(req,res);}catch(error){console.error(error);if(!res.headersSent){res.writeHead(500);res.end();}}});http.listen(port,'127.0.0.1',()=>console.error(`Stadtstack MCP http://127.0.0.1:${port}/mcp`));}else{await server().connect(new StdioServerTransport());}}
