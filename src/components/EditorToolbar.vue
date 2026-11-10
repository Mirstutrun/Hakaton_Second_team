<script setup lang="ts">
import { computed, ref } from "vue";
import TrafficDock from "./TrafficDock.vue";
import AppIcon from "./AppIcon.vue";
import { tagsOf } from "../core/osm/model";
import { useEditorStore } from "../stores/editor";
import { editorTools, type EditorTool } from "../editor/tools";

const store = useEditorStore();
const search = ref("");
const normalize = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");
// Поиск только по названию улицы: одна запись на название.
const matches = computed(() => {
  store.revision;
  const query = normalize(search.value);
  if (query.length < 2 || !store.document) return [];
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const [id, way] of store.document.ways) {
    const tags = tagsOf(way);
    if (!tags.highway || !tags.name || !normalize(tags.name).includes(query)) continue;
    if (seen.has(tags.name)) continue;
    seen.add(tags.name);
    result.push({ id, name: tags.name });
    if (result.length === 8) break;
  }
  return result;
});
function pickResult(id: string) {
  store.selectOsmElement({ type: "way", id });
  store.focusRequest++;
  store.error = "";
  search.value = "";
}
const groups = computed<{ title: string; tools: EditorTool[] }[]>(() =>
  store.workspaceMode === "traffic"
    ? [{ title: "Транспорт на карте", tools: ["car", "bus-stop", "bus-route"] }]
    : [
        { title: "Выбрать", tools: ["select", "lane"] },
        { title: "Изменить сеть", tools: ["draw", "move", "insert"] },
      ],
);
function choose(id: EditorTool) {
  store.toolsOpen = false;
  store.tool = id;
  store.draft = [];
  store.laneLinkSource = null;
  if (id === "lane" && store.selection?.type === "way")
    store.selectedLane = store.selectedLane ?? 0;
}
function find() {
  if (!search.value.trim()) return;
  if (matches.value.length) pickResult(matches.value[0].id);
  else store.error = "Улица с таким названием не найдена";
}
</script>

<template>
  <aside class="tools-panel">
    <div class="tools-intro">
      <div class="section-label">РАБОЧИЕ ИНСТРУМЕНТЫ</div>
      <h2>
        {{ store.workspaceMode === "traffic" ? "Транспорт" : "Инструменты" }}
      </h2>
      <p>
        {{
          store.workspaceMode === "traffic"
            ? "Машины — предпросмотр. Остановки и маршруты сохраняются в OSM."
            : "Выберите действие. Подсказка появится над картой."
        }}
      </p>
    </div>
    <section v-for="group in groups" :key="group.title" class="tool-group">
      <div class="section-label">{{ group.title }}</div>
      <button
        v-for="id in group.tools"
        :key="id"
        :class="['tool', { active: store.tool === id }]"
        :disabled="!store.document"
        :title="editorTools.find((tool) => tool.id === id)?.hint"
        @click="choose(id)"
      >
        <span class="tool-icon"><AppIcon :name="id" /></span>
        <span>{{ editorTools.find((tool) => tool.id === id)?.name }}</span>
        <kbd>{{ editorTools.find((tool) => tool.id === id)?.key }}</kbd>
      </button>
    </section>
    <section class="tool-group">
      <div class="section-label">Проверка</div>
      <button
        :class="['tool', { active: store.reviewOpen }]"
        :disabled="!store.document"
        :aria-pressed="store.reviewOpen"
        :aria-label="`Проверка сети, проблем: ${store.problems.length}`"
        title="Показать список ошибок дорожной сети и кнопки их исправления"
        @click="store.toggleReview()"
      >
        <span class="tool-icon"><AppIcon name="review" /></span>
        <span>Проверка сети</span>
        <span :class="['tool-count', { clean: !store.problems.length }]">{{
          store.problems.length
        }}</span>
      </button>
    </section>
    <TrafficDock v-if="store.workspaceMode === 'traffic'" />
    <section class="find-section">
      <div class="section-label">НАЙТИ НА КАРТЕ</div>
      <form class="search" @submit.prevent="find">
        <input
          v-model="search"
          aria-label="Название улицы"
          placeholder="Название улицы"
        />
        <button type="submit" aria-label="Найти улицу">
          <AppIcon name="search" />
        </button>
      </form>
      <div
        v-if="matches.length"
        class="search-results"
        aria-label="Найденные улицы"
      >
        <button
          v-for="result in matches"
          :key="result.id"
          @click="pickResult(result.id)"
        >
          <strong>{{ result.name }}</strong>
        </button>
      </div>
    </section>
    <details class="layer-settings">
      <summary>Показать слои карты</summary>
      <label class="toggle"
        ><span>Здания</span>
        <input v-model="store.buildings" type="checkbox" />
      </label>
      <label class="toggle"
        ><span>Дорожная разметка</span>
        <input v-model="store.markings" type="checkbox" />
      </label>
      <label class="toggle"
        ><span>Пешеходные дорожки</span>
        <input v-model="store.pedestrians" type="checkbox" />
      </label>
    </details>
  </aside>
</template>
