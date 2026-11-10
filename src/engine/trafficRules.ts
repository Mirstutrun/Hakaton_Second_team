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

export type LaneDirection = "forward" | "backward" | "both";

/** Направление каждой физической полосы (0 — крайняя правая по ходу линии дороги). */
export function laneDirections(tags: Tags, total: number, side: DrivingSide): LaneDirection[] {
  const layout = drivingLanes(tags, total, side);
  return Array.from({ length: total }, (_, lane) => {
    const forward = layout.forward.includes(lane), backward = layout.backward.includes(lane);
    return forward && !backward ? "forward" : backward && !forward ? "backward" : "both";
  });
}

/**
 * Раскладка полос, которую можно записать в OSM: там хранится только число полос
 * в каждом направлении, поэтому полосы одного направления стоят рядом
 * (при правостороннем движении попутные — справа по ходу линии дороги).
 * «В обе стороны» допустимо только для однополосной дороги.
 */
export function normalizeLaneDirections(directions: LaneDirection[], side: DrivingSide): LaneDirection[] {
  const total = directions.length;
  if (total === 1) return [...directions];
  const forward = directions.filter((d) => d !== "backward").length;
  const tags: Tags = forward === total ? { oneway: "yes" } : forward === 0 ? { oneway: "-1" }
    : { "lanes:forward": String(forward), "lanes:backward": String(total - forward) };
  return laneDirections(tags, total, side);
}

/**
 * Теги OSM для числа полос и направлений (результат normalizeLaneDirections).
 * Теги «по полосам» (turn:lanes, change:lanes, maxspeed:lanes…) перечисляют полосы
 * через «|»; если число полос в их направлении изменилось, такой тег стал бы
 * неверным для симуляторов — он удаляется.
 */
export function laneDirectionTags(tags: Tags, directions: LaneDirection[]): Record<string, string | null> {
  const total = directions.length;
  const forward = directions.filter((d) => d === "forward").length;
  const backward = directions.filter((d) => d === "backward").length;
  // Круговое движение и магистраль односторонние по умолчанию — двустороннее надо указать явно.
  const implied = oneWayDirection({ ...tags, oneway: "" });
  const twoWay = implied ? "no" : null;
  const base = { lanes: String(total), "lanes:forward": null, "lanes:backward": null, "lanes:both_ways": null };
  const result: Record<string, string | null> =
    total > 1 && forward && backward
      ? { ...base, oneway: twoWay, "lanes:forward": String(forward), "lanes:backward": String(backward) }
      : forward === total
        ? { ...base, oneway: implied === 1 ? null : "yes" }
        : backward === total
          ? { ...base, oneway: "-1" }
          : { ...base, oneway: twoWay };
  const lanesIn: Record<string, number> = {
    "": total,
    ":forward": total - backward,
    ":backward": total - forward,
    ":both_ways": 0,
  };
  for (const [key, value] of Object.entries(tags)) {
    const suffix = /^.+:lanes(:forward|:backward|:both_ways)?$/.exec(key);
    if (suffix && value.split("|").length !== lanesIn[suffix[1] ?? ""]) result[key] = null;
  }
  return result;
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
