#!/usr/bin/env python3
"""Verify that AAPT retained every locked web asset, with exact bytes."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

with zipfile.ZipFile(sys.argv[1]) as apk:
    manifest = json.loads(apk.read('assets/paseo/_workbench.json'))
    for item in manifest['files']:
        content = apk.read('assets/paseo/' + item['path'])
        assert len(content) == item['size'], item['path']
        assert hashlib.sha256(content).hexdigest() == item['sha256'], item['path']
    assert apk.read('assets/legal/Paseo-0.12.0.txt')
    save_bridge = Path(__file__).resolve().parents[1] / 'app/src/main/assets/pocket-file-save.js'
    if save_bridge.exists():
        assert apk.read('assets/pocket-file-save.js') == save_bridge.read_bytes(), 'File-save bridge must be included unchanged'
        assert any(b'FileSaveBridge' in apk.read(name) for name in apk.namelist() if name.endswith('.dex')), 'Native file-save bridge is missing'
    print(f"Verified {len(manifest['files'])} APK web assets for Paseo {manifest['metadata']['version']}")
