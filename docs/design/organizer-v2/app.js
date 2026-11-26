(() => {
  'use strict';
  const data=window.DESIGN_DATA;
  if(!data){document.getElementById('app').textContent='请通过本地设计预览服务打开此页面。';return;}
  const paths={
    arrow:'M5 12h14m-5-5 5 5-5 5',chevron:'m9 5 7 7-7 7',back:'m14 5-7 7 7 7',check:'m5 12 4 4L19 6',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-2-5h4l1 3 3-1 2 3-2 3 2 3-2 3-3-1-1 3h-4l-1-3-3 1-2-3 2-3-2-3 2-3 3 1 1-3',
    folder:'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
    chat:'M21 15a3 3 0 0 1-3 3H9l-6 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Zm-14-7h10M7 12h7',
    layers:'m12 3 10 5-10 5L2 8Zm-9 10 9 5 9-5m-18 5 9 5 9-5',
    spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Zm7-1v4m-2-2h4',
    model:'M8 3v3m8-3v3M5 7h14a2 2 0 0 1 2 2v10H3V9a2 2 0 0 1 2-2m3 4v3m8-3v3m-8 3h8',
    branch:'M6 3v12a4 4 0 0 0 4 4h4m-8-9h8a4 4 0 0 0 4-4V3M3 3h6m6 0h6m-7 13 3 3-3 3',
    clock:'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0m-9-5v5l3 2',
    file:'M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6',
    search:'M16 10a6 6 0 1 0-12 0 6 6 0 0 0 12 0m-1 5 6 6',
    info:'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0m-9-1v6m0-10v1',
    puzzle:'M3 9h5V5a2 2 0 1 1 4 0v4h5v5h2a2 2 0 1 1 0 4h-2v3H3v-5h3a2 2 0 1 0 0-4H3Z',
    database:'M21 6c0 2-4 3-9 3S3 8 3 6s4-3 9-3 9 1 9 3m0 0v12c0 2-4 3-9 3s-9-1-9-3V6m0 6c0 2 4 3 9 3s9-1 9-3',
    shield:'m12 3 9 4v5c0 5-9 9-9 9s-9-4-9-9V7Zm-5 9 3 3 6-6',
    terminal:'M3 4h18v16H3Zm4 5 3 3-3 3m6 0h4',
    box:'m12 3 9 5v9l-9 5-9-5V8Zm-9 5 9 5 9-5m-9 5v9m-4-17 9 5',
    restart:'M4 8a9 9 0 1 1-1 8M3 3v6h6m3-2v5l3 2',
    activity:'M3 12h4l3-8 4 16 3-8h4',
    link:'m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    external:'M14 3h7v7m0-7L10 14m-1-9H3v16h16v-6',close:'m6 6 12 12M6 18 18 6',
  };
  const icon=(name,size=16)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const attr=value=>esc(value);
  const time=value=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
  const stateNames={deployed:'已上线',partial:'部分覆盖',pending:'未上线',unknown:'待核实',discussion:'无代码改动'};
  const symbols={deployed:'✓',partial:'◐',pending:'○',unknown:'?',discussion:'·'};
  const colors={deployed:'green',partial:'amber',pending:'blue',unknown:'amber',discussion:'gray'};
  const badge=state=>`<span class="pill ${colors[state]||'gray'}">${symbols[state]||'?'} ${stateNames[state]||'待核实'}</span>`;
  const button=(action,label,classes='btn',extra='')=>`<button type="button" class="${classes}" data-action="${action}" ${extra}>${label}</button>`;
  const label=(name,control)=>`<label>${esc(name)}${control}</label>`;
  const input=(id,value,extra='')=>`<input id="${id}" value="${attr(value)}" ${extra}>`;
  const select=(id,options,value)=>`<select id="${id}">${options.map(([v,l])=>`<option value="${attr(v)}" ${v===value?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
  const disclosure=(title,content,open=false)=>`<details class="evidence" ${open?'open':''}><summary>${title}<span class="chev">${icon('chevron',13)}</span></summary><div class="detail-body">${content}</div></details>`;
  const ownRuns=new Map((data.results||[]).map(e=>[e.workspaceId,e]));
  const attempts=new Map((data.results||[]).map(e=>[e.test.id,e]));
  const state={page:'summary',scope:'project',selected:null,workspace:null,filter:'all',search:'',settings:'home',settingsScope:'project',draft:{...data.policy},modelDraft:{...data.profile},modelStatus:'',busy:false,error:'',timeline:false};
  const settingsRows=[
    ['extensions','扩展管理','档案话题的启用、连接与配置','puzzle'],
    ['storage','项目存储与缓存','工作区目录、记录位置、缓存与占用','database'],
    ['review','审核配置','模式、模型、角色、指令与会话复用','shield'],
    ['execution','会话与执行','会话关系、权限预设、执行模型','terminal'],
    ['repositories','项目与仓库','仓库选择、聚合范围','folder'],
    ['production','生产与上线','逐仓库生产分支与覆盖判断','branch'],
    ['runtime','环境与工具链','自动 / 系统 / mise、工具版本','box'],
    ['recovery','自动恢复','继续消息、间隔与单会话覆盖','restart'],
    ['topics','话题与资料','服务连接、关注群与投递偏好','chat'],
    ['files','文件与改动规则','测试文件识别与默认筛选','file'],
    ['diagnostics','状态与诊断','任务记录、实际输入与失败原因','activity'],
  ];
  const app=document.getElementById('app');
  const getWorkspace=key=>data.snapshot.workspaces.find(w=>w.key===key||w.material.workspaceId===key);
  const getTarget=id=>id?.startsWith('unlinked:')?(()=>{const w=getWorkspace(id.slice(9));return w?{id,currentTitle:null,workspaceKeys:[w.key],representative:w.key,state:w.material.state,unlinked:true}:null;})():data.snapshot.targets.find(t=>t.id===id);
  const linkedWorkspaces=t=>t.workspaceKeys.map(getWorkspace).filter(Boolean);
  function representative(t){return getWorkspace(t.representative)||linkedWorkspaces(t).filter(w=>w.material.evidence.some(e=>e.kind!=='hint')).sort((a,b)=>Date.parse(b.material.activityAt)-Date.parse(a.material.activityAt))[0]||linkedWorkspaces(t)[0];}
  function selectedWorkspace(){const t=getTarget(state.selected);return getWorkspace(state.workspace)||t&&representative(t);}
  function entryFor(w){return w&&ownRuns.get(w.material.workspaceId);}
  function parsedResult(entry){if(entry?.test?.state!=='complete'||entry.test.run?.error)return null;try{return JSON.parse(entry.test.run.output.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{return null;}}
  function errorMessage(entry){const code=entry?.test.error||entry?.test.run?.error;return ({organizer_model_evidence_invalid:'模型返回的事项引用未通过来源校验，结果未采纳。可以调整材料后重新生成。',organizer_model_output_incomplete:'模型输出不完整，未保存为有效结果。',organizer_sushi_model_not_loaded:'指定 Sushi 模型尚未就绪，本次没有生成。'})[code]||code||'请核对模型连接与输入材料后重试';}
  function sourceCounts(w){const es=w.material.evidence;return {goals:es.filter(e=>e.kind==='goal'||e.kind==='note').length,commits:es.filter(e=>e.kind==='commit').length,diffs:es.filter(e=>e.kind==='diff').length};}
  function sourceChips(w){const c=sourceCounts(w);return `<div class="source-chips"><span class="source-chip">${icon('file',12)}目标 / 说明 <b>${c.goals}</b></span><span class="source-chip">${icon('branch',12)}自身提交 <b>${c.commits}</b></span><span class="source-chip">${icon('layers',12)}改动片段 <b>${c.diffs}</b></span></div>`;}
  function excerpted(entry){try{const submitted=JSON.parse(entry.input),original=getWorkspace(entry.workspaceKey);return submitted.evidence.some(e=>e.text.length<(original?.material.evidence.find(s=>s.id===e.id)?.text.length||0))||submitted.coverage?.complete===false;}catch{return true;}}
  const notify=text=>{const toast=document.getElementById('toast');toast.textContent=text;toast.className='visible';setTimeout(()=>toast.className='',4200);};
  const goSettings=section=>{state.page='settings';state.settings=section;state.error='';render();scrollTo({top:0});};
  function render(){
    app.innerHTML=`<div class="review-strip"><span class="row"><i class="dot"></i>DESIGN PREVIEW / 设计稿</span><span>YUVA 真实资料 · 标题未改动</span></div><nav class="nav" aria-label="Workbench 主导航">${['Git','文件','摘要','话题','缓存与空间','设置'].map(name=>button(name==='摘要'?'nav-summary':name==='设置'?'nav-settings':'other',name,(state.page==='summary'&&name==='摘要'||state.page==='settings'&&name==='设置')?'active':'')).join('')}</nav>${state.page==='summary'?(state.selected?detailPage():summaryPage()):settingsPage()}`;
    app.querySelectorAll('[data-action]').forEach(el=>el.addEventListener('click',()=>action(el.dataset.action,el.dataset.value)));
    app.querySelectorAll('[data-rule]').forEach(el=>el.addEventListener('change',()=>{state.draft[el.dataset.rule]=el.type==='number'?Number(el.value):el.type==='checkbox'?el.checked:el.value;if(el.dataset.rule==='mode')render();else updateSave();}));
    app.querySelectorAll('[data-model]').forEach(el=>el.addEventListener('input',()=>{state.modelDraft[el.dataset.model]=el.type==='number'?Number(el.value):el.value;updateSave();}));
    const search=app.querySelector('#session-search');search?.addEventListener('input',()=>{state.search=search.value;const start=search.selectionStart;render();const next=app.querySelector('#session-search');next.focus();next.setSelectionRange(start,start);});
    app.querySelector('#workspace-select')?.addEventListener('change',event=>{state.workspace=event.target.value;state.error='';render();});
    app.querySelector('#settings-category')?.addEventListener('change',event=>goSettings(event.target.value));
    app.querySelector('#settings-scope')?.addEventListener('change',event=>{state.settingsScope=event.target.value;render();});
    updateElapsed();
  }
  function topHeader(title,kicker='WORKSPACE WORKBENCH',subtitle=''){
    return `<header class="page-title"><div class="row between"><div><div class="kicker">${kicker}</div><h1 class="heading">${title}</h1></div><span class="project-chip">${icon('folder',13)}${esc(data.project.name)}</span></div>${subtitle?`<p class="muted sm" style="margin:0">${subtitle}</p>`:''}</header>`;
  }
  function modelStatus(){return `<div class="status-row"><button data-action="settings-model" class="row"><span class="dot ${data.modelReady?'accent':'amber'}"></span>${data.modelReady?'本地模型就绪':'模型未就绪'}</button><span class="dim">/</span><button data-action="settings-rules">自动维护${data.policy.enabled?'已开启':'关闭'}</button><span style="flex:1"></span><span>${time(data.snapshotAt)} 读取</span></div>`;}
  function backgroundTask(){
    const job=data.snapshot.jobs.find(j=>j.state==='running')||data.snapshot.jobs.find(j=>j.state==='complete'&&j.total>0);
    if(!job)return '<div data-progress-container></div>';
    return `<div data-progress-container class="task secondary" data-testid="production-check"><div class="row between"><div class="task-heading muted">${icon('branch',13)}${job.state==='complete'?'项目生产检查已完成':'项目生产检查'}</div><span class="mono muted">${job.completed} / ${job.total}</span></div><div class="progress"><span style="width:${job.total?Math.min(100,job.completed/job.total*100):0}%"></span></div><div class="row between xs muted"><span>Git 与生产分支 · ${time(job.updatedAt)}</span><span class="pill gray">此检查不调用模型</span></div></div>`;
  }
  function summaryPage(){
    let targets=data.snapshot.targets.filter(t=>state.filter==='all'||state.filter==='pending'&&['pending','partial'].includes(t.state)||t.state===state.filter);
    if(state.search.trim())targets=targets.filter(t=>[t.currentTitle,...linkedWorkspaces(t).map(w=>w.material.name)].join(' ').toLowerCase().includes(state.search.toLowerCase()));
    return `<section class="page" data-testid="summary-overview">${topHeader('工作摘要','WORKSPACE WORKBENCH','选择一项需求，先看依据，再生成摘要与标题预览。')}
      <div class="stats"><div class="stat"><b>${data.snapshot.workspaces.length}</b><span>工作区</span></div><div class="stat"><b class="accent">${data.snapshot.targets.length}</b><span>关联会话</span></div><div class="stat"><b class="amber">${data.snapshot.unlinked.length}</b><span>未关联工作区</span></div></div>
      ${modelStatus()}<div class="segmented" aria-label="资料范围">${button('scope-current','当前会话 <small>未关联</small>',state.scope==='current'?'active':'')}${button('scope-project','整个项目 <small>'+data.snapshot.targets.length+' 个会话</small>',state.scope==='project'?'active':'')}</div>
      ${state.scope==='current'?`<div class="empty"><div class="empty-icon">${icon('link',24)}</div><h2>此会话暂无关联工作区</h2><p>YUVA 的项目资料可以查看。只有确认关联后，才能维护这里的会话标题。</p>${button('scope-project','查看 YUVA 项目资料 '+icon('arrow',14),'btn primary')}</div>`:
      `<div class="row between"><h2 class="section-heading">会话与需求</h2><span class="xs muted">${[...ownRuns.values()].filter(parsedResult).length} 个样例预览 · 尚未应用标题</span></div><div class="search">${icon('search',14)}<input id="session-search" placeholder="搜索需求、会话或工作区" aria-label="搜索需求" value="${attr(state.search)}"></div>
      <div class="filters">${[['all','全部'],['pending','未全部上线'],['unknown','待核实']].map(([v,l])=>button('filter',l,'filter '+(state.filter===v?'active':''),`data-value="${v}"`)).join('')}</div>
      <div class="stack">${targets.map(t=>sessionCard(t)).join('')||'<div class="empty"><p>此筛选下暂无会话</p></div>'}</div>
      ${disclosure(`<span class="row">${icon('link',14)}未关联工作区 <span class="pill amber">${data.snapshot.unlinked.length}</span></span>`,`<p class="sm muted" style="margin:0">可以分析工作区内容；暂不能同步到原生会话标题。</p><div class="orphan-list">${data.snapshot.workspaces.filter(w=>data.snapshot.unlinked.includes(w.material.workspaceId)).slice(0,16).map(w=>`<div class="orphan-item"><span class="mono">${esc(w.material.name)}</span><div class="row between"><span class="xs muted">${w.material.evidence.some(e=>e.kind!=='hint')?'已有提交或改动材料':'尚未读取材料'}</span>${button('open-session','查看','text-btn',`data-value="${attr('unlinked:'+w.key)}"`)}</div></div>`).join('')}</div>`)}
      `}
      ${backgroundTask()}<div class="footnote">标题要在生成预览后确认应用。代码覆盖与事项完成分别记录。</div>
    </section>`;
  }
  function sessionCard(t){
    const w=representative(t),ws=linkedWorkspaces(t),run=entryFor(w),result=parsedResult(run);
    const ready=ws.filter(x=>x.material.evidence.some(e=>e.kind!=='hint')).length;
    return `<article class="session-card"><button class="session-main" data-action="open-session" data-value="${attr(t.id)}"><div class="row top"><span class="session-icon">${icon('chat',15)}</span><div class="grow"><div class="session-title clamp">${esc(result?.title||t.currentTitle||w?.material.name||'未命名会话')}</div></div>${icon('chevron',14)}</div><div class="row between"><div class="session-meta"><span>${ws.length} 个工作区</span><span class="divider"></span><span>${ready} 项已有材料</span></div>${result?'<span class="pill green">预览待确认</span>':badge(t.state)}</div></button><div class="card-actions"><span class="xs muted grow">${result?'已生成摘要，原生标题保持原值':'尚未生成摘要与标题'}</span>${button('open-session','查看依据 '+icon('arrow',12),'text-btn',`data-value="${attr(t.id)}"`)}</div></article>`;
  }
  function steps(phase){
    return `<div class="steps">${['选择材料','模型生成','核对预览','应用标题'].map((l,i)=>`${i?'<span class="step-line"></span>':''}<div class="step ${i<phase?'done':i===phase?'active':''}"><span class="step-circle">${i<phase?icon('check',11):i+1}</span><span>${l}</span></div>`).join('')}</div>`;
  }
  function detailPage(){
    const t=getTarget(state.selected);if(!t){state.selected=null;return summaryPage();}
    const w=selectedWorkspace();if(!w)return `<section class="page">${button('back-summary',icon('back',13)+'返回','back')}<div class="empty"><p>尚无可分析材料</p></div></section>`;
    const entry=entryFor(w),result=parsedResult(entry),running=entry&&['queued','running'].includes(entry.test.state);
    const available=w.material.evidence.some(e=>e.kind!=='hint'),ws=linkedWorkspaces(t);
    return `<section class="page" data-testid="summary-detail">${button('back-summary',icon('back',13)+'项目摘要','back')}
      <div class="page-title"><div class="row between"><span class="kicker">${t.unlinked?'未关联工作区':'会话 / '+ws.length+' 个工作区'}</span><span class="row xs muted">${t.unlinked?'':'汇总'}${badge(t.state)}</span></div><h1 class="section-heading clamp" style="font-size:17px;line-height:1.6">${esc(result?.title||t.currentTitle||w.material.name)}</h1></div>
      ${steps(result?2:running?1:0)}
      ${running?runningTask(entry,w):''}
      ${result?resultPanel(t,w,entry,result):''}
      <${result||running?'details':'div'} class="setting-card">${result||running?`<summary style="padding:0"><span class="row">${icon('file',14)}本次分析材料</span><span class="pill gray">1 个工作区</span><span class="chev">${icon('chevron',13)}</span></summary>`:'<div class="row between"><h2>本次分析材料</h2><span class="pill gray">1 个工作区</span></div>'}
        ${label(t.unlinked?'工作区':'代表工作区',`<select id="workspace-select" aria-label="分析工作区">${ws.map(x=>`<option value="${attr(x.key)}" ${x.key===w.key?'selected':''}>${esc(x.material.name)}</option>`).join('')}</select>`)}
        <span class="xs muted">${w.key===t.representative?'未上线优先，同组选择最近有实质改动的一项。':'已手动选择预览对象，不会自动更换会话的代表工作区。'}</span>
        ${sourceChips(w)}${w.material.taskBrief?`<div class="sm">${esc(w.material.taskBrief)}</div>`:''}
        ${disclosure('<span class="row">'+icon('file',13)+'查看实际提交与改动</span>',evidenceBody(w))}
      </${result||running?'details':'div'}>
      ${state.error?`<div class="error-box">${esc(state.error)}</div>`:''}
      ${entry&&['failed','cancelled','interrupted'].includes(entry.test.state)?`<div class="error-box"><strong>${entry.test.state==='cancelled'?'本次生成已取消':'摘要生成未通过校验'}</strong><br>${esc(errorMessage(entry))}</div>`:''}
      ${!running&&!result?`<div class="stack tight">${button('generate',icon('spark',15)+'调用本地模型，生成预览','btn primary full',`data-testid="generate-preview" ${!available||!data.modelReady||!data.live?'disabled':''}`)}<div class="row between xs muted"><span>${data.live?'会真实调用 Sushi，原生标题不变':'离线设计稿 · 可查看已保存的真实输出'}</span>${button('settings-model','模型配置','text-btn')}</div>${!available?'<div class="notice warning">'+icon('info',15)+'<p>目前只有名称线索，没有可分析的目标、提交或改动。</p></div>':''}</div>`:''}
      ${disclosure(`<span class="row">${icon('branch',14)}本工作区的生产依据 ${badge(w.material.state)}</span>`,productionBody(w))}
      ${t.unlinked?`<div class="notice warning">${icon('link',16)}<p><b>暂无明确会话关联</b><br>这份工作区摘要可以保留，暂不能改原生会话标题。</p></div>`:''}
      <div class="footnote">本设计稿仅调用模型测试，不写入原生标题、归档或项目设置。</div>
    </section>`;
  }
  function evidenceBody(w){
    return w.material.evidence.filter(e=>e.kind!=='hint').map(e=>`<div class="commit"><div class="row between"><span class="pill gray">${({goal:'目标',commit:'提交',note:'改动说明',diff:'代码差异',message:'会话消息'})[e.kind]}</span><code class="dim">${esc(e.repository||'')}${e.sha?' · '+esc(e.sha.slice(0,8)):''}</code></div>${e.kind==='diff'?`<pre>${esc(e.text.slice(0,2200))}${e.text.length>2200?'\n…设计页仅展开前 2200 字':''}</pre>`:`<div class="message">${esc(e.text)}</div>`}</div>`).join('')||'<p class="muted sm">没有可用材料。名称本身不作为需求依据。</p>';
  }
  function productionBody(w){
    return `<div class="xs muted">以下来自 Git 核验，不由模型判断。无改动的仓库单独列出。</div>${w.material.repositories.map(r=>`<div class="repo-line"><strong class="sm">${esc(r.repositoryId)}</strong>${badge(r.state)}<code class="mono">${esc(r.productionRef||'未配置生产分支')}</code><span class="xs muted">覆盖 ${r.covered} · 未覆盖 ${r.pending} · 待核实 ${r.uncertain}</span>${r.reason?`<span class="xs amber" style="grid-column:1/-1">${esc(r.reason)}</span>`:''}</div>`).join('')}`;
  }
  function runningTask(entry,w){
    return `<div class="task" data-testid="model-task"><div class="row between"><div class="task-heading"><i class="spinner"></i>${entry.test.state==='queued'?'等待本地模型':'正在生成摘要与标题'}</div><span class="elapsed mono muted" data-start="${attr(entry.submittedAt)}">0 秒</span></div><div class="sm clamp">${esc(w.material.name)}</div><div class="progress indeterminate"><span></span></div><div class="row between xs"><span class="muted">${esc(data.profile.name)} · ${esc(data.profile.model)}</span><span class="pill green">真实请求</span></div><div class="row between"><span class="xs muted">1 项分析 · 标题尚未写入</span>${button('cancel-generation','取消生成','btn quiet small')}</div>${disclosure('查看本次实际输入',`<pre>${esc(JSON.stringify(JSON.parse(entry.input),null,2))}</pre>`)}</div>`;
  }
  function resultPanel(t,w,entry,result){
    const run=entry.test.run,secs=((run.elapsedMs||0)/1000).toFixed(1),newTitle=`${symbols[t.state]||'?'} ${result.title}`;
    return `<div class="stack"><div class="result" data-testid="generated-result"><div class="result-header"><span class="row accent">${icon('check',14)}预览已生成</span><span class="pill amber">待确认 · 未改标题</span></div><div class="title-comparison"><div><div class="label-small">原生会话当前标题</div><div class="old-title clamp">${esc(t.currentTitle||'暂无关联会话')}</div></div><div style="color:#75946e">${icon('arrow',15)}</div><div><div class="label-small">建议标题</div><div class="new-title">${esc(newTitle)}</div></div></div><div class="result-footer"><p class="result-brief">${esc(result.brief)}</p></div></div>
      <div class="row between xs muted run-token"><span class="row">${icon('model',13)}Sushi · ${secs} 秒</span><span>${run.usage?.total_tokens?run.usage.total_tokens.toLocaleString()+' tokens':'用量未返回'} · ${run.truncated||excerpted(entry)?'已选取材料片段':'选中材料已完整输入'}</span></div>
      <div class="stack tight">${button('confirm-title',icon('check',14)+'核对并应用标题','btn primary full',t.unlinked?'disabled':'')}<div class="row between xs muted"><span>这一步才修改原生会话标题</span>${button('generate','重新生成','text-btn',!data.live?'disabled':'')}</div></div>
      ${result.items?.length?`<div class="setting-card"><div class="row between"><h2>事项清单</h2><span class="xs muted">与上线状态分开</span></div><div class="items">${result.items.map(item=>`<label class="todo"><input type="checkbox"><span>${esc(item.text)}${item.completed?'<span class="pill amber" style="margin-top:4px">模型建议完成 · 待你确认</span>':''}</span></label>`).join('')}</div></div>`:''}
      ${disclosure(`<span class="row">${icon('activity',14)}真实模型记录 <span class="pill green">1 次已完成</span></span>`,`<div class="xs muted">${esc(data.profile.model)} · ${time(run.at)} · ${secs} 秒</div>${disclosure('实际提示词',`<pre>${esc(run.prompt)}</pre>`)}${disclosure('实际输入与来源',`<pre>${esc(JSON.stringify(JSON.parse(run.input),null,2))}</pre>`)}${disclosure('原始模型输出',`<pre>${esc(run.output)}</pre>`)}<div class="xs muted">输入 ${run.usage?.prompt_tokens??'—'} / 输出 ${run.usage?.completion_tokens??'—'} tokens</div>`)}
    </div>`;
  }
  function settingsPage(){
    const section=state.settings;
    const title=section==='home'?'设置':section==='model'?'模型连接':section==='rules'?'自动整理':settingsRows.find(r=>r[0]===section)?.[1]||'设置';
    const content=section==='home'?settingsHome():settingsDetail(section);
    return `<section class="page settings-page" data-testid="settings-${section}">${section!=='home'?button('settings-home',icon('back',13)+'全部设置','back'):''}${topHeader(title,'WORKSPACE WORKBENCH')}
      <div class="settings-context"><span class="row xs">${icon('folder',13)}${esc(data.project.name)}</span><span class="spacer"></span><span class="xs muted">${section==='model'?'主机共享连接':state.settingsScope==='project'?'项目设置':'主机默认'}</span><span class="grow"></span>${button('settings-context','切换','text-btn')}</div>
      ${content}<div class="footnote">设计预览 · 配置修改不写入现有插件</div>
    </section>`;
  }
  function toggleSwitch(on,actionName,labelText){return `<button class="switch ${on?'on':''}" data-action="${actionName}" role="switch" aria-checked="${on}" aria-label="${labelText}"><span></span></button>`;}
  function settingsHome(){
    return `<div class="setting-card" data-testid="model-connection-entry"><div class="row"><span class="setting-icon">${icon('model',18)}</span><div class="grow"><h2>模型连接</h2><span class="xs muted">${esc(data.profile.name)} · 主机共享</span></div><span class="pill green"><span class="dot"></span>${data.modelReady?'已就绪':'待检测'}</span></div><div class="stack tight"><div class="model-address mono">${esc(data.profile.baseUrl)}</div><div class="xs muted mono">${esc(data.profile.model)}</div></div>${button('settings-model','配置地址与模型 '+icon('arrow',13),'text-btn')}</div>
      <div class="setting-card" data-testid="automatic-organizer-entry"><div class="row"><span class="setting-icon">${icon('spark',18)}</span><div class="grow"><h2>自动整理</h2><span class="xs muted">${state.draft.enabled?'未来新内容自动纳入':'未开启 · 手动生成预览仍可使用'}</span></div>${toggleSwitch(state.draft.enabled,'toggle-auto','自动整理开关')}</div><div class="row between"><span class="xs muted">范围：${state.draft.mode==='selected'?'仅指定范围':state.draft.mode==='exclude'?'全部，除排除项':'明确关联的新内容'}</span>${button('settings-rules','范围与命名规则 '+icon('arrow',12),'text-btn')}</div></div>
      <div class="row between"><span class="setting-group-title">项目与主机配置</span><span class="xs dim">所有入口</span></div>
      <div class="setting-lines">${settingsRows.map(([id,name,desc,symbol])=>`<button class="setting-line" data-action="settings-open" data-value="${id}"><span class="setting-icon">${icon(symbol,17)}</span><span class="grow"><h3>${name}</h3><p>${desc}</p></span>${icon('chevron',14)}</button>`).join('')}</div>`;
  }
  function settingsDetail(section){
    const existing=data.existing||{},review=existing.review?.effective||{},runtime=existing.runtime||{},session=existing.session?.effective||{};
    const footer=()=>`<div class="save-bar">${button('save-design','保存此设计稿中的修改','btn primary','data-testid="save-design"')}<span class="xs muted" style="text-align:center">不会写入现有插件设置</span></div>`;
    if(section==='model')return `<div class="notice">${icon('info',15)}<p><b>主机级模型连接</b><br>项目选择使用哪个连接；地址和认证在这里统一管理。</p></div>
      <div class="setting-card"><div class="row between"><h2>连接配置</h2><span class="pill green">${data.modelReady?'已就绪':'未就绪'}</span></div>
      ${label('连接名称',input('profile-name',state.modelDraft.name,'data-model="name"'))}
      ${label('接口地址',input('profile-url',state.modelDraft.baseUrl,'data-model="baseUrl" type="url" aria-label="模型接口地址"'))}
      ${label('模型 ID',input('profile-model',state.modelDraft.model,'data-model="model" aria-label="模型 ID"'))}
      ${label('认证（可选）','<input type="password" autocomplete="off" placeholder="留空保留已有认证" aria-label="模型认证">')}
      <div class="row between">${button('check-model',icon('activity',14)+'检测连接','btn small')}<span class="xs muted">只检测，不加载或切换模型</span></div>${state.modelStatus?`<div class="notice"><span class="xs">${esc(state.modelStatus)}</span></div>`:''}</div>
      ${disclosure('上下文、输出与超时',`<div class="field-grid">${label('上下文预算',input('context',state.modelDraft.contextTokens,'type="number" data-model="contextTokens"'))}${label('输出上限',input('output',state.modelDraft.outputTokens,'type="number" data-model="outputTokens"'))}</div>${label('请求超时（秒）',input('timeout',state.modelDraft.timeoutMs/1000,'type="number"'))}<div class="xs muted">默认单并发；不自动转用其他服务。</div>`)}
      ${button('start-model-sample',icon('spark',14)+'用 YUVA 样例试生成一次','btn')}${footer()}`;
    if(section==='rules')return `<div class="setting-card"><div class="row between"><div><h2>自动维护未来内容</h2><div class="xs muted" style="margin-top:5px">${state.draft.enabled?'设计草稿：已开启':'当前关闭'}</div></div>${toggleSwitch(state.draft.enabled,'toggle-auto','自动整理开关')}</div><div class="xs muted">历史内容先生成预览，确认后才会改名。</div></div>
      <div class="setting-card"><h2>整理范围</h2>${label('纳入哪些内容',`<select data-rule="mode" aria-label="自动整理范围">${[['automatic','所有明确关联的新内容'],['selected','只整理我选择的范围'],['exclude','全部，但排除指定内容']].map(([v,l])=>`<option value="${v}" ${state.draft.mode===v?'selected':''}>${l}</option>`).join('')}</select>`)}
      ${state.draft.mode==='selected'?`<div class="stack">${data.snapshot.targets.map(t=>`<label class="todo"><input type="checkbox"><span class="clamp">${esc(t.currentTitle)}</span></label>`).join('')}</div>`:''}
      ${state.draft.mode==='exclude'?label('排除的 Workspace 或会话 ID','<textarea placeholder="每行一个 ID"></textarea>'):''}
      ${label('使用的模型连接',`<select><option>${esc(data.profile.name)} · ${esc(data.profile.model)}</option></select>`)}</div>
      <div class="setting-card"><h2>标题格式</h2><div class="rule-preview"><div class="label-small">状态符号 + 稳定的短标题</div><div class="new-title">○ ${esc(sampleTitle())}</div></div><div class="symbol-grid">${[['✓','已上线'],['◐','部分覆盖'],['○','未上线'],['?','待核实'],['·','讨论中']].map(([s,l])=>`<div class="symbol-item"><b contenteditable="true" role="textbox" aria-label="${l}符号">${s}</b><span>${l}</span></div>`).join('')}</div>${label('标题正文长度',input('title-limit',state.draft.titleLength,'type="number" data-rule="titleLength"'))}</div>
      ${disclosure('提示词与更新频率',`${label('整理提示词',`<textarea data-rule="prompt">${esc(state.draft.prompt)}</textarea>`)}<div class="field-grid">${label('事件合并等待（秒）',input('debounce',state.draft.debounceSeconds,'type="number" data-rule="debounceSeconds"'))}${label('同对象最短间隔（秒）',input('interval',state.draft.analysisIntervalSeconds,'type="number" data-rule="analysisIntervalSeconds"'))}</div>`)}${footer()}`;
    if(section==='extensions')return `<div class="setting-card"><div class="row"><span class="setting-icon">${icon('puzzle',18)}</span><div class="grow"><h2>${esc(existing.extension?.manifest?.name||'档案话题')}</h2><span class="xs muted">${esc(existing.extension?.manifest?.description||'选择话题原文与附件，带入开发会话')}</span></div>${toggleSwitch(existing.extension?.enabled,'toggle-extension','启用档案话题扩展')}</div><div class="row between"><span class="xs muted">v${esc(existing.extension?.manifest?.version||'0.2.0')}</span><span class="pill ${existing.extension?.state==='ready'?'green':'gray'}">${existing.extension?.state==='ready'?'已启用':existing.extension?.state==='disabled'?'已停用':esc(existing.extension?.state||'未读取')}</span></div>${button('settings-topics','连接、关注群与投递配置 '+icon('arrow',13),'text-btn')}</div><div class="notice">${icon('puzzle',15)}<p>扩展的启用状态在这里管理，具体连接与投递偏好进入扩展配置。</p></div>${footer()}`;
    if(section==='storage')return `<div class="setting-card"><h2>项目存储位置</h2>${[['worktrees','工作区目录'],['records','Workspace 记录'],['state','运行状态与整理记录'],['config','项目配置文件']].map(([key,l])=>`<div><div class="label-small">${l}</div><div class="path mono">${esc(existing.storage?.[key]?.path||'未读取')}</div></div>`).join('')}</div><div class="setting-card"><div class="row between"><h2>运行时缓存</h2>${toggleSwitch(runtime.cache?.enabled,'toggle-cache','运行时缓存')}</div>${label('缓存目录',input('cache-path',runtime.cache?.root||'','placeholder="使用项目默认缓存目录"'))}<div class="row between xs muted"><span>观察缓存</span><span>${Math.round((existing.storage?.derived?.cacheBytes||0)/1048576)} / ${Math.round((existing.storage?.derived?.cacheLimit||0)/1048576)} MiB</span></div>${button('space-preview','查看空间与清理预览 '+icon('arrow',13),'text-btn')}</div>${footer()}`;
    if(section==='review')return `<div class="setting-card"><h2>审核方式</h2>${label('审核模式',select('review-mode',[['off','关闭'],['manual','手动触发'],['automatic','自动审核']],review.mode||'off'))}${label('审核目标',select('review-target',[['independent','独立 Reviewer'],['coordinator','当前协调者']],review.reviewerTarget||'independent'))}${label('Reviewer 模型',input('review-model',review.reviewerModel||'','placeholder="跟随执行模型"'))}</div><div class="setting-card"><h2>角色与指令</h2>${label('Reviewer 角色',input('review-role',review.reviewerRole||''))}${label('审核指令',`<textarea>${esc(review.instructions||'')}</textarea>`)}</div>${disclosure('轮数、超时与会话复用',`<div class="field-grid">${label('最多轮数',input('review-rounds',review.maxRounds||3,'type="number"'))}${label('超时（分钟）',input('review-timeout',(review.reviewerTimeoutMs||600000)/60000,'type="number"'))}</div>${label('审核会话',select('review-reuse',[['reuse','复用会话'],['new_per_round','每轮新建']],review.reviewerSession||'reuse'))}`)}${footer()}`;
    if(section==='execution')return `<div class="setting-card"><h2>会话与执行默认值</h2>${label('会话关系',select('session-relationship',[['independent','独立会话'],['child','子会话']],session.defaultRelationship||'independent'))}${label('权限预设',select('permission',[['inherit','继承宿主默认'],['auto','自动'],['auto-review','自动审阅'],['full-access','完全访问']],session.permissionMode||'inherit'))}${label('执行模型',input('execution-model',review.executionModel||'','placeholder="跟随 Provider 默认"'))}</div>${disclosure('Provider 覆盖',`<pre>${esc(JSON.stringify(session.providerRelationships||{},null,2))}</pre>`)}${footer()}`;
    if(section==='runtime')return `<div class="setting-card"><h2>运行环境</h2>${label('工具链来源',select('runtime-mode',[['auto','自动'],['system','系统'],['mise','mise']],runtime.mode||'auto'))}${label('mise 路径',input('mise-path',runtime.managerPath||''))}${label('运行路径',`<textarea>${esc((runtime.runtimePaths||[]).join('\n'))}</textarea>`)}</div>${disclosure('仓库工具版本',`<pre contenteditable="true">${esc(JSON.stringify(runtime.requirements||{},null,2))}</pre>`)}${footer()}`;
    if(section==='production'){
      const repos=new Map();for(const w of data.snapshot.workspaces)for(const r of w.material.repositories)if(!repos.has(r.repositoryId))repos.set(r.repositoryId,r);
      return `<div class="notice">${icon('branch',15)}<p>生产覆盖由 Git 核验。模型只归纳内容，不决定是否上线。</p></div><div class="setting-card"><h2>各仓库生产分支</h2>${[...repos.values()].map(r=>label(r.repositoryId,input('ref-'+r.repositoryId,r.productionRef||'','class="mono"'))).join('')}</div><div class="setting-card">${label('焦点或刷新时最短获取间隔（分钟）',input('fetch-interval',data.policy.fetchIntervalSeconds/60,'type="number"'))}</div>${footer()}`;
    }
    if(section==='repositories')return `<div class="setting-card"><h2>项目配置</h2><div class="path mono">${esc(data.project.configPath)}</div></div><div class="setting-card"><h2>仓库选择</h2>${Object.keys(runtime.requirements||{}).map(id=>`<label class="todo"><input type="checkbox" checked><span>${esc(id)}</span></label>`).join('')||'<span class="muted xs">进入项目仓库扫描与选择</span>'}</div>${disclosure('Gitlink 聚合范围','<div class="xs muted">已选仓库与关联工作区。现有执行和审核范围不会随此设置扩大。</div>')}${footer()}`;
    if(section==='recovery')return `<div class="setting-card"><div class="row between"><h2>启用自动恢复</h2>${toggleSwitch(false,'toggle-recovery','启用自动恢复')}</div>${label('恢复方式',select('recovery-method',[['continue','发送继续消息'],['auto','自动选择宿主支持方式']],'continue'))}${label('继续消息','<textarea placeholder="配置继续执行时发送的消息"></textarea>')}<div class="field-grid">${label('重试间隔（秒）',input('retry','60','type="number"'))}${label('最长时限（分钟）',input('retry-limit','','type="number" placeholder="不限制"'))}</div></div>${disclosure('单会话覆盖','<div class="xs muted">默认继承主机；可对每个会话单独启用或停用。</div>')}${footer()}`;
    if(section==='topics')return `<div class="setting-card"><h2>档案话题连接</h2>${label('服务地址',input('topic-url','','placeholder="沿用现有话题服务配置"'))}${label('访问凭据','<input type="password" placeholder="留空保留原凭据">')}${button('preview-topic-test','检测连接','btn small')}</div><div class="setting-lines">${[['关注群','项目关注范围与远端发现策略分开'],['投递偏好','原文、附件选择与目标会话'],['历史投递记录','冻结资料与投递回执']].map(([h,p])=>`<button class="setting-line" data-action="preview-only"><span class="grow"><h3>${h}</h3><p>${p}</p></span>${icon('chevron',14)}</button>`).join('')}</div>${footer()}`;
    if(section==='files')return `<div class="setting-card">${label('测试文件显示',select('test-display',[['all','正常显示'],['dim','淡化'],['hide','隐藏']],'all'))}${label('测试文件匹配规则','<textarea placeholder="按现有项目规则继承"></textarea>')}</div>${footer()}`;
    return `<div class="setting-card"><h2>连接与运行状态</h2><div class="row between sm"><span>本机 Sushi</span><span class="pill green">${data.modelReady?'模型已就绪':'待检测'}</span></div><div class="row between sm"><span>项目正式摘要</span><span>${data.snapshot.workspaces.filter(w=>w.fingerprint).length} / ${data.snapshot.workspaces.length}</span></div><div class="row between sm"><span>原生标题修改</span><span>${data.snapshot.targets.reduce((n,t)=>n+(t.history?.length||0),0)} 次</span></div><div class="row between sm"><span>本设计稿模型试验</span><span>${attempts.size} 次 · ${[...attempts.values()].filter(e=>e.test.state==='failed').length} 次未采纳</span></div></div>${backgroundTask()}${[...attempts.values()].reverse().map(e=>disclosure(`<span class="row">${icon('model',14)}<span class="clamp grow">${esc(e.workspaceId)}</span><span class="pill ${e.test.state==='complete'?'green':'amber'}">${e.test.state==='complete'?'已生成':e.test.state==='failed'?'未采纳':'运行中'}</span></span>`,e.test.run?`${e.test.state==='failed'?`<div class="error-box">${esc(errorMessage(e))}</div>`:''}<div class="xs muted">${time(e.test.run.at)} · ${((e.test.run.elapsedMs||0)/1000).toFixed(1)} 秒</div><pre>${esc(e.test.run.output||e.test.run.error||'等待响应')}</pre>`:'<span class="xs muted">运行中</span>')).join('')}`;
  }
  function sampleTitle(){return [...ownRuns.values()].map(parsedResult).find(Boolean)?.title||'具体需求的稳定短标题';}
  function updateSave(){app.querySelector('[data-testid="save-design"]')?.classList.add('dirty');}
  function modal(html){document.getElementById('modal-root').innerHTML=`<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;document.querySelectorAll('#modal-root [data-action]').forEach(el=>el.addEventListener('click',()=>action(el.dataset.action,el.dataset.value)));}
  function closeModal(){document.getElementById('modal-root').innerHTML='';}
  async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;}
  async function generate(){
    const w=selectedWorkspace();if(!w||!data.live||state.busy)return;state.busy=true;state.error='';
    try{const entry=await api('/api/generate',{workspaceId:w.material.workspaceId});ownRuns.set(w.material.workspaceId,entry);attempts.set(entry.test.id,entry);render();poll(entry.test.id);}catch(error){state.error=error.message;render();}finally{state.busy=false;}
  }
  async function poll(id){
    try{const entry=await api('/api/run?id='+encodeURIComponent(id));ownRuns.set(entry.workspaceId,entry);attempts.set(entry.test.id,entry);render();if(['queued','running'].includes(entry.test.state))setTimeout(()=>poll(id),1000);}catch(error){state.error=error.message;render();}
  }
  async function action(name,value){
    if(name==='nav-summary'){state.page='summary';state.selected=null;render();scrollTo({top:0});return;}
    if(name==='nav-settings'||name==='settings-home'){goSettings('home');return;}
    if(name==='scope-current'||name==='scope-project'){state.scope=name==='scope-current'?'current':'project';render();return;}
    if(name==='filter'){state.filter=value;render();return;}
    if(name==='open-session'){state.selected=value;state.workspace=representative(getTarget(value))?.key||null;state.error='';render();scrollTo({top:0});return;}
    if(name==='back-summary'){state.selected=null;state.error='';render();scrollTo({top:0});return;}
    if(name==='settings-model'||name==='settings-rules'||name==='settings-topics'){goSettings(name.slice(9));return;}
    if(name==='settings-open'){goSettings(value);return;}
    if(name==='toggle-auto'){state.draft.enabled=!state.draft.enabled;render();notify('设计草稿：自动整理'+(state.draft.enabled?'开启':'关闭')+'，尚未写入插件');return;}
    if(name==='save-design'){notify('已保存在本设计稿中，现有插件配置未改动');return;}
    if(name==='settings-context'){modal(`<h2>编辑目标</h2><div class="settings-context">${icon('folder',14)}${esc(data.project.name)}<span class="pill gray" style="margin-left:auto">固定项目</span></div>${label('作用范围',select('settings-scope',[['project','当前项目覆盖'],['host','主机默认']],state.settingsScope))}<div class="xs muted">未覆盖项继承主机默认。切换会话焦点不改变编辑目标。</div><div class="modal-actions">${button('close-modal','取消','btn quiet')}${button('apply-scope','确认','btn primary')}</div>`);return;}
    if(name==='apply-scope'){state.settingsScope=document.getElementById('settings-scope').value;closeModal();render();return;}
    if(name==='check-model'){if(!data.live){notify('离线稿保留真实检测结果；在线设计稿可重新检测连接');return;}state.modelStatus='正在检测现有模型…';render();try{const r=await api('/api/model');state.modelStatus=r.selectedAvailable?'连接成功 · 指定模型 loaded / ready':'连接可达，指定模型尚未就绪';}catch(e){state.modelStatus=e.message;}render();return;}
    if(name==='generate'){await generate();return;}
    if(name==='start-model-sample'){state.page='summary';state.selected=data.snapshot.targets[0]?.id;state.workspace=null;render();scrollTo({top:0});return;}
    if(name==='cancel-generation'){const entry=entryFor(selectedWorkspace());if(entry){await api('/api/cancel',{id:entry.test.id});await poll(entry.test.id);}return;}
    if(name==='confirm-title'){
      const t=getTarget(state.selected),entry=entryFor(selectedWorkspace()),r=parsedResult(entry);
      modal(`<div class="row between"><h2>确认标题变更</h2>${button('close-modal',icon('close',15),'icon-btn','aria-label="关闭"')}</div><div><div class="label-small">当前标题</div><div class="old-title">${esc(t.currentTitle)}</div></div><div class="divider-line"></div><div><div class="label-small">拟用标题</div><div class="new-title">${esc((symbols[t.state]||'?')+' '+r.title)}</div></div><label class="todo"><input type="checkbox"><span>应用后继续维护（仍受总开关与范围控制）</span></label><div class="notice warning">${icon('info',15)}<p>这是确认步骤的设计预览。本次没有开放原生标题写入。</p></div><div class="modal-actions">${button('close-modal','返回核对','btn')}${button('prototype-apply','确认应用','btn primary')}</div>`);return;
    }
    if(name==='prototype-apply'){closeModal();notify('已演示确认步骤，原生标题保持原值');return;}
    if(name==='close-modal'){closeModal();return;}
    if(name.startsWith('toggle-')){notify('已预览此开关操作，现有配置未改变');return;}
    if(name==='space-preview'){notify('空间管理将打开现有扫描与清理预览');return;}
    if(name==='other'){notify('本次设计预览聚焦“摘要”和“设置”，原有页保留');return;}
    notify('已展示该配置入口；实际设置仍由现有服务保存');
  }
  function updateElapsed(){for(const el of document.querySelectorAll('.elapsed')){const seconds=Math.max(0,Math.round((Date.now()-Date.parse(el.dataset.start))/1000));el.textContent=seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';}}
  const route=new URLSearchParams(location.search);
  if(route.has('settings')){state.page='settings';state.settings=route.get('settings')||'home';}
  if(route.get('view')==='result'&&data.snapshot.targets[0]){state.selected=data.snapshot.targets[0].id;state.workspace=representative(data.snapshot.targets[0])?.key||null;}
  render();setInterval(updateElapsed,1000);
  if(data.live)setInterval(async()=>{if(document.visibilityState!=='visible')return;try{const progress=await api('/api/progress');data.snapshot.jobs=progress.jobs;for(const container of app.querySelectorAll('[data-progress-container]'))container.outerHTML=backgroundTask();}catch{}},4000);
  for(const entry of ownRuns.values())if(['queued','running'].includes(entry.test.state)&&data.live)void poll(entry.test.id);
  window.WORKBENCH_DESIGN={data,state,render,goSettings,ownRuns};
})();
