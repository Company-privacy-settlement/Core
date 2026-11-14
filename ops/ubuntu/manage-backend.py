#!/usr/bin/env python3
"""Manage the isolated Money Station API/indexer and organization service as the owner."""
import argparse
import fcntl
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shlex
import socket
import signal
import subprocess
import sys
import threading
import time
import urllib.request

DEFAULT_ROOT='/home/jiheon/.local/share/money-station/backend'
MARKER='# money-station-backend-autostart'


def private_directory(p):
    p.mkdir(parents=True,exist_ok=True,mode=0o700)
    st=p.lstat()
    if p.is_symlink() or st.st_uid!=os.getuid() or st.st_mode&0o077:
        raise ValueError('Deployment directories must be owner-only regular directories')


def load(root):
    private_directory(root)
    c=json.loads((root/'config.json').read_text())
    release=Path(c['release'])
    if release.parent!=root/'releases' or release.is_symlink():raise ValueError('Invalid release path')
    if c['frontOrigin']!='https://moneystation.site' or c['apiOrigin']!='https://api.moneystation.site':raise ValueError('Unexpected origins')
    if (c['apiPort'],c['organizationPort'])!=(3331,3332):raise ValueError('Unexpected backend ports')
    if c['rpc']!='https://test.rpc.fastnear.com':raise ValueError('Unexpected RPC')
    for name in ['run','logs','state','state/api','state/organizations','secrets','secrets/organizations']:private_directory(root/name)
    return c


def verify_release(c):
    release=Path(c['release']);m=json.loads((release/'runtime-manifest.json').read_text())
    if m.get('format')!='money-station-backend-runtime-v1' or not m.get('files'):raise ValueError('Invalid runtime manifest')
    if m['policySha256']!=c['policySha256']:raise ValueError('Policy manifest mismatch')
    for name,pin in m['files'].items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts:raise ValueError('Invalid manifest path')
        p=release/rel
        if not p.is_file() or p.is_symlink():raise ValueError('Runtime asset is missing or linked')
        with p.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=pin:raise ValueError('Runtime integrity mismatch: '+name)
    with (release/'config/policy.json').open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=c['policySha256']:raise ValueError('Policy pin mismatch')


def sandbox(root,c,unit,maintenance=None,secrets_write=False):
    release=Path(c['release'])
    args=['bwrap','--unshare-all','--share-net','--new-session','--die-with-parent',
          '--cap-drop','ALL','--ro-bind','/usr','/usr','--symlink','usr/lib','/lib',
          '--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
          '--dir','/etc','--dir','/etc/ssl','--ro-bind','/etc/ssl/certs','/etc/ssl/certs',
          '--ro-bind',str(release/'config/passwd'),'/etc/passwd',
          '--ro-bind',str(release/'config/group'),'/etc/group']
    for name in ['resolv.conf','nsswitch.conf','hosts']:
        args+=['--ro-bind','/etc/'+name,'/etc/'+name]
    args+=['--ro-bind',str(release),'/app','--bind',str(root/'state'/unit),'/data',
           '--clearenv','--setenv','PATH','/app/runtime:/usr/bin','--setenv','NODE_ENV','production',
           '--setenv','NODE_OPTIONS','--max-old-space-size=256','--setenv','TMPDIR','/tmp',
           '--setenv','LANG','C.UTF-8','--chdir','/app']
    if unit=='organizations':args+=['--bind' if secrets_write else '--ro-bind',str(root/'secrets/organizations'),'/secrets']
    env={'PORT':str(c['apiPort'] if unit=='api' else c['organizationPort'])}
    if unit=='api':
        env.update(CORE_POLICY_FILE='/app/config/policy.json',CORE_POLICY_SHA256=c['policySha256'],
                   CORE_DATA_DIR='/data',CORE_INDEX_DB='/data/activity.sqlite',CORE_RPC_URL=c['rpc'],CORE_ALLOWED_ORIGINS=c['frontOrigin'],
                   CORE_API_HOST='127.0.0.1',CORE_API_REQUIRE_INDEX='true',CORE_SERVICE_NETWORK='testnet',
                   CORE_INDEX_INTERVAL_MS='15000',CORE_BACKUP_INTERVAL_MS='21600000',CORE_BACKUP_KEEP='7')
        command=['/app/runtime/node','scripts/start-service.mjs']
    else:
        env.update(CORE_ORGANIZATION_HOST='127.0.0.1',CORE_ORGANIZATION_DB='/data/organizations.sqlite',
                   CORE_ORGANIZATION_ORIGIN=c['apiOrigin'],CORE_ORGANIZATION_ALLOWED_ORIGINS=c['frontOrigin'],
                   CORE_ORGANIZATION_RPC_URL=c['rpc'],CORE_ORGANIZATION_INVOICE_KEYS_FILE='/secrets/invoice-keys.json')
        command=['/app/runtime/node','dist/service/scripts/organization-server.js']
    for key,value in env.items():args+=['--setenv',key,value]
    return args+(maintenance if maintenance else command)


