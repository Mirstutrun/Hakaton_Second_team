import { buildingShapes } from "./buildingShapes";
import { createProjection, documentOrigin } from "../geo/projection";
import {
  coordinateOf,
  refsOf,
  tagsOf,
  type OsmDocument,
  type Tags,
} from "./model";
import type { ValidationIssue } from "./validation";

/**
 * Non-destructive geometric QA. All distances are in metres in a local
 * tangent-plane projection; never silently "repair" OSM geometry.
 */
type Point = { x: number; z: number };
type Bounds = { minX: number; minZ: number; maxX: number; maxZ: number };
type Segment = {
  wayId: string;
  index: number; // index of the END node, for insert-node
  aId: string;
  bId: string;
  a: Point;
  b: Point;
  tags: Tags;
  bounds: Bounds;
  passageAtA?:boolean;passageAtB?:boolean;
};
type Footprint = { id: string; ring: Point[]; holes:Point[][]; bounds: Bounds };

const CELL = 70;
const LIMIT = 300;
const NON_MOTOR = new Set([
  "footway", "path", "pedestrian", "cycleway", "steps",
  "bridleway", "corridor", "platform", "proposed", "construction",
]);

function box(a: Point, b: Point): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minZ: Math.min(a.z, b.z),
    maxX: Math.max(a.x, b.x),
    maxZ: Math.max(a.z, b.z),
  };
}
function expand(bounds: Bounds, distance: number): Bounds {
  return {
    minX: bounds.minX - distance,
    minZ: bounds.minZ - distance,
    maxX: bounds.maxX + distance,
    maxZ: bounds.maxZ + distance,
  };
}
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX &&
    a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}
function cross(a: Point, b: Point): number {
  return a.x * b.z - a.z * b.x;
}
function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, z: a.z - b.z };
}
function squared(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}
function intersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = subtract(b, a), s = subtract(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return null;
  const delta = subtract(c, a);
  const t = cross(delta, s) / denominator;
  const u = cross(delta, r) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9)
    return null;
  return { x: a.x + t * r.x, z: a.z + t * r.z };
}
function closestOnSegment(point: Point, a: Point, b: Point): Point {
  const delta = subtract(b, a);
  const length2 = squared(a, b);
  const t = length2 ? Math.max(0, Math.min(1,
    ((point.x - a.x) * delta.x + (point.z - a.z) * delta.z) / length2)) : 0;
  return { x: a.x + delta.x * t, z: a.z + delta.z * t };
}
function pointToSegment(point: Point, a: Point, b: Point): number {
  return Math.sqrt(squared(point, closestOnSegment(point, a, b)));
}
function inside(point: Point, ring: Point[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > point.z) !== (b.z > point.z) &&
        point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x)
      result = !result;
  }
  return result;
}
function touchesFootprint(segment:Segment,polygon:Footprint):boolean {
  if(!overlaps(segment.bounds,polygon.bounds))return false;
  const occupied=(p:Point)=>inside(p,polygon.ring)&&!polygon.holes.some(h=>inside(p,h));
  const nearPassage=(p:Point)=>!!(segment.passageAtA&&Math.sqrt(squared(p,segment.a))<.15||segment.passageAtB&&Math.sqrt(squared(p,segment.b))<.15);
  if(occupied(segment.a)&&!nearPassage(segment.a)||occupied(segment.b)&&!nearPassage(segment.b)||occupied({x:(segment.a.x+segment.b.x)/2,z:(segment.a.z+segment.b.z)/2}))return true;
  for(const ring of [polygon.ring,...polygon.holes])for(let i=0;i<ring.length;i++){const p=intersection(segment.a,segment.b,ring[i],ring[(i+1)%ring.length]);if(p&&!nearPassage(p))return true;}
  return false;
}

function atGrade(tags: Tags): boolean {
  return !(
    (tags.bridge && tags.bridge !== "no") ||
    (tags.tunnel && tags.tunnel !== "no") ||
    tags.covered === "yes" ||
    tags.indoor === "yes"
  );
}
function level(tags: Tags): number {
  const value = Number(tags.layer || "0");
  return Number.isFinite(value) ? value : 0;
}
function isRoad(tags: Tags): boolean {
  return Boolean(tags.highway && !NON_MOTOR.has(tags.highway) &&
    tags.area !== "yes");
}

