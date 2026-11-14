import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,openSync,closeSync,writeFileSync,fsyncSync} from 'node:fs';
import {measurePrivacy} from './lib/privacy-baseline.js';
const [input,digest,output,...extra]=process.argv.slice(2);
let fd:number|undefined;
try{
 if(!input||!digest||!output||extra.length||!/^[a-f0-9]{64}$/.test(digest))throw Error('Usage');
 const st=lstatSync(input);if(!st.isFile()||st.isSymbolicLink()||st.size>8388608)throw Error('Bounded regular observation file required');
 const raw=readFileSync(input);if(createHash('sha256').update(raw).digest('hex')!==digest)throw Error('Observation digest mismatch');
 const report=measurePrivacy(JSON.parse(raw.toString('utf8')));
 fd=openSync(output,'wx',0o600);writeFileSync(fd,JSON.stringify({...report,observationFileSha256:digest},null,2)+'\n');fsyncSync(fd);
 console.log(JSON.stringify({report:output,depositSigners:report.participation.observedDepositSignerCount,independentPeopleVerified:null,effectiveAnonymityEstablished:false}));
}catch{console.error('Privacy measurement failed. Use a bounded public dataset, its independent SHA-256 and a new report path. No privacy claim is established.');process.exitCode=1;}finally{if(fd!==undefined)closeSync(fd);}