def managed_pid(root):
    try:
        pid=json.loads((root/'run/status.json').read_text())['managerPid']
        cmd=Path('/proc',str(pid),'cmdline').read_bytes().split(b'\0')
        if Path('/proc',str(pid)).stat().st_uid!=os.getuid():return None
        if str(root/'control.py').encode() in cmd and b'run' in cmd and str(root).encode() in cmd:return pid
    except (OSError,ValueError,KeyError,TypeError):pass
    return None


def terminate(p):
    if p.poll() is None:
        # Signal only our top-level Node child, so it can close SQLite and stop
        # its own index worker before the enclosing namespace disappears.
        pending=[p.pid];target=None
        for _ in range(64):
            if not pending:break
            pid=pending.pop()
            try:
                proc=Path('/proc',str(pid))
                if proc.stat().st_uid!=os.getuid():continue
                argv=(proc/'cmdline').read_bytes().split(b'\0')
                if argv[:2] in [[b'/app/runtime/node',b'scripts/start-service.mjs'],[b'/app/runtime/node',b'dist/service/scripts/organization-server.js']]:target=pid;break
                pending.extend(map(int,(proc/'task'/str(pid)/'children').read_text().split()))
            except (OSError,ValueError):pass
        try:
            if target:os.kill(target,signal.SIGTERM)
            else:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:return
        try:p.wait(timeout=25)
        except subprocess.TimeoutExpired:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.wait()


