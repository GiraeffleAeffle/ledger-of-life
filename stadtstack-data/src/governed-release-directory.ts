import {isAbsolute,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Selection only: the caller must authenticate the complete immutable release.
 * No old out fallback, schema conversion, source fetch, or authority provisioning.
 */
export function governedReleaseDirectory(environment:NodeJS.ProcessEnv=process.env):string{
 const configured=environment.STADTSTACK_MCP_RELEASE_DIR;
 if(!configured||!isAbsolute(configured))throw Error('STADTSTACK_MCP_RELEASE_DIR must name an absolute governed live release directory');
 const directory=resolve(configured),historical=resolve(fileURLToPath(new URL('../out',import.meta.url))),child=relative(historical,directory);
 if(!child||!(child==='..'||child.startsWith('..'+sep)||isAbsolute(child)))throw Error('Historical release output is not the live serving root');
 return directory;
}
