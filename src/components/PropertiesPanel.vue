<script setup lang="ts">
import LaneConnectionsPanel from "./LaneConnectionsPanel.vue";
import { computed, ref, watch } from "vue";
import { refsOf, tagsOf } from "../core/osm/model";
import {
  laneDirections,
  laneDirectionTags,
  normalizeLaneDirections,
  type LaneDirection,
} from "../engine/trafficRules";
import { roadStyle } from "../engine/geometry/roads";
import { useEditorStore } from "../stores/editor";
import { applyFix, fixLabel, issuesOfSelection } from "../editor/issueFixes";

const store = useEditorStore();
const confirmDelete = ref(false);
const tags = computed(() => {
  store.revision;
  return store.selected ? tagsOf(store.selected) : {};
});
const isRoad = computed(
  () => store.selection?.type === "way" && !!tags.value.highway,
);
const isStop = computed(
  () =>
    tags.value.public_transport === "stop_position" && tags.value.bus === "yes",
);
const pedestrian = computed(() => roadStyle(tags.value).pedestrian);
// Проблемы проверки у выбранного объекта: красную дорогу можно исправить прямо здесь.
const selectedIssues = computed(() => {
  store.revision;
  return issuesOfSelection(store);
});

// Число полос и направление каждой: 0 — крайняя правая по ходу линии дороги.
const MAX_LANES = 12;
const laneCount = ref(1);
const directions = ref<LaneDirection[]>([]);
const touched = ref(false);
const stopName = ref("");
// Сбрасывается при смене объекта или после правки, но не при повторном клике
// по той же дороге (например, чтобы выбрать полосу для соединения).
watch(
  () => [store.selection?.type, store.selection?.id, store.revision],
  () => {
    const count = Math.min(MAX_LANES, roadStyle(tags.value).lanes);
    laneCount.value = count;
    directions.value = laneDirections(tags.value, count, store.drivingSide);
    touched.value = false;
    stopName.value = tags.value.name ?? "";
    confirmDelete.value = false;
  },
  { immediate: true },
);
/** Полосы слева направо по ходу линии дороги. */
const shownLanes = computed(() =>
  directions.value.map((direction, lane) => ({ lane, direction })).reverse(),
);
/** Ввод числа полос. Пустое или неверное значение не трогает раскладку, пока его набирают. */
function typeCount(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= 1) setCount(value);
}
function setCount(value: number) {
  const count = Math.max(1, Math.min(MAX_LANES, Math.floor(value) || 1));
  touched.value = true;
  const current = directions.value;
  const all = (d: LaneDirection) => current.length && current.every((x) => x === d);
  const forward = all("forward") ? count : all("backward") ? 0 : Math.ceil(count / 2);
  laneCount.value = count;
  directions.value =
    count === 1 && !all("forward") && !all("backward")
      ? ["both"]
      : normalizeLaneDirections(
          Array.from({ length: count }, (_, i) => (i < forward ? "forward" : "backward")),
          store.drivingSide,
        );
}
function toggle(lane: number) {
  touched.value = true;
  // Полоса заодно становится выбранной: её подсветка на карте показывает, о какой речь.
  store.selectedLane = lane;
  const next = [...directions.value];
  next[lane] =
    next.length === 1
      ? ({ forward: "backward", backward: "both", both: "forward" } as const)[next[lane]]
      : next[lane] === "forward"
        ? "backward"
        : "forward";
  directions.value = normalizeLaneDirections(next, store.drivingSide);
}
const arrow = (direction: LaneDirection) =>
  direction === "forward" ? "↑" : direction === "backward" ? "↓" : "⇅";
