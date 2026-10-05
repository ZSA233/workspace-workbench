import {memo} from 'react';
import {Text} from 'react-native';
import type {HighlightedCodeProps} from './syntax';
import {nativeRenderSegments} from './native-syntax';
import {syntaxPalette} from './syntax-palette';
import {editorCodeFontFamily} from './code-font';
/** Drawing only: no loading, timers or tokenizer in a row's render path. */
export const NativeHighlightedCode=memo(function NativeHighlightedCode({code,theme,style,spans,inlineChange,changeBackground}:HighlightedCodeProps){
 const palette=syntaxPalette(theme);
 if(!spans&&!inlineChange)return <Text selectable style={[style,{color:palette.plain,fontFamily:editorCodeFontFamily}]}>{code}</Text>;
 const segments=nativeRenderSegments(code,spans,inlineChange);
 return <Text selectable style={[style,{color:palette.plain,fontFamily:editorCodeFontFamily}]}>{segments.map((span,index)=><Text key={index} style={{color:palette[span.kind],fontFamily:editorCodeFontFamily,...(span.changed?{backgroundColor:changeBackground}:{})}}>{code.slice(span.start,span.end)}</Text>)}</Text>;
});
