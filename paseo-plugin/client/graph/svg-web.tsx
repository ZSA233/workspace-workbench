import { createElement, type ReactNode } from "react";

// Web-only DOM primitives. Do not import react-native-svg: its extractors and
// inheritance helpers are unnecessary for the paths already computed by us.
type Props = { children?: ReactNode; [key: string]: unknown };
export function Svg({ children, ...props }: Props) { return createElement("svg", props, children); }
export function Path(props: Props) { return createElement("path", props); }
export function Circle(props: Props) { return createElement("circle", props); }
export function Rect({ onPress, ...props }: Props) { return createElement("rect", { ...props, onClick: onPress }); }
