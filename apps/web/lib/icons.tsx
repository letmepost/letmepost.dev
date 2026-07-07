import type { CSSProperties } from "react";
import iconData from "./icon-data.json";

type IconEntry = {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
};
type IconCollection = { prefix: string; icons: Record<string, IconEntry> };

const registry: Record<string, IconEntry> = {};
for (const col of iconData as unknown as IconCollection[]) {
  for (const [name, entry] of Object.entries(col.icons)) {
    registry[`${col.prefix}:${name}`] = entry;
  }
}

export function Icon({
  icon,
  width = "1em",
  height = "1em",
  className,
  style,
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
}: {
  icon: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
}) {
  const data = registry[icon];
  if (!data) return null;
  const w = data.width ?? 24;
  const h = data.height ?? 24;
  const l = data.left ?? 0;
  const t = data.top ?? 0;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`${l} ${t} ${w} ${h}`}
      className={className}
      style={style}
      aria-hidden={ariaLabel ? undefined : ariaHidden}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
}
