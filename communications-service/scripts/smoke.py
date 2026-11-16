#!/usr/bin/env python3
"""Verify release artifacts only; Python is not a service runtime dependency."""
import argparse, hashlib, json, os, pathlib, platform, shutil, socket, subprocess, sys, tarfile, tempfile, time, urllib.error, urllib.request

def verify(archive):
    archive = pathlib.Path(archive).resolve()
    with tempfile.TemporaryDirectory(prefix='communications-release-smoke-') as directory:
        root = pathlib.Path(directory)
        with tarfile.open(archive) as bundle:
            names = bundle.getnames()
            assert 'project-communications' in names and 'README.md' in names
            assert not any('/node_modules/' in n or n.endswith(('.ts', '.py')) for n in names)
            for member in bundle.getmembers():
                assert not pathlib.PurePosixPath(member.name).is_absolute() and '..' not in pathlib.PurePosixPath(member.name).parts
                assert not member.issym() and not member.islnk()
            bundle.extractall(root)
        target = ('darwin' if sys.platform == 'darwin' else 'linux') + '-' + ('arm64' if platform.machine() in ('arm64', 'aarch64') else 'amd64')
        if not archive.name.endswith('-' + target + '.tar.gz'):
            return {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'execution': 'cross-build-only'}
        executable = root / 'project-communications'
        env = dict(os.environ, PATH=str(root / 'empty-path'))
        (root / 'empty-path').mkdir()
        fixture = pathlib.Path(__file__).resolve().parent.parent / 'testdata/node-v1/home'
        home = root / 'data'
        shutil.copytree(fixture, home)
        for file in home.rglob('*'):
            file.chmod(0o700 if file.is_dir() else 0o600)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        command = [str(executable), 'serve', '--home', str(home), '--port', str(port)]
        token = (home / 'api-token').read_text().strip()
        base = 'http://127.0.0.1:' + str(port)
        def request(path, data=None, method=None):
            encoded = None if data is None else json.dumps(data).encode()
            req = urllib.request.Request(base + path, data=encoded, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)
        def start():
            child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            end = time.monotonic() + 10
            while time.monotonic() < end:
                if child.poll() is not None: raise RuntimeError(child.stderr.read())
                try:
                    assert request('/health')['version'] == '0.2.0'; return child
                except (OSError, urllib.error.URLError): time.sleep(.02)
            child.kill(); child.wait(); raise TimeoutError('service did not start')
        child = start()
        rss = None
        try:
            version = subprocess.check_output([str(executable), 'version'], env=env, text=True)
            assert json.loads(version)['apiVersion'] == 1
            action = lambda value: request('/v1/projects/legacy-project/actions', value)['result']
            before = action({'action': 'snapshot'})
            assert before['messageCount'] == 2 and before['credentials']['modelKey']
            assert before['background'] == 'paused'
            assert any(task['id'] == 'interrupted-task' and task['state'] == 'cancelled' for task in before['tasks'])
            assert action({'action': 'delivery.status', 'id': 'interrupted-delivery'})['state'] == 'uncertain'
            request('/v1/projects/smoke', {'name': 'independent archive'}, 'PUT')
            action({'action': 'configure', 'revision': before['revision'], 'config': {'model': {'contextTokens': 524288}}})
            status = subprocess.check_output([str(executable), 'status', '--home', str(home), '--port', str(port)], env=env, text=True)
            assert json.loads(status)['state'] == 'running'
            try: rss = int(subprocess.check_output(['/bin/ps', '-o', 'rss=', '-p', str(child.pid)], text=True).strip())
            except (OSError, ValueError): pass
            subprocess.run([str(executable), 'stop', '--home', str(home), '--port', str(port)], env=env, check=True, capture_output=True)
            child.wait(timeout=10); assert child.returncode == 0
            recovery = time.monotonic(); child = start()
            after = action({'action': 'snapshot'})
            assert after['revision'] == before['revision'] + 1 and after['config']['model']['contextTokens'] == 524288
            assert after['messageCount'] == 2 and action({'action': 'delivery.status', 'id': 'interrupted-delivery'})['state'] == 'uncertain'
            recovery_ms = (time.monotonic() - recovery) * 1000
            child.terminate(); child.wait(timeout=10); assert child.returncode == 0
            return {'archive': archive.name, 'execution': 'native-passed', 'nodePythonWorkbenchOnPATH': False, 'rssKiB': rss, 'restartAndSnapshotMs': round(recovery_ms, 2)}
        finally:
            if child.poll() is None: child.kill(); child.wait()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('archives', nargs='+'); args = parser.parse_args()
    print(json.dumps([verify(archive) for archive in args.archives], indent=2))
