import {writeFileSync,renameSync} from 'node:fs';
import {workerData} from 'node:worker_threads';

// Deliberately starve this thread's event loop. The real process supervisor must
// still observe parent/PG loss and terminate the whole PID, not leave an orphan.
writeFileSync(workerData.marker+'.tmp',String(process.pid),{mode:0o600,flag:'wx'});renameSync(workerData.marker+'.tmp',workerData.marker);
for(;;){}
