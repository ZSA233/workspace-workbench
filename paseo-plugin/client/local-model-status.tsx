import {useQuery} from '@tanstack/react-query';
import {View} from 'react-native';
import {Button,Label,Row,Field,Section} from './extensions/project-communications/ui';
import type {OrganizerInput} from '../shared/organizer';

type Counts={requests:number;complete:number;timeout:number;failed:number;cancelled:number};
export function LocalModelStatus({call,concurrency,onConcurrency}:{call<T>(request:OrganizerInput['request'],project?:string):Promise<T>;concurrency:number;onConcurrency(value:number):void}){
 const status=useQuery({queryKey:['workbench-model-queue'],queryFn:()=>call<{running:number;waiting:number;concurrency:number;tasks:Array<{label:string;purpose?:string;state:string;project?:string;jobId?:string;testId?:string}>}>({action:'model.status'}),refetchInterval:q=>q.state.data?.running||q.state.data?.waiting?1000:15000,retry:false});
 const metrics=useQuery({queryKey:['workbench-model-metrics'],queryFn:()=>call<{since:string;lastHour:Counts;today:Counts;lastHourComplete:boolean}>({action:'model.metrics'}),refetchInterval:15000,retry:false});
 return <Section title="Workbench 队列与用量" collapsible initiallyOpen={false}>
  <Field label="本机并发数（1—4）" value={String(concurrency)} onChange={value=>onConcurrency(Number(value))}/>
  <Row><Label>运行 {status.data?.running??0}</Label><Label muted>等待 {status.data?.waiting??0}</Label></Row>
  {status.data?.tasks.map((task,index)=><Row key={task.jobId||task.testId||index}><View style={{flex:1,minWidth:0}}><Label lines={1}>{task.label}</Label><Label muted>{task.state==='running'?'执行中':'排队中'}{task.purpose?' · '+task.purpose:''}</Label></View>{task.jobId||task.testId?<Button variant="link" onPress={()=>{void call(task.jobId?{action:'cancel',jobId:task.jobId}:{action:'profile.test.cancel',testId:task.testId!},task.project).then(()=>status.refetch());}}>取消</Button>:null}</Row>)}
  {metrics.data?<View style={{gap:5}}><Row><Label>近一小时 {metrics.data.lastHour.requests} 次</Label><Label muted>今日 {metrics.data.today.requests} 次</Label></Row><Label muted>成功 {metrics.data.lastHour.complete} · 超时 {metrics.data.lastHour.timeout} · 失败 {metrics.data.lastHour.failed} · 取消 {metrics.data.lastHour.cancelled}</Label><Label muted>统计自 {new Date(metrics.data.since).toLocaleString()}</Label></View>:null}
  {status.error||metrics.error?<Label warning>暂时无法读取本机任务记录</Label>:null}
 </Section>;
}
