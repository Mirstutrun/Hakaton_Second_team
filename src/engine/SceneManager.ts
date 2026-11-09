import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Plane,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
  type Mesh,
} from "@babylonjs/core";
import { createProjection, documentOrigin } from "../core/geo/projection";
import {
  coordinateOf,
  refsOf,
  tagsOf,
  type EditPatch,
  type OsmDocument,
  type RoadPoint,
} from "../core/osm/model";
import {
  buildRoad, roadStyle, selectedLaneMesh, smoothRoadPoints,
} from "./geometry/roads";
import { TrafficModel } from "./TrafficModel";
import { buildBuilding } from "./geometry/buildings";
import { buildSignal } from "./geometry/signals";
import type { useEditorStore } from "../stores/editor";

export class SceneManager {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private document: OsmDocument | null = null;
  private projection = createProjection({ lat: 52.26, lon: 104.26 });
  private wayMeshes = new Map<string, Mesh[]>();
  private signalMeshes = new Map<string, Mesh[]>();
  private junctionCounts = new Map<string, number>();
  private handles: Mesh[] = [];
  private issueMeshes: Mesh[] = [];
  private preview: Mesh | null = null;
  private laneHighlight: Mesh | null = null;
  private traffic: TrafficModel | null = null;
  private vehicleMeshes = new Map<string, Mesh>();
  private vehicleHeadings = new Map<string, number>();
  private vehicleMaterials: StandardMaterial[] = [];
  private drag: {
    id: string;
    plane: Plane;
    point: Vector3;
    mesh: Mesh;
  } | null = null;
  private down = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver;
  private materials: Record<string, StandardMaterial> = {};
  private previousView = { alpha: -Math.PI / 2, beta: 0.95, radius: 1550 };

