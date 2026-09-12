import { View } from "react-native";

import { GRAPH_LANE_WIDTH, GRAPH_ROW_HEIGHT } from "./constants";
import { graphLanePalette } from "./palette";
import type { GraphCanvasProps } from "./types";
import { sampleCurve } from "./geometry";

const NATIVE_STROKE_WIDTH = 1.5;
const NATIVE_NODE_SIZE = 12;
const NATIVE_JOIN_OVERLAP = 1;

export function GraphCanvasNative({
  rows,
  width,
  height,
  selectedCommit,
  showWorktree,
  worktreeSelected,
  theme,
}: GraphCanvasProps) {
  const palette = graphLanePalette(theme);
  const rowOffset = showWorktree ? 1 : 0;
  const worktreeX = 8;
  const worktreeCenter = GRAPH_ROW_HEIGHT / 2;
  const headX = rows[0] ? rows[0].lane * GRAPH_LANE_WIDTH + 8 : worktreeX;
  const headCenter = GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
  return (
    <View pointerEvents="none" style={{ height, left: 0, position: "absolute", top: 0, width }}>
      {showWorktree ? (
        <>
          {rows.length ? <GraphSegment x1={worktreeX} y1={worktreeCenter} x2={headX} y2={headCenter} color={theme.colors.statusWarning} opacity={0.65} /> : null}
          <GraphNode
            color={theme.colors.statusWarning}
            filled={worktreeSelected}
            surface={theme.colors.surface2}
            x={worktreeX}
            y={worktreeCenter}
          />
        </>
      ) : null}
      {rows.flatMap((row, rowIndex) => {
        const top = (rowIndex + rowOffset) * GRAPH_ROW_HEIGHT;
        const center = top + GRAPH_ROW_HEIGHT / 2;
        const bottom = top + GRAPH_ROW_HEIGHT;
        const incoming = Array.from({ length: row.lanesBefore.length }, (_, lane) => {
          const x = lane * GRAPH_LANE_WIDTH + 8;
          const incomingColor = row.node.isBase
            ? theme.colors.foregroundMuted
            : palette[(row.laneColorsBefore[lane] || 0) % palette.length];
          return <GraphRail key={`incoming-${row.node.sha}-${lane}`} color={incomingColor} x={x} top={top - (rowIndex > 0 ? NATIVE_JOIN_OVERLAP : 0)} bottom={center} />;
        });
        const connectedLanes = new Set<number>();
        const outgoing = row.laneTransitions.map((transition, transitionIndex) => {
          if (!transition.terminal) connectedLanes.add(transition.to);
          const fromX = transition.from * GRAPH_LANE_WIDTH + 8;
          const toX = transition.to * GRAPH_LANE_WIDTH + 8;
          const transitionColor = row.node.isBase
            ? theme.colors.foregroundMuted
            : palette[(transition.colorIndex ?? row.colorIndex) % palette.length];
          if (transition.from === transition.to) {
            return <GraphRail key={`outgoing-${row.node.sha}-${transition.sha}-${transitionIndex}`} color={transitionColor} opacity={transition.terminal ? 0.65 : 1} x={toX} top={center} bottom={bottom} />;
          }
          return <GraphSegment key={`segment-${row.node.sha}-${transition.sha}-${transitionIndex}`} color={transitionColor} opacity={transition.terminal ? 0.65 : 1} x1={fromX} y1={center} x2={toX} y2={bottom} />;
        });
        row.lanesAfter.forEach((_, lane) => {
          if (connectedLanes.has(lane)) return;
          const x = lane * GRAPH_LANE_WIDTH + 8;
          const outgoingColor = row.node.isBase
            ? theme.colors.foregroundMuted
            : palette[(row.laneColorsAfter[lane] || row.colorIndex) % palette.length];
          outgoing.push(<GraphRail key={`unconnected-${row.node.sha}-${lane}`} color={outgoingColor} x={x} top={center} bottom={bottom} />);
        });
        const dotColor = row.node.isBase
          ? theme.colors.foregroundMuted
          : palette[row.colorIndex % palette.length];
        const filled = row.node.isBase || row.node.sha === selectedCommit;
        const node = <GraphNode key={`node-${row.node.sha}`} color={dotColor} filled={filled} surface={theme.colors.surface2} x={row.lane * GRAPH_LANE_WIDTH + 8} y={center} />;
        return [...incoming, ...outgoing, node];
      })}
    </View>
  );
}

function GraphRail({
  color,
  opacity = 1,
  x,
  top,
  bottom,
}: {
  color: string;
  opacity?: number;
  x: number;
  top: number;
  bottom: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: color,
        borderRadius: NATIVE_STROKE_WIDTH / 2,
        height: Math.max(0, bottom - top),
        left: x - NATIVE_STROKE_WIDTH / 2,
        opacity,
        position: "absolute",
        top,
        width: NATIVE_STROKE_WIDTH,
      }}
    />
  );
}

function GraphSegment({
  color,
  opacity = 1,
  x1,
  y1,
  x2,
  y2,
}: {
  color: string;
  opacity?: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
  const points = sampleCurve({ x: x1, y: y1 }, { x: x2, y: y2 });
  return <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, opacity }}>
    {points.slice(1).map((point, index) => <StraightSegment key={index} color={color} x1={points[index].x} y1={points[index].y} x2={point.x} y2={point.y} />)}
    {points.map((point, index) => <View key={`join-${index}`} style={{ position: "absolute", left: point.x - NATIVE_STROKE_WIDTH / 2, top: point.y - NATIVE_STROKE_WIDTH / 2, width: NATIVE_STROKE_WIDTH, height: NATIVE_STROKE_WIDTH, borderRadius: NATIVE_STROKE_WIDTH, backgroundColor: color }} />)}
  </View>;
}

function StraightSegment({ color, x1, y1, x2, y2 }: { color: string; x1: number; y1: number; x2: number; y2: number }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!length) return null;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: color,
        borderRadius: NATIVE_STROKE_WIDTH / 2,
        height: NATIVE_STROKE_WIDTH,
        left: (x1 + x2) / 2 - (length + NATIVE_JOIN_OVERLAP) / 2,
        position: "absolute",
        top: (y1 + y2) / 2 - NATIVE_STROKE_WIDTH / 2,
        transform: [{ rotate: `${angle}deg` }],
        width: length + NATIVE_JOIN_OVERLAP,
      }}
    />
  );
}

function GraphNode({
  color,
  filled,
  surface,
  x,
  y,
}: {
  color: string;
  filled: boolean;
  surface: string;
  x: number;
  y: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: filled ? color : surface,
        borderColor: color,
        borderRadius: NATIVE_NODE_SIZE / 2,
        borderWidth: 2,
        height: NATIVE_NODE_SIZE,
        left: x - NATIVE_NODE_SIZE / 2,
        position: "absolute",
        top: y - NATIVE_NODE_SIZE / 2,
        width: NATIVE_NODE_SIZE,
        zIndex: 3,
      }}
    />
  );
}
