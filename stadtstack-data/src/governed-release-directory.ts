import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve,relative,dirname,basename,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Selection only: the caller must authenticate the complete immutable release.
 * No old out fallback, schema conversion, source fetch, or authority provisioning.
 */
export function governedReleaseDirectory(environment:NodeJS.ProcessEnv=process.env):string{
 const configured=environment.STADTSTACK_MCP_RELEASE_DIR;
 if(!configured||!isAbsolute(configured))throw Error('STADTSTACK_MCP_RELEASE_DIR must name an absolute governed live release directory');
 const configuredPath=resolve(configured),historicalPath=resolve(fileURLToPath(new URL('../out',import.meta.url)));
 const outside=(root:string,path:string)=>{const child=relative(root,path);return child==='..'||child.startsWith('..'+sep)||isAbsolute(child);};
 if(!outside(historicalPath,configuredPath))throw Error('Historical release output is not the live serving root');
 const directory=realpathSync(configuredPath);
 let historical:string;
 try{historical=realpathSync(historicalPath);}
 catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  // A clean serving image may omit out entirely; a dangling historical symlink is not omission.
  let exists=true;
  try{lstatSync(historicalPath);}
  catch(missing){if((missing as NodeJS.ErrnoException).code!=='ENOENT')throw missing;exists=false;}
  if(exists)throw error;
  historical=join(realpathSync(dirname(historicalPath)),basename(historicalPath));
 }
 if(!outside(historical,directory))throw Error('Historical release output is not the live serving root');
 let current:string=sep;
 for(const component of configuredPath.split(sep).filter(Boolean)){
  current=join(current,component);const metadata=lstatSync(current);
  if(metadata.isSymbolicLink()||!metadata.isDirectory())throw Error('Governed live release directory must have only real directory components');
 }
 return directory;
}
