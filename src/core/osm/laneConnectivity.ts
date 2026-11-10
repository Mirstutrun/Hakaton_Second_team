import { childElements, coordinateOf, refsOf, tagsOf, type Coordinate, type OsmDocument, type RoadPoint } from "./model";
import type { EditCommand } from "./commands";
import type { TurnEdge } from "./turnRestrictions";
import { drivingLanes, type DrivingSide } from "../../engine/trafficRules";
import { roadStyle } from "../../engine/geometry/roads";
import { createProjection } from "../geo/projection";

/** Точка дороги, ближайшая к координате: существующий узел (ближе 2 м) или место вставки. */
function nearestOnWay(document: OsmDocument, wayId: string, near: Coordinate): { point: RoadPoint; distance: number } | null {
  const projection = createProjection(near);
  const refs = refsOf(document.ways.get(wayId)!);
  const points = refs.map((id) => {
    const node = document.nodes.get(id);
    return node ? projection.project(coordinateOf(node)) : null;
  });
  let best: { distance: number; index: number; x: number; z: number } | null = null;
  for (let i = 1; i < refs.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / (dx * dx + dz * dz || 1)));
    const x = a.x + dx * t, z = a.z + dz * t, distance = Math.hypot(x, z);
    if (!best || distance < best.distance) best = { distance, index: i, x, z };
  }
  if (!best) return null;
  const a = points[best.index - 1]!, b = points[best.index]!;
  const point: RoadPoint =
    Math.hypot(best.x - a.x, best.z - a.z) < 2 ? { nodeId: refs[best.index - 1] }
    : Math.hypot(best.x - b.x, best.z - b.z) < 2 ? { nodeId: refs[best.index] }
    : { wayId, index: best.index, coordinate: projection.unproject({ x: best.x, z: best.z }) };
  return { point, distance: best.distance };
}

/**
 * Ручное соединение выбранной дороги/полосы с другой дорогой (горячая клавиша J).
 * - У дорог есть общий перекрёсток: связываются полосы (команда connect-lanes).
 * - Дороги не соединены: ближайший к клику конец выбранной дороги присоединяется
 *   к другой дороге (команда connect-roads). Если конец уже рядом с ней (до 6 м),
 *   берётся ближайшая точка дороги, иначе — место клика.
 * Сообщения ошибок — для пользователя.
 */
export function planRoadLink(
  document: OsmDocument,
  source: { wayId: string; lane: number },
  target: { wayId: string; lane: number; near: Coordinate },
  side: DrivingSide,
): Extract<EditCommand, { type: "connect-lanes" | "connect-roads" }> {
  if (source.wayId === target.wayId) throw Error("Выберите другую дорогу");
  const a = document.ways.get(source.wayId), b = document.ways.get(target.wayId);
  if (!a || !b || !tagsOf(a).highway || !tagsOf(b).highway) throw Error("Соединять можно только дороги");
  if (roadStyle(tagsOf(a)).pedestrian || roadStyle(tagsOf(b)).pedestrian)
    throw Error("Соединять можно автомобильные дороги, а не пешеходные дорожки");
  const aRefs = refsOf(a), bRefs = refsOf(b);
  if (aRefs.some((id) => bRefs.includes(id))) return planLaneLink(document, source, target, side);
  if (aRefs.length < 2 || aRefs[0] === aRefs[aRefs.length - 1])
    throw Error("У выбранной дороги нет свободного конца для соединения");
  const click = createProjection(target.near);
  const reach = (id: string) => {
    const node = document.nodes.get(id);
    if (!node) return Infinity;
    const p = click.project(coordinateOf(node));
    return Math.hypot(p.x, p.z);
  };
  const nodeId = reach(aRefs[0]) <= reach(aRefs[aRefs.length - 1]) ? aRefs[0] : aRefs[aRefs.length - 1];
  const beside = nearestOnWay(document, target.wayId, coordinateOf(document.nodes.get(nodeId)!));
  const clicked = nearestOnWay(document, target.wayId, target.near);
  const place = beside && beside.distance <= 6 ? beside : clicked;
  if (!place) throw Error("Не удалось найти место соединения на другой дороге");
  return { type: "connect-roads", wayId: source.wayId, nodeId, target: place.point };
}

/**
 * Связь полосы выбранной дороги с полосой другой дороги через их общий
 * перекрёсток впереди по ходу выбранной полосы (параметры команды connect-lanes).
 */
