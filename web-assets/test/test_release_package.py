import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('web_builder',Path(__file__).resolve().parents[1]/'src/build-release.py')
builder=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(builder)
class PackageTests(unittest.TestCase):
    def test_another_recipe_produces_a_standard_archive_and_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';dist=source/'dist';dist.mkdir(parents=True)
            (dist/'index.html').write_text('<script src="/app.123.js"></script>');(dist/'app.123.js').write_text('static fixture')
            (source/'COPYING').write_text('fixture license');recipe_dir=root/'recipe';recipe_dir.mkdir();(recipe_dir/'recipe.json').write_text('{}')
            recipe=dict(id='generic-site',dist='dist',recipe_version='wb.1',compatible_runtimes={},licenses={'COPYING':'LICENSE'},notice='fixture')
            lock=dict(version='1.0.0-wb.1',source_commit='a'*40)
            descriptor=builder.package(dist,root/'output',lock,recipe,recipe_dir,'b'*64)
            archive=root/'output'/descriptor['archive']['name']
            self.assertEqual(archive.name,'generic-site-web-1.0.0-wb.1.tar.gz')
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),descriptor['archive']['sha256'])
            with tarfile.open(archive) as tar:self.assertEqual(set(tar.getnames()),set(descriptor['files']))
            self.assertEqual(descriptor,json.loads((root/'output/frontend-release.json').read_text()))
    def test_unsafe_recipe_paths_are_rejected(self):
        for name in ('/absolute','../escape','a/../b'):self.assertFalse(builder.safe(name))

if __name__=='__main__':unittest.main()
