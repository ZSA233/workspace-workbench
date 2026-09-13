import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_workbench import make_repository, write_config, run_git
from workspace_workbench.core.config import load_config
from workspace_workbench.core.service import ObserverService
from workspace_workbench.core.git import GitClient
from workspace_workbench.core.errors import GitCommandError, WorkbenchError


class RepositoryAdditionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['one', 'two', 'three']:
            make_repository(self.root, name)
        config = self.root / 'project.json'
        write_config(config, self.root, [{'id': name, 'path': name} for name in ['one', 'two', 'three']])
        value = json.loads(config.read_text())
        value['management'] = {'enabled': True}
        config.write_text(json.dumps(value))
        self.service = ObserverService(load_config(config))
        self.addCleanup(self.service.close)
        self.original = self.service.handle('workspace.create', {'name': 'sample', 'repositories': ['one']})

    def add(self, *names):
        return self.service.handle('workspace.addRepositories', {'workspaceId': 'sample', 'repositories': list(names), 'baseRefs': {name: 'HEAD' for name in names}})

    def test_real_git_idempotency_manifest_and_runtime(self):
        record = self.add('two')
        retry = self.add('two')
        self.assertEqual(len(retry['repositories']), 2)
        self.assertEqual(record['id'], self.original['id'])
        self.assertEqual(record['createdAt'], self.original['createdAt'])
        self.assertEqual(record['repositories'][0], self.original['repositories'][0])
        manifest = json.loads((Path(record['treePath']) / '.workspace/manifest.json').read_text())
        self.assertEqual(manifest['repositories'], record['repositories'])
        runtime = self.service.handle('workspace.runtime', {'workspaceId': 'sample'})
        self.assertEqual(len(runtime['repositories']), 2)
        self.assertEqual(run_git(self.root / 'two', 'rev-parse', 'HEAD'), record['repositories'][1]['baseSha'])
        with self.assertRaises(WorkbenchError):
            self.service.handle('workspace.addRepositories', {'workspaceId': 'sample', 'repositories': ['two'], 'baseRefs': {'two': 'other'}})

    def test_partial_failure_retry_preserves_completed_repository(self):
        original_run = GitClient.run
        def fail(git, args, **kwargs):
            if args[:2] == ['worktree', 'add'] and git.repository.name == 'three':
                raise GitCommandError('injected failure')
            return original_run(git, args, **kwargs)
        with patch.object(GitClient, 'run', fail), self.assertRaises(GitCommandError):
            self.add('two', 'three')
        record = self.service.provider.get('sample')
        self.assertEqual([r['id'] for r in record['repositories']], ['one', 'two'])
        with self.assertRaises(WorkbenchError) as error:
            self.service.handle('workspace.runtime', {'workspaceId': 'sample'})
        self.assertEqual(error.exception.code, 'repository_addition_pending')
        self.assertEqual(len(self.add('two', 'three')['repositories']), 3)

    def test_timeout_after_git_completion_is_reconciled(self):
        original_run = GitClient.run
        def timeout(git, args, **kwargs):
            result = original_run(git, args, **kwargs)
            if args[:2] == ['worktree', 'add']:
                raise GitCommandError('injected timeout', code='git_timeout')
            return result
        with patch.object(GitClient, 'run', timeout):
            self.assertEqual(len(self.add('two')['repositories']), 2)

    def test_active_and_unknown_task_state_block_additions(self):
        path = self.service.config.state_root / 'agent-bindings.json'
        for status in ['running', 'initializing', None]:
            path.write_text(json.dumps({'bindings': [{'workspaceId': 'sample', 'status': status}]}))
            with self.assertRaises(WorkbenchError) as error:
                self.add('two')
            self.assertEqual(error.exception.code, 'workspace_task_active')
        path.write_text('{')
        with self.assertRaises(WorkbenchError) as error:
            self.add('two')
        self.assertEqual(error.exception.code, 'workspace_task_status_unavailable')

    def test_preexisting_user_branch_is_preserved(self):
        run_git(self.root / 'two', 'branch', 'obs/sample/two')
        with self.assertRaises(WorkbenchError):
            self.add('two')
        self.assertTrue(run_git(self.root / 'two', 'rev-parse', 'obs/sample/two'))
        self.assertEqual(len(self.service.provider.get('sample')['repositories']), 1)
