<script setup lang="ts">
import { ref } from "vue";
import AppIcon from "./AppIcon.vue";
import { useEditorStore } from "../stores/editor";
import { editorTools, type EditorTool } from "../editor/tools";

const store = useEditorStore();
const search = ref("");
const groups: { title: string; tools: EditorTool[] }[] = [
  { title: "Выбор и транспорт", tools: ["select", "lane", "car"] },
  { title: "Редактирование", tools: ["draw", "move", "insert", "signal"] },
];
function choose(id: EditorTool) {
  store.tool = id;
  store.draft = [];
  if (id === "lane" && store.selection?.type === "way")
    store.selectedLane = store.selectedLane ?? 0;
}
function find() {
  const raw = search.value.trim();
  const id = raw.replace(/^(way|node)[/:]/i, "");
  const type = raw.toLowerCase().startsWith("node")
    ? "node"
    : store.document?.ways.has(id) ? "way" : "node";
  if ((type === "way" ? store.document?.ways : store.document?.nodes)?.has(id)) {
    store.selectOsmElement({ type, id });
    store.focusRequest++;
    store.error = "";
  } else store.error = `Объект № ${id} не найден`;
}
</script>

<template>
  <aside class="tools-panel">
    <div class="tools-intro">
      <div class="section-label">РАБОЧИЕ ИНСТРУМЕНТЫ</div>
      <h2>Редактор карты</h2>
      <p>Выберите инструмент и нажмите на дорогу.</p>
    </div>
    <section v-for="group in groups" :key="group.title" class="tool-group">
      <div class="section-label">{{ group.title }}</div>
      <button v-for="id in group.tools" :key="id"
        :class="['tool', { active: store.tool === id }]"
        :disabled="!store.document"
        :title="editorTools.find((tool) => tool.id === id)?.hint"
        @click="choose(id)">
        <span class="tool-icon"><AppIcon :name="id" /></span>
        <span>{{ editorTools.find((tool) => tool.id === id)?.name }}</span>
        <kbd>{{ editorTools.find((tool) => tool.id === id)?.key }}</kbd>
      </button>
    </section>
    <section class="find-section">
      <div class="section-label">НАЙТИ НА КАРТЕ</div>
      <form class="search" @submit.prevent="find">
        <input v-model="search" aria-label="OSM ID"
          placeholder="Номер дороги или узла" />
        <button type="submit" aria-label="Найти объект">
          <AppIcon name="search" />
        </button>
      </form>
    </section>
    <details class="layer-settings">
      <summary>Показать слои карты</summary>
      <label class="toggle"><span>Здания</span>
        <input v-model="store.buildings" type="checkbox" />
      </label>
      <label class="toggle"><span>Дорожная разметка</span>
        <input v-model="store.markings" type="checkbox" />
      </label>
      <label class="toggle"><span>Пешеходные дорожки</span>
        <input v-model="store.pedestrians" type="checkbox" />
      </label>
    </details>
    <div class="project-card">
      <span class="section-label">НА КАРТЕ</span>
      <strong>{{ store.stats.roads.toLocaleString("ru") }} <small>дорог</small></strong>
      <div>{{ store.stats.nodes.toLocaleString("ru") }} узлов ·
        {{ store.stats.signals }} светофоров</div>
    </div>
  </aside>
</template>
