/** One host queue shared by tests and project analysis. Admission is bounded. */
export class OrganizerModelQueue {
  private active=0;
  private pending:Array<()=>void>=[];
  private results=new Set<Promise<unknown>>();
  private limit:()=>number;
  constructor(limit:()=>number){this.limit=limit;}
  private pump(){while(this.pending.length&&this.active<this.limit()){this.active++;this.pending.shift()!();}}
  run<T>(work:()=>Promise<T>):Promise<T>{
    if(this.pending.length>=32)throw Error('organizer_model_queue_full');
    const result=new Promise<T>((resolve,reject)=>{this.pending.push(()=>{void Promise.resolve().then(work).then(resolve,reject).finally(()=>{this.active--;this.pump();});});});
    this.results.add(result);void result.finally(()=>this.results.delete(result)).catch(()=>{});this.pump();return result;
  }
  async idle(){await Promise.allSettled([...this.results]);}
}
