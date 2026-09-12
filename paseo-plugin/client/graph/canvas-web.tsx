import { GRAPH_LANE_WIDTH, GRAPH_ROW_HEIGHT } from "./constants";
import { graphLanePalette } from "./palette";
import type { GraphCanvasProps } from "./types";

const WEB_STROKE_WIDTH = 1.5;
const WEB_NODE_RADIUS = 5;

export function GraphCanvasWeb({
  rows,
  width,
  height,
  selectedCommit,
  showWorktree,
  worktreeSelected,
  theme,
}: GraphCanvasProps) {
  // Keep this require inside the Web renderer. Android does not evaluate this
  // DOM-backed SVG entry point, so the native renderer remains dependency-safe.
  const svgElements = require("react-native-svg/lib/module/elements.web.js");
  const Svg = svgElements.default;
  const Circle = svgElements.Circle;
  const Path = svgElements.Path;
  const palette = graphLanePalette(theme);
  const rowOffset = showWorktree ? 1 : 0;
  const worktreeX = 8;
  const worktreeCenter = GRAPH_ROW_HEIGHT / 2;
  const headX = rows[0] ? rows[0].lane * GRAPH_LANE_WIDTH + 8 : worktreeX;
  const headCenter = GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
  return (
    <Svg
      height={height}
      pointerEvents="none"
      style={{ height, left: 0, position: "absolute", top: 0, width }}
      width={width}
    >
      {showWorktree ? (
        <>
          {rows.length ? (
            <Path
              d={`M ${worktreeX} ${worktreeCenter} C ${worktreeX} ${worktreeCenter + 8}, ${headX} ${headCenter - 8}, ${headX} ${headCenter}`}
              fill="none"
              stroke={theme.colors.statusWarning}
              strokeDasharray="3 3"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.65}
              strokeWidth={WEB_STROKE_WIDTH}
            />
          ) : null}
          <Circle
            cx={worktreeX}
            cy={worktreeCenter}
            fill={worktreeSelected ? theme.colors.statusWarning : theme.colors.surface2}
            r={WEB_NODE_RADIUS}
            stroke={theme.colors.statusWarning}
            strokeDasharray="2 2"
            strokeWidth={WEB_STROKE_WIDTH}
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
          return (
            <Path
              key={`incoming-${row.node.sha}-${lane}`}
              d={`M ${x} ${top} L ${x} ${center}`}
              fill="none"
              stroke={incomingColor}
              strokeLinecap="round"
              strokeWidth={WEB_STROKE_WIDTH}
            />
          );
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
            return (
              <Path
                key={`outgoing-${row.node.sha}-${transition.sha}-${transitionIndex}`}
                d={`M ${toX} ${center} L ${toX} ${bottom}`}
                fill="none"
                stroke={transitionColor}
                strokeDasharray={transition.terminal ? "3 3" : undefined}
                strokeLinecap="round"
                strokeOpacity={transition.terminal ? 0.65 : 1}
                strokeWidth={WEB_STROKE_WIDTH}
              />
            );
          }
          return (
            <Path
              key={`curve-${row.node.sha}-${transition.sha}-${transitionIndex}`}
              d={`M ${fromX} ${center} C ${fromX} ${center + 8}, ${toX} ${bottom - 8}, ${toX} ${bottom}`}
              fill="none"
              stroke={transitionColor}
              strokeDasharray={transition.terminal ? "3 3" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={transition.terminal ? 0.65 : 1}
              strokeWidth={WEB_STROKE_WIDTH}
            />
          );
        });
        row.lanesAfter.forEach((_, lane) => {
          if (connectedLanes.has(lane)) return;
          const x = lane * GRAPH_LANE_WIDTH + 8;
          const outgoingColor = row.node.isBase
            ? theme.colors.foregroundMuted
            : palette[(row.laneColorsAfter[lane] || row.colorIndex) % palette.length];
          outgoing.push(
            <Path
              key={`unconnected-${row.node.sha}-${lane}`}
              d={`M ${x} ${center} L ${x} ${bottom}`}
              fill="none"
              stroke={outgoingColor}
              strokeLinecap="round"
              strokeWidth={WEB_STROKE_WIDTH}
            />,
          );
        });
        const dotColor = row.node.isBase
          ? theme.colors.foregroundMuted
          : palette[row.colorIndex % palette.length];
        const filled = row.node.isBase || row.node.sha === selectedCommit;
        const node = (
          <Circle
            key={`node-${row.node.sha}`}
            cx={row.lane * GRAPH_LANE_WIDTH + 8}
            cy={center}
            fill={filled ? dotColor : theme.colors.surface2}
            r={WEB_NODE_RADIUS}
            stroke={dotColor}
            strokeWidth={WEB_STROKE_WIDTH}
          />
        );
        return [...incoming, ...outgoing, node];
      })}
    </Svg>
  );
}
