<script setup lang="ts">
import { computed, ref } from "vue";
import { coordinateOf, refsOf } from "../core/osm/model";
import { buildingShapes } from "../core/osm/buildingShapes";
import type { ValidationIssue } from "../core/osm/validation";
import { documentOrigin } from "../core/geo/projection";
import { useEditorStore } from "../stores/editor";

const store = useEditorStore();
const passageWidth=ref(3.5),passageHeight=ref(2.7);
function proposePassage(issue:ValidationIssue){if(!issue.id||!issue.buildingId)return;store.passageProposal={wayId:issue.id,buildingId:issue.buildingId};passageWidth.value=3.5;passageHeight.value=2.7;}
function makePassage(){const p=store.passageProposal;if(!p)return;const result=store.execute({type:"mark-building-passage",...p,width:passageWidth.value,height:passageHeight.value});if(result){store.passageProposal=null;store.message="Проезд через арку выделен отдельным участком. Проверьте ширину и высоту по реальному месту";}}
function fixBuilding(issue:ValidationIssue,courtyard=false){if(!store.document||!issue.buildingId)return;const shape=buildingShapes(store.document).find(s=>s.id===issue.buildingId);if(!shape)return;store.selectOsmElement({type:"way",id:shape.outerWay});store.workspaceMode="edit";store.focusRequest++;if(courtyard){store.view="2d";store.courtyardOwner=shape.outerWay;store.draft=[];store.tool="courtyard";store.inspectorOpen=false;}else{store.tool="move";store.view="2d";}}

const open = ref(true);
const filter = ref("all");
const mapOpen = ref(false);
const showAll = ref(false);
const issueList = computed(() => store.graphIssues);
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
        {{ store.connectivity?.components.length || 0 }} частей</strong
      ><span
        >С учётом направлений:
        {{ store.connectivity?.directedComponents || 0 }} групп</span
      >
    </div>
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
          <option value="invalid-restriction">
            Неполные ограничения поворотов
          </option>
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
          <div v-if="issue.code === 'road-building-overlap' && issue.buildingId" class="conflict-solutions">
            <strong>Что находится здесь в реальности?</strong>
            <button @click="proposePassage(issue)">Проезд через арку</button><button @click="fixBuilding(issue,true)">Открытый двор внутри здания</button><button @click="fixBuilding(issue)">Контур здания нарисован неверно</button>
            <p>Выберите решение только после сверки с картой или местностью. Для арки сохраняются габариты, для двора вырезается внутренний контур.</p>
            <form v-if="store.passageProposal?.wayId===issue.id && store.passageProposal?.buildingId===issue.buildingId" @submit.prevent="makePassage">
              <label>Ширина проезда, м<input v-model.number="passageWidth" type="number" min="2" max="30" step="0.1" required /></label>
              <label>Высота арки, м<input v-model.number="passageHeight" type="number" min="2.2" max="15" step="0.1" required /></label>
              <button class="primary">Выделить участок арки</button><button type="button" @click="store.passageProposal=null">Отмена</button>
            </form>
          </div>
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
