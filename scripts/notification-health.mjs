import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
// Read-only diagnostics: never invoke the worker or print private headers/body.
try {
 const env=parseEnv(readFileSync(new URL('../.env.vercel',import.meta.url),'utf8'));
 if(!env.CRON_SECRET) throw Error('Missing private scheduler configuration');
 const response=await fetch('https://housemate-api.vercel.app/internal/notifications/health',{headers:{Authorization:`Bearer ${env.CRON_SECRET}`},redirect:'error',signal:AbortSignal.timeout(15000)});
 const data=await response.json();const d=data.delivery;
 const allowed=['pending','oldestDueSeconds','recentFailures','acceptedLast15Minutes','maxCreationToAcceptanceSeconds','maxQueueToAcceptanceSeconds','healthy'];
 console.log(JSON.stringify({httpStatus:response.status,checkedAt:new Date().toISOString(),...(d?{delivery:Object.fromEntries(allowed.map(key=>[key,d[key]]))}:{available:false})}));
 if(!response.ok) process.exitCode=1;
} catch {console.error('Notification delivery health unavailable; private configuration and response details withheld.');process.exitCode=1;}
