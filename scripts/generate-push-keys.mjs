import {readFile,appendFile} from 'node:fs/promises';
import webpush from 'web-push';
const path=new URL('../.env',import.meta.url);
const env=await readFile(path,'utf8');
if(/^VAPID_(PUBLIC|PRIVATE)_KEY=.+$/m.test(env)) {
  console.log('VAPID keys already exist; existing subscriptions require keeping these keys.');
}else {
  const keys=webpush.generateVAPIDKeys();
  await appendFile(path,`\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
  console.log('VAPID keys saved to ignored api/.env. Add a real VAPID_SUBJECT contact before enabling delivery.');
}
