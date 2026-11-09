import {
  Mesh,
  VertexData,
  Vector3,
  MeshBuilder,
  type Scene,
  type Material,
} from "@babylonjs/core";
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
    (pedestrian ||
    tags.oneway === "yes" ||
    tags.oneway === "-1" ||
    tags.highway === "service"
      ? 1
      : 2);
  const explicitWidth = Number.parseFloat(tags.width);
  return {
    pedestrian,
    lanes: Math.min(20, Math.max(1, lanes)),
    width:
      Number.isFinite(explicitWidth) && explicitWidth > 0
        ? explicitWidth
        : pedestrian
          ? 2.2
          : Math.min(20, Math.max(1, lanes)) * 3.4,
    elevation:
      0.18 +
      (Number(tags.layer) ||
        (tags.bridge === "yes" ? 1 : tags.tunnel === "yes" ? -1 : 0)) *
        5,
  };
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
): Mesh[] {
  if (points.length < 2) return [];
  const style = roadStyle(tags);
  const path = points.map(
    (point) => new Vector3(point.x, style.elevation, point.z),
  );
  const road = ribbon(`way:${id}`, path, style.width, scene);
  road.material = material;
  road.metadata = { type: "way", id, role: "road", width: style.width };
  const result = [road];
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
      markings.color.set(0.65, 0.74, 0.7);
      markings.isPickable = false;
      markings.metadata = { role: "markings" };
      result.push(markings);
    }
    if (tags.oneway === "yes" || tags.oneway === "-1") {
      const a = path[0],
        b = path[1];
      const direction = b
        .subtract(a)
        .normalize()
        .scale(tags.oneway === "-1" ? -1 : 1);
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
      arrow.color.set(0.7, 0.88, 0.8);
      arrow.isPickable = false;
      arrow.material = lineMaterial;
      result.push(arrow);
    }
  }
  return result;
}
