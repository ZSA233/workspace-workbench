import {createContext,type RefObject} from 'react';
/** The entire owning panel, rather than the shorter changed-files section. */
export const FileFilterBoundsContext=createContext<RefObject<any>|undefined>(undefined);
