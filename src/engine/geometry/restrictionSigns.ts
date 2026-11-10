import {
  Mesh,
  MeshBuilder,
  Vector3,
  type Scene,
  type Material,
} from "@babylonjs/core";
import { coordinateOf, tagsOf, type OsmDocument } from "../../core/osm/model";
import {
  turnRestrictions,
  restrictionType,
} from "../../core/osm/turnRestrictions";
import type { createProjection } from "../../core/geo/projection";
export function buildRestrictionSigns(
  document: OsmDocument,
  projection: ReturnType<typeof createProjection>,
  scene: Scene,
  materials: Record<string, Material>,
): Mesh[] {
  const result: Mesh[] = [];
  for (const rule of turnRestrictions(document)) {
    if (!rule.via) continue;
    const node = document.nodes.get(rule.via);
    if (!node) continue;
    const p = projection.project(coordinateOf(node)),
      type = restrictionType(rule.tags),
      only = type.startsWith("only_");
    if (!type) continue;
    const sign = MeshBuilder.CreateDisc(
      `sign:${rule.id}`,
      { radius: 2, tessellation: 24 },
      scene,
    );
    const fromWay = document.ways.get(rule.from[0]);
    const elevation = fromWay ? Number(tagsOf(fromWay).layer || 0) * 5 : 0;
    sign.position = new Vector3(p.x + 5, 4 + elevation, p.z + 3);
    sign.billboardMode = Mesh.BILLBOARDMODE_ALL;
    sign.material = materials[only ? "signBlue" : "signRed"];
    sign.isPickable = false;
    sign.metadata = { role: "restriction-sign", id: rule.id };
    result.push(sign);
    if (!only) {
      const inset = MeshBuilder.CreateDisc(
        `sign-face:${rule.id}`,
        { radius: 1.55, tessellation: 24 },
        scene,
      );
      inset.parent = sign;
      inset.position.z = -0.03;
      inset.material = materials.signWhite;
      inset.isPickable = false;
    }
    let points = type.includes("left")
      ? [
          new Vector3(0.6, -0.9, -0.08),
          new Vector3(0.6, 0.4, -0.08),
          new Vector3(-0.7, 0.4, -0.08),
        ]
      : type.includes("right")
        ? [
            new Vector3(-0.6, -0.9, -0.08),
            new Vector3(-0.6, 0.4, -0.08),
            new Vector3(0.7, 0.4, -0.08),
          ]
        : type.includes("u_turn")
          ? [
              new Vector3(0.6, -0.8, -0.08),
              new Vector3(0.6, 0.7, -0.08),
              new Vector3(-0.6, 0.7, -0.08),
              new Vector3(-0.6, -0.3, -0.08),
            ]
          : [new Vector3(0, -0.9, -0.08), new Vector3(0, 0.9, -0.08)];
    const tip = points[points.length - 1],
      prev = points[points.length - 2],
      dir = tip.subtract(prev).normalize(),
      side = new Vector3(-dir.y, dir.x, 0);
    const lines = [
      points,
      [
        tip.subtract(dir.scale(0.45)).add(side.scale(0.4)),
        tip,
        tip.subtract(dir.scale(0.45)).subtract(side.scale(0.4)),
      ],
    ];
    if (!only)
      lines.push([
        new Vector3(-1.1, -1.1, -0.13),
        new Vector3(1.1, 1.1, -0.13),
      ]);
    const arrow = MeshBuilder.CreateLineSystem(
      `sign-arrow:${rule.id}`,
      { lines },
      scene,
    );
    arrow.parent = sign;
    arrow.color.set(only ? 1 : 0.12, only ? 1 : 0.15, only ? 1 : 0.17);
    arrow.isPickable = false;
  }
  return result;
}
