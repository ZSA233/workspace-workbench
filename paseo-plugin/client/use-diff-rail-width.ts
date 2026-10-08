import {useEffect,useState} from 'react';
import {Platform} from 'react-native';
import {railWidth} from './diff-scroll-model';
/** Native touch and coarse web pointers share the wider target, never an invisible code overlay. */
export function useDiffRailWidth(){
 const [touch,setTouch]=useState(()=>Platform.OS!=='web'||Boolean((globalThis as any).matchMedia?.('(pointer: coarse)').matches));
 useEffect(()=>{
  if(Platform.OS!=='web')return;
  const media=(globalThis as any).matchMedia?.('(pointer: coarse)');if(!media)return;
  const change=()=>setTouch(media.matches);change();media.addEventListener?.('change',change);
  return()=>media.removeEventListener?.('change',change);
 },[]);
 return railWidth(touch);
}
