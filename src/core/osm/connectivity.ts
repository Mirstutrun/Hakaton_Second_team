import { coordinateOf, refsOf, tagsOf, type OsmDocument } from "./model";
import { oneWayDirection } from "../../engine/trafficRules";
export function networkConnectivity(document: OsmDocument) {
  const graph = new Map<string, Set<string>>(),
    reverse = new Map<string, Set<string>>(),
    weak = new Map<string, Set<string>>();
  const excluded = new Set([
    "footway",
    "path",
    "steps",
    "pedestrian",
    "cycleway",
    "bridleway",
    "corridor",
    "platform",
    "construction",
    "proposed",
  ]);
  const add = (map: Map<string, Set<string>>, a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
    if (!map.has(b)) map.set(b, new Set());
  };
  const ways = new Map<string, string[]>();
  for (const [id, way] of document.ways) {
    const t = tagsOf(way);
    if (
      !t.highway ||
      excluded.has(t.highway) ||
      t.area === "yes" ||
      (t.motor_vehicle ?? t.vehicle ?? t.access) === "no"
    )
      continue;
    const refs = refsOf(way).filter((id) => document.nodes.has(id));
    ways.set(id, refs);
    for (let i = 1; i < refs.length; i++) {
      const a = refs[i - 1],
        b = refs[i],
        dir = oneWayDirection(t);
      add(weak, a, b);
      add(weak, b, a);
      if (dir !== -1) {
        add(graph, a, b);
        add(reverse, b, a);
      }
      if (dir !== 1) {
        add(graph, b, a);
        add(reverse, a, b);
      }
    }
  }
  const components: {
    nodes: string[];
    ways: string[];
    coordinate: { lat: number; lon: number };
  }[] = [];
  const seen = new Set<string>();
  for (const id of weak.keys())
    if (!seen.has(id)) {
      const nodes: string[] = [],
        stack = [id];
      seen.add(id);
      while (stack.length) {
        const node = stack.pop()!;
        nodes.push(node);
        for (const next of weak.get(node) ?? [])
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
      }
      const members = new Set(nodes);
      components.push({
        nodes,
        ways: [...ways]
          .filter(([, refs]) => refs.some((id) => members.has(id)))
          .map(([id]) => id),
        coordinate: coordinateOf(document.nodes.get(id)!),
      });
    }
  components.sort((a, b) => b.nodes.length - a.nodes.length);
  // Iterative Kosaraju avoids call-stack failures on large city extracts.
  const visited = new Set<string>(),
    order: string[] = [];
  for (const id of graph.keys())
    if (!visited.has(id)) {
      const stack: [string, boolean][] = [[id, false]];
      while (stack.length) {
        const [node, exit] = stack.pop()!;
        if (exit) {
          order.push(node);
          continue;
        }
        if (visited.has(node)) continue;
        visited.add(node);
        stack.push([node, true]);
        for (const next of graph.get(node) ?? [])
          if (!visited.has(next)) stack.push([next, false]);
      }
    }
  visited.clear();
  let directedComponents = 0;
  for (const id of order.reverse())
    if (!visited.has(id)) {
      directedComponents++;
      const stack = [id];
      visited.add(id);
      while (stack.length) {
        for (const n of reverse.get(stack.pop()!) ?? [])
          if (!visited.has(n)) {
            visited.add(n);
            stack.push(n);
          }
      }
    }
  return {
    components,
    directedComponents,
    nodes: weak.size,
    roads: ways.size,
    connected: components.length === 1,
  };
}
