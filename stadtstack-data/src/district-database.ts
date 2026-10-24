import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import type {Pool,PoolClient} from 'pg';

/** Content-free operational failure, never a new job disposition or retry grant. */
export class DistrictDatabaseConnectionLost extends Error {
 readonly code='DATABASE_CONNECTION_LOST';
 constructor(){super('DATABASE_CONNECTION_LOST');this.name='DistrictDatabaseConnectionLost';}
}
const connectionCodes:Readonly<Record<string,true>>={ECONNRESET:true,ECONNREFUSED:true,EPIPE:true,ETIMEDOUT:true,ENETUNREACH:true,EHOSTUNREACH:true,ENOTFOUND:true,'57P01':true,'57P02':true,'57P03':true};
export function isDistrictDatabaseConnectionError(error:unknown):boolean {
 if(error instanceof DistrictDatabaseConnectionLost)return true;
 if(!error||typeof error!=='object')return false;
 const {code,message}=error as {code?:unknown;message?:unknown};
 return typeof code==='string'&&(Object.hasOwn(connectionCodes,code)||/^08[A-Z0-9]{3}$/.test(code))||typeof message==='string'&&(['Connection terminated unexpectedly','Connection terminated','Connection terminated due to connection timeout','Client has encountered a connection error and is not queryable'].includes(message)||code==='55000'&&/^database .* is not currently accepting connections$/.test(message));
}
interface PoolMonitor {listeners:Set<()=>void>}
const monitors=new WeakMap<Pool,PoolMonitor>();
const guardedClients=new WeakSet<PoolClient>();
const currentScope=new AsyncLocalStorage<DistrictDatabaseScope>();
function monitorPool(pool:Pool):PoolMonitor {
 let monitor=monitors.get(pool);
 if(monitor)return monitor;
 const created:PoolMonitor={listeners:new Set()};monitor=created;monitors.set(pool,created);
 const lost=()=>{for(const listener of created.listeners)listener();};
 const guardClient=(client:PoolClient)=>{
  if(guardedClients.has(client))return;
  guardedClients.add(client);
  // Keep this handler for the client's lifetime, including late errors after
  // rollback/release. pg removes its own idle listener while checked out.
  client.on('error',lost);
 };
 pool.on('error',lost);pool.on('connect',guardClient);pool.on('acquire',guardClient);
 return monitor;
}
/** Installs permanent non-throwing error handlers before any checkout/query.
 * Scope subscriptions are temporary; one process can run independent executors.
 */
export function guardDistrictPool(pool:Pool):Pool {
 monitorPool(pool);currentScope.getStore()?.observe(pool);return pool;
}
export class DistrictDatabaseScope {
 readonly controller=new AbortController();
 private readonly observed=new Map<Pool,PoolMonitor>();
 failure:DistrictDatabaseConnectionLost|undefined;
 lostAt:number|undefined;
 get signal():AbortSignal{return this.controller.signal;}
 readonly lose=():void=>{
  if(this.failure)return;
  this.failure=new DistrictDatabaseConnectionLost();this.lostAt=performance.now();
  this.controller.abort(this.failure);
 };
 observe(pool:Pool):void {
  if(this.observed.has(pool))return;
  const monitor=monitorPool(pool);this.observed.set(pool,monitor);monitor.listeners.add(this.lose);
 }
 throwIfLost():void {if(this.failure)throw this.failure;}
 dispose():void {for(const monitor of this.observed.values())monitor.listeners.delete(this.lose);this.observed.clear();}
}
/** Nested CLI/executor scopes share loss across all their pools, including the
 * handler pool, without changing any semantic-hashed handler implementation.
 * Work is joined, never detached by an error race; inventory cleanup can drain.
 */
export async function withDistrictDatabaseScope<T>(work:(scope:DistrictDatabaseScope)=>Promise<T>):Promise<T> {
 const existing=currentScope.getStore();
 if(existing){existing.throwIfLost();return work(existing);}
 const scope=new DistrictDatabaseScope();
 return currentScope.run(scope,async()=>{
  try{const result=await work(scope);scope.throwIfLost();return result;}
  catch(error){if(isDistrictDatabaseConnectionError(error))scope.lose();throw scope.failure??error;}
  finally{scope.dispose();}
 });
}
