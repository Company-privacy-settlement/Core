#!/usr/bin/env python3
"""Read-only live RPC acceptance, optional controlled restart, and isolation checks."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.request

cli=argparse.ArgumentParser(description=__doc__)
cli.add_argument('--root',type=Path,default=Path('/home/jiheon/.local/share/money-station/backend'))
cli.add_argument('--restart',action='store_true')
cli.add_argument('--output',type=Path,required=True)
a=cli.parse_args();root=a.root.absolute()
spec=importlib.util.spec_from_file_location('backend_control',root/'control.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);c=m.load(root)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
checks=[]
def fetch(port,path,origin=None,method='GET'):
    req=urllib.request.Request(f'http://127.0.0.1:{port}{path}',method=method,headers={'Origin':origin} if origin else {})
    try:r=opener.open(req,timeout=20)
    except urllib.error.HTTPError as e:r=e
    with r:
        body=r.read();return r.status,json.loads(body) if body else None,dict(r.headers)
def ready():
    before=time.monotonic()
    while time.monotonic()-before<100:
        try:
            x=fetch(c['apiPort'],'/readyz');y=fetch(c['organizationPort'],'/readyz')
            if x[0]==200 and y[0]==200:return x[1],y[1]
        except OSError:pass
        time.sleep(1)
    raise AssertionError('Real backend readiness timed out')
api,org=ready();assert api['readOnly'] and api['deploymentVerified'] and api['index']['enabled']
assert org['databaseAvailable'] and org['network']=='testnet' and not org['identityClaimsVerified']
checks+=['native-deployment-and-index-ready','organization-rpc-and-storage-ready']
status,config,headers=fetch(c['apiPort'],'/v1/config',c['frontOrigin']);assert status==200 and config['policy']==json.loads((Path(c['release'])/'config/policy.json').read_text())
assert headers['access-control-allow-origin']==c['frontOrigin'];checks.append('exact-policy-and-allowed-origin')
for port in [c['apiPort'],c['organizationPort']]:
    assert fetch(port,'/readyz','https://unrelated.invalid')[0]==403
assert fetch(c['organizationPort'],'/v1/organizations',c['frontOrigin'])[0]==401
checks+=['both-unrelated-origins-denied','organization-session-required']
for unit in ['api','organizations']:
    subprocess.run(m.sandbox(root,c,unit,['/usr/bin/test','!','-e','/home/jiheon']),check=True)
subprocess.run(m.sandbox(root,c,'api',['/usr/bin/test','!','-e','/secrets/invoice-keys.json']),check=True)
subprocess.run(m.sandbox(root,c,'organizations',['/usr/bin/test','-r','/secrets/invoice-keys.json']),check=True)
subprocess.run(m.sandbox(root,c,'organizations',['/usr/bin/test','!','-w','/secrets/invoice-keys.json']),check=True)
subprocess.run(m.sandbox(root,c,'api',['/usr/bin/test','!','-w','/app/config/policy.json']),check=True)
checks+=['host-home-absent','public-api-cannot-read-organization-secrets','organization-secrets-and-runtime-read-only']
duplicate=subprocess.run(m.sandbox(root,c,'api'),capture_output=True,timeout=30)
assert duplicate.returncode==1
locked=subprocess.run(m.sandbox(root,c,'api',['flock','--nonblock','--conflict-exit-code','73','/data/.core-service.lock','/usr/bin/true']),capture_output=True,timeout=10)
assert locked.returncode==73;checks.append('duplicate-index-writer-rejected')
old=fetch(c['apiPort'],'/v1/index/status')[1]
for _ in range(30):
    time.sleep(2);new=fetch(c['apiPort'],'/v1/index/status')[1]
    if new['checkpoint']['block']['height']>old['checkpoint']['block']['height']:break
else:raise AssertionError('Index checkpoint did not advance')
assert new['indexedRecords']>=old['indexedRecords'];checks.append('real-finalized-index-checkpoint-advanced')
restarted=False
if a.restart:
    keys=root/'secrets/organizations/invoice-keys.json';pin=hashlib.sha256(keys.read_bytes()).digest()
    inode=(root/'state/organizations/organizations.sqlite').stat().st_ino
    previous=json.loads((root/'run/status.json').read_text())['children']
    pid=m.managed_pid(root);assert pid;os.kill(pid,signal.SIGHUP)
    for _ in range(75):
        time.sleep(1)
        current=json.loads((root/'run/status.json').read_text())['children']
        if len(current)==2 and all(current[u]['pid']!=previous[u]['pid'] for u in previous):break
    else:raise AssertionError('Workers did not restart')
    api,org=ready();status=fetch(c['apiPort'],'/v1/index/status')[1]
    assert status['indexedRecords']>=new['indexedRecords'] and status['checkpoint']['block']['height']>=new['checkpoint']['block']['height']
    assert hashlib.sha256(keys.read_bytes()).digest()==pin and (root/'state/organizations/organizations.sqlite').stat().st_ino==inode
    checks+=['controlled-worker-restart','index-and-organization-database-preserved','separate-encryption-keys-preserved'];restarted=True
report={'format':'money-station-backend-acceptance-v1','status':'passed','checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
        'runtime':c['releaseId'],'sourceCommit':json.loads((Path(c['release'])/'runtime-manifest.json').read_text())['sourceCommit'],
        'checks':checks,'apiReadiness':api,'organizationReadiness':org,'restartChecked':restarted,
        'scope':{'nativeNearTestnet':True,'publicHttpsAccepted':False,'realWalletSessionChecked':False,
                 'browserUsdcAccepted':False,'actualKybTaxProvidersAccepted':False}}
with a.output.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
print(json.dumps(report))
