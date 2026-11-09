<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SceneManager } from "../engine/SceneManager";
import QualityDock from "./QualityDock.vue";
import TrafficDock from "./TrafficDock.vue";
import { useEditorStore } from "../stores/editor";

const canvas = ref<HTMLCanvasElement>();
const store = useEditorStore();
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
  () => [store.selection, store.selectedVertex],
  () => manager?.refreshSelection(),
  { deep: true },
);
watch(
  () => store.view,
  () => manager?.setView(),
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
      <span class="muted">/ {{ store.view.toUpperCase() }}</span>
    </div>
    <div class="compass"><span>N</span><b>↑</b><small>СЕВЕР</small></div>
    <div class="map-credit">
      © OpenStreetMap contributors · локальные данные
    </div>
    <div class="view-controls">
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
    <QualityDock />
    <TrafficDock />
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
  </main>
</template>
