import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { observerSettingsRpc } from '../shared/settings';
import { createFileClassifier, filterChangedFiles, type NoteFilter, type PathFilter, type TestFileDisplay, type TestFileRules } from '../shared/change-file-filter';
import { noteFilterMatches } from './change-notes-model';
import { useChangeNotes, noteCurrent, type NoteScope } from './use-change-notes';
import { changeFileFilters, fileFilterContext } from './change-file-filter-store';
import type { FileChange } from './model';
const EMPTY_FILES: FileChange[] = [];

export function useChangeFileFilter(scope: NoteScope | undefined, inputFiles: FileChange[] = EMPTY_FILES, enabled = true) {
  const projectKey = scope?.projectConfig || '', contextKey = fileFilterContext(scope);
  const read = useRpc(observerSettingsRpc.read), write = useRpc(observerSettingsRpc.write);
  const io = useMemo(() => ({ read: () => read({}), write }), [read, write]);
  const preference = useSyncExternalStore(changeFileFilters.subscribe, () => changeFileFilters.project(projectKey));
  const session = useSyncExternalStore(changeFileFilters.subscribe, () => changeFileFilters.session(contextKey));
  useEffect(() => { void changeFileFilters.load(io); }, [io]);
  const explanations = useChangeNotes(scope, enabled);
  const byPath = useMemo(() => {
    const map = new Map<string, import('../shared/change-notes').ChangeNote[]>();
    for (const note of explanations.data?.notes || []) for (const path of new Set(note.content.anchors.map(a => a.path))) {
      const list = map.get(path) || []; list.push(note); map.set(path, list);
    }
    return map;
  }, [explanations.data]);
  const valid = (note: import('../shared/change-notes').ChangeNote) => !!scope && !!explanations.data && noteCurrent(note, explanations.data, scope);
  const classify = useMemo(() => {
    const resolve=createFileClassifier(preference.rules),cache=new Map<string,ReturnType<typeof resolve>>();
    return (path:string)=>{let value=cache.get(path);if(!value){value=resolve(path);cache.set(path,value);}return value;};
  }, [preference.rules]);
  const model = useMemo(() => filterChangedFiles(inputFiles, session.applied, preference.display, classify, path => {
    return noteFilterMatches(session.noteFilter,byPath.get(path)||[],explanations.data,scope);
  }), [inputFiles, session, preference.display, classify, byPath, explanations.data, scope?.scope, scope?.commitSha, scope?.baseSha, scope?.head, scope?.comparison]);
  return {
    ...model, preference, session, contextKey, explanations, byPath, valid,
    active: !!session.include || !!session.exclude || session.noteFilter !== 'all' || preference.display !== 'all',
    update: (patch: Partial<PathFilter & { noteFilter: NoteFilter }>) => changeFileFilters.updateSession(contextKey, patch),
    setDisplay: (display: TestFileDisplay) => { void changeFileFilters.updateProject(projectKey, { display }, io); },
    setRules: (rules: TestFileRules) => { void changeFileFilters.updateProject(projectKey, { rules }, io); },
    retrySave: () => { void changeFileFilters.retry(projectKey, io); },
    reset: (display: TestFileDisplay = 'dim') => { changeFileFilters.resetSession(contextKey); void changeFileFilters.updateProject(projectKey, { display }, io); },
  };
}
export type ChangeFileFilter = ReturnType<typeof useChangeFileFilter>;
