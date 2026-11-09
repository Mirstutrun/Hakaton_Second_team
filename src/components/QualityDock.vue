<script setup lang="ts">
import { computed, ref } from "vue";
import { coordinateOf, refsOf } from "../core/osm/model";
import { documentOrigin } from "../core/geo/projection";
import { useEditorStore } from "../stores/editor";

const store = useEditorStore();
const open = ref(false);
const mapOpen = ref(false);
const showAll = ref(false);
const issueList = computed(() => store.geometryIssues);
const counts = computed(() => ({
  crossings: issueList.value.filter((issue) => issue.code === "unconnected-crossing").length,
  buildings: issueList.value.filter((issue) => issue.code === "road-building-overlap").length,
  gaps: issueList.value.filter((issue) => (issue.code === "near-disconnection" || issue.code === "isolated-component")).length,
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
  store.focusRequest++;
}
function repair(index: number) {
  const issue = issueList.value[index];
  if (!issue?.fix) return;
  const fix = issue.fix;
  // Warning-level findings need explicit user action; never rewrite road
  // geometry without showing what will be connected.
  if (!window.confirm(`Соединить дороги ${fix.wayA} и ${fix.wayB} общим узлом? Проверьте, что это реальный перекрёсток, а не разноуровневая развязка.`))
    return;
  const patch = store.execute({ type: "connect-crossing", ...fix });
  if (patch) store.message = "Перекрёсток соединён. Проверка пересчитана.";
}
</script>

<template>
  <div class="qa-dock">
    <div class="qa-actions">
      <button class="qa-trigger" :aria-expanded="open" @click="open = !open">
        <span class="qa-symbol">◇</span>
        Топология
        <strong>{{ issueList.length }}</strong>
      </button>
      <button class="qa-trigger" :aria-expanded="mapOpen" @click="mapOpen = !mapOpen">
        Карта-эталон
      </button>
    </div>
    <div v-if="open" class="qa-panel">
      <div class="qa-header">
        <div><small>АНАЛИЗ ДОРОЖНОЙ СЕТИ</small><h3>Проверка геометрии</h3></div>
        <button aria-label="Закрыть проверку" @click="open = false">×</button>
      </div>
      <p class="qa-subtitle">Подсказки требуют проверки по реальной карте. Ничего не перемещается автоматически.</p>
      <div class="qa-metrics">
        <span><strong>{{ counts.crossings }}</strong> Пересечения</span>
        <span><strong>{{ counts.buildings }}</strong> Здания</span>
        <span><strong>{{ counts.gaps }}</strong> Разрывы</span>
      </div>
      <div class="qa-list">
        <p v-if="!issueList.length" class="qa-empty">Геометрических предупреждений не найдено. Это не подтверждает точность сети на местности.</p>
        <article v-for="(issue, index) in (showAll ? issueList : issueList.slice(0, 35))"
          :key="index" class="qa-issue">
          <p>{{ issue.message }}</p>
          <div class="qa-issue-actions">
            <button v-if="issue.id" @click="locate(index)">Показать</button>
            <button v-if="issue.fix" class="qa-repair" @click="repair(index)">Соединить узлом</button>
          </div>
        </article>
      </div>
      <button v-if="issueList.length > 35" class="qa-more" @click="showAll = !showAll">
        {{ showAll ? "Свернуть" : "Показать все предупреждения" }}
      </button>
    </div>
    <div v-if="mapOpen" class="reference-panel">
      <div class="qa-header">
        <div><small>ВИЗУАЛЬНАЯ СВЕРКА</small><h3>Яндекс Карты</h3></div>
        <button aria-label="Закрыть карту" @click="mapOpen = false">×</button>
      </div>
      <p class="qa-subtitle">Расположение по выбранному объекту. Это карта для сравнения, а не геодезически совмещённая подложка.</p>
      <iframe :key="yandexUrl" :src="yandexUrl" title="Яндекс Карты — справочная карта"
        referrerpolicy="strict-origin-when-cross-origin" loading="lazy"
        allowfullscreen></iframe>
      <a :href="externalMap" target="_blank" rel="noopener noreferrer">Открыть выбранную точку в Яндекс Картах ↗</a>
      <small class="qa-provider-note">Отображение встроенной карты зависит от доступности сервиса и условий Яндекса.</small>
    </div>
  </div>
</template>