  constructor(
    private canvas: HTMLCanvasElement,
    private store: ReturnType<typeof useEditorStore>,
  ) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    this.engine.setHardwareScalingLevel(
      Math.max(1, window.devicePixelRatio / 1.5),
    );
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.87, 0.92, 0.94, 1);
    this.camera = new ArcRotateCamera(
      "camera",
      -Math.PI / 2,
      0.95,
      1550,
      Vector3.Zero(),
      this.scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.lowerRadiusLimit = 12;
    this.camera.upperRadiusLimit = 16000;
    this.camera.lowerBetaLimit = 0.02;
    this.camera.upperBetaLimit = Math.PI / 2 - 0.05;
    this.camera.minZ = 0.2;
    this.camera.maxZ = 40000;
    this.camera.wheelDeltaPercentage = 0.015;
    this.camera.panningSensibility = 12;
    const light = new HemisphericLight(
      "sky",
      new Vector3(0.2, 1, -0.5),
      this.scene,
    );
    light.intensity = 1.2;
    light.groundColor = Color3.FromHexString("#cadbdd");
    for (const [name, color] of Object.entries({
      asphalt: "#7b929e",
      pedestrian: "#bbcebe",
      building: "#b6c8d5",
      selected: "#188ba4",
      selectedLane: "#38d5ee",
      selectedVehicle: "#ffac38",
      handle: "#effcfd",
      ground: "#edf3ef",
      pole: "#415f74",
      lamp: "#43cbb0",
      line: "#edf9f4",
      issueCrossing: "#ffb968",
      issueBuilding: "#ff6e84",
      issueGap: "#aee1ff",
    })) {
      const material = new StandardMaterial(name, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      material.backFaceCulling = false;
      if (["selected", "selectedLane", "selectedVehicle", "handle", "lamp", "issueCrossing", "issueBuilding", "issueGap"].includes(name))
        material.emissiveColor = material.diffuseColor.scale(0.4);
      this.materials[name] = material;
    }
    for (const [index, hex] of [
      "#e8e8e2", "#f5ac59", "#8cc6e9", "#ef7773", "#b8a1e4", "#99ca9b",
    ].entries()) {
      const paint = new StandardMaterial(`car-${index}`, this.scene);
      paint.diffuseColor = Color3.FromHexString(hex);
      paint.specularColor = Color3.FromHexString("#47515a");
      this.vehicleMaterials.push(paint);
    }
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 40000, height: 40000 },
      this.scene,
    );
    ground.position.y = -10;
    ground.material = this.materials.ground;
    ground.metadata = { role: "ground" };
    const lines: Vector3[][] = [];
    for (let axis = -5000; axis <= 5000; axis += 100) {
      lines.push([
        new Vector3(axis, -9.9, -5000),
        new Vector3(axis, -9.9, 5000),
      ]);
      lines.push([
        new Vector3(-5000, -9.9, axis),
        new Vector3(5000, -9.9, axis),
      ]);
    }
    const grid = MeshBuilder.CreateLineSystem("grid", { lines }, this.scene);
    grid.color = Color3.FromHexString("#d8e5e2");
    grid.isPickable = false;
    this.scene.onPointerObservable.add((info) =>
      this.pointer(info.type, info.event as PointerEvent),
    );
    this.scene.onBeforeRenderObservable.add(() => {
      this.updateOrtho();
      this.tickTraffic();
    });
    this.resizeObserver = new ResizeObserver(() => this.engine.resize());
    this.resizeObserver.observe(canvas);
    this.engine.runRenderLoop(() => this.scene.render());
  }

  private point(id: string): Vector3 | null {
    const node = this.document?.nodes.get(id);
    if (!node) return null;
    const point = this.projection.project(coordinateOf(node));
    return new Vector3(point.x, 0, point.z);
  }

  load(document: OsmDocument) {
    this.document = document;
    this.projection = createProjection(documentOrigin(document));
    for (const meshes of [
      ...this.wayMeshes.values(),
      ...this.signalMeshes.values(),
    ])
      meshes.forEach((mesh) => mesh.dispose());
    this.wayMeshes.clear();
    this.signalMeshes.clear();
    this.clearVehicles();
    this.traffic = new TrafficModel(document);
    this.rebuildJunctionCounts();
    for (const id of document.ways.keys()) this.refreshWay(id);
    for (const id of document.nodes.keys()) this.refreshSignal(id);
    this.camera.setTarget(Vector3.Zero());
    this.camera.radius = 1550;
    this.setView();
    this.refreshSelection();
    this.refreshIssues();
    this.visibility();
    this.addVehicles(18);
  }

  private rebuildJunctionCounts() {
    this.junctionCounts.clear();
    if (!this.document) return;
    for (const way of this.document.ways.values()) {
      if (!tagsOf(way).highway) continue;
      for (const id of new Set(refsOf(way)))
        this.junctionCounts.set(id, (this.junctionCounts.get(id) ?? 0) + 1);
    }
  }

  private protectedCorners(refs: string[]): ReadonlySet<number> {
    const indices = new Set<number>();
    for (let index = 1; index < refs.length - 1; index++) {
      const id = refs[index];
      const node = this.document?.nodes.get(id);
      const tags = node ? tagsOf(node) : {};
      if ((this.junctionCounts.get(id) ?? 0) > 1 ||
          tags.highway === "traffic_signals" || tags.barrier || tags.railway)
        indices.add(index);
    }
    return indices;
  }

  private refreshWay(id: string) {
    this.wayMeshes.get(id)?.forEach((mesh) => mesh.dispose());
    this.wayMeshes.delete(id);
    const way = this.document?.ways.get(id);
    if (!way) return;
    const tags = tagsOf(way);
    const refs = refsOf(way);
    const points = refs
      .map((ref) => this.point(ref))
      .filter((point): point is Vector3 => point !== null);
    const meshes: Mesh[] = [];
    if (tags.highway) {
      const style = roadStyle(tags);
      meshes.push(
        ...buildRoad(
          id,
          points,
          tags,
          this.scene,
          this.materials[style.pedestrian ? "pedestrian" : "asphalt"],
          this.materials.line,
          this.protectedCorners(refs),
        ),
      );
    }
    if (tags.building && tags.building !== "no") {
      const building = buildBuilding(
        id,
        points,
        tags,
        this.scene,
        this.materials.building,
      );
      if (building) meshes.push(building);
    }
    if (meshes.length) this.wayMeshes.set(id, meshes);
  }

  private refreshSignal(id: string) {
    this.signalMeshes.get(id)?.forEach((mesh) => mesh.dispose());
    this.signalMeshes.delete(id);
    const node = this.document?.nodes.get(id);
    const point = this.point(id);
    if (!node || !point || tagsOf(node).highway !== "traffic_signals") return;
    const way = Array.from(this.document!.ways.values()).find(
      (way) => tagsOf(way).highway && refsOf(way).includes(id),
    );
    point.y = way ? roadStyle(tagsOf(way)).elevation : 0;
    this.signalMeshes.set(
      id,
      buildSignal(
        id,
        point,
        this.scene,
        this.materials.pole,
        this.materials.lamp,
      ),
    );
  }

  refreshChangedMeshes(patch: EditPatch | null) {
    if (!patch || !this.document) return;
    const nodes = new Set(
      patch.changes
        .filter((change) => change.type === "node")
        .map((change) => change.id),
    );
    const ways = new Set(
      patch.changes
        .filter((change) => change.type === "way")
        .map((change) => change.id),
    );
    this.rebuildJunctionCounts();
    if (nodes.size)
      for (const [id, way] of this.document.ways)
        if (refsOf(way).some((ref) => nodes.has(ref))) ways.add(id);
    for (const id of ways) {
      this.refreshWay(id);
      const way = this.document.ways.get(id);
      if (way)
        for (const ref of refsOf(way))
          if (this.signalMeshes.has(ref)) nodes.add(ref);
    }
    for (const id of nodes) this.refreshSignal(id);
    this.refreshSelection();
    this.refreshIssues();
    this.resetTrafficAfterEdit();
    this.visibility();
  }

  private resetTrafficAfterEdit() {
    this.clearVehicles();
    if (this.document) this.traffic = new TrafficModel(this.document);
  }

  addVehicleAt(wayId: string, position: Vector3) {
    if (!this.document || !this.traffic) return;
    const way = this.document.ways.get(wayId);
    if (!way) return;
    const nearest = this.nearestSegment(wayId, position);
    const refs = refsOf(way);
    const from = refs[nearest.index - 1], to = refs[nearest.index];
    const a = this.point(from), b = this.point(to);
    if (!a || !b) return;
    const delta = b.subtract(a);
    const progress = Math.max(0.02, Math.min(0.96,
      Vector3.Dot(position.subtract(a), delta) / (delta.lengthSquared() || 1)));
    const lane = this.laneAtPoint(wayId, position) ?? 0;
    const id = this.traffic.addAt(wayId, from, to, progress, lane) ??
      this.traffic.addAt(wayId, to, from, 1 - progress, lane);
    if (!id) {
      this.store.error = "На выбранной дороге нет доступного направления движения";
      return;
    }
    this.spawnCarMesh(id);
    this.store.vehicleCount = this.traffic.size;
  }

  private spawnCarMesh(id: string) {
    const vehicle = this.traffic?.cars.get(id);
    if (!vehicle) return;
    const mesh = MeshBuilder.CreateBox(`vehicle:${id}`,
      { width: 1.8, height: 1.25, depth: 4.1 }, this.scene);
    mesh.material = this.vehicleMaterials[vehicle.color % this.vehicleMaterials.length];
    mesh.metadata = { role: "vehicle", id };
    const cabin = MeshBuilder.CreateBox(`vehicle-cabin:${id}`,
      { width: 1.45, height: 0.35, depth: 2.05 }, this.scene);
    cabin.parent = mesh;
    cabin.position.set(0, 0.73, -0.2);
    cabin.material = this.materials.pole;
    cabin.isPickable = false;
    this.vehicleMeshes.set(id, mesh);
    const position = this.traffic!.pose(vehicle);
    mesh.position.set(position.x, position.y, position.z);
    mesh.rotation.y = position.heading;
  }

  addVehicles(count: number) {
    if (!this.traffic) return;
    const wayId = this.store.selection?.type === "way"
      ? this.store.selection.id : undefined;
    for (const id of this.traffic.add(count, wayId))
      this.spawnCarMesh(id);
    this.store.vehicleCount = this.traffic.size;
  }

  deleteSelectedVehicle() {
    const id = this.store.selectedVehicle;
    if (!id) return;
    this.traffic?.remove(id);
    this.vehicleMeshes.get(id)?.dispose();
    this.vehicleMeshes.delete(id);
    this.vehicleHeadings.delete(id);
    this.store.selectedVehicle = null;
    this.store.vehicleCount = this.traffic?.size ?? 0;
  }

  clearVehicles() {
    for (const mesh of this.vehicleMeshes.values()) mesh.dispose();
    this.vehicleMeshes.clear();
    this.vehicleHeadings.clear();
    this.traffic?.clear();
    this.store.selectedVehicle = null;
    this.store.vehicleCount = 0;
  }

  private tickTraffic() {
    if (!this.traffic) return;
    if (this.store.trafficRunning)
      this.traffic.update(this.engine.getDeltaTime() / 1000, this.store.trafficSpeed);
    for (const [id, mesh] of this.vehicleMeshes) {
      const car = this.traffic.cars.get(id);
      if (!car) continue;
      const position = this.traffic.pose(car);
      mesh.position.set(position.x, position.y, position.z);
      const previous = this.vehicleHeadings.get(id) ?? position.heading;
      const difference = Math.atan2(Math.sin(position.heading - previous),
        Math.cos(position.heading - previous));
      const heading = previous + difference * Math.min(1, this.engine.getDeltaTime() / 170);
      this.vehicleHeadings.set(id, heading);
      mesh.rotation.y = heading;
      mesh.material = this.store.selectedVehicle === id
        ? this.materials.selectedVehicle
        : this.vehicleMaterials[car.color % this.vehicleMaterials.length];
    }
  }

  private refreshIssues() {
    this.issueMeshes.forEach((mesh) => mesh.dispose());
    this.issueMeshes = [];
    if (!this.document) return;
    for (const issue of this.store.geometryIssues) {
      if (!issue.coordinate || !issue.id || !issue.elementType || issue.code === "limit") continue;
      const point = this.projection.project(issue.coordinate);
      const marker = MeshBuilder.CreateSphere(
        `issue:${issue.code}:${issue.id}`,
        { diameter: 4.8, segments: 8 },
        this.scene,
      );
      marker.position = new Vector3(point.x, 3, point.z);
      marker.material = this.materials[
        issue.code === "road-building-overlap" ? "issueBuilding"
          : issue.code === "near-disconnection" ? "issueGap" : "issueCrossing"
      ];
      marker.metadata = {
        type: issue.elementType === "node" ? "node" : "way",
        id: issue.id, role: "issue",
      };
      this.issueMeshes.push(marker);
    }
  }

  refreshSelection() {
    this.laneHighlight?.dispose();
    this.laneHighlight = null;
    this.handles.forEach((mesh) => mesh.dispose());
    this.handles = [];
    if (!this.document) return;
    const selected = this.store.selection;
    for (const [id, meshes] of this.wayMeshes) {
      const road = meshes.find((mesh) => mesh.metadata?.role === "road");
      if (road)
        road.material =
          selected?.type === "way" && selected.id === id
            ? this.materials.selected
            : this.materials[
                roadStyle(tagsOf(this.document.ways.get(id)!)).pedestrian
                  ? "pedestrian"
                  : "asphalt"
              ];
    }
    if (selected?.type === "way" && this.store.selectedLane !== null) {
      const way = this.document.ways.get(selected.id);
      if (way) {
        const points = refsOf(way).map((ref) => this.point(ref))
          .filter((point): point is Vector3 => point !== null);
        this.laneHighlight = selectedLaneMesh(
          selected.id, points, tagsOf(way), this.store.selectedLane,
          this.scene, this.materials.selectedLane,
          this.protectedCorners(refsOf(way)),
        );
      }
    }
    const ids =
      selected?.type === "way"
        ? refsOf(
            this.document.ways.get(selected.id) ??
              this.document.xml.createElement("way"),
          )
        : selected
          ? [selected.id]
          : [];
    const elevation =
      selected?.type === "way" && this.document.ways.has(selected.id)
        ? roadStyle(tagsOf(this.document.ways.get(selected.id)!)).elevation
        : 0;
    for (const id of new Set(ids)) {
      const point = this.point(id);
      if (!point) continue;
      const handle = MeshBuilder.CreateSphere(
        `handle:${id}`,
        {
          diameter: Math.max(2, Math.min(8, this.camera.radius / 170)),
          segments: 6,
        },
        this.scene,
      );
      handle.position = point.add(new Vector3(0, elevation + 1.2, 0));
      handle.material =
        this.materials[
          id === this.store.selectedVertex ? "selected" : "handle"
        ];
      handle.metadata = { type: "node", id, role: "handle" };
      this.handles.push(handle);
    }
  }

  visibility() {
    for (const [id, meshes] of this.wayMeshes) {
      const way = this.document?.ways.get(id);
      const pedestrian = way ? roadStyle(tagsOf(way)).pedestrian : false;
      for (const mesh of meshes) {
        const role = mesh.metadata?.role;
        mesh.setEnabled(
          role === "building"
            ? this.store.buildings
            : (!pedestrian || this.store.pedestrians) &&
                (role !== "markings" || this.store.markings),
        );
      }
    }
  }

  setView() {
    if (this.store.view === "2d") {
      this.previousView = {
        alpha: this.camera.alpha,
        beta: this.camera.beta,
        radius: this.camera.radius,
      };
      this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      this.camera.alpha = -Math.PI / 2;
      this.camera.beta = 0.001;
      this.camera.lowerBetaLimit = this.camera.upperBetaLimit = 0.001;
      this.camera.lowerAlphaLimit = this.camera.upperAlphaLimit = -Math.PI / 2;
    } else {
      this.camera.mode = Camera.PERSPECTIVE_CAMERA;
      this.camera.lowerBetaLimit = 0.02;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.05;
      this.camera.lowerAlphaLimit = this.camera.upperAlphaLimit = null;
      Object.assign(this.camera, this.previousView);
    }
  }

  private updateOrtho() {
    if (this.camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) return;
    const half = this.camera.radius / 2;
    const aspect = this.engine.getRenderWidth() / this.engine.getRenderHeight();
    this.camera.orthoLeft = -half * aspect;
    this.camera.orthoRight = half * aspect;
    this.camera.orthoTop = half;
    this.camera.orthoBottom = -half;
  }

  focus() {
    if (this.store.focusCoordinate) {
      const point = this.projection.project(this.store.focusCoordinate);
      this.camera.setTarget(new Vector3(point.x, 0, point.z));
      this.camera.radius = 130;
      this.store.focusCoordinate = null;
      return;
    }
    const selected = this.store.selection;
    const way =
      selected?.type === "way" ? this.document?.ways.get(selected.id) : null;
    const points = (way ? refsOf(way) : selected ? [selected.id] : [])
      .map((id) => this.point(id))
      .filter((point): point is Vector3 => point !== null);
    if (!points.length) {
      this.camera.setTarget(Vector3.Zero());
      this.camera.radius = 1550;
      return;
    }
    const center = points
      .reduce((sum, point) => sum.add(point), Vector3.Zero())
      .scale(1 / points.length);
    this.camera.setTarget(center);
    this.camera.radius = Math.max(
      100,
      Math.max(...points.map((point) => Vector3.Distance(point, center))) * 3.5,
    );
    this.refreshSelection();
  }

  private groundPoint(y = 0): Vector3 | null {
    const ray = this.scene.createPickingRay(
      this.scene.pointerX,
      this.scene.pointerY,
      null,
      this.camera,
    );
    const distance = ray.intersectsPlane(new Plane(0, 1, 0, -y));
    return distance === null
      ? null
      : ray.origin.add(ray.direction.scale(distance));
  }

  private snap(point: Vector3): RoadPoint {
    if (!this.document) return this.projection.unproject(point);
    let nearest: string | null = null;
    let distance = 8;
    for (const way of this.document.ways.values()) {
      const tags = tagsOf(way);
      if (!tags.highway || Math.abs(roadStyle(tags).elevation - 0.18) > 1)
        continue;
      for (const id of refsOf(way)) {
        const position = this.point(id);
        if (!position) continue;
        const candidate = Vector3.Distance(point, position);
        if (candidate < distance) {
          distance = candidate;
          nearest = id;
        }
      }
    }
    return nearest ? { nodeId: nearest } : this.projection.unproject(point);
  }

  private nearestSegment(wayId: string, point: Vector3) {
    const refs = refsOf(this.document!.ways.get(wayId)!);
    let result = { index: 1, distance: Infinity, point, nodeId: "" };
    for (let index = 1; index < refs.length; index++) {
      const a = this.point(refs[index - 1])!,
        b = this.point(refs[index])!;
      if (!a || !b) continue;
      const delta = b.subtract(a);
      const t = Math.max(
        0,
        Math.min(
          1,
          Vector3.Dot(point.subtract(a), delta) / (delta.lengthSquared() || 1),
        ),
      );
      const projected = a.add(delta.scale(t));
      const distance = Vector3.DistanceSquared(point, projected);
      if (distance < result.distance)
        result = {
          index,
          distance,
          point: projected,
          nodeId:
            Vector3.Distance(projected, a) < 2
              ? refs[index - 1]
              : Vector3.Distance(projected, b) < 2
                ? refs[index]
                : "",
        };
    }
    return result;
  }

  refreshPreview(cursor?: Vector3) {
    this.preview?.dispose();
    this.preview = null;
    const points = this.store.draft.map((point) =>
      "nodeId" in point
        ? this.point(point.nodeId)!
        : (() => {
            const p = this.projection.project(point);
            return new Vector3(p.x, 0, p.z);
          })(),
    );
    if (cursor) points.push(cursor);
    if (points.length > 1) {
      const preview = MeshBuilder.CreateLines(
        "draft",
        { points: points.map((point) => point.add(new Vector3(0, 0.7, 0))) },
        this.scene,
      );
      preview.color = Color3.FromHexString("#97ffb9");
      preview.isPickable = false;
      this.preview = preview;
    }
  }

  private laneAtPoint(wayId: string, position: Vector3): number | null {
    const way = this.document?.ways.get(wayId);
    if (!way) return null;
    const style = roadStyle(tagsOf(way));
    if (style.pedestrian) return null;
    const points = refsOf(way).map((ref) => this.point(ref))
      .filter((point): point is Vector3 => point !== null);
    const smooth = smoothRoadPoints(points);
    let nearest = Infinity, side = 0;
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1], b = smooth[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length2 = dx * dx + dz * dz;
      if (length2 < 0.0001) continue;
      const t = Math.max(0, Math.min(1,
        ((position.x - a.x) * dx + (position.z - a.z) * dz) / length2));
      const x = a.x + dx * t, z = a.z + dz * t;
      const distance2 = (position.x - x) ** 2 + (position.z - z) ** 2;
      if (distance2 < nearest) {
        nearest = distance2;
        side = ((position.x - x) * -dz + (position.z - z) * dx) / Math.sqrt(length2);
      }
    }
    return Math.max(0, Math.min(style.lanes - 1,
      Math.floor((side + style.width / 2) * style.lanes / style.width)));
  }

  private pointer(type: number, event: PointerEvent) {
    if (!this.document) return;
    if (type === PointerEventTypes.POINTERDOWN && event.button === 0) {
      this.down = { x: event.clientX, y: event.clientY };
      const pick = this.scene.pick(
        this.scene.pointerX,
        this.scene.pointerY,
        (mesh) =>
          mesh.metadata?.role === "handle" || mesh.metadata?.role === "signal",
      );
      if (pick?.pickedMesh && this.store.tool === "move") {
        const mesh = pick.pickedMesh as Mesh;
        this.store.selectedVertex = mesh.metadata.id;
        const point = this.groundPoint(mesh.position.y);
        if (point) {
          this.drag = {
            id: mesh.metadata.id,
            plane: new Plane(0, 1, 0, -mesh.position.y),
            point,
            mesh,
          };
          this.camera.detachControl();
          this.canvas.setPointerCapture(event.pointerId);
        }
      }
    }
    if (type === PointerEventTypes.POINTERMOVE) {
      if (this.drag) {
        const ray = this.scene.createPickingRay(
          this.scene.pointerX,
          this.scene.pointerY,
          null,
          this.camera,
        );
        const distance = ray.intersectsPlane(this.drag.plane);
        if (distance !== null) {
          this.drag.point = ray.origin.add(ray.direction.scale(distance));
          this.drag.mesh.position.copyFrom(this.drag.point);
        }
      } else if (this.store.tool === "draw") {
        const point = this.groundPoint();
        if (point) this.refreshPreview(point);
      }
    }
    if (type !== PointerEventTypes.POINTERUP || event.button !== 0) return;
    if (this.drag) {
      const { id, point } = this.drag;
      this.drag = null;
      this.camera.attachControl(this.canvas, true);
      this.store.execute({
        type: "move-node",
        id,
        coordinate: this.projection.unproject(point),
      });
      return;
    }
    if (
      Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5
    )
      return;
    const roadOnly = this.store.tool === "lane" || this.store.tool === "car";
    const pick = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) => roadOnly
        ? mesh.metadata?.role === "road"
        : ["road", "handle", "signal", "issue", "vehicle"].includes(mesh.metadata?.role),
    );
    const metadata = pick?.pickedMesh?.metadata;
    if (this.store.tool === "car") {
      if (metadata?.role === "road" && pick?.pickedPoint) {
        this.addVehicleAt(metadata.id, pick.pickedPoint);
      } else this.store.error = "Нажмите на дорожное полотно, чтобы добавить машину";
      return;
    }
    if (this.store.tool === "lane") {
      if (metadata?.role === "road" && pick?.pickedPoint) {
        this.store.selectOsmElement({ type: "way", id: metadata.id });
        this.store.selectedLane = this.laneAtPoint(metadata.id, pick.pickedPoint);
        this.refreshSelection();
      } else this.store.error = "Нажмите на одну из полос дороги";
      return;
    }
    if (this.store.tool === "draw") {
      const point = this.groundPoint();
      if (point) {
        this.store.draft.push(this.snap(point));
        this.refreshPreview();
      }
    } else if (["insert", "signal"].includes(this.store.tool)) {
      const wayId =
        metadata?.type === "way"
          ? metadata.id
          : this.store.selection?.type === "way"
            ? this.store.selection.id
            : null;
      if (!wayId || !this.document.ways.has(wayId)) return;
      const point = this.groundPoint(
        roadStyle(tagsOf(this.document.ways.get(wayId)!)).elevation,
      );
      if (!point) return;
      const nearest = this.nearestSegment(wayId, point);
      if (Math.sqrt(nearest.distance) > 15) {
        this.store.error = "Нажмите ближе к сегменту дороги";
        return;
      }
      this.store.execute({
        type: this.store.tool === "signal" ? "add-signal" : "insert-node",
        wayId,
        index: nearest.index,
        point: nearest.nodeId
          ? { nodeId: nearest.nodeId }
          : this.projection.unproject(nearest.point),
      });
    } else if (metadata) {
      if (metadata.role === "vehicle") {
        this.store.selectedVehicle = metadata.id;
        this.store.selectOsmElement(null);
        return;
      }
      this.store.selectedVehicle = null;
      if (metadata.role === "road" && metadata.type === "way") {
        this.store.selectOsmElement({ type: "way", id: metadata.id });
        this.store.selectedLane = pick?.pickedPoint
          ? this.laneAtPoint(metadata.id, pick.pickedPoint) : null;
        this.refreshSelection();
        return;
      }
      if (metadata.role === "handle" && this.store.selection?.type === "way")
        this.store.selectedVertex = metadata.id;
      else
        this.store.selectOsmElement({ type: metadata.type, id: metadata.id });
      this.refreshSelection();
    } else this.store.selectOsmElement(null);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.engine.stopRenderLoop();
    this.clearVehicles();
    this.scene.dispose();
    this.engine.dispose();
  }
}