// Кнопка активна, когда пользователь менял раскладку и теги OSM от этого изменятся
// (в том числе когда неявное или неверное значение становится явным).
const changed = computed(() => {
  if (!touched.value) return false;
  const next = laneDirectionTags(tags.value, directions.value);
  return Object.entries(next).some(
    ([key, value]) => (tags.value[key] ?? null) !== value,
  );
});
function applyLanes() {
  if (!store.selection || !changed.value) return;
  store.execute({
    type: "set-tags",
    target: store.selection,
    tags: laneDirectionTags(tags.value, directions.value),
  });
}
function renameStop() {
  if (store.selection?.type !== "node") return;
  store.execute({ type: "rename-bus-stop", id: store.selection.id, name: stopName.value });
}
function remove() {
  if (!store.selection) return;
  const patch = store.execute(
    isRoad.value
      ? { type: "delete-way", id: store.selection.id }
      : { type: "remove-bus-stop", id: store.selection.id },
  );
  if (patch) store.selectOsmElement(null);
  confirmDelete.value = false;
}
const vertexEditing = computed(
  () =>
    isRoad.value &&
    ["move", "insert"].includes(store.tool) &&
    !!store.selectedVertex &&
    !!store.selected &&
    refsOf(store.selected).includes(store.selectedVertex),
);
function removeVertex() {
  if (!store.selection || !store.selected || !store.selectedVertex) return;
  if (
    store.execute({
      type: "remove-vertex",
      wayId: store.selection.id,
      index: refsOf(store.selected).indexOf(store.selectedVertex),
    })
  )
    store.selectedVertex = null;
}
</script>