export function planLaneLink(
  document: OsmDocument,
  source: { wayId: string; lane: number },
  target: { wayId: string; lane: number; near?: Coordinate },
  side: DrivingSide,
) {
  if (source.wayId === target.wayId) throw Error("Выберите другую дорогу");
  const a = document.ways.get(source.wayId), b = document.ways.get(target.wayId);
  if (!a || !b || !tagsOf(a).highway || !tagsOf(b).highway) throw Error("Соединять можно только дороги");
  const aRefs = refsOf(a), bRefs = refsOf(b);
  const aLayout = drivingLanes(tagsOf(a), roadStyle(tagsOf(a)).lanes, side);
  const bLayout = drivingLanes(tagsOf(b), roadStyle(tagsOf(b)).lanes, side);
  const aForward = aLayout.forward.includes(source.lane), aBackward = aLayout.backward.includes(source.lane);
  const bForward = bLayout.forward.includes(target.lane), bBackward = bLayout.backward.includes(target.lane);
  const near = target.near ? createProjection(target.near) : null;
  const distance = (id: string) => {
    const node = document.nodes.get(id);
    if (!near || !node) return 0;
    const p = near.project(coordinateOf(node));
    return Math.hypot(p.x, p.z);
  };
  const options: { via: string; fromNode: string; toNode: string; score: number }[] = [];
  for (const via of new Set(aRefs.filter((id) => bRefs.includes(id)))) {
    const i = aRefs.indexOf(via), j = bRefs.indexOf(via);
    const from = [aForward && aRefs[i - 1], aBackward && aRefs[i + 1]].filter((n): n is string => !!n);
    const to = [bForward && bRefs[j + 1], bBackward && bRefs[j - 1]].filter((n): n is string => !!n);
    for (const fromNode of from)
      for (const toNode of to) options.push({ via, fromNode, toNode, score: distance(via) + distance(toNode) });
  }
  if (!bRefs.some((id) => aRefs.includes(id)))
    throw Error("У дорог нет общего перекрёстка");
  if (!options.length)
    throw Error("Выбранные полосы не ведут через общий перекрёсток. Выберите полосу нужного направления");
  const best = options.sort((x, y) => x.score - y.score)[0];
  return {
    type: "connect-lanes" as const,
    fromWay: source.wayId, toWay: target.wayId,
    via: best.via, fromNode: best.fromNode, toNode: best.toNode,
    fromLane: source.lane, toLane: target.lane, drivingSide: side,
  };
}
export function parseConnectivity(value:string) {
  const result:{from:number;to:number}[]=[];
  for(const entry of value.split("|")) {
    const [from,to]=entry.split(":");if(!/^\d+$/.test(from||""))continue;
    for(const target of (to||"").split(",")) {
      const lane=Number(target.replace(/[()]/g,""));if(Number(from)>0&&Number.isInteger(lane)&&lane>0)result.push({from:Number(from),to:lane});
    }
  }
  return result;
}
export function formatConnectivity(pairs:{from:number;to:number}[]) {
  const grouped=new Map<number,Set<number>>();for(const p of pairs){if(!grouped.has(p.from))grouped.set(p.from,new Set());grouped.get(p.from)!.add(p.to);}
  return [...grouped].sort((a,b)=>a[0]-b[0]).map(([from,to])=>`${from}:${[...to].sort((a,b)=>a-b).join(",")}`).join("|");
}
export function laneConnections(document:OsmDocument) {
  return [...document.relations].flatMap(([id,r])=>{
    if(tagsOf(r).type!=="connectivity")return [];
    const members=childElements(r),ref=(role:string,type:string)=>members.find(m=>m.tagName==="member"&&m.getAttribute("role")===role&&m.getAttribute("type")===type)?.getAttribute("ref");
    const fromWay=ref("from","way"),toWay=ref("to","way"),via=ref("via","node");
    if(!fromWay||!toWay||!via)return [];
    return parseConnectivity(tagsOf(r).connectivity||"").map(p=>({id,fromWay,toWay,via,...p}));
  });
}
export class LaneConnections {
  readonly entries:ReturnType<typeof laneConnections>;
  constructor(document:OsmDocument){this.entries=laneConnections(document);}
  targets(incoming:TurnEdge,next:TurnEdge,source:number):number[]|null {
    const configured=this.entries.filter(c=>c.fromWay===incoming.wayId&&c.via===incoming.to&&c.from===source);
    return configured.length?configured.filter(c=>c.toWay===next.wayId).map(c=>c.to):null;
  }
}
