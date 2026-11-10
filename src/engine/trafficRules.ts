import type { Tags } from "../core/osm/model";

export type DrivingSide = "left" | "right";
export function oneWayDirection(tags: Tags): -1 | 0 | 1 {
  if (tags.oneway === "-1") return -1;
  if (["no", "0", "false"].includes(tags.oneway)) return 0;
  return ["yes", "1", "true"].includes(tags.oneway) ||
    tags.junction === "roundabout" || tags.highway === "motorway" ? 1 : 0;
}
/** Physical lane indices run from right to left along the OSM way.
 * Directional OSM lane counts take precedence; shared centre lanes are not
 * used for through traffic. Lane zero in each direction is nearest the curb.
 */
export function drivingLanes(tags: Tags, total: number, side: DrivingSide) {
  const count = (key: string) => /^\d+$/.test(tags[key] ?? "")
    ? Math.min(total, Number(tags[key])) : undefined;
  const direction = oneWayDirection(tags);
  const indices = Array.from({ length: total }, (_, i) => i);
  if (direction) {
    const ordered = side === "left" ? [...indices].reverse() : indices;
    return { forward: direction === 1 ? ordered : [],
      backward: direction === -1 ? [...ordered].reverse() : [] };
  }
  if (total === 1) return { forward: [0], backward: [0] };
  const shared = count("lanes:both_ways") ?? 0;
  const usable = Math.max(0, total - shared);
  const f = Math.min(usable, count("lanes:forward") ??
    (count("lanes:backward") !== undefined ? usable - count("lanes:backward")! : Math.ceil(usable / 2)));
  const b = Math.min(usable - f, count("lanes:backward") ?? usable - f);
  return side === "left"
    ? { forward: indices.slice(total - f).reverse(), backward: indices.slice(0, b) }
    : { forward: indices.slice(0, f), backward: indices.slice(total - b).reverse() };
}

/** OSM pipe-delimited lane tags are ordered left to right along travel. */
export function laneTagInfo(tags: Tags, count: number, lane: number, side: DrivingSide) {
  const layout = drivingLanes(tags, count, side);
  const forward = layout.forward.includes(lane);
  const physical = [...(forward ? layout.forward : layout.backward)]
    .sort((a, b) => forward ? b - a : a - b);
  if (!physical.includes(lane)) return null;
  return { index: physical.indexOf(lane), count: physical.length,
    suffix: oneWayDirection(tags) ? "" : forward ? ":forward" : ":backward",
    direction: forward ? "Прямое направление" : "Обратное направление" };
}
