import { createProjection, documentOrigin, type LocalPoint } from "../core/geo/projection";
import { coordinateOf, refsOf, tagsOf, type OsmDocument, type Tags } from "../core/osm/model";
import { pedestrianTypes, roadStyle } from "./geometry/roads";
import { busRoutes } from "../core/osm/busRoutes";

export interface TrafficEdge {
  wayId: string;
  from: string;
  to: string;
  a: LocalPoint;
  b: LocalPoint;
  length: number;
  lanes: number;
  width: number;
  elevation: number;
  speed: number;
  oneway: boolean;
}
export interface TrafficVehicle {
  id: string;
  edge: TrafficEdge;
  progress: number;
  speed: number;
  lane: number;
  color: number;
  stopped: boolean;
  kind: "car" | "bus";
  routeId?: string;
  routeLeg?: number;
  routeStep?: number;
  dwell?: number;
}
export interface VehiclePose {
  x: number;
  z: number;
  y: number;
  heading: number;
}
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Local traffic preview, never part of OSM export or a substitute for SUMO.
 * Traverses OSM nodes and respects simple one-way/speed/signal attributes.
 */
export class TrafficModel {
  readonly cars = new Map<string, TrafficVehicle>();
  private readonly outgoing = new Map<string, TrafficEdge[]>();
  private readonly starts: TrafficEdge[] = [];
  private readonly signals = new Set<string>();
  private readonly routes = new Map<string, { legs: TrafficEdge[][]; loop: boolean }>();
  private nextId = 1;
  private seconds = 0;

