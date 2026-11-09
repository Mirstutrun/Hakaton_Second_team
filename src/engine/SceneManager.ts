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
import { buildRoad, roadStyle } from "./geometry/roads";
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
  private handles: Mesh[] = [];
  private issueMeshes: Mesh[] = [];
  private preview: Mesh | null = null;
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
    this.scene.clearColor = new Color4(0.055, 0.085, 0.1, 1);
    this.camera = new ArcRotateCamera(
      "camera",
      -Math.PI / 2,
      0.95,
      1550,
      Vector3.Zero(),
      this.scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.lowerRadiusLimit = 25;
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
    light.groundColor = Color3.FromHexString("#22312d");
    for (const [name, color] of Object.entries({
      asphalt: "#424f52",
      pedestrian: "#67766a",
      building: "#667d82",
      selected: "#20c99c",
      handle: "#baffd8",
      ground: "#18292c",
      pole: "#263f45",
      lamp: "#7dffb5",
      line: "#d8e9cc",
      issueCrossing: "#ffb968",
      issueBuilding: "#ff6e84",
      issueGap: "#aee1ff",
    })) {
      const material = new StandardMaterial(name, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      material.backFaceCulling = false;
      if (["selected", "handle", "lamp", "issueCrossing", "issueBuilding", "issueGap"].includes(name))
        material.emissiveColor = material.diffuseColor.scale(0.4);
      this.materials[name] = material;
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
    grid.color = Color3.FromHexString("#294044");
    grid.isPickable = false;
    this.scene.onPointerObservable.add((info) =>
      this.pointer(info.type, info.event as PointerEvent),
    );
    this.scene.onBeforeRenderObservable.add(() => this.updateOrtho());
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
    for (const id of document.ways.keys()) this.refreshWay(id);
    for (const id of document.nodes.keys()) this.refreshSignal(id);
    this.camera.setTarget(Vector3.Zero());
    this.camera.radius = 1550;
    this.refreshSelection();
    this.refreshIssues();
    this.visibility();
  }

  private refreshWay(id: string) {
    this.wayMeshes.get(id)?.forEach((mesh) => mesh.dispose());
    this.wayMeshes.delete(id);
    const way = this.document?.ways.get(id);
    if (!way) return;
    const tags = tagsOf(way);
    const points = refsOf(way)
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
    this.visibility();
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
    const pick = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) => ["road", "handle", "signal", "issue"].includes(mesh.metadata?.role),
    );
    const metadata = pick?.pickedMesh?.metadata;
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
    this.scene.dispose();
    this.engine.dispose();
  }
}
