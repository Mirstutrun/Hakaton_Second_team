<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SceneManager } from "../engine/SceneManager";
import { editorTools } from "../editor/tools";
import { useEditorStore } from "../stores/editor";

const canvas = ref<HTMLCanvasElement>();
const store = useEditorStore();
const activeTool = computed(() =>
  editorTools.find((tool) => tool.id === store.tool)!,
);
let manager: SceneManager | undefined;
onMounted(() => {
  try {
    manager = new SceneManager(canvas.value!, store);
    if (store.document) manager.load(store.document);
  } catch (error) {
    store.error = `Не удалось запустить WebGL: ${(error as Error).message}`;
  }
});
watch(
  () => store.document,
  (document) => {
    if (document) manager?.load(document);
  },
);
watch(
  () => store.revision,
  () => manager?.refreshChangedMeshes(store.lastPatch),
);
watch(
  () => [store.selection, store.selectedVertex, store.selectedLane],
  () => manager?.refreshSelection(),
  { deep: true },
);
watch(
  () => store.view,
  () => manager?.setView(),
);
watch(
  () => store.tool,
  () => manager?.refreshSelection(),
);
watch(
  () => store.showGraphIssues,
  () => {
    manager?.refreshSelection();
    manager?.visibility();
  },
);
watch(
  () => store.workspaceMode,
  () => manager?.visibility(),
);
watch(
  () => store.zoomRequest,
  (value, previous) => manager?.zoom(value > previous ? 0.75 : 1.33),
);
watch(
  () => store.fitRequest,
  () => manager?.fitMap(),
);
watch(
  () => [store.buildings, store.markings, store.pedestrians],
  () => manager?.visibility(),
);
watch(
  () => store.vehicleAddRequest,
  () => manager?.addVehicles(1),
);
watch(
  () => store.vehicleAddBatchRequest,
  () => manager?.addVehicles(10),
);
watch(
  () => store.vehicleDeleteRequest,
  () => manager?.deleteSelectedVehicle(),
);
watch(
  () => store.vehicleClearRequest,
  () => manager?.clearVehicles(),
);
watch(
  () => store.drivingSide,
  () => {
    manager?.refreshDrivingSide();
    manager?.addVehicles(18);
  },
);
watch(
  () => store.busAddRequest,
  () => manager?.addBus(),
);
watch(
  () => store.selectedBusRoute,
  () => manager?.refreshRoute(),
);
watch(
  () => store.focusRequest,
  () => manager?.focus(),
);
watch(
  () => store.draft.length,
  () => manager?.refreshPreview(),
);
onBeforeUnmount(() => manager?.dispose());
</script>

<template>
  <main class="viewport">
    <canvas
      ref="canvas"
      aria-label="Интерактивная карта OSM"
      tabindex="0"
    ></canvas>
    <div class="viewport-title">
      <span class="live-dot"></span> {{ store.fileName }}
      <span class="muted">{{
        store.view === "2d" ? "Вид сверху" : "Объёмный вид"
      }}</span>
    </div>
    <div class="compass"><span>N</span><b>↑</b><small>СЕВЕР</small></div>
    <div class="map-credit">© OpenStreetMap contributors</div>
    <div class="view-controls">
      <div class="zoom-controls">
        <button aria-label="Приблизить" @click="store.zoomRequest++">+</button
        ><button aria-label="Отдалить" @click="store.zoomRequest--">−</button>
      </div>
      <button
        aria-label="Вся карта"
        title="Показать всю карту"
        @click="store.fitRequest++"
      >
        ⊞
      </button>
      <div class="segmented">
        <button
          :class="{ active: store.view === '3d' }"
          @click="store.view = '3d'"
        >
          3D</button
        ><button
          :class="{ active: store.view === '2d' }"
          @click="store.view = '2d'"
        >
          2D
        </button>
      </div>
      <button
        title="Центрировать выбранный объект (F)"
        aria-label="Центрировать"
        @click="store.focusRequest++"
      >
        ⌖
      </button>
    </div>
    <div v-if="store.document" class="map-instruction" role="status">
      <span class="instruction-icon">{{
        store.tool === "select" ? "↖" : "+"
      }}</span>
      <div>
        <strong>{{ activeTool.name }}</strong>
        <p>
          {{
            store.tool === "join" && store.joinSource
              ? `Конец дороги ${store.joinSource.wayId} выбран. Теперь нажмите на другую дорогу или её узел.`
              : activeTool.hint
          }}
        </p>
      </div>
      <button
        v-if="store.tool !== 'select'"
        @click="
          store.tool = 'select';
          store.draft = [];
          store.routeDraft = [];
          store.joinSource = null;
        "
      >
        Готово · Esc
      </button>
    </div>
    <div class="map-legend" aria-label="Обозначения карты">
      <span><i class="legend-road"></i>Дорога</span
      ><span><i class="legend-building"></i>Здание</span
      ><span><i class="legend-selected"></i>Выбрано</span>
      <span v-if="store.showGraphIssues"
        ><i class="legend-issue"></i>Проверить</span
      >
    </div>
    <button
      class="mobile-tools"
      @click="
        store.toolsOpen = !store.toolsOpen;
        store.inspectorOpen = false;
      "
      :aria-expanded="store.toolsOpen"
    >
      {{ store.toolsOpen ? "Скрыть инструменты" : "Инструменты" }}
    </button>
    <button
      class="mobile-inspector"
      @click="store.inspectorOpen = !store.inspectorOpen"
    >
      {{
        store.workspaceMode === "review"
          ? store.inspectorOpen
            ? "Закрыть проверку"
            : "Показать проверку"
          : store.inspectorOpen
            ? "Закрыть свойства"
            : "Свойства объекта"
      }}
    </button>
    <div v-if="store.loading" class="loading">
      <div class="spinner"></div>
      Подготовка дорожной сети…
    </div>
    <div v-if="store.tool === 'draw'" class="draw-card">
      <span
        >Новая дорога <b>{{ store.draft.length }} точек</b></span
      ><button
        class="primary"
        :disabled="store.draft.length < 2"
        @click="store.finishRoad()"
      >
        Завершить ↵</button
      ><button
        @click="
          store.draft = [];
          store.tool = 'select';
        "
      >
        Отмена
      </button>
    </div>
    <div v-if="store.tool === 'bus-route'" class="draw-card route-card">
      <span
        >Маршрут <b>{{ store.routeDraft.length }} остановки</b></span
      >
      <input
        v-model="store.routeName"
        aria-label="Название маршрута"
        placeholder="Например, автобус 1"
      />
      <button
        class="primary"
        :disabled="store.routeDraft.length < 2 || !store.routeName.trim()"
        @click="store.finishBusRoute()"
      >
        Сохранить маршрут
      </button>
      <button
        :disabled="!store.routeDraft.length"
        @click="store.routeDraft.pop()"
      >
        Убрать последнюю
      </button>
      <button
        @click="
          store.routeDraft = [];
          store.tool = 'select';
        "
      >
        Отмена
      </button>
    </div>
  </main>
</template>