/** A compact spatial hash avoids O(number_of_roads * number_of_buildings). */
class SpatialGrid<T> {
  private cells = new Map<string, T[]>();
  private large: T[] = [];
  add(bounds: Bounds, value: T) {
    const x0 = Math.floor(bounds.minX / CELL);
    const x1 = Math.floor(bounds.maxX / CELL);
    const z0 = Math.floor(bounds.minZ / CELL);
    const z1 = Math.floor(bounds.maxZ / CELL);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 2000) {
      this.large.push(value);
      return;
    }
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x + ":" + z;
        const bucket = this.cells.get(key) ?? [];
        bucket.push(value);
        this.cells.set(key, bucket);
      }
    }
  }
  near(bounds: Bounds): T[] {
    const result = new Set<T>(this.large);
    const x0 = Math.floor(bounds.minX / CELL);
    const x1 = Math.floor(bounds.maxX / CELL);
    const z0 = Math.floor(bounds.minZ / CELL);
    const z1 = Math.floor(bounds.maxZ / CELL);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (const value of this.cells.get(x + ":" + z) ?? [])
          result.add(value);
    return Array.from(result);
  }
}

/**
 * Warnings identify suspicious topology, not proof of a bad real-world road.
 * In particular: bridges/tunnels are excluded from at-grade join suggestions.
 */
