import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import io

SPEC=importlib.util.spec_from_file_location('web_builder',Path(__file__).resolve().parents[1]/'src/build-release.py')
builder=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(builder)
class PackageTests(unittest.TestCase):
    def test_new_stable_versions_keep_source_and_lock_validation(self):
        recipe=dict(repository='getpaseo/paseo',recipe_version='wb.3')
        source='https://codeload.github.com/getpaseo/paseo/tar.gz/'+'a'*40
        for version in ('0.16.1','0.17.0','1.0.0','2.4.0'):
            with self.subTest(version=version):
                lock=dict(upstream_version=version,version=version+'-wb.3',source_commit='a'*40,source_url=source)
                self.assertEqual(builder.source_url(lock,recipe),source)
                for changes in ({'source_url':'https://other.invalid/source'},{'source_commit':'main'},{'version':'0.15.4-wb.3'}):
                    with self.assertRaises(ValueError):builder.source_url({**lock,**changes},recipe)
        for version in ('0.16.1-beta','v0.16.1','0.16.1\n','0.16.01','../0.16.1'):
            with self.assertRaises(ValueError):builder.source_url(dict(upstream_version=version),recipe)
    def test_source_internal_links_are_supported_but_cannot_escape(self):
        for target,allowed in [('README',True),('../../outside',False)]:
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);archive=root/'source.tar.gz'
                with tarfile.open(archive,'w:gz') as tar:
                    body=b'source';entry=tarfile.TarInfo('project/README');entry.size=len(body);tar.addfile(entry,io.BytesIO(body))
                    link=tarfile.TarInfo('project/DOC');link.type=tarfile.SYMTYPE;link.linkname=target;tar.addfile(link)
                if allowed:
                    source=builder.extract_source(archive,root/'work');self.assertEqual((source/'DOC').read_bytes(),b'source')
                else:
                    with self.assertRaises(tarfile.FilterError):builder.extract_source(archive,root/'work')
    def test_another_recipe_produces_a_standard_archive_and_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';dist=source/'dist';dist.mkdir(parents=True)
            (dist/'index.html').write_text('<script src="/app.123.js"></script>');(dist/'app.123.js').write_text('static fixture')
            (source/'COPYING').write_text('fixture license');recipe_dir=root/'recipe';recipe_dir.mkdir();(recipe_dir/'recipe.json').write_text('{}')
            recipe=dict(id='generic-site',dist='dist',recipe_version='wb.1',compatible_runtimes={'example-runtime':['${upstream_version}'],'fixed-runtime':['0.15.4']},licenses={'COPYING':'LICENSE'},notice='fixture')
            lock=dict(version='1.0.0-wb.1',upstream_version='1.0.0',source_commit='a'*40)
            descriptor=builder.package(dist,root/'output',lock,recipe,recipe_dir,'b'*64)
            archive=root/'output'/descriptor['archive']['name']
            self.assertEqual(archive.name,'generic-site-web-1.0.0-wb.1.tar.gz')
            self.assertEqual(descriptor['compatible_runtimes'],{'example-runtime':['1.0.0'],'fixed-runtime':['0.15.4']})
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),descriptor['archive']['sha256'])
            with tarfile.open(archive) as tar:self.assertEqual(set(tar.getnames()),set(descriptor['files']))
            self.assertEqual(descriptor,json.loads((root/'output/frontend-release.json').read_text()))
    def test_unsafe_recipe_paths_are_rejected(self):
        for name in ('/absolute','../escape','a/../b'):self.assertFalse(builder.safe(name))

if __name__=='__main__':unittest.main()
