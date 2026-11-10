import {
  Mesh,
  VertexData,
  type Vector3,
  type Scene,
  type Material,
} from "@babylonjs/core";
import earcut from "earcut";
import type { Tags } from "../../core/osm/model";

/** One mesh per building; subtle per-face colours add depth without textures. */
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
  if (
    ring.length < 3 ||
    ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))
  )
    return null;
  const height = Math.max(
    2,
    Math.min(
      200,
      Number.parseFloat(tags.height) ||
        Number(tags["building:levels"]) * 3.2 ||
        9.6,
    ),
  );
  const base = Math.max(
    0,
    Math.min(height - 1, Number.parseFloat(tags.min_height) || 0),
  );
  const positions: number[] = [],
    indices: number[] = [],
    colors: number[] = [];
  const palette = [
    [0.76, 0.77, 0.7],
    [0.78, 0.76, 0.69],
    [0.73, 0.77, 0.74],
    [0.78, 0.78, 0.74],
  ];
  const hash = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const tint = palette[hash % palette.length];
  const color = (shade: number) =>
    colors.push(...tint.map((c) => Math.min(1, c * shade)), 1);
  ring.forEach((p) => {
    positions.push(p.x, height, p.z);
    color(1.08);
  });
  const triangles = earcut(ring.flatMap((p) => [p.x, p.z]));
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    const cross =
      (ring[b].z - ring[a].z) * (ring[c].x - ring[a].x) -
      (ring[b].x - ring[a].x) * (ring[c].z - ring[a].z);
    indices.push(a, cross >= 0 ? c : b, cross >= 0 ? b : c);
  }
  ring.forEach((p, i) => {
    const next = ring[(i + 1) % ring.length],
      start = positions.length / 3;
    positions.push(
      p.x,
      base,
      p.z,
      next.x,
      base,
      next.z,
      p.x,
      height,
      p.z,
      next.x,
      height,
      next.z,
    );
    const dx = next.x - p.x,
      dz = next.z - p.z,
      len = Math.hypot(dx, dz) || 1;
    const shade = 0.89 + 0.06 * Math.abs(dx / len) + 0.03 * Math.abs(dz / len);
    for (let j = 0; j < 4; j++) color(shade);
    indices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  });
  const mesh = new Mesh(`building:${id}`, scene),
    data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.colors = colors;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.isPickable = false;
  mesh.metadata = { role: "building", id };
  return mesh;
}
