import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ScrollView } from "../native-components";
import { handoffMaterials, type BundleRef } from "../../shared/handoff-materials";
import { useQueryContinuity } from '../query-continuity';
import { useWorkbenchCopy } from "../i18n";
import type { makeStyles } from "./ui";

type ReadResult = { content: string; nextOffset: number | null; parent?: BundleRef; sourceCount: number; requiredSources: string[]; blockers: string[]; warnings: string[]; conversation: { state: string; messages: number }; fetched: string[] };
export function HandoffMaterialsCard({ projectConfig, workspaceId, bundle, styles }: { projectConfig: string; workspaceId: string; bundle: BundleRef; styles: ReturnType<typeof makeStyles> }) {
  const copy = useWorkbenchCopy();
  const read = useRpc(handoffMaterials);
  const [open, setOpen] = useState(false), [file, setFile] = useState("HANDOFF.md"), [offset, setOffset] = useState(0), [version, setVersion] = useState(bundle.version);
  const pageKey = ["handoff-materials", projectConfig, workspaceId, bundle.id, version, file, offset];
  const query = useQuery({ queryKey: pageKey,
    enabled: open, queryFn: async () => await read({ projectConfig, workspaceId, bundle: { id: bundle.id, version }, action: "read", file, offset }) as ReadResult,
  });
  const { displayed: page } = useQueryContinuity<ReadResult>(JSON.stringify([projectConfig, workspaceId, bundle.id, version, file]), pageKey, query.data, data => data as ReadResult | undefined);
  return <View>
    <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.handoffMaterials} · V{version}</Text></Pressable>
    {open ? <View>
      <View style={styles.reviewTagRow}>{["HANDOFF.md", "SOURCES.md"].map(name => <Pressable key={name} accessibilityRole="button" onPress={() => { setFile(name); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{name}</Text></Pressable>)}</View>
      {query.isError ? <Text style={styles.warningText}>{copy.handoffMaterialsUnavailable}</Text> : null}
      {page ? <>
        <Text style={styles.reviewEntryMeta}>{copy.handoffMaterials}: {page.sourceCount} · {copy.handoffConversation}: {page.conversation.state} ({page.conversation.messages})</Text>
        <Text style={styles.reviewEntryMeta}>{copy.handoffRequired}: {page.requiredSources.join(", ") || "—"}</Text>
        <Text style={styles.warningText}>{[...page.blockers, ...page.warnings].join("\n")}</Text>
        <ScrollView style={{ maxHeight: 320 }}><Text selectable style={styles.reviewEntryMeta}>{page.content}</Text></ScrollView>
        <Text style={styles.reviewEntryMeta}>{copy.handoffFetched}: {page.fetched?.join(", ")}</Text>
        <View style={styles.reviewTagRow}>
          {page.nextOffset !== null ? <Pressable accessibilityRole="button" disabled={query.isFetching} onPress={() => { if (query.isError) void query.refetch(); else setOffset(page!.nextOffset!); }} style={styles.secondaryButton}>{query.isFetching ? <ActivityIndicator size="small" /> : null}<Text style={styles.secondaryButtonText}>{copy.handoffNextPage}</Text></Pressable> : null}
          {page.parent ? <Pressable accessibilityRole="button" onPress={() => { setVersion(page!.parent!.version); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>V{page.parent.version}</Text></Pressable> : null}
          {version !== bundle.version ? <Pressable accessibilityRole="button" onPress={() => { setVersion(bundle.version); setOffset(0); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>V{bundle.version}</Text></Pressable> : null}
        </View>
      </> : null}
    </View> : null}
  </View>;
}