export function auditGeometry(document: OsmDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (issue: ValidationIssue) => {
    if (issues.length < LIMIT) issues.push(issue);
  };
  const projection = createProjection(documentOrigin(document));
  const coordinates = new Map<string, Point>();
  for (const [id, node] of document.nodes) {
    const point = coordinateOf(node);
    if (Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
        Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180)
      coordinates.set(id, projection.project(point));
  }

  const passageNodes=new Set<string>();for(const w of document.ways.values())if(tagsOf(w).tunnel==="building_passage"){const refs=refsOf(w);passageNodes.add(refs[0]);passageNodes.add(refs.at(-1)!);}
  const buildingGrid = new SpatialGrid<Footprint>();
  const segments: Segment[] = [];
  const segmentGrid = new SpatialGrid<Segment>();
  const roadWays = new Map<string, string[]>();
  const usage = new Map<string, number>();
  for (const [id, way] of document.ways) {
    const tags = tagsOf(way);
    const refs = refsOf(way);
    if (!isRoad(tags)) continue;
    roadWays.set(id, refs);
    for (const ref of new Set(refs))
      usage.set(ref, (usage.get(ref) ?? 0) + 1);
    for (let index = 1; index < refs.length; index++) {
      const a = coordinates.get(refs[index - 1]);
      const b = coordinates.get(refs[index]);
      if (!a || !b) continue;
      if (squared(a, b) < 0.04) {
        push({ severity: "warning", code: "zero-length", id,
          elementType: "way", message: `Дорога ${id}: почти нулевой сегмент ${index}`,
          coordinate: projection.unproject(a) });
        continue;
      }
      const segment: Segment = {
        wayId: id, index, aId: refs[index - 1], bId: refs[index],
        a, b, tags, bounds: box(a, b),passageAtA:passageNodes.has(refs[index-1]),passageAtB:passageNodes.has(refs[index]),
      };
      segments.push(segment);
      segmentGrid.add(segment.bounds, segment);
    }
  }

  for(const shape of buildingShapes(document,projection)) {
    if(shape.outer.length<3)continue;
    const xs=shape.outer.map(p=>p.x),zs=shape.outer.map(p=>p.z);
    const footprint={id:shape.id,ring:shape.outer,holes:shape.holes,bounds:{minX:Math.min(...xs),maxX:Math.max(...xs),minZ:Math.min(...zs),maxZ:Math.max(...zs)}};
    buildingGrid.add(footprint.bounds,footprint);
  }
  // Exact geometric crossings of two motor roads on the same surface level.
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!atGrade(segment.tags)) continue;
    for (const other of segmentGrid.near(segment.bounds)) {
      if (segment === other || segment.wayId === other.wayId ||
          !atGrade(other.tags) || level(segment.tags) !== level(other.tags) ||
          !overlaps(segment.bounds, other.bounds)) continue;
      const key = [segment.wayId + ":" + segment.index,
        other.wayId + ":" + other.index].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      // Shared node means the crossing is already topologically connected.
      if (segment.aId === other.aId || segment.aId === other.bId ||
          segment.bId === other.aId || segment.bId === other.bId)
        continue;
      const point = intersection(segment.a, segment.b, other.a, other.b);
      if (!point) continue;
      const coordinate = projection.unproject(point);
      const endpoint = [segment.a, segment.b, other.a, other.b]
        .some((end) => Math.sqrt(squared(end, point)) < 0.75);
      push({
        severity: "warning", code: "unconnected-crossing",
        id: segment.wayId, elementType: "way", coordinate,
        message: `Дороги ${segment.wayId} и ${other.wayId} пересекаются без общего узла`,
        fix: endpoint ? undefined : {
          kind: "connect-crossing", wayA: segment.wayId, indexA: segment.index,
          wayB: other.wayId, indexB: other.index, coordinate,
        },
      });
    }
  }

  // A centreline through a building footprint may be a tagging, mapping or
  // elevation issue. Report it for human inspection; don't move geometry.
  const reported = new Set<string>();
  for (const segment of segments) {
    if (!atGrade(segment.tags)) continue;
    for (const building of buildingGrid.near(segment.bounds)) {
      const key = segment.wayId + "/" + building.id;
      if (reported.has(key) || !touchesFootprint(segment, building)) continue;
      reported.add(key);
      push({
        severity: "warning", code: "road-building-overlap",
        id: segment.wayId, elementType: "way",buildingId:building.id,
        coordinate: projection.unproject({
          x: (segment.a.x + segment.b.x) / 2,
          z: (segment.a.z + segment.b.z) / 2,
        }),
        message: `Дорога ${segment.wayId} пересекает контур здания ${building.id} — проверьте по снимку`,
      });
    }
  }

  // Near misses: road endpoint close to another road, but without common ID.
  for (const [wayId, refs] of roadWays) {
    const way = document.ways.get(wayId)!;
    const tags = tagsOf(way);
    if (!atGrade(tags)) continue;
    for (const nodeId of new Set([refs[0], refs[refs.length - 1]])) {
      if (!nodeId || (usage.get(nodeId) ?? 0) > 1) continue;
      const point = coordinates.get(nodeId);
      if (!point) continue;
      let nearest: Segment | null = null, distance = 3.5;
      for (const segment of segmentGrid.near(expand(box(point, point), 3.5))) {
        if (segment.wayId === wayId || segment.aId === nodeId ||
            segment.bId === nodeId || !atGrade(segment.tags) ||
            level(segment.tags) !== level(tags)) continue;
        const candidate = pointToSegment(point, segment.a, segment.b);
        if (candidate < distance) {
          distance = candidate;
          nearest = segment;
        }
      }
      if (nearest) {
        const snapped = closestOnSegment(point, nearest.a, nearest.b);
        const interior = Math.sqrt(squared(snapped, nearest.a)) >= 0.75 &&
          Math.sqrt(squared(snapped, nearest.b)) >= 0.75;
        push({
          severity: "warning", code: "near-disconnection",
          id: nodeId, elementType: "node",
          coordinate: coordinateOf(document.nodes.get(nodeId)!),
          message: `Конец дороги ${wayId} почти касается ${nearest.wayId} (${distance.toFixed(1)} м), но не соединён`,
          fix: interior ? {
            kind: "attach-endpoint", nodeId, targetWayId: nearest.wayId,
            targetIndex: nearest.index,
            coordinate: projection.unproject(snapped),
          } : undefined,
        });
      }
    }
  }
  // Undirected connectivity check: disconnected motor-road subgraphs are
  // candidates for review (not necessarily errors in a clipped OSM extract).
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    let current = id;
    while (parent.get(current)! !== current) current = parent.get(current)!;
    const root = current;
    current = id;
    while (parent.get(current)! !== current) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  for (const refs of roadWays.values()) {
    if (!refs.length) continue;
    const anchor = find(refs[0]);
    for (const ref of refs.slice(1)) {
      const other = find(ref);
      if (anchor !== other) parent.set(other, anchor);
    }
  }
  const components = new Map<string, { ways: Set<string>; nodes: Set<string> }>();
  for (const [wayId, refs] of roadWays) {
    if (!refs.length) continue;
    const root = find(refs[0]);
    const component = components.get(root) ?? {
      ways: new Set<string>(), nodes: new Set<string>(),
    };
    component.ways.add(wayId);
    for (const ref of refs) component.nodes.add(ref);
    components.set(root, component);
  }
  const sorted = Array.from(components.values())
    .sort((a, b) => b.nodes.size - a.nodes.size);
  if (sorted.length > 1) {
    for (const component of sorted.slice(1, 41)) {
      const wayId = component.ways.values().next().value!;
      const nodeId = component.nodes.values().next().value!;
      const node = document.nodes.get(nodeId);
      push({
        severity: "warning", code: "isolated-component",
        id: wayId, elementType: "way",
        coordinate: node ? coordinateOf(node) : undefined,
        message: `Изолированная часть сети: ${component.ways.size} дорог / ${component.nodes.size} узлов. Проверьте соединения и границы OSM-фрагмента`,
      });
    }
  }
  if (issues.length === LIMIT) {
    issues.push({ severity: "warning", code: "limit",
      message: `Показаны первые ${LIMIT} геометрических предупреждений. Уточните карту и запустите проверку снова.` });
  }
  return issues;
}
