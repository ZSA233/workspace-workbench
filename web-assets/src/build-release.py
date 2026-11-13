#!/usr/bin/env python3
"""Build a repository-reviewed recipe from one resolved upstream commit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
def sha(raw): return hashlib.sha256(raw).hexdigest()
def safe(value):
    path = Path(value)
    return value and not path.is_absolute() and '..' not in path.parts and str(path) == value

def package(dist, output, lock, recipe, recipe_dir, source_sha):
    output.mkdir(parents=True, exist_ok=False)
    web = output / 'web'
    if dist.is_symlink() or any(p.is_symlink() or not (p.is_file() or p.is_dir()) for p in dist.rglob('*')): raise ValueError('Unsafe built resource')
    shutil.copytree(dist, web, symlinks=False)
    source = dist.parents[len(Path(recipe['dist']).parts)-1]
    for original,destination in recipe.get('licenses',{}).items():
        if not safe(original) or not safe(destination): raise ValueError('Unsafe license path')
        shutil.copy2(source / original, web / destination)
    (web / 'NOTICE-Workbench').write_text(recipe['notice']+'\n')
    files = {str(p.relative_to(web)): sha(p.read_bytes()) for p in sorted(web.rglob('*')) if p.is_file()}
    if 'index.html' not in files: raise ValueError('Missing web entry')
    archive = output / f"{recipe['id']}-web-{lock['version']}.tar.gz"
    with tarfile.open(archive, 'w:gz') as tar:
        for p in sorted(web.rglob('*')):
            if p.is_symlink() or (not p.is_file() and not p.is_dir()): raise ValueError('Unsafe built resource')
            tar.add(p, arcname=str(p.relative_to(web)), recursive=False)
    descriptor = dict(schema=1, version=lock['version'], archive=dict(name=archive.name, sha256=sha(archive.read_bytes()), format='tar.gz', root=''),
        source_commit=lock['source_commit'], source_sha256=source_sha, builder_commit=lock.get('builder_commit'),
        recipe_version=recipe['recipe_version'], compatible_runtimes=recipe['compatible_runtimes'], capabilities=recipe.get('capabilities', []), files=files,
        recipe_files={str(p.relative_to(recipe_dir)): sha(p.read_bytes()) for p in sorted(recipe_dir.rglob('*')) if p.is_file()})
    (output / 'frontend-release.json').write_text(json.dumps(descriptor, sort_keys=True, indent=2)+'\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{sha(p.read_bytes())}  {p.name}\n' for p in [archive, output / 'frontend-release.json']))
    shutil.rmtree(web)
    return descriptor

def build(lock_path, work, output):
    lock=json.loads(lock_path.read_text())
    if not re.fullmatch(r'[a-z0-9-]+',lock['recipe']): raise ValueError('Invalid recipe identifier')
    recipe_dir=ROOT/'web-assets/recipes'/lock['recipe'];recipe=json.loads((recipe_dir/'recipe.json').read_text())
    inventory={str(p.relative_to(recipe_dir)):sha(p.read_bytes()) for p in sorted(recipe_dir.rglob('*')) if p.is_file()}
    if inventory!=lock['recipe_files']: raise ValueError('Resolved recipe changed')
    if not re.fullmatch(r'[0-9a-f]{40}',lock['source_commit']) or lock['version']!=lock['upstream_version']+'-'+recipe['recipe_version']: raise ValueError('Invalid build lock')
    expected=f"https://codeload.github.com/{recipe['repository']}/tar.gz/{lock['source_commit']}"
    if lock['source_url']!=expected or not re.fullmatch(recipe['version_pattern'],lock['upstream_version']): raise ValueError('Untrusted source')
    work.mkdir(parents=True,exist_ok=False); archive=work/'source.tar.gz'
    with urllib.request.urlopen(expected,timeout=180) as response, archive.open('xb') as out: shutil.copyfileobj(response,out)
    source_sha=sha(archive.read_bytes())
    with tarfile.open(archive) as tar:
        members=tar.getmembers(); roots={m.name.split('/')[0] for m in members}
        if len(roots)!=1 or any(not safe(m.name.rstrip('/')) or not (m.isfile() or m.isdir()) for m in members): raise ValueError('Unsafe source archive')
        tar.extractall(work,filter='data')
    source=work/roots.pop()
    for name in recipe['patches']:
        if not safe(name): raise ValueError('Unsafe patch path')
        subprocess.run(['patch','-p1','--batch','--forward'],cwd=source,input=(recipe_dir/name).read_bytes(),check=True)
    for name,dest in recipe['copies'].items():
        if not safe(name) or not safe(dest): raise ValueError('Unsafe adapter path')
        shutil.copy2(recipe_dir/name,source/dest)
    env={k:v for k,v in os.environ.items() if not k.startswith(('EXPO_PUBLIC_','GH_','GITHUB_','ANDROID_'))}
    env.update(ELECTRON_SKIP_BINARY_DOWNLOAD='1',EXPO_NO_TELEMETRY='1',CI='1',NODE_OPTIONS='--max-old-space-size=4096')
    for command in recipe['commands']:
        if not isinstance(command,list) or not all(isinstance(s,str) for s in command): raise ValueError('Invalid recipe command')
        subprocess.run(command,cwd=source,env=env,check=True,timeout=1200)
    return package(source/recipe['dist'],output,lock,recipe,recipe_dir,source_sha)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--lock',type=Path,required=True);p.add_argument('--work',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();build(a.lock.resolve(),a.work.resolve(),a.output.resolve())