  constructor(document: OsmDocument) {
    const projection = createProjection(documentOrigin(document));
    for (const [id, node] of document.nodes)
      if (tagsOf(node).highway === "traffic_signals") this.signals.add(id);
    for (const [wayId, way] of document.ways) {
      const tags = tagsOf(way);
      if (!tags.highway || pedestrianTypes.has(tags.highway) ||
          tags.area === "yes" || tags.highway === "construction" ||
          tags.highway === "proposed") continue;
      const style = roadStyle(tags);
      const oneWay = tags.oneway === "yes" || tags.oneway === "-1" ||
        tags.junction === "roundabout";
      const speed = speedMetersPerSecond(tags);
      const refs = refsOf(way);
      for (let i = 1; i < refs.length; i++) {
        const first = document.nodes.get(refs[i - 1]);
        const last = document.nodes.get(refs[i]);
        if (!first || !last) continue;
        const a = projection.project(coordinateOf(first));
        const b = projection.project(coordinateOf(last));
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(length) || length < 1.0) continue;
        const forward = (): TrafficEdge => ({
          wayId, from: refs[i - 1], to: refs[i], a, b, length,
          lanes: Math.max(1, style.lanes),
          width: style.width, elevation: style.elevation, speed, oneway: oneWay,
        });
        const backward = (): TrafficEdge => ({
          wayId, from: refs[i], to: refs[i - 1], a: b, b: a, length,
          lanes: Math.max(1, style.lanes),
          width: style.width, elevation: style.elevation, speed, oneway: oneWay,
        });
        if (tags.oneway !== "-1") this.addEdge(forward());
        if (!oneWay) this.addEdge(backward());
        else if (tags.oneway === "-1") this.addEdge(backward());
      }
    }
    for (const route of busRoutes(document)) {
      const legs: TrafficEdge[][] = [];
      for (let i = 1; i < route.stops.length; i++) {
        const path = this.shortestPath(route.stops[i - 1], route.stops[i]);
        if (!path.length) break;
        legs.push(path);
      }
      if (legs.length !== route.stops.length - 1) continue;
      const returnPath = this.shortestPath(route.stops[route.stops.length - 1], route.stops[0]);
      if (returnPath.length) legs.push(returnPath);
      this.routes.set(route.id, { legs, loop: returnPath.length > 0 });
    }
  }
  private shortestPath(start: string, finish: string): TrafficEdge[] {
    const distances = new Map<string, number>([[start, 0]]);
    const previous = new Map<string, TrafficEdge>();
    const pending = new Set<string>([start]);
    while (pending.size) {
      let node = "", best = Infinity;
      for (const id of pending) {
        const distance = distances.get(id)!;
        if (distance < best) { best = distance; node = id; }
      }
      pending.delete(node);
      if (node === finish) break;
      for (const edge of this.outgoing.get(node) ?? []) {
        const next = best + edge.length;
        if (next >= (distances.get(edge.to) ?? Infinity)) continue;
        distances.set(edge.to, next);
        previous.set(edge.to, edge);
        pending.add(edge.to);
      }
    }
    if (!previous.has(finish)) return [];
    const result: TrafficEdge[] = [];
    for (let node = finish; node !== start;) {
      const edge = previous.get(node);
      if (!edge) return [];
      result.unshift(edge);
      node = edge.from;
    }
    return result;
  }
  canRoute(stops: string[]): boolean {
    return this.routeWayIds(stops) !== null;
  }
  routeWayIds(stops: string[]): string[] | null {
    if (stops.length < 2) return null;
    const ways: string[] = [];
    for (let i = 1; i < stops.length; i++) {
      const path = this.shortestPath(stops[i - 1], stops[i]);
      if (!path.length) return null;
      for (const edge of path)
        if (ways[ways.length - 1] !== edge.wayId) ways.push(edge.wayId);
    }
    return ways;
  }
  addBus(routeId: string): string | null {
    const first = this.routes.get(routeId)?.legs[0]?.[0];
    if (!first) return null;
    const id = String(this.nextId++);
    this.cars.set(id, {
      id, edge: first, progress: 0.02, speed: Math.min(first.speed, 13.9),
      lane: 0, color: 0, stopped: false, kind: "bus",
      routeId, routeLeg: 0, routeStep: 0, dwell: 0,
    });
    return id;
  }
  get busCount() { return Array.from(this.cars.values()).filter((car) => car.kind === "bus").length; }
  routeEdges(routeId: string): TrafficEdge[] {
    return this.routes.get(routeId)?.legs.flat() ?? [];
  }
  private addEdge(edge: TrafficEdge) {
    const list = this.outgoing.get(edge.from) ?? [];
    list.push(edge);
    this.outgoing.set(edge.from, list);
    this.starts.push(edge);
  }
  get available() { return this.starts.length; }
  get size() { return this.cars.size; }
  get clock() { return this.seconds; }
  addAt(wayId: string, from: string, to: string, progress: number, lane = 0): string | null {
    const edge = this.starts.find((candidate) => candidate.wayId === wayId &&
      candidate.from === from && candidate.to === to);
    if (!edge) return null;
    const id = String(this.nextId++);
    this.cars.set(id, {
      id, edge, progress: clamp(progress, 0.02, 0.96),
      speed: edge.speed * 0.85, lane: clamp(lane, 0, edge.lanes - 1),
      color: Number(id) % 6, stopped: false, kind: "car",
    });
    return id;
  }
  add(count = 1, wayId?: string): string[] {
    const ids: string[] = [];
    const central = this.starts.filter((edge) => {
      const centerX = (edge.a.x + edge.b.x) / 2;
      const centerZ = (edge.a.z + edge.b.z) / 2;
      return centerX * centerX + centerZ * centerZ < 1200 * 1200;
    });
    const pool = wayId ? this.starts.filter((edge) => edge.wayId === wayId)
      : (central.length ? central : this.starts);
    if (!pool.length) return ids;
    for (let i = 0; i < Math.min(count, 150); i++) {
      const edge = pool[Math.floor(Math.random() * pool.length)];
      const id = String(this.nextId++);
      this.cars.set(id, {
        id, edge, progress: 0.05 + Math.random() * 0.7,
        speed: edge.speed * (0.7 + Math.random() * 0.2),
        lane: Math.floor(Math.random() * (edge.oneway ? edge.lanes : Math.max(1, Math.floor(edge.lanes / 2)))),
        color: Number(id) % 6, stopped: false, kind: "car",
      });
      ids.push(id);
    }
    return ids;
  }
  remove(id: string): boolean { return this.cars.delete(id); }
  clear() { this.cars.clear(); }
  private nextEdge(car: TrafficVehicle): TrafficEdge | null {
    const candidates = (this.outgoing.get(car.edge.to) ?? [])
      .filter((edge) => edge.to !== car.edge.from);
    if (!candidates.length) {
      // Dead end: reverse only when the road allows two-way traffic.
      const reverse = (this.outgoing.get(car.edge.to) ?? [])
        .find((edge) => edge.to === car.edge.from);
      return reverse ?? null;
    }
    const directionX = car.edge.b.x - car.edge.a.x;
    const directionZ = car.edge.b.z - car.edge.a.z;
    const weighted = candidates.map((edge) => {
      const nextX = edge.b.x - edge.a.x;
      const nextZ = edge.b.z - edge.a.z;
      const dot = (directionX * nextX + directionZ * nextZ) /
        (Math.hypot(directionX, directionZ) * Math.hypot(nextX, nextZ));
      return { edge, weight: 0.2 + Math.pow((dot + 1) / 2, 2) * 4 };
    });
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * total;
    for (const item of weighted) {
      random -= item.weight;
      if (random <= 0) return item.edge;
    }
    return weighted[weighted.length - 1].edge;
  }
  update(dt: number, speedFactor = 1): void {
    const elapsed = clamp(dt, 0, 0.1) * clamp(speedFactor, 0, 5);
    this.seconds += elapsed;
    const lanes = new Map<TrafficEdge, Map<number, TrafficVehicle[]>>();
    for (const car of this.cars.values()) {
      const byLane = lanes.get(car.edge) ?? new Map<number, TrafficVehicle[]>();
      const row = byLane.get(car.lane) ?? [];
      row.push(car);
      byLane.set(car.lane, row);
      lanes.set(car.edge, byLane);
    }
    for (const byLane of lanes.values())
      for (const row of byLane.values())
        row.sort((a, b) => b.progress - a.progress);
    for (const car of this.cars.values()) {
      if (car.kind === "bus" && (car.dwell ?? 0) > 0) {
        car.dwell = Math.max(0, car.dwell! - elapsed);
        car.stopped = true;
        continue;
      }
      const distanceLeft = (1 - car.progress) * car.edge.length;
      const signalRed = this.signals.has(car.edge.to) &&
        (Math.floor(this.seconds / 12) % 2 === 0);
      const queue = lanes.get(car.edge)?.get(car.lane) ?? [];
      const index = queue.indexOf(car);
      const leading = index > 0 ? queue[index - 1] : null;
      const headway = leading ? (leading.progress - car.progress) * car.edge.length : Infinity;
      car.stopped = (signalRed && distanceLeft < 7) || headway < 7.5;
      if (car.stopped) continue;
      car.progress += (car.speed * elapsed) / car.edge.length;
      if (car.progress < 1) continue;
      let next: TrafficEdge | null;
      if (car.kind === "bus") {
        const route = this.routes.get(car.routeId!);
        const legs = route?.legs ?? [];
        const leg = legs[car.routeLeg ?? 0] ?? [];
        if ((car.routeStep ?? 0) + 1 < leg.length) {
          car.routeStep!++;
          next = leg[car.routeStep!];
        } else {
          const nextLeg = (car.routeLeg ?? 0) + 1;
          car.routeLeg = nextLeg < legs.length ? nextLeg : route?.loop ? 0 : nextLeg;
          car.routeStep = 0;
          next = legs[car.routeLeg]?.[0] ?? null;
          car.dwell = 3;
        }
      } else next = this.nextEdge(car);
      if (!next) {
        car.progress = 1;
        car.stopped = true;
        continue;
      }
      car.progress = clamp((car.progress - 1) * car.edge.length / next.length, 0, 0.99);
      car.edge = next;
      car.speed = car.kind === "bus" ? Math.min(next.speed, 13.9) : next.speed * 0.8;
      car.lane = Math.min(car.lane,
        next.oneway ? next.lanes - 1 : Math.max(0, Math.floor(next.lanes / 2) - 1));
    }
  }
  pose(car: TrafficVehicle): VehiclePose {
    const { a, b, width, lanes, elevation } = car.edge;
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const laneWidth = width / Math.max(1, lanes);
    // Russia: traffic keeps to the right, even for reverse-way edges.
    const offsetSide = -width / 2 + (car.lane + 0.5) * laneWidth;
    return {
      x: a.x + dx * car.progress - (dz / length) * offsetSide,
      z: a.z + dz * car.progress + (dx / length) * offsetSide,
      y: elevation + (car.kind === "bus" ? 1.35 : 0.75),
      heading: Math.atan2(dx, dz),
    };
  }
}
export function speedMetersPerSecond(tags: Tags): number {
  const match = tags.maxspeed?.match(/^\s*(\d+(?:\.\d+)?)/);
  const kmh = match ? Number(match[1]) :
    tags.highway === "living_street" ? 20 :
    tags.highway === "service" ? 25 : 45;
  return clamp(kmh, 5, 130) / 3.6;
}