<template>
  <aside class="properties-panel">
    <div class="inspector-heading">
      <span class="section-label">СВОЙСТВА ОБЪЕКТА</span
      ><button
        v-if="store.selected"
        class="clear-selection"
        @click="store.selectOsmElement(null)"
        aria-label="Снять выделение"
      >
        ×
      </button>
    </div>
    <template v-if="store.selected">
      <template v-if="isRoad">
        <h2>{{ tags.name || "Дорога без названия" }}</h2>
        <div class="object-id">Дорога № {{ store.selection?.id }}</div>
        <section v-if="selectedIssues.length" class="issue-notice" role="alert">
          <div class="section-label">ПРОБЛЕМА НА ЭТОЙ ДОРОГЕ</div>
          <template v-for="(issue, index) in selectedIssues" :key="index">
            <p>{{ issue.message }}</p>
            <button
              v-if="fixLabel(issue)"
              class="qa-repair"
              @click="applyFix(store, issue)"
            >
              {{ fixLabel(issue) }}
            </button>
          </template>
          <button v-if="!store.reviewOpen" @click="store.toggleReview()">
            Открыть проверку
          </button>
        </section>
        <form
          v-if="!pedestrian"
          class="properties-form lane-editor"
          @submit.prevent="applyLanes"
        >
          <label
            >Количество полос<input
              :value="laneCount"
              aria-label="Полосы"
              type="number"
              min="1"
              :max="MAX_LANES"
              @input="typeCount"
              @blur="($event.target as HTMLInputElement).value = String(laneCount)"
          /></label>
          <div class="section-label">НАПРАВЛЕНИЕ КАЖДОЙ ПОЛОСЫ</div>
          <div class="lane-picker lane-directions" aria-label="Направления полос">
            <button
              v-for="(item, index) in shownLanes"
              :key="item.lane"
              type="button"
              :aria-label="`Полоса ${index + 1}: ${item.direction === 'forward' ? 'по направлению дороги' : item.direction === 'backward' ? 'навстречу' : 'в обе стороны'}`"
              :class="{ 'lane-active': store.selectedLane === item.lane }"
              @click="toggle(item.lane)"
            >
              <b>{{ arrow(item.direction) }}</b><small>{{ index + 1 }}</small>
            </button>
          </div>
          <p class="field-hint">
            Нажмите на полосу, чтобы сменить направление. ↑ — по стрелкам на
            выбранной дороге, ↓ — навстречу. Полосы одного направления
            группируются справа по ходу движения, как принято в OSM.
          </p>
          <button class="primary full-width" :disabled="!changed">
            Применить изменения
          </button>
        </form>
        <p v-else class="field-hint">
          Пешеходная дорожка: полосы для транспорта не настраиваются.
        </p>
        <LaneConnectionsPanel v-if="!pedestrian" />
        <div v-if="vertexEditing" class="geometry-details">
          <button class="full-width" @click="removeVertex">
            Удалить выбранную вершину
          </button>
        </div>
        <div class="delete-section">
          <button
            v-if="!confirmDelete"
            class="danger full-width"
            @click="confirmDelete = true"
          >
            Удалить дорогу
          </button>
          <div v-else class="confirm-delete">
            <p>Удалить эту дорогу? Общие узлы останутся на карте.</p>
            <button class="danger" @click="remove">Подтвердить удаление</button
            ><button @click="confirmDelete = false">Отмена</button>
          </div>
        </div>
      </template>
      <template v-else-if="isStop">
        <h2>{{ tags.name || "Автобусная остановка" }}</h2>
        <form class="properties-form" @submit.prevent="renameStop">
          <label
            >Название остановки
            <input
              v-model="stopName"
              aria-label="Название остановки"
              placeholder="Например, Центральная"
            />
          </label>
          <button class="primary full-width">Сохранить название</button>
        </form>
        <div class="delete-section">
          <button
            v-if="!confirmDelete"
            class="danger full-width"
            @click="confirmDelete = true"
          >
            Убрать остановку
          </button>
          <div v-else class="confirm-delete">
            <p>Убрать остановку? Узел дороги останется.</p>
            <button class="danger" @click="remove">Подтвердить удаление</button
            ><button @click="confirmDelete = false">Отмена</button>
          </div>
        </div>
      </template>
      <template v-else>
        <h2>Узел дороги</h2>
        <section v-if="selectedIssues.length" class="issue-notice" role="alert">
          <div class="section-label">ПРОБЛЕМА В ЭТОМ УЗЛЕ</div>
          <template v-for="(issue, index) in selectedIssues" :key="index">
            <p>{{ issue.message }}</p>
            <button
              v-if="fixLabel(issue)"
              class="qa-repair"
              @click="applyFix(store, issue)"
            >
              {{ fixLabel(issue) }}
            </button>
          </template>
        </section>
        <p class="field-hint">
          Чтобы перенести узел, выберите дорогу и включите «Переместить узел».
        </p>
      </template>
    </template>
    <div v-else-if="store.workspaceMode === 'traffic'" class="empty-inspector">
      <div class="empty-icon">⌖</div>
      <h2>Транспорт</h2>
      <p>
        Нажмите на остановку, чтобы задать название или убрать её. Машину можно
        выделить кликом и удалить кнопкой слева.
      </p>
    </div>
    <div v-else class="empty-inspector">
      <div class="empty-icon">⌖</div>
      <h2>Выберите дорогу</h2>
      <p>
        Для дороги можно задать число полос и направление каждой полосы. Красные
        дороги — с ошибками: нажмите на такую дорогу или откройте «Проверку».
      </p>
      <ol class="inspector-steps">
        <li>Нажмите на дорогу</li>
        <li>Задайте полосы и их направления</li>
        <li>Нажмите «Применить изменения»</li>
      </ol>
      <button class="full-width" @click="store.helpOpen = true">
        Показать быстрый старт
      </button>
      <span class="key-hint"><kbd>V</kbd> Выбор объекта</span>
    </div>
    <div class="validation">
      <div class="section-label">ПРОВЕРКА ДОКУМЕНТА</div>
      <div v-if="store.document" class="validation-state">
        <span class="live-dot"></span
        >{{
          store.issues.some((issue) => issue.severity === "error")
            ? "Есть ошибки"
            : "Ссылки дорог корректны"
        }}
      </div>
    </div>
  </aside>
</template>
