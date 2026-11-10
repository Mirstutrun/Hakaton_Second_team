import {
  Color3,
  Mesh,
  VertexData,
  Vector3,
  MeshBuilder,
  type Scene,
  type Material,
} from "@babylonjs/core";
import {
  drivingLanes,
  oneWayDirection,
  type DrivingSide,
} from "../trafficRules";
import type { Tags } from "../../core/osm/model";

export const pedestrianTypes = new Set([
  "footway",
  "path",
  "steps",
  "pedestrian",
  "cycleway",
  "bridleway",
]);

export function roadStyle(tags: Tags) {
  const pedestrian = pedestrianTypes.has(tags.highway);
  const lanes =
    Number(tags.lanes) ||
    (Number(tags["lanes:forward"]) || 0) +
      (Number(tags["lanes:backward"]) || 0) +
      (Number(tags["lanes:both_ways"]) || 0) ||
    (pedestrian || oneWayDirection(tags) !== 0 || tags.highway === "service"
      ? 1
      : 2);
  const explicitWidth = Number.parseFloat(tags.width);
  return {
    pedestrian,
    lanes: Math.min(20, Math.max(1, Math.floor(lanes))),
    width:
      Number.isFinite(explicitWidth) && explicitWidth > 0
        ? explicitWidth
        : pedestrian
          ? 2.2
          : Math.min(20, Math.max(1, Math.floor(lanes))) * 3.4,
    elevation:
      0.18 +
      (Number(tags.layer) ||
        (tags.bridge === "yes" ? 1 : tags.tunnel === "yes" ? -1 : 0)) *
        5,
  };
}

/**
 * Purely visual rounding: the underlying OSM nodes and exported XML are
 * untouched. Trim is capped so a short segment is never over-smoothed.
 */
export function smoothRoadPoints(
  points: Vector3[],
  radius = 8,
  protectedIndices?: ReadonlySet<number>,
): Vector3[] {
  if (points.length < 3 || radius <= 0) return points.map((p) => p.clone());
  const result: Vector3[] = [points[0].clone()];
  for (let i = 1; i < points.length - 1; i++) {
    if (protectedIndices?.has(i)) {
      result.push(points[i].clone());
      continue;
    }
    const prev = points[i - 1],
      current = points[i],
      next = points[i + 1];
    const into = current.subtract(prev),
      out = next.subtract(current);
    const inLen = into.length(),
      outLen = out.length();
    if (inLen < 0.05 || outLen < 0.05) {
      result.push(current.clone());
      continue;
    }
    const a = into.scale(1 / inLen),
      b = out.scale(1 / outLen);
    const dot = Math.max(-1, Math.min(1, Vector3.Dot(a, b)));
    if (dot > 0.998 || dot < -0.98) {
      result.push(current.clone());
      continue;
    }
    const trim = Math.min(radius, inLen * 0.32, outLen * 0.32);
    const p0 = current.subtract(a.scale(trim));
    const p2 = current.add(b.scale(trim));
    // Quadratic Bézier with short transitions and no overshoot.
    for (let step = 0; step <= 6; step++) {
      const t = step / 6;
      const s = 1 - t;
      const p = p0
        .scale(s * s)
        .add(current.scale(2 * s * t))
        .add(p2.scale(t * t));
      if (
        result.length === 0 ||
        Vector3.DistanceSquared(result[result.length - 1], p) > 0.00001
      )
        result.push(p);
    }
  }
  result.push(points[points.length - 1].clone());
  return result;
}

export function laneCenterline(
  points: Vector3[],
  width: number,
  count: number,
  lane: number,
): Vector3[] {
  if (points.length < 2) return [];
  const offset = -width / 2 + ((lane + 0.5) * width) / count;
  return points.map((point, index) => {
    const previous = points[Math.max(index - 1, 0)];
    const next = points[Math.min(index + 1, points.length - 1)];
    const direction = next.subtract(previous);
    direction.y = 0;
    if (direction.lengthSquared() < 0.00001) return point.clone();
    direction.normalize();
    return point.add(
      new Vector3(-direction.z * offset, 0, direction.x * offset),
    );
  });
}

export function selectedLaneMesh(
  wayId: string,
  original: Vector3[],
  tags: Tags,
  lane: number,
  scene: Scene,
  material: Material,
  protectedIndices?: ReadonlySet<number>,
): Mesh | null {
  const style = roadStyle(tags);
  if (
    style.pedestrian ||
    lane < 0 ||
    lane >= style.lanes ||
    original.length < 2
  )
    return null;
  const path = smoothRoadPoints(
    original.map((p) => new Vector3(p.x, style.elevation + 0.12, p.z)),
    8,
    protectedIndices,
  );
  const centerline = laneCenterline(path, style.width, style.lanes, lane);
  const mesh = ribbon(
    `lane:${wayId}:${lane}`,
    centerline,
    Math.max(0.6, style.width / style.lanes - 0.25),
    scene,
  );
  mesh.material = material;
  mesh.isPickable = false;
  mesh.metadata = { role: "lane-highlight", type: "way", id: wayId, lane };
  return mesh;
}

