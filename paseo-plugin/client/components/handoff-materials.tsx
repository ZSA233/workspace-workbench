import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, Text, View } from "react-native";
import { handoffMaterials, type BundleRef } from "../../shared/handoff-materials";
import { useWorkbenchCopy } from "../i18n";
import type { makeStyles } from "./ui";

type ReadResult = { content: string; nextOffset: number | null; parent?: BundleRef; sourceCount: number; requiredSources: string[]; blockers: string[]; warnings: string[]; conversation: { state: string; messages: number }; fetched: string[] };
export function HandoffMaterialsCard({ projectConfig, workspaceId, bundle, styles }: { projectConfig: string; workspaceId: string; bundle: BundleRef; styles: ReturnType<typeof makeStyles> }) {
  const copy = useWorkbenchCopy();
  const read = useRpc(handoffMaterials);
  const [open, setOpen] = useState(false), [file, setFile] = useState("HANDOFF.md"), [offset, setOffset] = useState(0), [version, setVersion] = useState(bundle.version);
  const query = useQuery({ queryKey: ["handoff-materials", projectConfig, workspaceId, bundle.id, version, file, offset],
    enabled: open, queryFn: async () => await read({ projectConfig, workspaceId, bundle: { id: bundle.id, version }, action: "read", file, offset }) as ReadResult,
  });
  return <View>
    <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.handoffMaterials} · V{version}</Text></Pressable>
    {open ? <View>
      <View style={styles.reviewTagRow}>{["HANDOFF.md", "SOURCES.md"].map(name => <Pressable key={name} accessibilityRole="button" onPress={() => { setFile(name); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{name}</Text></Pressable>)}</View>
      {query.isError ? <Text style={styles.warningText}>{copy.handoffMaterialsUnavailable}</Text> : null}
      {query.data ? <>
        <Text style={styles.reviewEntryMeta}>{copy.handoffMaterials}: {query.data.sourceCount} · {copy.handoffConversation}: {query.data.conversation.state} ({query.data.conversation.messages})</Text>
        <Text style={styles.reviewEntryMeta}>{copy.handoffRequired}: {query.data.requiredSources.join(", ") || "—"}</Text>
        <Text style={styles.warningText}>{[...query.data.blockers, ...query.data.warnings].join("\n")}</Text>
        <ScrollView style={{ maxHeight: 320 }}><Text selectable style={styles.reviewEntryMeta}>{query.data.content}</Text></ScrollView>
        <Text style={styles.reviewEntryMeta}>{copy.handoffFetched}: {query.data.fetched?.join(", ")}</Text>
        <View style={styles.reviewTagRow}>
          {query.data.nextOffset !== null ? <Pressable accessibilityRole="button" onPress={() => setOffset(query.data!.nextOffset!)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.handoffNextPage}</Text></Pressable> : null}
          {query.data.parent ? <Pressable accessibilityRole="button" onPress={() => { setVersion(query.data!.parent!.version); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>V{query.data.parent.version}</Text></Pressable> : null}
          {version !== bundle.version ? <Pressable accessibilityRole="button" onPress={() => { setVersion(bundle.version); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>V{bundle.version}</Text></Pressable> : null}
        </View>
      </> : null}
    </View> : null}
  </View>;
}
