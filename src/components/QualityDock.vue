<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useEditorStore } from "../stores/editor";
import { applyFix, fixLabel } from "../editor/issueFixes";
import { coordinateOf, refsOf, type Coordinate } from "../core/osm/model";
import { documentOrigin } from "../core/geo/projection";

const store = useEditorStore();
const open = ref(true);
const filter = ref("all");
const showAll = ref(false);
const mapOpen = ref(false);
const referencePanel = ref<HTMLDivElement>();
const issueCoordinate = ref<Coordinate | null>(null);
watch(() => store.selection, () => {
  issueCoordinate.value = null;
}, { flush: "sync" });

const mapLocation = computed(() => {
  store.revision;
  const document = store.document;
  if (!document) return "";
  const selected = store.selection;
  const way = selected?.type === "way" ? document.ways.get(selected.id) : undefined;
  const nodeId = selected?.type === "node" ? selected.id : way ? refsOf(way)[0] : undefined;
  const node = nodeId ? document.nodes.get(nodeId) : undefined;
  const { lat, lon } = issueCoordinate.value ??
    (node ? coordinateOf(node) : documentOrigin(document));
  return new URLSearchParams({ ll: `${lon.toFixed(6)},${lat.toFixed(6)}`, z: "17" }).toString();
});
const yandexUrl = computed(() => `https://yandex.ru/map-widget/v1/?${mapLocation.value}`);
const externalMap = computed(() => `https://yandex.ru/maps/?${mapLocation.value}`);
const issueList = computed(() => store.problems);
const visibleIssues = computed(() =>
  issueList.value
    .map((issue, index) => ({ issue, index }))
    .filter(
      ({ issue }) => filter.value === "all" || issue.code === filter.value,
    ),
);
const counts = computed(() => ({
  crossings: issueList.value.filter(
    (issue) => issue.code === "unconnected-crossing",
  ).length,
  buildings: issueList.value.filter(
    (issue) =>
      issue.code === "road-building-overlap" ||
      issue.code === "underground-passage",
  ).length,
  gaps: issueList.value.filter(
    (issue) =>
      issue.code === "near-disconnection" ||
      issue.code === "isolated-component",
  ).length,
}));
function locate(index: number) {
  const issue = issueList.value[index];
  if (!issue?.id || !issue.elementType) return;
  const type = issue.elementType === "node" ? "node" : "way";
  if (type === "node" && !store.document?.nodes.has(issue.id)) return;
  if (type === "way" && !store.document?.ways.has(issue.id)) return;
  store.selectOsmElement({ type, id: issue.id });
  store.focusCoordinate = issue.coordinate ?? null;
  store.focusRequest++;
  issueCoordinate.value = issue.coordinate ?? null;
  mapOpen.value = true;
  void nextTick(() => referencePanel.value?.scrollIntoView({ block: "nearest" }));
}
</script>

<template>
  <div class="qa-dock">
    <label class="toggle"
      ><span>Выделять ошибки на графе</span
      ><input v-model="store.showGraphIssues" type="checkbox"
    /></label>
    <p class="field-hint">
      Красный — геометрия и ошибки, оранжевый — разрывы, фиолетовый — отдельные
      части сети.
    </p>
    <div class="connectivity-summary">
      <strong
        >Связность:
        {{
          store.connectivity?.isolated
            ? `отдельных частей сети: ${store.connectivity.isolated}`
            : "сеть связна"
        }}</strong
      ><span v-if="store.connectivity?.clipped"
        >У границы выгрузки: {{ store.connectivity.clipped }} (не ошибка)</span
      ><span
        >С учётом направлений:
        {{ store.connectivity?.directedComponents || 0 }} групп</span
      >
    </div>
    <p v-for="(note, index) in store.notes" :key="index" class="field-hint">
      {{ note }}
    </p>
    <div class="qa-actions">
      <button class="qa-trigger" :aria-expanded="open" @click="open = !open">
        <span class="qa-symbol">◇</span>
        Ошибки сети
        <strong>{{ issueList.length }}</strong>
      </button>
      <button
        class="qa-trigger"
        :aria-expanded="mapOpen"
        @click="mapOpen = !mapOpen"
      >
        Сверить с картой
      </button>
    </div>
    <div v-if="open" class="qa-panel">
      <div class="qa-header">
        <div>
          <small>АНАЛИЗ ДОРОЖНОЙ СЕТИ</small>
          <h3>Проверка геометрии</h3>
        </div>
      </div>
      <p class="qa-subtitle">
        Подсказки требуют проверки по реальной карте. Ничего не перемещается
        автоматически.
      </p>
      <div class="qa-metrics">
        <span
          ><strong>{{ counts.crossings }}</strong> Пересечения</span
        >
        <span
          ><strong>{{ counts.buildings }}</strong> Проезды</span
        >
        <span
          ><strong>{{ counts.gaps }}</strong> Разрывы</span
        >
      </div>
      <label class="qa-filter"
        >Какие проблемы показать
        <select v-model="filter" aria-label="Тип проблемы">
          <option value="all">Все предупреждения</option>
          <option value="unconnected-crossing">Пересечения без узла</option>
          <option value="near-disconnection">Разрывы рядом с дорогой</option>
          <option value="road-building-overlap">Дорога через здание</option>
          <option value="underground-passage">Проезд под зданием ниже земли</option>
          <option value="isolated-component">Изолированные участки</option>
        </select>
      </label>
      <div class="qa-list">
        <p v-if="!issueList.length" class="qa-empty">
          Геометрических предупреждений не найдено. Это не подтверждает точность
          сети на местности.
        </p>
        <p v-if="issueList.length && !visibleIssues.length" class="qa-empty">
          По выбранному фильтру предупреждений нет.
        </p>
        <article
          v-for="{ issue, index } in showAll
            ? visibleIssues
            : visibleIssues.slice(0, 35)"
          :key="index"
          class="qa-issue"
        >
          <p>{{ issue.message }}</p>
          <div class="qa-issue-actions">
            <button v-if="issue.id" @click="locate(index)">Показать</button>
            <button
              v-if="fixLabel(issue)"
              class="qa-repair"
              @click="applyFix(store, issue)"
            >
              {{ fixLabel(issue) }}
            </button>
          </div>
        </article>
      </div>
      <button
        v-if="issueList.length > 35"
        class="qa-more"
        @click="showAll = !showAll"
      >
        {{ showAll ? "Свернуть" : "Показать все предупреждения" }}
      </button>
    </div>
    <div v-if="mapOpen" ref="referencePanel" class="qa-panel reference-panel">
      <div class="qa-header">
        <div>
          <small>ВИЗУАЛЬНАЯ СВЕРКА</small>
          <h3>Яндекс Карты</h3>
        </div>
        <button aria-label="Закрыть карту" @click="mapOpen = false">×</button>
      </div>
      <iframe
        :key="yandexUrl"
        :src="yandexUrl"
        title="Яндекс Карты — справочная карта"
        referrerpolicy="strict-origin-when-cross-origin"
        loading="lazy"
        allowfullscreen
      ></iframe>
      <a :href="externalMap" target="_blank" rel="noopener noreferrer">
        Открыть выбранную точку в Яндекс Картах ↗
      </a>
    </div>
  </div>
</template>

<style scoped>
.reference-panel iframe {
  width: 100%;
  height: 300px;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.reference-panel a {
  display: block;
  font-size: 10px;
  color: #6b8c58;
  margin: 12px 0;
}
</style>
