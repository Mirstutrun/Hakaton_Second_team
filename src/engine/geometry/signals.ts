import {
  MeshBuilder,
  Vector3,
  type Mesh,
  type Scene,
  type Material,
} from "@babylonjs/core";

export function buildSignal(
  id: string,
  point: Vector3,
  scene: Scene,
  poleMaterial: Material,
  lampMaterial: Material,
): Mesh[] {
  const pole = MeshBuilder.CreateCylinder(
    `signal:${id}`,
    { height: 6, diameter: 0.35, tessellation: 6 },
    scene,
  );
  pole.position = point.add(new Vector3(0, 3, 0));
  pole.material = poleMaterial;
  const head = MeshBuilder.CreateBox(
    `signal-head:${id}`,
    { width: 1.5, height: 2.6, depth: 0.8 },
    scene,
  );
  head.position = point.add(new Vector3(0, 5.6, 0));
  head.material = poleMaterial;
  const lamp = MeshBuilder.CreateSphere(
    `signal-lamp:${id}`,
    { diameter: 0.85, segments: 6 },
    scene,
  );
  lamp.position = point.add(new Vector3(0, 5.4, -0.5));
  lamp.material = lampMaterial;
  for (const mesh of [pole, head, lamp])
    mesh.metadata = { type: "node", id, role: "signal" };
  return [pole, head, lamp];
}
