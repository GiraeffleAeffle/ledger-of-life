import type {Pool} from 'pg';

/** pg-pool.end() can resolve before idle clients finish their socket shutdown. */
export function poolShutdownBarrier(pool:Pool):()=>Promise<void>{
  const closed:Promise<void>[]=[];
  pool.on('connect',client=>{closed.push(new Promise<void>(resolve=>{client.once('end',resolve);}));});
  return async()=>{await pool.end();await Promise.all(closed);};
}