def run(root):
    c=load(root)
    with (root/'run/manager.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit('A backend manager already holds the lock')
        verify_release(c)
        stop=threading.Event();restart=threading.Event();children={};readers=[]
        for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda *_:stop.set())
        signal.signal(signal.SIGHUP,lambda *_:restart.set())
        logger=logging.getLogger('money-station-backend');logger.setLevel(logging.INFO)
        handler=RotatingFileHandler(root/'logs/backend.log',maxBytes=10*1024*1024,backupCount=3)
        handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'));logger.addHandler(handler)
        def log_output(p,unit):
            for line in iter(p.stdout.readline,b''):
                logger.info('%s %s',unit,line[:16384].decode(errors='replace').rstrip())
            p.stdout.close()
        def spawn_unit(unit):
            readers[:]=[thread for thread in readers if thread.is_alive()]
            p=subprocess.Popen(['nice','-n','5','prlimit','--nofile=1024:1024','--core=0:0','--',*sandbox(root,c,unit)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
            thread=threading.Thread(target=log_output,args=(p,unit),daemon=True);thread.start();readers.append(thread)
            return p
        def status(event):
            data={'format':'money-station-backend-status-v1','event':event,'managerPid':os.getpid(),
                  'releaseId':c['releaseId'],'updatedAt':time.time(),
                  'children':{u:{'pid':p.pid,'exitCode':p.poll()} for u,p in children.items()}}
            temporary=root/'run/status.next';temporary.write_text(json.dumps(data)+'\n');temporary.replace(root/'run/status.json')
        try:
            status('initializing')
            # Keys are generated once inside the organization sandbox. They never
            # enter release files, environment values, logs or public API responses.
            keys=root/'secrets/organizations/invoice-keys.json'
            if not keys.exists():
                p=subprocess.run(sandbox(root,c,'organizations',['/app/runtime/node','scripts/organization-invoice-keys.mjs','/secrets/invoice-keys.json','initial'],secrets_write=True),capture_output=True,timeout=30)
                if p.returncode:raise RuntimeError('Organization key provisioning failed')
            if keys.is_symlink() or keys.stat().st_mode&0o077:raise ValueError('Organization keys must be owner-only')
            delays={u:1 for u in ['api','organizations']};retry_at={u:0 for u in delays}
            while not stop.is_set():
                if restart.is_set():
                    for p in children.values():terminate(p)
                    children.clear();restart.clear();c=load(root);verify_release(c)
                for unit in delays:
                    old=children.get(unit)
                    if old and old.poll() is not None:
                        logger.warning('%s exited with %s',unit,old.returncode)
                        retry_at[unit]=time.monotonic()+delays[unit];delays[unit]=min(60,delays[unit]*2);del children[unit]
                    if unit not in children and time.monotonic()>=retry_at[unit]:children[unit]=spawn_unit(unit)
                status('running');stop.wait(1)
        finally:
            for p in children.values():terminate(p)
            for thread in readers:thread.join(timeout=2)
            status('stopped');handler.close()


def probe(port,path):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f'http://127.0.0.1:{port}{path}',timeout=20) as response:
            return {'http':response.status,'body':json.load(response)}
    except Exception as e:return {'error':type(e).__name__}


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('command',choices=['run','start','stop','restart','status','autostart'])
    cli.add_argument('--root',type=Path,default=Path(DEFAULT_ROOT))
    args=cli.parse_args();root=args.root.absolute();c=load(root)
    if args.command=='run':return run(root)
    pid=managed_pid(root)
    if args.command=='start':
        if not pid:
            for port in [c['apiPort'],c['organizationPort']]:
                with socket.socket() as listener:
                    listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                    listener.bind(('127.0.0.1',port))
            with (root/'logs/manager.log').open('ab') as log:
                p=subprocess.Popen([sys.executable,str(root/'control.py'),'run','--root',str(root)],
                    stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
            print(json.dumps({'status':'starting','managerPid':p.pid,'root':str(root)}))
        else:print(json.dumps({'status':'already-running','managerPid':pid}))
    elif args.command in ['stop','restart']:
        if not pid:raise SystemExit('No managed backend process is running')
        os.kill(pid,signal.SIGHUP if args.command=='restart' else signal.SIGTERM)
        print(json.dumps({'status':args.command+'-requested','managerPid':pid}))
    elif args.command=='autostart':
        if any(x in str(root) for x in ['\n','%']):raise ValueError('Unsupported cron path')
        old=subprocess.run(['crontab','-l'],capture_output=True,text=True)
        if old.returncode not in [0,1]:raise RuntimeError('Could not read owner crontab')
        command=shlex.join([sys.executable,str(root/'control.py'),'start','--root',str(root)])
        line='@reboot '+command+' >> '+shlex.quote(str(root/'logs/boot.log'))+' 2>&1 '+MARKER
        lines=[x for x in old.stdout.splitlines() if not x.endswith(MARKER)]
        current=subprocess.run(['crontab','-l'],capture_output=True,text=True)
        if current.stdout!=old.stdout:raise RuntimeError('Crontab changed; refusing to overwrite it')
        subprocess.run(['crontab','-'],input='\n'.join(lines+[line])+'\n',text=True,check=True)
        print(json.dumps({'status':'owner-reboot-autostart-installed','root':str(root)}))
    else:
        print(json.dumps({'managerPid':pid,'releaseId':c['releaseId'],
            'api':probe(c['apiPort'],'/readyz'),'organizations':probe(c['organizationPort'],'/readyz')}))


if __name__=='__main__':
    os.umask(0o077)
    main()
