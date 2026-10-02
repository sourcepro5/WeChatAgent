"""Real Windows HTTP/auth/handle tests; no WeChat process or message send."""
import json
import pathlib
import subprocess
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
directory = root / 'state' / 'hook' / 'probe'
fixture = directory / 'wxid_fixture_account' / 'db_storage' / 'contact' / 'contact.db'
fixture.parent.mkdir(parents=True, exist_ok=True)
fixture.write_bytes(b'fixture only, not a real database')
(directory / 'wechatagent-hook.token').write_text('a' * 64)
process = subprocess.Popen([str(directory / 'probe.exe'), str(fixture)], cwd=directory,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    port = int(process.stdout.readline().strip())
    def request(route, token=True, data=None, account=None):
        headers = {'Authorization': 'Bearer ' + 'a' * 64} if token else {}
        if account:
            headers['X-WeChatAgent-Account'] = account
        req = urllib.request.Request(f'http://127.0.0.1:{port}{route}',
            data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)
    assert request('/WeChatAgent/health', token=False)[0] == 401
    assert request('/SendTextMsg', token=False, data={'msg': 'fixture'})[0] == 401
    status, health = request('/WeChatAgent/health')
    assert status == 200 and health['integration'] == 'WeChatAgent-1'
    assert health['databaseAccounts'] == ['wxid_fixture_account'], 'Process handle account detection failed'
    assert request('/QueryDB/execute', data={})[0] == 404
    assert request('/SendTextMsg', data={'wxidorgid': 'wxid_fixture', 'msg': 'fixture'}, account='wxid_fixture_account')[0] == 409
    assert process.poll() is None, 'Native sending must not run in a mismatched process'
    print('Native HTTP checks passed: token required, current-process account detection, limited routes, version gate.')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
