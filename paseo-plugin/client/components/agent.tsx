import {executionBindingState} from "../execution-binding-state";
import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { ActivityIndicator,Pressable,Text,View } from "react-native";
import { copy,type WorkbenchCopy } from "../../shared/copy";

import { useWorkbenchCopy } from "../i18n";
import { makeStyles } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;




export function executionStatusLabel(status: string | undefined | null, strings: WorkbenchCopy = copy): string {
  const labels: Record<string, string> = {
    pending: strings.text_15c5640f77,
    initializing: strings.text_fb0309dda4,
    running: strings.text_1f425b6bf0,
    idle: strings.text_837e7a109a,
    permission: strings.text_4c5958e011,
    completed: strings.text_e99b48a29b,
    blocked: strings.text_059c4d4016,
    error: strings.text_9746cfc7d2,
    closed: strings.text_f628761bf5,
    archived: strings.text_5cfbea2b76,
    "not-started": strings.text_87f8d08d81,
  };
  return labels[status || "not-started"] || status || strings.text_87f8d08d81;
}

export function executionStatusColor(status: string | undefined | null, theme: PanelProps["theme"]): string {
  if (["permission", "blocked"].includes(status || "")) return theme.colors.statusWarning;
  if (["error"].includes(status || "")) return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export function ExecutionSessionDetails({execution,refreshing,canDelegate,agentContextState,delegating,onDelegate,onOpenAgent,onRetry,theme,styles}:{
  execution: ReturnType<typeof executionBindingState>;
  refreshing:boolean;canDelegate:boolean;agentContextState?:"ready"|"loading"|"unavailable"|"missing";
  delegating:boolean;onDelegate():void;onOpenAgent?:()=>void;onRetry():void;
  theme:PanelProps["theme"];styles:ReturnType<typeof makeStyles>;
}) {
  const strings=useWorkbenchCopy(),{binding,agent,status,state,error,stale}=execution;
  const row=(label:string,value:string)=><View style={{flexDirection:'row',gap:12,paddingVertical:5}}><Text style={{color:theme.colors.foregroundMuted,fontSize:12,width:76}}>{label}</Text><Text selectable style={{color:theme.colors.foreground,fontSize:12,flex:1}}>{value}</Text></View>;
  return <View testID="execution-session-details" style={{gap:8}}>
    {state==='loading'?<View style={{flexDirection:'row',gap:8}}><ActivityIndicator color={theme.colors.foregroundMuted}/><Text style={styles.layoutMenuHint}>{strings.text_b21b631cd5}</Text></View>:null}
    {state==='none'?<Text style={styles.layoutMenuHint}>{strings.executionUnbound}</Text>:null}
    {state==='failed'?<Text style={styles.warningText}>{strings.executionReadFailed}</Text>:null}
    {stale?<Text style={styles.warningText}>{strings.executionStale}</Text>:null}
    {error?<Text selectable style={styles.warningText}>{error}</Text>:null}
    {binding?<>
      <Text selectable style={styles.executionStatusText}>{binding.agentId||strings.executionNotObserved}</Text>
      {row(strings.executionStatus,status?executionStatusLabel(status,strings):strings.executionNotObserved)}
      {row(strings.executionRelationship,binding.relationship==='child'?strings.reviewSettingsChildAgent:binding.relationship==='independent'?strings.reviewSettingsIndependent:strings.executionNotObserved)}
      {row(strings.executionMode,agent?.planningState==='plan'?strings.executionPlan:agent?.planningState==='execute'?strings.executionExecute:strings.executionNotObserved)}
      {row(strings.executionPermission,agent?.permissionModeId||strings.executionNotObserved)}
      {!onOpenAgent&&binding.agentId?<Text style={styles.layoutMenuHint}>{strings.executionUnavailable}</Text>:null}
    </>:null}
    {!canDelegate&&!binding?<Text style={styles.layoutMenuHint}>{agentContextState==='loading'?strings.agentContextLoading:agentContextState==='unavailable'?strings.agentContextUnavailable:strings.agentCoordinatorRequired}</Text>:null}
    <View style={[styles.briefActions,{flexWrap:'wrap'}]}>
      {onOpenAgent?<Pressable accessibilityRole="button" onPress={onOpenAgent} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{strings.executionOpen}</Text></Pressable>:null}
      <Pressable accessibilityRole="button" disabled={refreshing} onPress={onRetry} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{strings.executionReadRetry}</Text></Pressable>
      {canDelegate&&['error','blocked','closed'].includes(status||'')?<Pressable accessibilityRole="button" disabled={delegating} onPress={onDelegate} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{strings.text_2b6021df2f}</Text></Pressable>:null}
    </View>
  </View>;
}
