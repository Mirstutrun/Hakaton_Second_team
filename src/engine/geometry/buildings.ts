import {
  Mesh,
  VertexData,
  type Vector3,
  type Scene,
  type Material,
} from "@babylonjs/core";
import earcut from "earcut";
import type { Tags } from "../../core/osm/model";

export function buildBuilding(
  id: string,
  points: Vector3[],
  tags: Tags,
  scene: Scene,
  material: Material,
): Mesh | null {
  const ring =
    points.length > 2 && points[0].equals(points[points.length - 1])
      ? points.slice(0, -1)
      : points;
  if (ring.length < 3) return null;
  const height = Math.max(
    2,
    Math.min(
      200,
      Number.parseFloat(tags.height) ||
        Number(tags["building:levels"]) * 3.2 ||
        12,
    ),
  );
  const positions: number[] = [];
  const indices: number[] = [];
  ring.forEach((point) => positions.push(point.x, height, point.z));
  indices.push(...earcut(ring.flatMap((point) => [point.x, point.z])));
  ring.forEach((point, index) => {
    const next = ring[(index + 1) % ring.length];
    const start = positions.length / 3;
    positions.push(
      point.x,
      0,
      point.z,
      next.x,
      0,
      next.z,
      point.x,
      height,
      point.z,
      next.x,
      height,
      next.z,
    );
    indices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  });
  const mesh = new Mesh(`building:${id}`, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.metadata = { role: "building", id };
  return mesh;
}
