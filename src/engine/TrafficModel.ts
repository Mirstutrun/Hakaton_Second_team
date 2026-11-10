import { obstacleFilter } from "../core/osm/obstacles";
import { LaneConnections } from "../core/osm/laneConnectivity";
import { TurnRules } from "../core/osm/turnRestrictions";
import {
  createProjection,
  documentOrigin,
  type LocalPoint,
} from "../core/geo/projection";
import {
  coordinateOf,
  refsOf,
  tagsOf,
  type OsmDocument,
  type Tags,
} from "../core/osm/model";
import { pedestrianTypes, roadStyle } from "./geometry/roads";
import {
  drivingLanes,
  oneWayDirection,
  type DrivingSide,
} from "./trafficRules";
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
  laneIndices: number[];
  laneNumbers: number[];
  maxHeight: number;
  maxWidth: number;
  reverse: boolean;
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
  pathWays?: string[];
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
  private readonly routes = new Map<
    string,
    { legs: TrafficEdge[][]; loop: boolean }
  >();
  private nextId = 1;
  private seconds = 0;
  private readonly turnRules: TurnRules;
  private readonly laneLinks: LaneConnections;
  private readonly pathLanes=new WeakMap<TrafficEdge[],number[]>();

  constructor(
    document: OsmDocument,
    readonly drivingSide: DrivingSide = "left",
  ) {
    this.turnRules = new TurnRules(document);
    this.laneLinks = new LaneConnections(document);
    const projection = createProjection(documentOrigin(document));
    const blocked=obstacleFilter(document,projection);
    for (const [id, node] of document.nodes)
      if (tagsOf(node).highway === "traffic_signals") this.signals.add(id);
    for (const [wayId, way] of document.ways) {
      const tags = tagsOf(way);
      if (
        !tags.highway ||
        pedestrianTypes.has(tags.highway) ||
        tags.area === "yes" ||
        tags.highway === "construction" ||
        tags.highway === "proposed" ||
        (tags.motor_vehicle ?? tags.vehicle ?? tags.access) === "no"
      )
        continue;
      const style = roadStyle(tags);
      const direction = oneWayDirection(tags);
      const oneWay = direction !== 0;
      const layout = drivingLanes(tags, style.lanes, drivingSide);
      const speed = speedMetersPerSecond(tags);
      const maxHeight=Number.parseFloat(tags.maxheight)||Infinity,maxWidth=Number.parseFloat(tags.maxwidth)||Infinity;
      if(maxHeight<1.8||maxWidth<1.9)continue;
      const laneNumbers=(indices:number[],reverse:boolean)=>{const ordered=[...indices].sort((a,b)=>reverse?a-b:b-a);return indices.map(i=>ordered.indexOf(i)+1);};
      const refs = refsOf(way);
      for (let i = 1; i < refs.length; i++) {
        const first = document.nodes.get(refs[i - 1]);
        const last = document.nodes.get(refs[i]);
        if (!first || !last || tagsOf(first).barrier === "block" || tagsOf(last).barrier === "block") continue;
        const a = projection.project(coordinateOf(first));
        const b = projection.project(coordinateOf(last));
        if(blocked(a,b))continue;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(length) || length < 1.0) continue;
        const forward = (): TrafficEdge => ({
          wayId,
          from: refs[i - 1],
          to: refs[i],
          a,
          b,
          length,
          laneIndices: layout.forward,
          laneNumbers:laneNumbers(layout.forward,false),maxHeight,maxWidth,
          reverse: false,
          lanes: Math.max(1, style.lanes),
          width: style.width,
          elevation: style.elevation,
          speed,
          oneway: oneWay,
        });
        const backward = (): TrafficEdge => ({
          wayId,
          from: refs[i],
          to: refs[i - 1],
          a: b,
          b: a,
          length,
          laneIndices: layout.backward,
          laneNumbers:laneNumbers(layout.backward,true),maxHeight,maxWidth,
          reverse: true,
          lanes: Math.max(1, style.lanes),
          width: style.width,
          elevation: style.elevation,
          speed,
          oneway: oneWay,
        });
        if (layout.forward.length) this.addEdge(forward());
        if (layout.backward.length) this.addEdge(backward());
      }
    }
    for (const route of busRoutes(document)) {
      const legs: TrafficEdge[][] = [];
      let routeLane=0;
      for (let i = 1; i < route.stops.length; i++) {
        const previous = legs.flat();
        const path = this.shortestPath(
          route.stops[i - 1],
          route.stops[i],
          previous,
          "bus",routeLane,
        );
        if (!path.length) break;
        legs.push(path);routeLane=this.pathLanes.get(path)?.at(-1)??0;
      }
      if (legs.length !== route.stops.length - 1) continue;
      const returnPath = this.shortestPath(
        route.stops[route.stops.length - 1],
        route.stops[0],
        legs.flat(),
        "bus",routeLane,
      );
      if (
        returnPath.length &&
        !this.turnRules.allowed(
          returnPath[returnPath.length - 1],
          legs[0][0],
          returnPath.reduce(
            (ways, edge) => this.turnRules.advance(ways, edge),
            [] as string[],
          ),
          "bus",
        )
      )
        returnPath.length = 0;
      if (returnPath.length) legs.push(returnPath);
      this.routes.set(route.id, { legs, loop: returnPath.length > 0 });
    }
  }
  private shortestPath(
    start: string,
    finish: string,
    history: TrafficEdge[] = [],
    kind: "car" | "bus" = "bus",
    initialLane=0,
  ): TrafficEdge[] {
    type State = { node: string; edge?: TrafficEdge; ways: string[]; lane:number };
    const initial: State = {
      node: start,lane:initialLane,
      edge: history[history.length - 1],
      ways: history.reduce(
        (ways, e) => this.turnRules.advance(ways, e),
        [] as string[],
      ),
    };
    const key = (s: State) =>
      JSON.stringify([s.node, s.edge?.wayId, s.edge?.from, s.ways,s.lane]);
    const startKey = key(initial),
      states = new Map<string, State>([[startKey, initial]]),
      distances = new Map<string, number>([[startKey, 0]]),
      previous = new Map<string, { key: string; edge: TrafficEdge; lane:number }>(),
      pending = new Set([startKey]);
    let finishKey = "";
    while (pending.size) {
      let current = "",
        best = Infinity;
      for (const id of pending) {
        const d = distances.get(id)!;
        if (d < best) {
          best = d;
          current = id;
        }
      }
      pending.delete(current);
      const state = states.get(current)!;
      if (state.node === finish && current !== startKey) {
        finishKey = current;
        break;
      }
      for (const edge of this.outgoing.get(state.node) ?? []) {
        if (
          state.edge &&
          !this.turnRules.allowed(state.edge, edge, state.ways, kind)
        )
          continue;
        if(kind==="bus"&&(edge.maxHeight<3.2||edge.maxWidth<2.6))continue;
        const lanes=state.edge?this.targetLanes(state.edge,edge,state.lane):[0];
        for(const lane of lanes) {
          const next:State={node:edge.to,edge,ways:this.turnRules.advance(state.ways,edge),lane},id=key(next),cost=best+edge.length;
          if(cost>=(distances.get(id)??Infinity))continue;
          distances.set(id,cost);states.set(id,next);previous.set(id,{key:current,edge,lane});pending.add(id);
        }
      }
    }
    if (!finishKey) return [];
    const result: TrafficEdge[] = [],lanes:number[]=[];
    for (let id = finishKey; id !== startKey;) {
      const p = previous.get(id);
      if (!p) return [];
      result.unshift(p.edge);lanes.unshift(p.lane);
      id = p.key;
    }
    this.pathLanes.set(result,lanes);
    return result;
  }
  private targetLanes(incoming:TrafficEdge,next:TrafficEdge,lane:number) {
    const targets=this.laneLinks.targets(incoming,next,incoming.laneNumbers[lane]);
    return targets===null?[Math.min(lane,next.laneIndices.length-1)]:next.laneNumbers.flatMap((number,index)=>targets.includes(number)?[index]:[]);
  }
  connectionPaths(wayId:string,physicalLane:number|null) {
    return this.laneLinks.entries.filter(c=>c.fromWay===wayId).flatMap(c=>{
      const from=this.starts.find(e=>e.wayId===c.fromWay&&e.to===c.via&&e.laneNumbers.includes(c.from)),to=this.starts.find(e=>e.wayId===c.toWay&&e.from===c.via&&e.laneNumbers.includes(c.to));
      if(!from||!to)return [];
      const a=from.laneNumbers.indexOf(c.from),b=to.laneNumbers.indexOf(c.to);
      if(physicalLane!==null&&from.laneIndices[a]!==physicalLane)return [];
      const pose=(edge:TrafficEdge,lane:number,progress:number)=>this.pose({edge,lane,progress,kind:"car"} as TrafficVehicle);
      return [{start:pose(from,a,Math.max(0,1-12/from.length)),end:pose(to,b,Math.min(1,12/to.length)),via:from.b}];
    });
  }
  canRoute(stops: string[]): boolean {
    return this.routeWayIds(stops) !== null;
  }
  routeWayIds(stops: string[]): string[] | null {
    if (stops.length < 2) return null;
    const ways: string[] = [];
    const history: TrafficEdge[] = [];let lane=0;
    for (let i = 1; i < stops.length; i++) {
      const path = this.shortestPath(stops[i - 1], stops[i], history, "bus",lane);
      lane=this.pathLanes.get(path)?.at(-1)??0;
      history.push(...path);
      if (!path.length) return null;
      for (const edge of path)
        if (ways[ways.length - 1] !== edge.wayId) ways.push(edge.wayId);
    }
    return ways;
  }
  addBus(routeId: string): string | null {
    const first = this.routes.get(routeId)?.legs[0]?.[0];
    if (!first || !this.hasRoom(first, 0, 0.02, 9)) return null;
    const id = String(this.nextId++);
    this.cars.set(id, {
      id,
      edge: first,
      progress: 0.02,
      speed: Math.min(first.speed, 13.9),
      lane: this.pathLanes.get(this.routes.get(routeId)!.legs[0])?.[0]??0,
      color: 0,
      stopped: false,
      kind: "bus",
      routeId,
      routeLeg: 0,
      routeStep: 0,
      dwell: 0,
    });
    return id;
  }
  get busCount() {
    return Array.from(this.cars.values()).filter((car) => car.kind === "bus")
      .length;
  }
  routeEdges(routeId: string): TrafficEdge[] {
    return this.routes.get(routeId)?.legs.flat() ?? [];
  }
  private addEdge(edge: TrafficEdge) {
    const list = this.outgoing.get(edge.from) ?? [];
    list.push(edge);
    this.outgoing.set(edge.from, list);
    this.starts.push(edge);
  }
  get networkSummary() {
    const nodes = new Set(this.starts.flatMap((e) => [e.from, e.to]));
    const incoming = new Set(this.starts.map((e) => e.to));
    return {
      directedEdges: this.starts.length,
      nodes: nodes.size,
      sinks: [...nodes].filter((id) => !this.outgoing.has(id)),
      sources: [...nodes].filter((id) => !incoming.has(id)),
    };
  }
  get available() {
    return this.starts.length;
  }
  get size() {
    return this.cars.size;
  }
  get clock() {
    return this.seconds;
  }
  private hasRoom(
    edge: TrafficEdge,
    lane: number,
    progress: number,
    length = 4.1,
    ignoreId?:string,
  ): boolean {
    return !Array.from(this.cars.values()).some((car) => {
      if(car.id===ignoreId)return false;
      const sameLane = car.edge === edge && car.lane === lane;
      const sharedLane =
        car.edge.wayId === edge.wayId &&
        car.edge.from === edge.to &&
        car.edge.to === edge.from &&
        car.edge.laneIndices[car.lane] === edge.laneIndices[lane];
      if(sharedLane && edge.lanes===1)return true;
      return (
        (sameLane || sharedLane) &&
        Math.abs((sharedLane ? 1 - car.progress : car.progress) - progress) *
          edge.length <
          (length + (car.kind === "bus" ? 9 : 4.1)) / 2 + 2
      );
    });
  }
  /** Clicked physical lane determines direction; never retry in the opposing lane. */
  addOnLane(
    wayId: string,
    from: string,
    to: string,
    progress: number,
    physicalLane: number,
  ): string | null {
    const edge = this.starts.find(
      (e) =>
        e.wayId === wayId &&
        ((e.from === from && e.to === to) ||
          (e.from === to && e.to === from)) &&
        e.laneIndices.includes(physicalLane),
    );
    return edge
      ? this.addAt(
          wayId,
          edge.from,
          edge.to,
          edge.from === from ? progress : 1 - progress,
          edge.laneIndices.indexOf(physicalLane),
        )
      : null;
  }
  get metrics() {
    const cars = [...this.cars.values()];
    const stopped = cars.filter((c) => c.stopped).length;
    return {
      stopped,
      moving: cars.length - stopped,
      averageKmh: cars.length
        ? cars.reduce((n, c) => n + (c.stopped ? 0 : c.speed * 3.6), 0) /
          cars.length
        : 0,
    };
  }
  addAt(
    wayId: string,
    from: string,
    to: string,
    progress: number,
    lane = 0,
  ): string | null {
    const edge = this.starts.find(
      (candidate) =>
        candidate.wayId === wayId &&
        candidate.from === from &&
        candidate.to === to,
    );
    if (!edge) return null;
    lane = clamp(Math.floor(lane), 0, edge.laneIndices.length - 1);
    progress = clamp(progress, 0.02, 0.96);
    if (!this.hasRoom(edge, lane, progress)) return null;
    const id = String(this.nextId++);
    this.cars.set(id, {
      id,
      edge,
      progress: clamp(progress, 0.02, 0.96),
      speed: edge.speed * 0.85,
      lane,
      color: Number(id) % 6,
      stopped: false,
      kind: "car",
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
    const pool = wayId
      ? this.starts.filter((edge) => edge.wayId === wayId)
      : central.length
        ? central
        : this.starts;
    if (!pool.length) return ids;
    for (
      let i = 0;
      ids.length < Math.min(count, 150) && i < Math.min(count, 150) * 20;
      i++
    ) {
      const edge = pool[Math.floor(Math.random() * pool.length)];
      const id = this.addAt(
        edge.wayId,
        edge.from,
        edge.to,
        0.05 + Math.random() * 0.7,
        Math.floor(Math.random() * edge.laneIndices.length),
      );
      if (id) ids.push(id);
    }
    return ids;
  }
  remove(id: string): boolean {
    return this.cars.delete(id);
  }
  clear() {
    this.cars.clear();
  }
  private nextEdge(car: TrafficVehicle): TrafficEdge | null {
    const candidates = (this.outgoing.get(car.edge.to) ?? []).filter(
      (edge) =>
        edge.to !== car.edge.from && this.targetLanes(car.edge,edge,car.lane).length>0 &&
        this.turnRules.allowed(
          car.edge,
          edge,
          car.pathWays ?? [car.edge.wayId],
          car.kind,
        ),
    );
    if (!candidates.length) {
      return null; // Hold at a dead end rather than teleport through a U-turn.
    }
    const directionX = car.edge.b.x - car.edge.a.x;
    const directionZ = car.edge.b.z - car.edge.a.z;
    const weighted = candidates.map((edge) => {
      const nextX = edge.b.x - edge.a.x;
      const nextZ = edge.b.z - edge.a.z;
      const dot =
        (directionX * nextX + directionZ * nextZ) /
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
    let remaining = clamp(dt, 0, 0.1) * clamp(speedFactor, 0, 5);
    while (remaining > 0.000001) {
      const step = Math.min(0.02, remaining);
      this.step(step);
      remaining -= step;
    }
  }
  private step(elapsed: number) {
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
      const signalRed =
        this.signals.has(car.edge.to) &&
        Math.floor(this.seconds / 12) % 2 === 0;
      const queue = lanes.get(car.edge)?.get(car.lane) ?? [];
      const index = queue.indexOf(car);
      const leading = index > 0 ? queue[index - 1] : null;
      const headway = leading
        ? (leading.progress - car.progress) * car.edge.length
        : Infinity;
      const clearance = leading
        ? ((car.kind === "bus" ? 9 : 4.1) +
            (leading.kind === "bus" ? 9 : 4.1)) /
            2 +
          2
        : 0;
      car.stopped = (signalRed && distanceLeft < 7) || headway <= clearance;
      if (car.stopped) continue;
      const travel = Math.min(
        car.speed * elapsed,
        Math.max(0, headway - clearance),
        signalRed ? Math.max(0, distanceLeft - 6) : Infinity,
      );
      car.progress += travel / car.edge.length;
      if (car.progress < 1) continue;
      const routeState = {
        routeLeg: car.routeLeg,
        routeStep: car.routeStep,
        dwell: car.dwell,
      };
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
          car.routeLeg =
            nextLeg < legs.length ? nextLeg : route?.loop ? 0 : nextLeg;
          car.routeStep = 0;
          next = legs[car.routeLeg]?.[0] ?? null;
          car.dwell = 3;
        }
      } else next = this.nextEdge(car);
      if (
        next &&
        !this.turnRules.allowed(
          car.edge,
          next,
          car.pathWays ?? [car.edge.wayId],
          car.kind,
        )
      )
        next = null;
      if (!next) {
        if (car.kind === "bus") Object.assign(car, routeState);
        car.progress = 1;
        car.stopped = true;
        continue;
      }
      const choices=this.targetLanes(car.edge,next,car.lane);
      const planned=car.kind==="bus"?this.pathLanes.get(this.routes.get(car.routeId!)?.legs[car.routeLeg??0]??[])?.[car.routeStep??0]:undefined;
      const nextLane=planned!==undefined&&choices.includes(planned)?planned:choices[0];
      if(nextLane===undefined){if(car.kind==="bus")Object.assign(car,routeState);car.progress=1;car.stopped=true;continue;}
      if (!this.hasRoom(next, nextLane, 0, car.kind === "bus" ? 9 : 4.1,car.id)) {
        car.progress = 1 - 0.001 / car.edge.length;
        car.stopped = true;
        // Roll back bus routing state while waiting for the outgoing lane.
        if (car.kind === "bus") {
          Object.assign(car, routeState);
        }
        continue;
      }
      car.progress = clamp(
        ((car.progress - 1) * car.edge.length) / next.length,
        0,
        0.99,
      );
      car.pathWays = this.turnRules.advance(
        car.pathWays ?? [car.edge.wayId],
        next,
      );
      car.edge = next;
      car.speed =
        car.kind === "bus" ? Math.min(next.speed, 13.9) : next.speed * 0.8;
      car.lane = nextLane;
    }
  }
  pose(car: TrafficVehicle): VehiclePose {
    const { a, b, width, lanes, elevation } = car.edge;
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const laneWidth = width / Math.max(1, lanes);
    const physicalLane =
      car.edge.laneIndices[car.lane] ?? car.edge.laneIndices[0];
    const canonicalOffset = -width / 2 + (physicalLane + 0.5) * laneWidth;
    const offsetSide = car.edge.reverse ? -canonicalOffset : canonicalOffset;
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
  const kmh = match
    ? Number(match[1])
    : tags.highway === "living_street"
      ? 20
      : tags.highway === "service"
        ? 25
        : 45;
  return (
    clamp(tags.maxspeed?.includes("mph") ? kmh * 1.609344 : kmh, 0, 130) / 3.6
  );
}
