import {createContext,useContext,type ReactNode} from 'react';
export type TextThemeColors={surface0:string;surface1:string;foreground:string;foregroundMuted:string};
export const fallbackTextTheme:TextThemeColors={surface0:'#202124',surface1:'#202124',foreground:'#f1f3f4',foregroundMuted:'#b4bac2'};
export const WorkbenchThemeContext=createContext<TextThemeColors>(fallbackTextTheme);
export function WorkbenchThemeProvider({colors,children}:{colors?:TextThemeColors;children:ReactNode}){
 return <WorkbenchThemeContext.Provider value={colors||fallbackTextTheme}>{children}</WorkbenchThemeContext.Provider>;
}
export function useWorkbenchThemeColors(){return useContext(WorkbenchThemeContext);}
