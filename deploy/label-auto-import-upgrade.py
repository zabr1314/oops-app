#!/usr/bin/env python3
"""Install the zero-model new-meeting review bridge without restarting the main backend."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CODE=Path('/opt/oops/label')
DATA=Path('/var/lib/oops-label')
BACKEND=Path('/var/lib/oops/backend')
FILES=('team_label.py','team_label_ui.html','label_items.py','label_item_identity.py',
       'label_shared_identity.py','label_minutes_import.py','label_auto_import.py')
UNITS=('oops-label-import.service','oops-label-import.timer')
NEW_STATE={'auto-import-policy.json','auto-import-state.json','.auto-import.lock'}


def run(*args):
    return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def protected():
    return {str(p.relative_to(DATA)):sha(p) for p in DATA.rglob('*') if p.is_file()
        and (p.suffix in ('.json','.env') or p.name=='open-access') and p.name not in NEW_STATE}


def get(path,name='林春源'):
    request=urllib.request.Request('http://127.0.0.1:8798'+path,
        headers={'X-Labeler':urllib.parse.quote(name)})
    with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)


def main(stage):
    stage=Path(stage).resolve()
    if os.geteuid()!=0 or not BACKEND.is_dir():raise ValueError('existing_server_required')
    if any((DATA/name).exists() for name in NEW_STATE) or any((Path('/etc/systemd/system')/u).exists() for u in UNITS):
        raise ValueError('existing_bridge_requires_explicit_update')
    for filename in FILES:
        if filename.endswith('.py'):compile((stage/filename).read_bytes(),filename,'exec')
    run('systemd-analyze','verify',*(str(stage/u) for u in UNITS))
    account=pwd.getpwnam('oops')
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=Path('/var/backups/oops-label')/('auto-import-'+stamp)
    backup.mkdir(mode=0o700)
    previous={}
    original_meetings={p.name for p in (DATA/'meetings').iterdir() if p.is_dir()}
    for name in FILES:
        source=CODE/name
        previous[name]=dict(existed=source.exists(),uid=source.stat().st_uid if source.exists() else 0,
            gid=source.stat().st_gid if source.exists() else account.pw_gid,
            mode=source.stat().st_mode & 0o777 if source.exists() else 0o640)
        if source.exists():
            (backup/'code').mkdir(exist_ok=True)
            shutil.copy2(source,backup/'code'/name)
    try:
        run('systemctl','stop','oops-label')
        before=protected()
        for relative in before:
            target=backup/'data'/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(DATA/relative,target)
        (backup/'protected-before.json').write_text(json.dumps(before,indent=2))
        for name in FILES:
            target=CODE/name
            temporary=CODE/('.auto-import-new-'+name)
            shutil.copyfile(stage/name,temporary)
            os.chmod(temporary,previous[name]['mode'])
            os.chown(temporary,previous[name]['uid'],previous[name]['gid'])
            os.replace(temporary,target)
        policy=dict(schema=1,enabled=True,authorization='new_project_cloud_meetings_to_review_site',
            authorized_by='explicit_project_user_request',reuse_existing_minutes_only=True,
            destination_url='https://giftedprofessor.xyz/oops-meeting/label/',
            backend_dir=str(BACKEND),label_dir=str(DATA),
            enabled_after=dt.datetime.now(dt.timezone.utc).isoformat(),
            baseline_sessions=sorted(p.stem for p in (BACKEND/'meetings').glob('*.json')))
        path=DATA/'auto-import-policy.json'
        path.write_text(json.dumps(policy,ensure_ascii=False,indent=2))
        os.chmod(path,0o600);os.chown(path,account.pw_uid,account.pw_gid)
        for unit in UNITS:
            target=Path('/etc/systemd/system')/unit
            shutil.copyfile(stage/unit,target);os.chmod(target,0o644)
        run('systemctl','daemon-reload')
        run('systemctl','start','oops-label')
        for attempt in range(40):
            try:
                identities=get('/api/identity');break
            except (OSError,ValueError):
                if attempt==39:raise
                time.sleep(0.2)
        if sum(g['current'] for g in identities['groups'])!=5:raise ValueError('existing_names_changed')
        worker=json.loads(run('runuser','-u','oops','--','/usr/bin/python3','-B',str(CODE/'label_auto_import.py'),
            '--backend',str(BACKEND),'--data',str(DATA),'--policy',str(path)))
        if worker['model_calls']!=0:raise ValueError('bridge_must_not_call_model')
        catalog=get('/api/me')
        if len(catalog['meetings'])!=3:raise ValueError('unexpected_historical_import')
        checks={}
        for person in ('林春源','洪玉麟','江古月','黄丽萍'):
            identity=get('/api/identity',person)
            if not identity.get('shared') or sum(g['current'] for g in identity['groups'])!=5:
                raise ValueError('team_names_smoke_failed')
            checks[person]={}
            for mid in ('0235','0236','0238'):
                result=get('/api/meeting/'+mid+'/items',person)
                if result['status']!='ready':raise ValueError('legacy_items_changed')
                checks[person][mid]=dict(items=len(result['items']),revision=result['revision'],counts=result['counts'])
        if protected()!=before:raise ValueError('existing_private_files_changed')
        run('systemctl','enable','--now','oops-label-import.timer')
        run('systemctl','start','oops-label-import.service')
        if run('systemctl','is-active','oops-label-import.timer')!='active':raise ValueError('timer_not_active')
        if run('systemctl','show','oops-label-import.service','-p','Result','--value')!='success':
            raise ValueError('worker_service_failed')
        result=dict(status='deployed',backup=str(backup),enabled_after=policy['enabled_after'],
            excluded_existing_sessions=len(policy['baseline_sessions']),new_model_calls=0,
            protected_files=len(before),protected_unchanged=protected()==before,
            worker=worker,timer_active=True,checks=checks,source_sha256={n:sha(CODE/n) for n in FILES})
        if not result['protected_unchanged']:raise ValueError('private_state_changed_after_timer')
        (backup/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        os.chmod(backup/'result.json',0o600)
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except Exception:
        subprocess.run(['systemctl','disable','--now','oops-label-import.timer'],capture_output=True)
        subprocess.run(['systemctl','stop','oops-label-import.service'],capture_output=True)
        run('systemctl','stop','oops-label')
        try:
            # A meeting might finish during installation. Its original backend
            # stays untouched; archive only this attempt's generated mirrors on
            # rollback so an old label process cannot retain them without TTL.
            for folder in (DATA/'meetings').iterdir():
                if not folder.is_dir() or folder.name in original_meetings:continue
                marker=folder/'meeting.json'
                try:meeting=json.loads(marker.read_text())
                except (OSError,ValueError):continue
                if not meeting.get('imported') or not meeting.get('source_managed') \
                        or meeting.get('source_backend')!=str(BACKEND):continue
                for asset in folder.iterdir():
                    if asset.is_file() and (asset.name=='meeting.json'
                            or re.fullmatch(r'(?:audio-[a-f0-9]{64}\.wav|items-[a-f0-9]{64}\.json)',asset.name)):
                        archived=backup/'rollback-imports'/folder.name/asset.name
                        archived.parent.mkdir(parents=True,exist_ok=True)
                        shutil.copy2(asset,archived);asset.unlink()
            for name,old in previous.items():
                target=CODE/name
                if old['existed']:
                    shutil.copy2(backup/'code'/name,target);os.chown(target,old['uid'],old['gid'])
                elif target.exists():target.unlink()
            for unit in UNITS:
                path=Path('/etc/systemd/system')/unit
                if path.exists():path.unlink()
            for name in NEW_STATE:
                path=DATA/name
                if path.exists():
                    shutil.copy2(path,backup/('failed-'+name.lstrip('.')));path.unlink()
            run('systemctl','daemon-reload')
        finally:run('systemctl','start','oops-label')
        raise


if __name__=='__main__':main(sys.argv[1])
