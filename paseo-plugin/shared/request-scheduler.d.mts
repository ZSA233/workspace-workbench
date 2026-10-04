export type ScheduledContext = {signal:AbortSignal;deadline:number;diagnose(event:{phase:string;[key:string]:unknown}):void};
export function createRequestScheduler(options?: {concurrency?:number;queueLimit?:number;controlConcurrency?:number;now?:()=>number;schedule?:(callback:()=>void,delay:number)=>any;unschedule?:(handle:any)=>void}): {
  submit<T>(request:{id:string|number;deadline:number;control?:boolean;run(context:ScheduledContext):Promise<T>|T;respond(error:unknown,value:T):void;diagnose?:(event:unknown)=>void}):void;
  cancel(id:string|number,reason?:string):void;
  close():void;
  health():{active:number;queued:number};
};
