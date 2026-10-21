/** One checked-out canonical client, one transaction, never concurrent query()
 * calls. Closing rejects late branches and drains already submitted work before
 * COMMIT/ROLLBACK/release. A failed source must not restore the Pool facade. */
export function createCanonicalQueryQueue(execute:(...args:unknown[])=>Promise<unknown>){
 let accepting=true,tail:Promise<void>=Promise.resolve(),failure:unknown;
 return {
  query(...args:unknown[]):Promise<unknown>{
   if(!accepting)return Promise.reject(Error('Canonical query queue is closed'));
   const result=tail.then(()=>{if(failure!==undefined)throw failure;return execute(...args);});
   tail=result.then(()=>{},error=>{failure??=error;});
   return result;
  },
  async close(){accepting=false;await tail;},
 };
}
