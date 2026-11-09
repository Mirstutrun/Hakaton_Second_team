import { computed, markRaw, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { parseOsm } from "../core/osm/parser";
import { serializeOsm } from "../core/osm/serializer";
import { applyEdit, applyPatch, type EditCommand } from "../core/osm/commands";
import {
  tagsOf,
  type EditPatch,
  type OsmDocument,
  type RoadPoint,
  type Selection,
} from "../core/osm/model";
import { validateOsm } from "../core/osm/validation";
import type { EditorTool } from "../editor/tools";

export const useEditorStore = defineStore("editor", () => {
  const document = shallowRef<OsmDocument | null>(null);
  const revision = ref(0);
  const lastPatch = shallowRef<EditPatch | null>(null);
  const selection = ref<Selection | null>(null);
  const selectedVertex = ref<string | null>(null);
  const tool = ref<EditorTool>("select");
  const view = ref<"3d" | "2d">("3d");
  const buildings = ref(true);
  const markings = ref(true);
  const pedestrians = ref(true);
  const fileName = ref("example.osm");
  const message = ref("Откройте карту или загрузите пример");
  const error = ref("");
  const loading = ref(false);
  const focusRequest = ref(0);
  const draft = ref<RoadPoint[]>([]);
  const history = shallowRef<EditPatch[]>([]);
  const cursor = ref(0);
  const savedCursor = ref(0);
  const dirty = computed(() => cursor.value !== savedCursor.value);
  const canUndo = computed(() => cursor.value > 0);
  const canRedo = computed(() => cursor.value < history.value.length);
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
        }
      : { nodes: 0, roads: 0, signals: 0 };
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
      document.value = markRaw(next);
      fileName.value = name;
      history.value = [];
      cursor.value = savedCursor.value = 0;
      selection.value = null;
      selectedVertex.value = null;
      draft.value = [];
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
    selection.value = target;
    selectedVertex.value = target?.type === "node" ? target.id : null;
  }

  return {
    document,
    revision,
    lastPatch,
    selection,
    selectedVertex,
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
    draft,
    history,
    cursor,
    dirty,
    canUndo,
    canRedo,
    issues,
    stats,
    load,
    execute,
    undo,
    redo,
    exportOsm,
    finishRoad,
    selectOsmElement,
  };
});
