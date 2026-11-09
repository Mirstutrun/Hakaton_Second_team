<script setup lang="ts">
import { ref } from "vue";
import AppIcon from "./AppIcon.vue";
import { useEditorStore } from "../stores/editor";
import { editorTools } from "../editor/tools";

const store = useEditorStore();
const search = ref("");
function find() {
  const id = search.value.trim().replace(/^(way|node)[/:]/, "");
  const type = search.value.startsWith("node")
    ? "node"
    : store.document?.ways.has(id)
      ? "way"
      : "node";
  if (
    (type === "way" ? store.document?.ways : store.document?.nodes)?.has(id)
  ) {
    store.selectOsmElement({ type, id });
    store.focusRequest++;
    store.error = "";
  } else store.error = `OSM ID ${id} не найден`;
}
</script>

<template>
  <aside class="tools-panel">
    <div class="section-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
    <h2>Инструменты</h2>
    <div class="section-label tools-label">ИНСТРУМЕНТЫ</div>
    <button
      v-for="tool in editorTools"
      :key="tool.id"
      :class="['tool', { active: store.tool === tool.id }]"
      :disabled="!store.document"
      :title="tool.hint"
      @click="
        store.tool = tool.id;
        store.draft = [];
      "
    >
      <span class="tool-icon"><AppIcon :name="tool.id" /></span
      ><span>{{ tool.name }}</span
      ><kbd>{{ tool.key }}</kbd>
    </button>
    <div class="divider"></div>
    <div class="section-label">НАЙТИ ОБЪЕКТ</div>
    <form class="search" @submit.prevent="find">
      <input
        v-model="search"
        aria-label="OSM ID"
        placeholder="OSM ID или node/ID"
      /><button aria-label="Найти объект"><AppIcon name="search" /></button>
    </form>
    <div class="divider"></div>
    <div class="section-label">СЛОИ КАРТЫ</div>
    <label class="toggle"
      ><span>Объёмы зданий</span
      ><input v-model="store.buildings" type="checkbox"
    /></label>
    <label class="toggle"
      ><span>Дорожная разметка</span
      ><input v-model="store.markings" type="checkbox"
    /></label>
    <label class="toggle"
      ><span>Пешеходная сеть</span
      ><input v-model="store.pedestrians" type="checkbox"
    /></label>
    <div class="project-card">
      <span class="section-label">СЕТЬ В ЦИФРАХ</span
      ><strong
        >{{ store.stats.roads.toLocaleString("ru") }}
        <small>дорог</small></strong
      >
      <div>
        {{ store.stats.nodes.toLocaleString("ru") }} узлов <span>·</span>
        {{ store.stats.signals }} светофора
      </div>
    </div>

  </aside>
</template>
