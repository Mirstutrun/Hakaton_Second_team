import { computed, markRaw, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { reviewBaseline, reviewReport } from "../core/osm/reviewReport";
import { parseOsm } from "../core/osm/parser";
import { serializeOsm } from "../core/osm/serializer";
import { applyEdit, applyPatch, type EditCommand } from "../core/osm/commands";
import {
  tagsOf,
  type EditPatch,
  type Coordinate,
  type OsmDocument,
  type RoadPoint,
  type Selection,
} from "../core/osm/model";
import { validateOsm } from "../core/osm/validation";
import { auditGeometry } from "../core/osm/geometryAudit";
import { busRoutes } from "../core/osm/busRoutes";
import { TrafficModel } from "../engine/TrafficModel";
import type { EditorTool } from "../editor/tools";

export const useEditorStore = defineStore("editor", () => {
  let baseline: ReturnType<typeof reviewBaseline> | null = null;
  const document = shallowRef<OsmDocument | null>(null);
  const revision = ref(0);
  const lastPatch = shallowRef<EditPatch | null>(null);
  const selection = ref<Selection | null>(null);
  const selectedVertex = ref<string | null>(null);
  const selectedLane = ref<number | null>(null);
  const vehicleAddRequest = ref(0);
  const vehicleAddBatchRequest = ref(0);
  const vehicleDeleteRequest = ref(0);
  const vehicleClearRequest = ref(0);
  const selectedVehicle = ref<string | null>(null);
  const vehicleCount = ref(0);
  const busCount = ref(0);
  const busAddRequest = ref(0);
  const selectedBusRoute = ref("");
  const routeDraft = ref<string[]>([]);
  const routeName = ref("");
  const workspaceMode = ref<"edit" | "traffic" | "review">("edit");
  const helpOpen = ref(false);
  const inspectorOpen = ref(false);
  const zoomRequest = ref(0);
  const fitRequest = ref(0);
  const trafficRunning = ref(false);
  const trafficSpeed = ref(1);
  const drivingSide = ref<"left" | "right">("left");
  const trafficMetrics = ref({ stopped: 0, moving: 0, averageKmh: 0 });
  const tool = ref<EditorTool>("select");
  const view = ref<"3d" | "2d">("2d");
  const buildings = ref(true);
  const markings = ref(true);
  const pedestrians = ref(true);
  const fileName = ref("example.osm");
  const message = ref("Откройте карту или загрузите пример");
  const error = ref("");
  const loading = ref(false);
  const focusRequest = ref(0);
  const focusCoordinate = ref<Coordinate | null>(null);
  const draft = ref<RoadPoint[]>([]);
  const joinSource = ref<{ wayId: string; nodeId: string } | null>(null);
  const history = shallowRef<EditPatch[]>([]);
  const cursor = ref(0);
  const savedCursor = ref(0);
  const dirty = computed(() => cursor.value !== savedCursor.value);
  const canUndo = computed(() => cursor.value > 0);
  const canRedo = computed(() => cursor.value < history.value.length);
  const geometryIssues = computed(() => {
    revision.value;
    return document.value ? auditGeometry(document.value) : [];
  });
  const issues = computed(() => {
    revision.value;
    return document.value ? validateOsm(document.value) : [];
  });
  const stats = computed(() => {
    revision.value;
    const data = document.value;
    return data
      ? {
          nodes: data.nodes.size,
          roads: Array.from(data.ways.values()).filter(
            (way) => tagsOf(way).highway,
          ).length,
          signals: Array.from(data.nodes.values()).filter(
            (node) => tagsOf(node).highway === "traffic_signals",
          ).length,
          stops: Array.from(data.nodes.values()).filter(
            (node) =>
              tagsOf(node).public_transport === "stop_position" &&
              tagsOf(node).bus === "yes",
          ).length,
        }
      : { nodes: 0, roads: 0, signals: 0, stops: 0 };
  });
  const stops = computed(() => {
    revision.value;
    return document.value
      ? Array.from(document.value.nodes, ([id, node]) => ({
          id,
          name: tagsOf(node).name || `Остановка ${id}`,
        })).filter(({ id }) => {
          const tags = tagsOf(document.value!.nodes.get(id)!);
          return (
            tags.public_transport === "stop_position" && tags.bus === "yes"
          );
        })
      : [];
  });
  const routes = computed(() => {
    revision.value;
    return document.value ? busRoutes(document.value) : [];
  });
  const selected = computed(() => {
    revision.value;
    if (!selection.value || !document.value) return null;
    return (
      (selection.value.type === "way"
        ? document.value.ways
        : document.value.nodes
      ).get(selection.value.id) ?? null
    );
  });

  function load(source: string, name: string) {
    try {
      const next = parseOsm(source);
      const errors = validateOsm(next).filter(
        (issue) => issue.severity === "error",
      );
      if (errors.length) throw new Error(errors[0].message);
      baseline = reviewBaseline(next);
      document.value = markRaw(next);
      fileName.value = name;
      history.value = [];
      cursor.value = savedCursor.value = 0;
      selection.value = null;
      selectedVertex.value = null;
      selectedLane.value = null;
      selectedVehicle.value = null;
      vehicleCount.value = 0;
      busCount.value = 0;
      selectedBusRoute.value = "";
      routeDraft.value = [];
      routeName.value = "";
      trafficRunning.value = true;
      draft.value = [];
      joinSource.value = null;
      lastPatch.value = null;
      revision.value++;
      error.value = "";
      message.value = "Карта загружена. Выберите дорогу на сцене.";
    } catch (cause) {
      error.value = (cause as Error).message;
    }
  }

  function execute(command: EditCommand) {
    if (!document.value) return;
    try {
      const patch = markRaw(applyEdit(document.value, command));
      if (savedCursor.value > cursor.value) savedCursor.value = -1;
      history.value = [...history.value.slice(0, cursor.value), patch];
      cursor.value++;
      lastPatch.value = patch;
      if (patch.selection) selection.value = patch.selection;
      revision.value++;
      error.value = "";
      message.value = "Изменения применены";
      return patch;
    } catch (cause) {
      error.value = (cause as Error).message;
    }
  }

  function undo() {
    if (!document.value || !canUndo.value) return;
    const patch = history.value[--cursor.value];
    applyPatch(document.value, patch, "before");
    lastPatch.value = patch;
    revision.value++;
    message.value = "Действие отменено";
  }

  function redo() {
    if (!document.value || !canRedo.value) return;
    const patch = history.value[cursor.value++];
    applyPatch(document.value, patch, "after");
    lastPatch.value = patch;
    revision.value++;
    message.value = "Действие повторено";
  }

  function exportOsm() {
    if (!document.value) return;
    try {
      const source = serializeOsm(document.value);
      const url = URL.createObjectURL(
        new Blob([source], { type: "application/xml" }),
      );
      const link = window.document.createElement("a");
      link.href = url;
      link.download = fileName.value.replace(/\.osm$/i, "") + "-edited.osm";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      savedCursor.value = cursor.value;
      error.value = "";
      message.value = "OSM экспортирован с сохранением отношений и метаданных";
    } catch (cause) {
      error.value = (cause as Error).message;
    }
  }

  function exportReviewReport() {
    if (!document.value || !baseline) return;
    const report = {
      source: fileName.value,
      ...reviewReport(baseline, document.value),
      edits: history.value.slice(0, cursor.value).map((patch) => patch.label),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download =
      fileName.value.replace(/\.(osm|xml)$/i, "") + "-before-after.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.value = "Отчёт до/после экспортирован";
  }

  function finishRoad() {
    if (
      execute({
        type: "create-road",
        points: draft.value,
        tags: { highway: "residential", lanes: "2" },
      })
    ) {
      draft.value = [];
      tool.value = "select";
    }
  }

  function selectOsmElement(target: Selection | null) {
    if (target) inspectorOpen.value = true;
    selection.value = target;
    selectedVertex.value = target?.type === "node" ? target.id : null;
    selectedLane.value = null;
  }

  function addRouteStop(id: string) {
    if (routeDraft.value.includes(id)) {
      error.value = "Остановка уже есть в маршруте";
      return;
    }
    routeDraft.value = [...routeDraft.value, id];
    error.value = "";
    message.value = `В маршруте ${routeDraft.value.length} остановки`;
  }

  function finishBusRoute() {
    if (!document.value) return;
    const ways = new TrafficModel(document.value).routeWayIds(routeDraft.value);
    if (!ways) {
      error.value =
        "Между остановками нет проезда с учётом односторонних дорог";
      return;
    }
    const patch = execute({
      type: "create-bus-route",
      name: routeName.value,
      stops: routeDraft.value,
      ways,
    });
    if (patch) {
      selectedBusRoute.value =
        patch.changes.find(
          (change) => change.type === "relation" && !change.before,
        )?.id ?? "";
      routeDraft.value = [];
      routeName.value = "";
      tool.value = "select";
    }
  }

  return {
    document,
    revision,
    lastPatch,
    selection,
    selectedVertex,
    selectedLane,
    selectedVehicle,
    vehicleAddRequest,
    vehicleAddBatchRequest,
    vehicleDeleteRequest,
    vehicleClearRequest,
    vehicleCount,
    busCount,
    busAddRequest,
    selectedBusRoute,
    routeDraft,
    routeName,
    stops,
    routes,
    workspaceMode,
    helpOpen,
    inspectorOpen,
    zoomRequest,
    fitRequest,
    trafficRunning,
    trafficSpeed,
    drivingSide,
    trafficMetrics,
    selected,
    tool,
    view,
    buildings,
    markings,
    pedestrians,
    fileName,
    message,
    error,
    loading,
    focusRequest,
    focusCoordinate,
    draft,
    joinSource,
    history,
    cursor,
    dirty,
    canUndo,
    canRedo,
    issues,
    geometryIssues,
    stats,
    load,
    execute,
    undo,
    redo,
    exportOsm,
    exportReviewReport,
    finishRoad,
    selectOsmElement,
    addRouteStop,
    finishBusRoute,
  };
});
