import { buildingShapes } from "../core/osm/buildingShapes";
import { buildRestrictionSigns } from "./geometry/restrictionSigns";
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
  laneArrows,
  roadStyle,
  selectedLaneMesh,
  smoothRoadPoints,
} from "./geometry/roads";
import { TrafficModel } from "./TrafficModel";
import { buildBuilding, type PassageCut } from "./geometry/buildings";
import { planRoadLink } from "../core/osm/laneConnectivity";
import type { useEditorStore } from "../stores/editor";

export class SceneManager {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private document: OsmDocument | null = null;
  private projection = createProjection({ lat: 52.26, lon: 104.26 });
  private wayMeshes = new Map<string, Mesh[]>();
  private buildingMeshes:Mesh[]=[];
  private signalMeshes = new Map<string, Mesh[]>();
  private junctionCounts = new Map<string, number>();
  private handles: Mesh[] = [];
  private issueMeshes: Mesh[] = [];
  private restrictionMeshes: Mesh[] = [];
  private preview: Mesh | null = null;
  private routePreview: Mesh | null = null;
  private laneHighlight: Mesh | null = null;
  private laneArrowMesh: Mesh | null = null;
  private laneLinkPreview: Mesh | null = null;
  /** Автомобильные дороги на уровне земли — для поиска места остановки (кеш до правки). */
  private stopRoads:
    | {
        wayId: string;
        points: Vector3[];
        width: number;
        elevation: number;
        bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
      }[]
    | null = null;
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
      issueGap: "#e7a443",
      issueRoad: "#d85d54",
      issueIsolated: "#ab77cc",
      signRed: "#d94840",
      signBlue: "#3978bd",
      signWhite: "#fffdf3",
      signInk: "#28333b",
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
    this.stopRoads = null;
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
    this.refreshBuildings();
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
    if (meshes.length) this.wayMeshes.set(id, meshes);
  }

  private refreshBuildings() {
    this.buildingMeshes.forEach(mesh=>mesh.dispose());this.buildingMeshes=[];if(!this.document)return;
    const passages:PassageCut[]=[];
    // Проём в стенах — для арок и крытых проездов на уровне земли (не для подземных тоннелей).
    for(const way of this.document.ways.values()){
      const tags=tagsOf(way);if(!tags.highway||!(tags.tunnel==="building_passage"||tags.covered==="yes")||Number(tags.layer)<0)continue;
      const points=refsOf(way).map(id=>this.point(id)).filter((p):p is Vector3=>!!p);
      for(let i=1;i<points.length;i++)passages.push({a:points[i-1],b:points[i],width:roadStyle(tags).width,height:Number.parseFloat(tags.maxheight)||2.7});
    }
    for(const shape of buildingShapes(this.document,this.projection)){
      const points=shape.outer.map(p=>new Vector3(p.x,0,p.z)),holes=shape.holes.map(r=>r.map(p=>new Vector3(p.x,0,p.z)));
      const mesh=buildBuilding(shape.id+":"+shape.outerWay,points,shape.tags,this.scene,this.materials.building,holes,passages);
      if(mesh){mesh.metadata={role:"building",type:"way",id:shape.outerWay,wayIds:shape.wayIds};this.buildingMeshes.push(mesh);}
    }
  }
  /** Маркеры узлов: автобусная остановка сбоку от дороги и блоки-препятствия из данных. */
  private refreshSignal(id: string) {
    this.signalMeshes.get(id)?.forEach((mesh) => mesh.dispose());
    this.signalMeshes.delete(id);
    const node = this.document?.nodes.get(id);
    const point = this.point(id);
    if (!node || !point) return;
    const nodeTags = tagsOf(node);
    if (nodeTags.barrier === "block") {
      const width = Math.max(0.3, Math.min(30, Number(nodeTags.width) || 1.5)),
        depth = Math.max(0.3, Math.min(30, Number(nodeTags.length) || 1.5)),
        height = Math.max(0.2, Math.min(20, Number(nodeTags.height) || 1.2));
      const mesh = MeshBuilder.CreateBox(`block:${id}`, { width, depth, height }, this.scene);
      mesh.position = point.add(new Vector3(0, height / 2, 0));
      mesh.material = this.materials.pole;
      mesh.isPickable = false;
      mesh.metadata = { role: "block", type: "node", id };
      this.signalMeshes.set(id, [mesh]);
      return;
    }
    if (nodeTags.public_transport !== "stop_position" || nodeTags.bus !== "yes") return;
    const way = Array.from(this.document!.ways.values()).find(
      (candidate) => tagsOf(candidate).highway && refsOf(candidate).includes(id),
    );
    // Платформа остановки стоит сбоку от дороги (PTv2 stop_area); без неё — справа.
    const platform = this.platformOf(id);
    let place = platform ? this.point(platform) : null;
    let along = new Vector3(0, 0, 1);
    if (way) {
      const refs = refsOf(way), at = refs.indexOf(id);
      const neighbour = this.point(refs[at + 1] ?? refs[at - 1]);
      if (neighbour) {
        along = refs[at + 1] ? neighbour.subtract(point) : point.subtract(neighbour);
        along.y = 0;
        if (along.lengthSquared() > 1e-6) along.normalize();
        else along = new Vector3(0, 0, 1);
      }
      place ??= point.add(new Vector3(along.z, 0, -along.x).scale(roadStyle(tagsOf(way)).width / 2 + 2));
    }
    place ??= point.clone();
    place.y = way ? roadStyle(tagsOf(way)).elevation : 0;
    const shelter = MeshBuilder.CreateBox(`bus-stop:${id}`, { width: 2.2, height: 2.6, depth: 5 }, this.scene);
    shelter.position = place.add(new Vector3(0, 1.3, 0));
    shelter.rotation.y = Math.atan2(along.x, along.z);
    shelter.material = this.materials.busStop;
    shelter.metadata = { type: "node", id, role: "stop" };
    const sign = MeshBuilder.CreateCylinder(`bus-stop-sign:${id}`, { diameter: 0.9, height: 3.6, tessellation: 4 }, this.scene);
    sign.position = place.add(along.scale(3.4)).add(new Vector3(0, 1.8, 0));
    sign.material = this.materials.busStop;
    sign.metadata = { type: "node", id, role: "stop" };
    this.signalMeshes.set(id, [shelter, sign]);
  }

  private platformOf(stopId: string): string | undefined {
    for (const relation of this.document?.relations.values() ?? []) {
      if (tagsOf(relation).public_transport !== "stop_area") continue;
      const members = Array.from(relation.children).filter(
        (m) => m.tagName === "member" && m.getAttribute("type") === "node",
      );
      if (!members.some((m) => m.getAttribute("ref") === stopId && m.getAttribute("role") === "stop"))
        continue;
      return members.find((m) => m.getAttribute("role") === "platform")?.getAttribute("ref") ?? undefined;
    }
    return undefined;
  }

  refreshChangedMeshes(patch: EditPatch | null) {
    if (!patch || !this.document) return;
    this.stopRoads = null;
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
    this.refreshBuildings();
    this.refreshSelection();
    this.refreshIssues();
    this.resetTrafficAfterEdit();
    this.refreshSelection();
    this.visibility();
  }

  /**
   * После правки граф движения строится заново. Транспорт не пропадает:
   * машины и автобусы возвращаются на карту в том же количестве.
   */
  resetTrafficAfterEdit() {
    const buses = [...(this.traffic?.cars.values() ?? [])]
      .filter((car) => car.kind === "bus" && car.routeId)
      .map((car) => car.routeId!);
    const cars = (this.traffic?.size ?? 0) - buses.length;
    this.clearVehicles();
    if (this.document)
      this.traffic = new TrafficModel(this.document, this.store.drivingSide);
    this.refreshRoute();
    if (!this.traffic) return;
    for (const id of this.traffic.add(cars)) this.spawnCarMesh(id);
    for (const routeId of buses) {
      const id = this.traffic.addBus(routeId);
      if (id) this.spawnCarMesh(id);
    }
    this.store.vehicleCount = this.traffic.size;
    this.store.busCount = this.traffic.busCount;
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
      this.store.error = this.traffic.routeEdges(this.store.selectedBusRoute).length
        ? "Начало маршрута занято. Дождитесь освобождения полосы или уберите машины."
        : "Для маршрута нет доступного пути";
      return;
    }
    this.spawnCarMesh(id);
    this.store.vehicleCount = this.traffic.size;
    this.store.busCount = this.traffic.busCount;
    this.store.error = "";
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
    // Машины, доехавшие до конца дороги, исчезают с карты.
    if (this.traffic.finished.length) {
      for (const id of this.traffic.finished.splice(0)) {
        this.vehicleMeshes.get(id)?.dispose();
        this.vehicleMeshes.delete(id);
        this.vehicleHeadings.delete(id);
        if (this.store.selectedVehicle === id) this.store.selectedVehicle = null;
      }
      this.store.vehicleCount = this.traffic.size;
      this.store.busCount = this.traffic.busCount;
    }
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
    this.restrictionMeshes.forEach((mesh) => mesh.dispose());
    this.restrictionMeshes = this.document
      ? buildRestrictionSigns(
          this.document,
          this.projection,
          this.scene,
          this.materials,
        )
      : [];
    this.issueMeshes.forEach((mesh) => mesh.dispose());
    this.issueMeshes = [];
    if (!this.document) return;
    for (const issue of this.store.problems) {
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
          issue.code === "road-building-overlap" ||
          issue.code === "underground-passage"
            ? "issueBuilding"
            : issue.code === "near-disconnection"
              ? "issueGap"
              : issue.code === "isolated-component"
                ? "issueIsolated"
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
    this.laneLinkPreview?.dispose();this.laneLinkPreview=null;
    if(this.store.selection?.type==="way"&&this.traffic){
      const lines=this.traffic.connectionPaths(this.store.selection.id,this.store.selectedLane).map(path=>{
        const a=new Vector3(path.start.x,path.start.y+.2,path.start.z),b=new Vector3(path.end.x,path.end.y+.2,path.end.z),c=new Vector3(path.via.x,Math.max(a.y,b.y),path.via.z);
        return Array.from({length:17},(_,i)=>{const t=i/16;return a.scale((1-t)**2).add(c.scale(2*t*(1-t))).add(b.scale(t*t));});
      });
      if(lines.length){const mesh=MeshBuilder.CreateLineSystem("lane-connections",{lines},this.scene);mesh.color=Color3.FromHexString("#8757d6");mesh.isPickable=false;this.laneLinkPreview=mesh;}
    }
    this.laneHighlight?.dispose();
    this.laneHighlight = null;
    this.handles.forEach((mesh) => mesh.dispose());
    this.handles = [];
    if (!this.document) return;
    const selected = this.store.selection;
    const problemWays = new Map(
      this.store.problems
        .filter((i) => i.elementType === "way" && i.id)
        .sort(
          (a, b) =>
            (a.code === "isolated-component" ? -1 : 0) -
            (b.code === "isolated-component" ? -1 : 0),
        )
        .map((i) => [i.id!, i.code]),
    );
    for (const issue of this.store.problems.filter(
      (i) => i.elementType === "node" && i.id,
    ))
      for (const [id, way] of this.document.ways)
        if (refsOf(way).includes(issue.id!)) problemWays.set(id, issue.code);
    for (const component of this.store.connectivity?.components.slice(1) ?? [])
      if (!component.clipped) for (const id of component.ways)
        if (!problemWays.has(id)) problemWays.set(id, "isolated-component");
    for (const [id, meshes] of this.wayMeshes) {
      const road = meshes.find((mesh) => mesh.metadata?.role === "road");
      if (road)
        road.material =
          selected?.type === "way" && selected.id === id
            ? this.materials.selected
            : this.store.showGraphIssues && problemWays.has(id)
              ? this.materials[
                  problemWays.get(id) === "isolated-component"
                    ? "issueIsolated"
                    : "issueRoad"
                ]
              : this.materials[
                  roadStyle(tagsOf(this.document.ways.get(id)!)).pedestrian
                    ? "pedestrian"
                    : "asphalt"
                ];
    }
    // Стрелки направления на каждой полосе выбранной дороги.
    this.laneArrowMesh?.dispose();
    this.laneArrowMesh = null;
    const selectedRoad =
      selected?.type === "way" ? this.document.ways.get(selected.id) : undefined;
    if (selectedRoad && tagsOf(selectedRoad).highway && this.store.workspaceMode === "edit") {
      const refs = refsOf(selectedRoad);
      this.laneArrowMesh = laneArrows(
        selected!.id,
        refs.map((ref) => this.point(ref)).filter((point): point is Vector3 => point !== null),
        tagsOf(selectedRoad),
        this.store.drivingSide,
        this.scene,
        this.protectedCorners(refs),
      );
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
    // Вершины редактируются только у дорог: узлы зданий не меняются.
    const ids =
      ["move", "insert"].includes(this.store.tool) && selectedRoad && tagsOf(selectedRoad).highway
        ? refsOf(selectedRoad)
        : [];
    const elevation = selectedRoad && tagsOf(selectedRoad).highway
      ? roadStyle(tagsOf(selectedRoad)).elevation
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
    for(const mesh of this.buildingMeshes)mesh.setEnabled(this.store.buildings);
    for (const mesh of this.issueMeshes)
      mesh.setEnabled(this.store.showGraphIssues);
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
    if (this.store.tool === "bus-stop") {
      // Контур будущей остановки с той стороны дороги, где находится курсор.
      const place = cursor ? this.stopPlacement(cursor) : null;
      if (!place) return;
      const { platform, along, on } = place;
      const normal = new Vector3(-along.z, 0, along.x);
      const lift = new Vector3(0, 0.6, 0);
      const corner = (forward: number, sideways: number) =>
        platform.add(along.scale(forward)).add(normal.scale(sideways)).add(lift);
      const outline = [
        corner(-2.5, -1.1), corner(2.5, -1.1), corner(2.5, 1.1),
        corner(-2.5, 1.1), corner(-2.5, -1.1),
      ];
      const preview = MeshBuilder.CreateLineSystem(
        "draft",
        { lines: [outline, [on.add(lift), platform.add(lift)]] },
        this.scene,
      );
      preview.color = Color3.FromHexString("#ff9d1c");
      preview.isPickable = false;
      this.preview = preview;
      return;
    }
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
        { points: points.map((point) => new Vector3(point.x, 0.7, point.z)) },
        this.scene,
      );
      preview.color = Color3.FromHexString("#97ffb9");
      preview.isPickable = false;
      this.preview = preview;
    }
  }

  /**
   * Куда встанет остановка для точки на земле: ближайшая автомобильная дорога
   * (до 25 м) и сторона от её оси, с которой находится точка.
   */
  private stopPlacement(point: Vector3) {
    if (!this.document) return null;
    if (!this.stopRoads) {
      this.stopRoads = [];
      for (const [wayId, way] of this.document.ways) {
        const tags = tagsOf(way);
        if (
          !tags.highway ||
          tags.area === "yes" ||
          ["construction", "proposed"].includes(tags.highway)
        )
          continue;
        const style = roadStyle(tags);
        if (style.pedestrian || Math.abs(style.elevation - 0.18) > 1) continue;
        const points = refsOf(way).map((ref) => this.point(ref));
        if (points.length < 2 || points.some((p) => !p)) continue;
        const line = points as Vector3[];
        this.stopRoads.push({
          wayId,
          points: line,
          width: style.width,
          elevation: style.elevation,
          bounds: {
            minX: Math.min(...line.map((p) => p.x)),
            maxX: Math.max(...line.map((p) => p.x)),
            minZ: Math.min(...line.map((p) => p.z)),
            maxZ: Math.max(...line.map((p) => p.z)),
          },
        });
      }
    }
    let reach = 25;
    let best: {
      road: NonNullable<SceneManager["stopRoads"]>[number];
      index: number;
      x: number;
      z: number;
    } | null = null;
    for (const road of this.stopRoads) {
      const { minX, maxX, minZ, maxZ } = road.bounds;
      if (
        point.x < minX - reach || point.x > maxX + reach ||
        point.z < minZ - reach || point.z > maxZ + reach
      )
        continue;
      for (let index = 1; index < road.points.length; index++) {
        const a = road.points[index - 1],
          b = road.points[index];
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const length2 = dx * dx + dz * dz;
        if (length2 < 1e-6) continue;
        const t = Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2),
        );
        const x = a.x + dx * t,
          z = a.z + dz * t;
        const distance = Math.hypot(point.x - x, point.z - z);
        if (distance < reach) {
          reach = distance;
          best = { road, index, x, z };
        }
      }
    }
    if (!best) return null;
    const { road, index } = best;
    const a = road.points[index - 1],
      b = road.points[index];
    const along = b.subtract(a);
    along.y = 0;
    along.normalize();
    // Слева от линии дороги — положительное векторное произведение.
    const side: "left" | "right" =
      (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x) > 0
        ? "left"
        : "right";
    const refs = refsOf(this.document.ways.get(road.wayId)!);
    // Рядом с существующим узлом остановка занимает его, а не новый узел.
    const nodeId =
      Math.hypot(best.x - a.x, best.z - a.z) < 2
        ? refs[index - 1]
        : Math.hypot(best.x - b.x, best.z - b.z) < 2
          ? refs[index]
          : "";
    const base = nodeId === refs[index - 1] ? a : nodeId === refs[index] ? b : null;
    const on = new Vector3(base?.x ?? best.x, road.elevation, base?.z ?? best.z);
    const platform = on.add(
      new Vector3(-along.z, 0, along.x).scale(
        (side === "left" ? 1 : -1) * (road.width / 2 + 2),
      ),
    );
    return { wayId: road.wayId, index, nodeId, on, platform, along, side };
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
        (mesh) => mesh.metadata?.role === "handle",
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
      } else if (["draw", "bus-stop"].includes(this.store.tool)) {
        const point = this.groundPoint();
        if (point) this.refreshPreview(point);
      }
    }
    if (type !== PointerEventTypes.POINTERUP || event.button !== 0) return;
    if (this.drag) {
      const { id, point } = this.drag;
      this.drag = null;
      this.camera.attachControl(this.canvas, true);
      const patch = this.store.execute({
        type: "move-node",
        id,
        coordinate: this.projection.unproject(point),
      });
      if (!patch) {
        this.refreshSelection();
        this.refreshSignal(id);
        this.visibility();
      }
      return;
    }
    if (
      Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5
    )
      return;
    const traffic = this.store.workspaceMode === "traffic";
    const tool = this.store.tool;
    const roadOnly = ["lane", "lane-link", "car"].includes(tool);
    const pick = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) =>
        tool === "bus-route"
          ? mesh.metadata?.role === "stop"
          : roadOnly
            ? mesh.metadata?.role === "road"
            : traffic
              // В «Транспорте» объекты карты не выбираются: только машины и остановки.
              ? ["vehicle", "stop"].includes(mesh.metadata?.role)
              : ["road", "handle", "issue"].includes(mesh.metadata?.role),
    );
    const metadata = pick?.pickedMesh?.metadata;
    if (tool === "car") {
      if (metadata?.role === "road" && pick?.pickedPoint) {
        this.addVehicleAt(metadata.id, pick.pickedPoint);
      } else
        this.store.error = "Нажмите на дорожное полотно, чтобы добавить машину";
      return;
    }
    if (tool === "lane") {
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
    if (tool === "lane-link") {
      const source = this.store.laneLinkSource;
      if (!source) {
        this.store.tool = "select";
        return;
      }
      if (metadata?.role !== "road" || !pick?.pickedPoint) {
        this.store.error = "Нажмите на другую дорогу, с которой нужно соединить выбранную";
        return;
      }
      try {
        const command = planRoadLink(
          this.document,
          source,
          {
            wayId: metadata.id,
            lane: this.laneAtPoint(metadata.id, pick.pickedPoint) ?? 0,
            near: this.projection.unproject(pick.pickedPoint),
          },
          this.store.drivingSide,
        );
        if (this.store.execute(command)) {
          this.store.laneLinkSource = null;
          this.store.tool = "select";
          this.store.message =
            command.type === "connect-roads"
              ? "Дороги соединены общим узлом. Чтобы связать конкретные полосы, нажмите J ещё раз"
              : "Полоса соединена с полосой другой дороги";
        }
      } catch (error) {
        this.store.error = (error as Error).message;
      }
      return;
    }
    if (tool === "bus-route") {
      if (metadata?.role === "stop") this.store.addRouteStop(metadata.id);
      else this.store.error = "Нажмите на маркер остановки";
      return;
    }
    if (tool === "draw") {
      const point = this.groundPoint();
      if (point) {
        this.store.draft.push(this.snap(point));
        this.refreshPreview();
      }
      return;
    }
    if (tool === "insert") {
      const wayId =
        metadata?.role === "road"
          ? metadata.id
          : this.store.selection?.type === "way"
            ? this.store.selection.id
            : null;
      const way = wayId ? this.document.ways.get(wayId) : undefined;
      if (!wayId || !way || !tagsOf(way).highway) {
        this.store.error = "Выберите дорогу: узлы зданий не редактируются";
        return;
      }
      const point = this.groundPoint(roadStyle(tagsOf(way)).elevation);
      if (!point) return;
      const nearest = this.nearestSegment(wayId, point);
      if (Math.sqrt(nearest.distance) > 15) {
        this.store.error = "Нажмите ближе к сегменту дороги";
        return;
      }
      this.store.execute({
        type: "insert-node",
        wayId,
        index: nearest.index,
        point: nearest.nodeId
          ? { nodeId: nearest.nodeId }
          : this.projection.unproject(nearest.point),
      });
      return;
    }
    if (tool === "bus-stop") {
      // Остановка встаёт у ближайшей дороги с той стороны, где кликнули.
      const point = this.groundPoint();
      const place = point ? this.stopPlacement(point) : null;
      if (!place) {
        this.store.error =
          "Нажмите на дорогу или рядом с ней: остановка встанет с этой стороны";
        return;
      }
      this.store.execute({
        type: "add-bus-stop",
        wayId: place.wayId,
        index: place.index,
        point: place.nodeId
          ? { nodeId: place.nodeId }
          : this.projection.unproject(place.on),
        side: place.side,
      });
      this.refreshPreview();
      return;
    }
    if (!metadata) {
      this.store.selectedVehicle = null;
      this.store.selectOsmElement(null);
      return;
    }
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
    else this.store.selectOsmElement({ type: metadata.type, id: metadata.id });
    this.refreshSelection();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.engine.stopRenderLoop();
    this.clearVehicles();
    this.scene.dispose();
    this.engine.dispose();
  }
}
