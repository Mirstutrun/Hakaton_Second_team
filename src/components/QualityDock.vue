<script setup lang="ts">
import { computed, ref } from "vue";
import { coordinateOf, refsOf } from "../core/osm/model";
import { documentOrigin } from "../core/geo/projection";
import { useEditorStore } from "../stores/editor";

const store = useEditorStore();
const open = ref(true);
const filter = ref("all");
const mapOpen = ref(false);
const showAll = ref(false);
const issueList = computed(() => store.geometryIssues);
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
    (issue) => issue.code === "road-building-overlap",
  ).length,
  gaps: issueList.value.filter(
    (issue) =>
      issue.code === "near-disconnection" ||
      issue.code === "isolated-component",
  ).length,
}));
const center = computed(() => {
  store.revision;
  const document = store.document;
  if (!document) return { lat: 52.264, lon: 104.267 };
  const selected = store.selection;
  if (selected?.type === "node") {
    const node = document.nodes.get(selected.id);
    if (node) return coordinateOf(node);
  }
  if (selected?.type === "way") {
    const way = document.ways.get(selected.id);
    if (way) {
      const ref = refsOf(way)[0];
      const node = document.nodes.get(ref);
      if (node) return coordinateOf(node);
    }
  }
  return documentOrigin(document);
});
const yandexUrl = computed(() => {
  const { lat, lon } = center.value;
  return `https://yandex.ru/map-widget/v1/?ll=${encodeURIComponent(lon.toFixed(6) + "," + lat.toFixed(6))}&z=17`;
});
const externalMap = computed(() => {
  const { lat, lon } = center.value;
  return `https://yandex.ru/maps/?ll=${encodeURIComponent(lon.toFixed(6) + "," + lat.toFixed(6))}&z=17`;
});
function locate(index: number) {
  const issue = issueList.value[index];
  if (!issue?.id || !issue.elementType) return;
  const type = issue.elementType === "node" ? "node" : "way";
  if (type === "node" && !store.document?.nodes.has(issue.id)) return;
  if (type === "way" && !store.document?.ways.has(issue.id)) return;
  store.selectOsmElement({ type, id: issue.id });
  store.focusCoordinate = issue.coordinate ?? null;
  store.focusRequest++;
}
function downloadReport() {
  const report = {
    project: "RoadForge 3D",
    source: store.fileName,
    generatedAt: new Date().toISOString(),
    note: "Warnings are heuristics, not verified ground truth; no automatic edits were made.",
    issues: issueList.value,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    store.fileName.replace(/\.(osm|xml)$/i, "") + "-geometry-audit.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function repair(index: number) {
  const issue = issueList.value[index];
  if (!issue?.fix) return;
  const fix = issue.fix;
  // Warning-level findings need explicit user action; never rewrite road
  // geometry without showing what will be connected.
  const confirmation =
    fix.kind === "connect-crossing"
      ? `Соединить дороги ${fix.wayA} и ${fix.wayB} общим узлом? Убедитесь, что это наземный перекрёсток.`
      : `Переместить свободный конец ${fix.nodeId} к дороге ${fix.targetWayId} и вставить общий узел? Проверьте по снимку, что соединение существует.`;
  if (!window.confirm(confirmation)) return;
  const patch =
    fix.kind === "connect-crossing"
      ? store.execute({ type: "connect-crossing", ...fix })
      : store.execute({ type: "attach-endpoint", ...fix });
  if (patch) store.message = "Связь добавлена. Проверка пересчитана.";
}
</script>

<template>
  <div class="qa-dock">
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
        <button aria-label="Закрыть проверку" @click="open = false">×</button>
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
          ><strong>{{ counts.buildings }}</strong> Здания</span
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
            <button v-if="issue.fix" class="qa-repair" @click="repair(index)">
              {{
                issue.fix.kind === "attach-endpoint"
                  ? "Замкнуть разрыв"
                  : "Соединить узлом"
              }}
            </button>
          </div>
        </article>
      </div>
      <button
        class="qa-more"
        :disabled="!store.document"
        @click="downloadReport"
      >
        Скачать отчёт JSON
      </button>
      <button
        class="qa-more"
        :disabled="!store.document"
        @click="store.exportReviewReport"
      >
        Отчёт до / после для защиты
      </button>
      <button
        v-if="issueList.length > 35"
        class="qa-more"
        @click="showAll = !showAll"
      >
        {{ showAll ? "Свернуть" : "Показать все предупреждения" }}
      </button>
    </div>
    <div v-if="mapOpen" class="reference-panel">
      <div class="qa-header">
        <div>
          <small>ВИЗУАЛЬНАЯ СВЕРКА</small>
          <h3>Яндекс Карты</h3>
        </div>
        <button aria-label="Закрыть карту" @click="mapOpen = false">×</button>
      </div>
      <p class="qa-subtitle">
        Расположение по выбранному объекту. Это карта для сравнения, а не
        геодезически совмещённая подложка.
      </p>
      <iframe
        :key="yandexUrl"
        :src="yandexUrl"
        title="Яндекс Карты — справочная карта"
        referrerpolicy="strict-origin-when-cross-origin"
        loading="lazy"
        allowfullscreen
      ></iframe>
      <a :href="externalMap" target="_blank" rel="noopener noreferrer"
        >Открыть выбранную точку в Яндекс Картах ↗</a
      >
      <small class="qa-provider-note"
        >Отображение встроенной карты зависит от доступности сервиса и условий
        Яндекса.</small
      >
    </div>
  </div>
</template>
