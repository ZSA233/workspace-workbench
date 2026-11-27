/** One host queue shared by tests and project analysis. Admission is bounded. */
type Options={signal?:AbortSignal;priority?:number;label?:string};
type Pending={start():void;reject(error:Error):void;cleanup():void;at:number;options:Options};
export class OrganizerModelQueue {
  private active=0;
  private pending:Pending[]=[];
  private results=new Set<Promise<unknown>>();
  private limit:()=>number;
  constructor(limit:()=>number){this.limit=limit;}
  status(){return{running:this.active,waiting:this.pending.length,concurrency:this.limit(),pending:this.pending.map(p=>({label:p.options.label,priority:p.options.priority||0,queuedAt:new Date(p.at).toISOString()}))};}
  changed(){this.pump();}
  promote(signal:AbortSignal,priority:number){for(const p of this.pending)if(p.options.signal===signal)p.options.priority=Math.min(priority,p.options.priority??2);this.pump();}
  private pump(){this.pending.sort((a,b)=>(a.options.priority===0?0:Date.now()-a.at>30_000?1:(a.options.priority??2)+1)-(b.options.priority===0?0:Date.now()-b.at>30_000?1:(b.options.priority??2)+1)||a.at-b.at);while(this.pending.length&&this.active<this.limit()){const p=this.pending.shift()!;p.cleanup();this.active++;p.start();}}
  run<T>(work:()=>Promise<T>,options:Options={}):Promise<T>{
    if(options.signal?.aborted)return Promise.reject(Error('organizer_cancelled'));
    if(this.pending.length>=32)throw Error('organizer_model_queue_full');
    const result=new Promise<T>((resolve,reject)=>{const abort=()=>{const i=this.pending.indexOf(item);if(i>=0){this.pending.splice(i,1);item.cleanup();reject(Error('organizer_cancelled'));}};const item:Pending={at:Date.now(),options,reject,cleanup:()=>options.signal?.removeEventListener('abort',abort),start:()=>{void Promise.resolve().then(()=>{if(options.signal?.aborted)throw Error('organizer_cancelled');return work();}).then(resolve,reject).finally(()=>{this.active--;this.pump();});}};this.pending.push(item);options.signal?.addEventListener('abort',abort,{once:true});});
    this.results.add(result);void result.finally(()=>this.results.delete(result)).catch(()=>{});this.pump();return result;
  }
  async idle(){await Promise.allSettled([...this.results]);}
}
