import {schedulingConfig} from './scheduling.js';
import type {ProofRelay} from './service.js';
export function startRelayWorker(relay:ProofRelay){
 let stopped=false,running:Promise<unknown>|undefined;
 const tick=()=>{if(stopped||running)return;running=relay.drain().catch(()=>{/* Keep journal state; never rebroadcast after an exception. */}).finally(()=>{running=undefined;});};
 const timer=setInterval(tick,schedulingConfig.tickMilliseconds);timer.unref();tick();
 return async()=>{stopped=true;clearInterval(timer);await running;};
}
