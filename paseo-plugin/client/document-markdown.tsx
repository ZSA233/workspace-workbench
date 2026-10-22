import {useEffect,useMemo,useState,type ReactNode} from 'react';
import {View,Text,Image} from 'react-native';
import {ExternalLink} from '@getpaseo/plugin/client/ui';
import {ScrollView} from './native-components';
import {HighlightedCode,editorCodeFontFamily} from './syntax';
import {documentLink,type MarkdownNode} from '../shared/document';
type Tree=MarkdownNode&{nodes?:Tree[]};
function tree(tokens:MarkdownNode[]):Tree[]{const root:Tree[]=[];const stack:Tree[][]=[root];for(const token of tokens){if(token.level===-1){if(stack.length>1)stack.pop();continue;}const node:Tree={...token,...(token.children?{children:token.children}:{}),nodes:[]};stack.at(-1)!.push(node);if(token.level===1)stack.push(node.nodes!);}return root;}
type Props={nodes:MarkdownNode[];path:string;theme:any;fontSize:number;open(path:string):void;asset(path:string,offset:number,version?:string):Promise<any>};
function LocalImage({href,alt,props}:{href:string;alt:string;props:Props}){
  const target=documentLink(props.path,href),[uri,setUri]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let live=true;setUri('');setError('');if(!target){setError('Image URL is not a Workspace image');return;}
    void(async()=>{let offset=0,version:string|undefined,mime='',base64='';
      // Each chunk is a multiple of three bytes except the last; decode first to preserve boundaries.
      const chunks:Uint8Array[]=[];let length=0;
      const {decode,encode}=await import('./files-platform');
      while(live){const value=await props.asset(target.path,offset,version);if(!live)return;version=value.version;mime=value.mime;const bytes=decode(value.data);chunks.push(bytes);length+=bytes.length;if(length>4*1024*1024)throw Error('Image preview budget exceeded');if(value.eof)break;if(value.nextOffset<=offset)throw Error('Image read made no progress');offset=value.nextOffset;}
      if(!live)return;const data=new Uint8Array(length);let index=0;for(const chunk of chunks){data.set(chunk,index);index+=chunk.length;}base64=encode(data);setUri(`data:${mime};base64,${base64}`);
    })().catch(reason=>{if(live)setError(String(reason.message||reason));});return()=>{live=false;};
  },[props.path,href,props.asset]);
  return uri?<Image accessibilityLabel={alt} source={{uri}} style={{width:'100%',height:240,resizeMode:'contain',marginVertical:8}}/>:<Text style={{color:props.theme.colors.foregroundMuted,fontSize:12}}>{alt} · {error||'Loading image…'}</Text>;
}
/** Render structured tokens as RN components; never insert parser-produced HTML. */
export function DocumentMarkdown(props:Props){
  const nodes=useMemo(()=>tree(props.nodes),[props.nodes]),c=props.theme.colors,size=props.fontSize;
  const textStyle={color:c.foreground,fontSize:size,lineHeight:Math.round(size*1.65)};
  const inline=(values:MarkdownNode[]):ReactNode[]=>inlineNodes(tree(values));
  function inlineNodes(values:Tree[]):ReactNode[]{return values.map((node,index)=>{
    const children=node.children?inline(node.children):node.nodes?.length?inlineNodes(node.nodes):node.content;
    if(node.type==='image')return <LocalImage key={index} href={node.attrs?.src||''} alt={node.content} props={props}/>;
    if(node.type==='link_open'){
      const href=node.attrs?.href||'',target=documentLink(props.path,href);
      if(target)return <Text key={index} accessibilityRole="link" onPress={()=>props.open(target.path)} style={{color:c.accent,textDecorationLine:'underline'}}>{children}</Text>;
      if(/^https?:\/\//i.test(href))return <ExternalLink key={index} href={href}><Text style={{color:c.accent,textDecorationLine:'underline'}}>{children}</Text></ExternalLink>;
      return <Text key={index}>{children}</Text>;
    }
    if(node.type==='softbreak'||node.type==='hardbreak')return '\n';
    return <Text key={index} style={node.type==='code_inline'?{fontFamily:editorCodeFontFamily,backgroundColor:c.surface2,fontSize:size-1}:node.type==='strong_open'?{fontWeight:'700'}:node.type==='em_open'?{fontStyle:'italic'}:node.type==='s_open'?{textDecorationLine:'line-through'}:undefined}>{children}</Text>;
  });}
  const blocks=(values:Tree[],ordered?:number):ReactNode[]=>values.map((node,index)=>{
    const content=node.children?inline(node.children):node.nodes?.length?blocks(node.nodes,node.type==='ordered_list_open'?Number(node.attrs?.start||1):undefined):node.content;
    if(node.type==='inline')return <Text key={index} selectable style={textStyle}>{inline(node.children||[])}</Text>;
    if(node.type==='heading_open')return <View key={index} style={{marginTop:18,marginBottom:8,borderBottomWidth:node.tag==='h1'||node.tag==='h2'?1:0,borderColor:c.border}}><Text selectable style={[textStyle,{fontSize:size*(node.tag==='h1'?1.8:node.tag==='h2'?1.45:1.15),lineHeight:size*2.3,fontWeight:'700'}]}>{node.nodes?.flatMap(n=>n.children?inline(n.children):[n.content])}</Text></View>;
    if(node.type==='fence'||node.type==='code_block')return <ScrollView key={index} horizontal style={{backgroundColor:c.surface1,marginVertical:8,borderRadius:4}}><View style={{padding:10}}>{(node.lines||node.content.split(/\r\n|\n|\r/).map(code=>({code,spans:[]}))).map((line,i)=><HighlightedCode key={i} code={line.code||' '} path="" spans={line.spans} theme={props.theme} style={{fontSize:size-1,lineHeight:size+7}}/>)}</View></ScrollView>;
    if(node.type==='hr')return <View key={index} style={{height:1,backgroundColor:c.border,marginVertical:12}}/>;
    if(node.type==='table_open')return <ScrollView key={index} horizontal style={{marginVertical:8}}><View style={{minWidth:440,borderWidth:1,borderColor:c.border}}>{content}</View></ScrollView>;
    if(node.type==='tr_open')return <View key={index} style={{flexDirection:'row',borderBottomWidth:1,borderColor:c.border}}>{content}</View>;
    if(node.type==='th_open'||node.type==='td_open')return <View key={index} style={{flex:1,minWidth:110,padding:8,backgroundColor:node.type==='th_open'?c.surface1:undefined}}>{content}</View>;
    if(node.type==='blockquote_open')return <View key={index} style={{borderLeftWidth:3,borderColor:c.accent,paddingLeft:12,marginVertical:8}}>{content}</View>;
    if(node.type==='list_item_open')return <View key={index} style={{flexDirection:'row',paddingLeft:8,marginBottom:4}}><Text style={[textStyle,{minWidth:22,paddingRight:5}]}>{ordered===undefined?'•':`${ordered+index}.`}</Text><View style={{flex:1}}>{content}</View></View>;
    return <View key={index} style={{marginBottom:node.type==='paragraph_open'?10:0}}>{typeof content==='string'?<Text selectable style={textStyle}>{content}</Text>:content}</View>;
  });
  return <View testID="document-markdown" style={{padding:18,maxWidth:960,width:'100%',alignSelf:'center'}}>{blocks(nodes)}</View>;
}
