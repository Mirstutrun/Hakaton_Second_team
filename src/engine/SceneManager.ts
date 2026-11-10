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
  buildRoad,
  roadStyle,
  selectedLaneMesh,
  smoothRoadPoints,
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
  private routePreview: Mesh | null = null;
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
    this.scene.clearColor = new Color4(0.91, 0.93, 0.9, 1);
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
    light.intensity = 0.95;
    light.groundColor = Color3.FromHexString("#cbd1c6");
    for (const [name, color] of Object.entries({
      asphalt: "#727e80",
      pedestrian: "#c8bfa8",
      building: "#ffffff",
      selected: "#338f77",
      selectedLane: "#74cba7",
      selectedVehicle: "#ffac38",
      handle: "#effcfd",
      ground: "#e8ede5",
      pole: "#415f74",
      lamp: "#43cbb0",
      line: "#c5cec4",
      issueCrossing: "#ffb968",
      issueBuilding: "#ff6e84",
      issueGap: "#aee1ff",
      busStop: "#ffbf48",
    })) {
      const material = new StandardMaterial(name, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      material.backFaceCulling = false;
      if (
        [
          "selected",
          "selectedLane",
          "selectedVehicle",
          "handle",
          "lamp",
          "issueCrossing",
          "issueBuilding",
          "issueGap",
        ].includes(name)
      )
        material.emissiveColor = material.diffuseColor.scale(0.4);
      this.materials[name] = material;
    }
    for (const [index, hex] of [
      "#e8e8e2",
      "#f5ac59",
      "#8cc6e9",
      "#ef7773",
      "#b8a1e4",
      "#99ca9b",
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
    grid.color = Color3.FromHexString("#e0e7da");
    grid.isPickable = false;
    grid.setEnabled(false);
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
    this.traffic = new TrafficModel(document, this.store.drivingSide);
    this.refreshRoute();
    this.rebuildJunctionCounts();
    for (const id of document.ways.keys()) this.refreshWay(id);
    for (const id of document.nodes.keys()) this.refreshSignal(id);
    this.camera.setTarget(Vector3.Zero());
    this.camera.radius = 1550;
    this.setView();
    this.refreshSelection();
    this.refreshIssues();
    this.visibility();
    this.fitMap();
    this.camera.radius = Math.min(this.camera.radius, 1800);
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
      if (
        (this.junctionCounts.get(id) ?? 0) > 1 ||
        tags.highway === "traffic_signals" ||
        tags.public_transport === "stop_position" ||
        tags.barrier ||
        tags.railway
      )
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
          this.store.drivingSide,
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
    if (!node || !point) return;
    const nodeTags = tagsOf(node);
    const signal = nodeTags.highway === "traffic_signals";
    const busStop =
      nodeTags.public_transport === "stop_position" && nodeTags.bus === "yes";
    if (!signal && !busStop) return;
    const way = Array.from(this.document!.ways.values()).find(
      (way) => tagsOf(way).highway && refsOf(way).includes(id),
    );
    point.y = way ? roadStyle(tagsOf(way)).elevation : 0;
    if (signal)
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
    else {
      const marker = MeshBuilder.CreateBox(
        `bus-stop:${id}`,
        { width: 2.7, height: 0.25, depth: 5 },
        this.scene,
      );
      marker.position = point.add(new Vector3(0, 0.25, 0));
      marker.material = this.materials.busStop;
      marker.metadata = { type: "node", id, role: "stop" };
      const sign = MeshBuilder.CreateCylinder(
        `bus-stop-sign:${id}`,
        { diameter: 1.4, height: 3.2, tessellation: 4 },
        this.scene,
      );
      sign.position = point.add(new Vector3(3, 1.6, 0));
      sign.material = this.materials.busStop;
      sign.metadata = { type: "node", id, role: "stop" };
      this.signalMeshes.set(id, [marker, sign]);
    }
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

  refreshDrivingSide() {
    if (!this.document) return;
    for (const [id, way] of this.document.ways)
      if (tagsOf(way).highway) this.refreshWay(id);
    this.resetTrafficAfterEdit();
    this.refreshSelection();
    this.visibility();
  }
  resetTrafficAfterEdit() {
    this.clearVehicles();
    if (this.document)
      this.traffic = new TrafficModel(this.document, this.store.drivingSide);
    this.refreshRoute();
  }

  refreshRoute() {
    this.routePreview?.dispose();
    this.routePreview = null;
    const edges = this.traffic?.routeEdges(this.store.selectedBusRoute) ?? [];
    if (!edges.length) return;
    const lines = edges.map((edge) => [
      new Vector3(edge.a.x, edge.elevation + 1.1, edge.a.z),
      new Vector3(edge.b.x, edge.elevation + 1.1, edge.b.z),
    ]);
    const mesh = MeshBuilder.CreateLineSystem(
      "bus-route-preview",
      { lines },
      this.scene,
    );
    mesh.color = Color3.FromHexString("#ffae32");
    mesh.isPickable = false;
    this.routePreview = mesh;
  }

  addVehicleAt(wayId: string, position: Vector3) {
    if (!this.document || !this.traffic) return;
    const way = this.document.ways.get(wayId);
    if (!way) return;
    const nearest = this.nearestSegment(wayId, position);
    const refs = refsOf(way);
    const from = refs[nearest.index - 1],
      to = refs[nearest.index];
    const a = this.point(from),
      b = this.point(to);
    if (!a || !b) return;
    const delta = b.subtract(a);
    const progress = Math.max(
      0.02,
      Math.min(
        0.96,
        Vector3.Dot(position.subtract(a), delta) / (delta.lengthSquared() || 1),
      ),
    );
    const lane = this.laneAtPoint(wayId, position) ?? 0;
    const id = this.traffic.addOnLane(wayId, from, to, progress, lane);
    if (!id) {
      this.store.error =
        "Полоса занята или не предназначена для движения в этом направлении";
      return;
    }
    this.spawnCarMesh(id);
    this.store.vehicleCount = this.traffic.size;
  }

  addBus() {
    if (!this.traffic || !this.store.selectedBusRoute) return;
    const id = this.traffic.addBus(this.store.selectedBusRoute);
    if (!id) {
      this.store.error = "Для маршрута нет доступного пути";
      return;
    }
    this.spawnCarMesh(id);
    this.store.vehicleCount = this.traffic.size;
    this.store.busCount = this.traffic.busCount;
  }

  private spawnCarMesh(id: string) {
    const vehicle = this.traffic?.cars.get(id);
    if (!vehicle) return;
    const bus = vehicle.kind === "bus";
    const mesh = MeshBuilder.CreateBox(
      `vehicle:${id}`,
      bus
        ? { width: 2.4, height: 2.5, depth: 9 }
        : { width: 1.8, height: 1.25, depth: 4.1 },
      this.scene,
    );
    mesh.material = bus
      ? this.materials.busStop
      : this.vehicleMaterials[vehicle.color % this.vehicleMaterials.length];
    mesh.metadata = { role: "vehicle", id };
    if (bus) {
      for (const side of [-1, 1]) {
        const windows = MeshBuilder.CreateBox(
          `bus-windows:${id}:${side}`,
          { width: 0.06, height: 0.65, depth: 6.8 },
          this.scene,
        );
        windows.parent = mesh;
        windows.position.set(side * 1.23, 0.38, 0);
        windows.material = this.materials.pole;
        windows.isPickable = false;
      }
    } else {
      const cabin = MeshBuilder.CreateBox(
        `vehicle-cabin:${id}`,
        { width: 1.45, height: 0.35, depth: 2.05 },
        this.scene,
      );
      cabin.parent = mesh;
      cabin.position.set(0, 0.73, -0.2);
      cabin.material = this.materials.pole;
      cabin.isPickable = false;
    }
    mesh.setEnabled(this.store.workspaceMode === "traffic");
    this.vehicleMeshes.set(id, mesh);
    const position = this.traffic!.pose(vehicle);
    mesh.position.set(position.x, position.y, position.z);
    mesh.rotation.y = position.heading;
  }

  addVehicles(count: number) {
    if (!this.traffic) return;
    const wayId =
      this.store.selection?.type === "way"
        ? this.store.selection.id
        : undefined;
    for (const id of this.traffic.add(count, wayId)) this.spawnCarMesh(id);
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
    this.store.busCount = this.traffic?.busCount ?? 0;
  }

  clearVehicles() {
    for (const mesh of this.vehicleMeshes.values()) mesh.dispose();
    this.vehicleMeshes.clear();
    this.vehicleHeadings.clear();
    this.traffic?.clear();
    this.store.selectedVehicle = null;
    this.store.vehicleCount = 0;
    this.store.busCount = 0;
  }

  private lastMetricsUpdate = 0;
  private tickTraffic() {
    if (!this.traffic) return;
    if (this.store.trafficRunning)
      this.traffic.update(
        this.engine.getDeltaTime() / 1000,
        this.store.trafficSpeed,
      );
    if (performance.now() - this.lastMetricsUpdate > 250) {
      this.store.trafficMetrics = this.traffic.metrics;
      this.lastMetricsUpdate = performance.now();
    }
    for (const [id, mesh] of this.vehicleMeshes) {
      const car = this.traffic.cars.get(id);
      if (!car) continue;
      const position = this.traffic.pose(car);
      mesh.position.set(position.x, position.y, position.z);
      const previous = this.vehicleHeadings.get(id) ?? position.heading;
      const difference = Math.atan2(
        Math.sin(position.heading - previous),
        Math.cos(position.heading - previous),
      );
      const heading =
        previous + difference * Math.min(1, this.engine.getDeltaTime() / 170);
      this.vehicleHeadings.set(id, heading);
      mesh.rotation.y = heading;
      mesh.material =
        this.store.selectedVehicle === id
          ? this.materials.selectedVehicle
          : car.kind === "bus"
            ? this.materials.busStop
            : this.vehicleMaterials[car.color % this.vehicleMaterials.length];
    }
  }

  private refreshIssues() {
    this.issueMeshes.forEach((mesh) => mesh.dispose());
    this.issueMeshes = [];
    if (!this.document) return;
    for (const issue of this.store.geometryIssues) {
      if (
        !issue.coordinate ||
        !issue.id ||
        !issue.elementType ||
        issue.code === "limit"
      )
        continue;
      const point = this.projection.project(issue.coordinate);
      const marker = MeshBuilder.CreateSphere(
        `issue:${issue.code}:${issue.id}`,
        { diameter: 4.8, segments: 8 },
        this.scene,
      );
      marker.position = new Vector3(point.x, 3, point.z);
      marker.material =
        this.materials[
          issue.code === "road-building-overlap"
            ? "issueBuilding"
            : issue.code === "near-disconnection"
              ? "issueGap"
              : "issueCrossing"
        ];
      marker.metadata = {
        type: issue.elementType === "node" ? "node" : "way",
        id: issue.id,
        role: "issue",
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
        const points = refsOf(way)
          .map((ref) => this.point(ref))
          .filter((point): point is Vector3 => point !== null);
        this.laneHighlight = selectedLaneMesh(
          selected.id,
          points,
          tagsOf(way),
          this.store.selectedLane,
          this.scene,
          this.materials.selectedLane,
          this.protectedCorners(refsOf(way)),
        );
      }
    }
    const ids = !["move", "insert", "join"].includes(this.store.tool)
      ? []
      : selected?.type === "way"
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
    for (const mesh of this.issueMeshes)
      mesh.setEnabled(this.store.workspaceMode === "review");
    for (const mesh of this.vehicleMeshes.values())
      mesh.setEnabled(this.store.workspaceMode === "traffic");
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

  zoom(factor: number) {
    this.camera.radius = Math.max(
      12,
      Math.min(16000, this.camera.radius * factor),
    );
  }
  fitMap() {
    if (!this.document) return;
    const points: Vector3[] = [];
    for (const way of this.document.ways.values()) {
      if (!tagsOf(way).highway) continue;
      for (const id of refsOf(way)) {
        const p = this.point(id);
        if (p) points.push(p);
      }
    }
    if (!points.length) return;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.camera.setTarget(new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2));
    const aspect =
      this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight());
    const size =
      this.store.view === "2d"
        ? Math.max(maxZ - minZ, (maxX - minX) / aspect)
        : Math.max(maxZ - minZ, maxX - minX) * 1.5;
    this.camera.radius = Math.max(100, Math.min(16000, size * 1.25));
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
    let nearest: RoadPoint = this.projection.unproject(point);
    let distance = 8;
    for (const [wayId, way] of this.document.ways) {
      const tags = tagsOf(way);
      if (!tags.highway || Math.abs(roadStyle(tags).elevation - 0.18) > 1)
        continue;
      const refs = refsOf(way);
      for (const id of refs) {
        const position = this.point(id);
        if (!position) continue;
        const candidate = Vector3.Distance(point, position);
        if (candidate < distance) {
          distance = candidate;
          nearest = { nodeId: id };
        }
      }
      for (let index = 1; index < refs.length; index++) {
        const a = this.point(refs[index - 1]),
          b = this.point(refs[index]);
        if (!a || !b) continue;
        const delta = b.subtract(a);
        const t = Math.max(
          0,
          Math.min(
            1,
            Vector3.Dot(point.subtract(a), delta) /
              (delta.lengthSquared() || 1),
          ),
        );
        const projected = a.add(delta.scale(t));
        const candidate = Vector3.Distance(point, projected);
        if (
          candidate < distance &&
          projected.subtract(a).length() >= 1 &&
          projected.subtract(b).length() >= 1
        ) {
          distance = candidate;
          nearest = {
            wayId,
            index,
            coordinate: this.projection.unproject(projected),
          };
        }
      }
    }
    return nearest;
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
        : "wayId" in point
          ? (() => {
              const p = this.projection.project(point.coordinate);
              return new Vector3(p.x, 0, p.z);
            })()
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
    const points = refsOf(way)
      .map((ref) => this.point(ref))
      .filter((point): point is Vector3 => point !== null);
    const smooth = smoothRoadPoints(points);
    let nearest = Infinity,
      side = 0;
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1],
        b = smooth[i];
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const length2 = dx * dx + dz * dz;
      if (length2 < 0.0001) continue;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((position.x - a.x) * dx + (position.z - a.z) * dz) / length2,
        ),
      );
      const x = a.x + dx * t,
        z = a.z + dz * t;
      const distance2 = (position.x - x) ** 2 + (position.z - z) ** 2;
      if (distance2 < nearest) {
        nearest = distance2;
        side =
          ((position.x - x) * -dz + (position.z - z) * dx) / Math.sqrt(length2);
      }
    }
    return Math.max(
      0,
      Math.min(
        style.lanes - 1,
        Math.floor(((side + style.width / 2) * style.lanes) / style.width),
      ),
    );
  }

  private pointer(type: number, event: PointerEvent) {
    if (!this.document) return;
    if (type === PointerEventTypes.POINTERDOWN && event.button === 0) {
      this.down = { x: event.clientX, y: event.clientY };
      const pick = this.scene.pick(
        this.scene.pointerX,
        this.scene.pointerY,
        (mesh) =>
          mesh.metadata?.role === "handle" ||
          mesh.metadata?.role === "signal" ||
          mesh.metadata?.role === "stop",
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
    const roadOnly = ["lane", "car", "bus-stop"].includes(this.store.tool);
    const routeOnly = this.store.tool === "bus-route";
    const joinOnly = this.store.tool === "join";
    const pick = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) =>
        routeOnly
          ? mesh.metadata?.role === "stop"
          : joinOnly
            ? ["road", "handle"].includes(mesh.metadata?.role)
            : roadOnly
              ? mesh.metadata?.role === "road"
              : [
                  "road",
                  "handle",
                  "signal",
                  "stop",
                  "issue",
                  "vehicle",
                ].includes(mesh.metadata?.role),
    );
    const metadata = pick?.pickedMesh?.metadata;
    if (this.store.tool === "car") {
      if (metadata?.role === "road" && pick?.pickedPoint) {
        this.addVehicleAt(metadata.id, pick.pickedPoint);
      } else
        this.store.error = "Нажмите на дорожное полотно, чтобы добавить машину";
      return;
    }
    if (this.store.tool === "lane") {
      if (metadata?.role === "road" && pick?.pickedPoint) {
        this.store.selectOsmElement({ type: "way", id: metadata.id });
        this.store.selectedLane = this.laneAtPoint(
          metadata.id,
          pick.pickedPoint,
        );
        this.refreshSelection();
      } else this.store.error = "Нажмите на одну из полос дороги";
      return;
    }
    if (this.store.tool === "bus-route") {
      if (metadata?.role === "stop") this.store.addRouteStop(metadata.id);
      else this.store.error = "Нажмите на маркер остановки";
      return;
    }
    if (this.store.tool === "join") {
      if (!this.store.joinSource) {
        const wayId =
          metadata?.role === "road"
            ? metadata.id
            : metadata?.role === "handle" &&
                this.store.selection?.type === "way"
              ? this.store.selection.id
              : null;
        const way = wayId ? this.document.ways.get(wayId) : null;
        const refs = way ? refsOf(way) : [];
        const position = pick?.pickedPoint;
        if (!way || refs.length < 2 || !position) {
          this.store.error = "Сначала выберите свободный конец дороги";
          return;
        }
        const candidates = [refs[0], refs[refs.length - 1]];
        const nearest = candidates
          .map((id) => ({
            id,
            distance: this.point(id)
              ? Vector3.Distance(position, this.point(id)!)
              : Infinity,
          }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (nearest.distance > 14) {
          this.store.error = "Нажмите ближе к концу дороги";
          return;
        }
        this.store.joinSource = { wayId, nodeId: nearest.id };
        this.store.selectOsmElement({ type: "way", id: wayId });
        this.store.selectedVertex = nearest.id;
        this.store.error = "";
        this.refreshSelection();
      } else {
        if (
          metadata?.role !== "road" ||
          metadata.id === this.store.joinSource.wayId ||
          !pick?.pickedPoint
        ) {
          this.store.error = "Нажмите на другую дорогу";
          return;
        }
        const nearest = this.nearestSegment(metadata.id, pick.pickedPoint);
        if (Math.sqrt(nearest.distance) > 15) {
          this.store.error = "Нажмите ближе к целевой дороге";
          return;
        }
        const target: RoadPoint = nearest.nodeId
          ? { nodeId: nearest.nodeId }
          : {
              wayId: metadata.id,
              index: nearest.index,
              coordinate: this.projection.unproject(nearest.point),
            };
        if (
          this.store.execute({
            type: "merge-endpoint",
            wayId: this.store.joinSource.wayId,
            nodeId: this.store.joinSource.nodeId,
            target,
          })
        ) {
          this.store.joinSource = null;
          this.store.tool = "select";
        }
      }
      return;
    }
    if (this.store.tool === "draw") {
      const point = this.groundPoint();
      if (point) {
        this.store.draft.push(this.snap(point));
        this.refreshPreview();
      }
    } else if (["insert", "signal", "bus-stop"].includes(this.store.tool)) {
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
        type:
          this.store.tool === "signal"
            ? "add-signal"
            : this.store.tool === "bus-stop"
              ? "add-bus-stop"
              : "insert-node",
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
          ? this.laneAtPoint(metadata.id, pick.pickedPoint)
          : null;
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
