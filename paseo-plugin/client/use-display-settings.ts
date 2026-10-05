import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { observerSettings, observerSettingsRpc } from '../shared/settings';
/** Revision-aware settings merge. Saves only the user's changed fields. */
export function useDisplaySettings() {
  const read = useRpc(observerSettingsRpc.read), write = useRpc(observerSettingsRpc.write);
  const [values, setValues] = useState({fontSize: 14, wrap: false, production: {} as Record<string,string>});
  const [ready,setReady]=useState(false);
  const pending = useRef<Record<string, unknown>>({});
  const queue = useRef(Promise.resolve());
  useEffect(() => {let live = true; void read({}).then(result => {
    if (!live || result.status !== 'ready') return;
    const parsed = observerSettings.schema.safeParse(result.values);
    if (parsed.success) setValues(current => ({...current, ...parsed.data.diffDisplay, production: parsed.data.productionBranches, ...pending.current}));
  }).catch(() => {}).finally(()=>{if(live)setReady(true);}); return () => {live = false;};}, [read]);
  function update(patch: Partial<typeof values>) {
    Object.assign(pending.current, patch); setValues(current => ({...current, ...patch}));
    queue.current = queue.current.then(async () => {
      for (let attempt=0; attempt<3; attempt++) {
        const current = await read({}); if(current.status !== 'ready') return;
        const parsed = observerSettings.schema.safeParse(current.values); if(!parsed.success) return;
        const result = await write({revision: current.revision, values: {...parsed.data,
          diffDisplay: {...parsed.data.diffDisplay, ...(patch.fontSize ? {fontSize:patch.fontSize}:{}), ...(patch.wrap !== undefined ? {wrap:patch.wrap}:{})},
          productionBranches: {...parsed.data.productionBranches, ...patch.production}}});
        if (result.status === 'saved') return;
      }
    }).catch(() => {});
  }
  return { ...values, update, ready };
}
