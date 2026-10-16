#!/usr/bin/env python3
"""Provision a device-scoped Anker SDK licence without putting app_key in the APK.

Run on a trusted developer computer. Credentials come from ANKER_APP_ID / ANKER_APP_KEY
or an explicitly selected private toolkit markdown file. Never prints token or licence.
"""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid


def credentials(path=None):
    result = {k: os.environ.get('ANKER_' + k.upper(), '') for k in ('app_id', 'app_key')}
    if path:
        for line in Path(path).read_text().splitlines():
            cells = [s.strip().strip('`') for s in line.split('|')[1:-1]]
            if len(cells) >= 2 and cells[0] in result and not result[cells[0]]:
                result[cells[0]] = cells[1]
    if not all(result.values()):
        raise ValueError('需要 ANKER_APP_ID / ANKER_APP_KEY，或 --credentials-file 私有资料包')
    return result


def exchange(creds, identity, production=False, opener=urllib.request.urlopen):
    host = 'speaker-api' if production else 'speaker-api-ci'
    request = urllib.request.Request(
        f'https://{host}.anker-in.com/v1/third_party_sdk/get_token',
        data=json.dumps({**creds, **identity, 'timestamp': int(time.time() * 1000)}).encode(),
        headers={'Content-Type': 'application/json', 'X-Product-Code': 'D3200',
                 'X-Soundcore-SDK-Version': 'V1.3.02'}, method='POST')
    try:
        with opener(request, timeout=20) as response:
            value = json.load(response)
    except (urllib.error.URLError, ValueError):
        raise ValueError('安克授权服务连接或响应失败，旧配置未修改') from None
    if value.get('code') != 1 or not isinstance(value.get('data'), dict):
        # Vendor messages can echo request values; do not print them or response bodies.
        raise ValueError(f'安克拒绝授权（代码 {value.get("code")}），旧配置未修改')
    data = value['data']
    licence = data.get('license')
    if not isinstance(licence, dict) or any(licence.get(k) != v for k, v in identity.items()):
        raise ValueError('安克返回的授权身份与本次设备不一致')
    if licence.get('app_id') != creds['app_id'] or not data.get('token') or not data.get('license_signature'):
        raise ValueError('安克授权凭证不完整或业务不一致')
    if min(int(data.get('token_expire_time', 0)), int(licence.get('license_expire_time', 0))) <= time.time() + 60:
        raise ValueError('安克返回的授权已过期或即将到期')
    return data


def write_properties(path, identity, data, production):
    path = Path(path)
    values = {'BEAN_USER_ID': identity['user_id'], 'BEAN_DEVICE_ID': identity['device_id'],
              'BEAN_TOKEN': data['token'],
              'BEAN_LICENSE_JSON': json.dumps(data['license'], ensure_ascii=True, separators=(',', ':')),
              'BEAN_LICENSE_SIGNATURE': data['license_signature'],
              'BEAN_PRODUCTION': str(production).lower()}
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [line for line in lines if line.split('=', 1)[0].strip() not in values]
    lines += [k + '=' + v.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r') for k, v in values.items()]
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.bean-tmp')
    try:
        with open(temp, 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
            file.write('\n'.join(lines) + '\n')
        os.chmod(temp, 0o600)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials-file', type=Path)
    parser.add_argument('--identity', type=Path, default=Path('build/bean-private/installation.json'))
    parser.add_argument('--output', type=Path, default=Path('android/local.properties'))
    parser.add_argument('--production', action='store_true')
    args = parser.parse_args()
    try:
        if args.identity.exists():
            identity = json.loads(args.identity.read_text())
        else:
            identity = {'user_id': 'oops-' + uuid.uuid4().hex, 'device_id': str(uuid.uuid4())}
            args.identity.parent.mkdir(parents=True, exist_ok=True)
            with open(args.identity, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
                json.dump(identity, file)
        if set(identity) != {'user_id', 'device_id'} or not all(isinstance(v, str) and v for v in identity.values()):
            raise ValueError('设备身份文件无效')
        data = exchange(credentials(args.credentials_file), identity, args.production)
        write_properties(args.output, identity, data, args.production)
        print('录音豆授权已更新；app_key 未写入安装包配置。')
        print('token 到期：', time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(data['token_expire_time'])))
        print('license 到期：', time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(data['license']['license_expire_time'])))
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