/** Стрелки направления движения на каждой полосе выбранной дороги. */
export function laneArrows(
  wayId: string,
  original: Vector3[],
  tags: Tags,
  side: DrivingSide,
  scene: Scene,
  protectedIndices?: ReadonlySet<number>,
): Mesh | null {
  const style = roadStyle(tags);
  if (style.pedestrian || original.length < 2) return null;
  const path = smoothRoadPoints(
    original.map((p) => new Vector3(p.x, style.elevation + 0.16, p.z)),
    8,
    protectedIndices,
  );
  const layout = drivingLanes(tags, style.lanes, side);
  const size = Math.max(0.7, Math.min(2.2, (style.width / style.lanes) * 0.42));
  const lines: Vector3[][] = [];
  for (let lane = 0; lane < style.lanes; lane++) {
    const forward = layout.forward.includes(lane), backward = layout.backward.includes(lane);
    if (!forward && !backward) continue;
    const centre = laneCenterline(path, style.width, style.lanes, lane);
    let total = 0;
    for (let i = 1; i < centre.length; i++) total += Vector3.Distance(centre[i - 1], centre[i]);
    let travelled = 0, next = total < 14 ? total / 2 : 7;
    for (let i = 1; i < centre.length; i++) {
      const a = centre[i - 1], b = centre[i], length = Vector3.Distance(a, b);
      if (length < 0.01) continue;
      const along = b.subtract(a).scale(1 / length);
      while (next <= travelled + length) {
        const at = a.add(along.scale(next - travelled));
        for (const sign of forward && backward ? [1, -1] : [forward ? 1 : -1]) {
          const d = along.scale(sign), n = new Vector3(-d.z, 0, d.x);
          const centreOfArrow = forward && backward ? at.add(d.scale(size * 0.8)) : at;
          const tail = centreOfArrow.subtract(d.scale(size));
          lines.push([tail.add(n.scale(size * 0.6)), centreOfArrow.add(d.scale(size * 0.4)), tail.subtract(n.scale(size * 0.6))]);
        }
        next += 18;
      }
      travelled += length;
    }
  }
  if (!lines.length) return null;
  const mesh = MeshBuilder.CreateLineSystem(`lane-arrows:${wayId}`, { lines }, scene);
  mesh.color = new Color3(0.98, 0.99, 0.93);
  mesh.isPickable = false;
  mesh.metadata = { role: "lane-arrows" };
  return mesh;
}

export function ribbon(
  name: string,
  points: Vector3[],
  width: number,
  scene: Scene,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  points.forEach((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const direction = after.subtract(before).normalize();
    const normal = new Vector3(-direction.z, 0, direction.x).scale(width / 2);
    for (const vertex of [point.add(normal), point.subtract(normal)])
      positions.push(vertex.x, vertex.y, vertex.z);
    if (index) {
      const start = (index - 1) * 2;
      indices.push(
        start,
        start + 1,
        start + 2,
        start + 1,
        start + 3,
        start + 2,
      );
    }
  });
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh);
  return mesh;
}

export function buildRoad(
  id: string,
  points: Vector3[],
  tags: Tags,
  scene: Scene,
  material: Material,
  lineMaterial: Material,
  protectedIndices?: ReadonlySet<number>,
  side: DrivingSide = "right",
): Mesh[] {
  if (points.length < 2) return [];
  const style = roadStyle(tags);
  const layout = drivingLanes(tags, style.lanes, side);
  const dividingLane =
    side === "left"
      ? Math.min(...layout.forward)
      : Math.max(...layout.forward) + 1;
  const path = smoothRoadPoints(
    points.map((point) => new Vector3(point.x, style.elevation, point.z)),
    8,
    protectedIndices,
  );
  const road = ribbon(`way:${id}`, path, style.width, scene);
  road.material = material;
  road.metadata = { type: "way", id, role: "road", width: style.width };
  const edgePath = path.map((p) => new Vector3(p.x, p.y - 0.025, p.z));
  const shoulder = ribbon(
    `shoulder:${id}`,
    edgePath,
    style.width + (style.pedestrian ? 0.15 : 0.65),
    scene,
  );
  shoulder.material = lineMaterial;
  shoulder.isPickable = false;
  shoulder.metadata = { role: "shoulder" };
  const result = [shoulder, road];
  if (!style.pedestrian) {
    const lines: Vector3[][] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i];
      const direction = b.subtract(a).normalize();
      const normal = new Vector3(-direction.z, 0, direction.x);
      for (const side of [-1, 1]) {
        const offset = normal
          .scale(side * (style.width / 2 - 0.25))
          .add(new Vector3(0, 0.06, 0));
        lines.push([a.add(offset), b.add(offset)]);
      }
      for (let lane = 1; lane < style.lanes; lane++) {
        const offset = normal
          .scale(-style.width / 2 + (lane * style.width) / style.lanes)
          .add(new Vector3(0, 0.07, 0));
        const length = Vector3.Distance(a, b);
        if (oneWayDirection(tags) === 0 && lane === dividingLane) {
          lines.push([a.add(offset), b.add(offset)]);
          continue;
        }
        for (let distance = 0; distance < length; distance += 9) {
          lines.push([
            a.add(direction.scale(distance)).add(offset),
            a.add(direction.scale(Math.min(distance + 4, length))).add(offset),
          ]);
        }
      }
    }
    if (lines.length) {
      const markings = MeshBuilder.CreateLineSystem(
        `markings:${id}`,
        { lines },
        scene,
      );
      markings.color.set(0.91, 0.93, 0.87);
      markings.isPickable = false;
      markings.metadata = { role: "markings" };
      result.push(markings);
    }
    if (oneWayDirection(tags) !== 0) {
      const a = path[0],
        b = path[1];
      const direction = b.subtract(a).normalize().scale(oneWayDirection(tags));
      const center = Vector3.Center(a, b).add(new Vector3(0, 0.1, 0));
      const side = new Vector3(-direction.z, 0, direction.x);
      const arrow = MeshBuilder.CreateLines(
        `arrow:${id}`,
        {
          points: [
            center.subtract(direction.scale(2)).add(side),
            center.add(direction.scale(2)),
            center.subtract(direction.scale(2)).subtract(side),
          ],
        },
        scene,
      );
      arrow.color.set(0.95, 0.95, 0.86);
      arrow.isPickable = false;
      arrow.metadata = { role: "markings" };
      result.push(arrow);
    }
  }
  return result;
}
