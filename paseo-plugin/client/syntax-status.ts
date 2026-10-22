/** User-facing fallback status; parser/Git error details stay out of the code view. */
export function syntaxStatus(reason:string|undefined,zh=false):string|undefined{
  if(!reason||['unknown_language','unsupported_source','cancelled'].includes(reason))return;
  if(reason==='large_file'||reason==='syntax_budget')return zh?'大文件模式：保留源码显示，已限制语法高亮。':'Large file mode: source remains readable with limited highlighting.';
  if(reason==='token_response_limit')return zh?'部分行超过高亮预算，使用纯文本显示。':'Some lines exceed the highlighting budget and use plain text.';
  if(reason==='source_changed')return zh?'文件已变化，请刷新差异；当前保留原补丁。':'Source changed. Refresh the Diff; the original patch is still shown.';
  return zh?'语法高亮暂不可用，源码仍可阅读。':'Highlighting is unavailable; source remains readable.';
}
