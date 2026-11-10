<script setup lang="ts">
import { computed, ref } from "vue";
import TrafficDock from "./TrafficDock.vue";
import AppIcon from "./AppIcon.vue";
import { tagsOf } from "../core/osm/model";
import { useEditorStore } from "../stores/editor";
import { editorTools, type EditorTool } from "../editor/tools";

const store = useEditorStore();
const search = ref("");
const matches = computed(() => {
  store.revision;
  const query = search.value
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е");
  if (
    query.length < 2 ||
    !store.document ||
    /^(way|node)[/:]/i.test(query) ||
    /^-?\d+$/.test(query)
  )
    return [];
  return Array.from(store.document.ways, ([id, way]) => ({
    id,
    tags: tagsOf(way),
  }))
    .filter(
      ({ tags }) =>
        tags.highway &&
        tags.name?.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(query),
    )
    .slice(0, 8);
});
function pickResult(id: string) {
  store.selectOsmElement({ type: "way", id });
  store.focusRequest++;
  store.error = "";
  search.value = "";
}
const groups = computed<{ title: string; tools: EditorTool[] }[]>(() =>
  store.workspaceMode === "traffic"
    ? [
        {
          title: "Транспорт на карте",
          tools: ["select", "car", "bus-stop", "bus-route"],
        },
      ]
    : store.workspaceMode === "review"
      ? [{ title: "Исправить на карте", tools: ["select", "join", "move"] }]
      : [
          { title: "Выбрать", tools: ["select", "lane"] },
          {
            title: "Изменить сеть",
            tools: ["draw", "join", "move", "insert", "signal"],
          },
        ],
);
function choose(id: EditorTool) {
  store.tool = id;
  store.draft = [];
  store.joinSource = null;
  if (id === "lane" && store.selection?.type === "way")
    store.selectedLane = store.selectedLane ?? 0;
}
function find() {
  const raw = search.value.trim();
  if (!raw) return;
  if (matches.value.length) {
    if (matches.value.length === 1) pickResult(matches.value[0].id);
    return;
  }
  const id = raw.replace(/^(way|node)[/:]/i, "");
  const type = raw.toLowerCase().startsWith("node")
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
  } else store.error = `Объект № ${id} не найден`;
}
</script>

<template>
  <aside class="tools-panel">
    <div class="tools-intro">
      <div class="section-label">РАБОЧИЕ ИНСТРУМЕНТЫ</div>
      <h2>
        {{
          store.workspaceMode === "traffic"
            ? "Транспорт"
            : store.workspaceMode === "review"
              ? "Контроль качества"
              : "Инструменты"
        }}
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
    <TrafficDock v-if="store.workspaceMode === 'traffic'" />
    <section class="find-section">
      <div class="section-label">НАЙТИ НА КАРТЕ</div>
      <form class="search" @submit.prevent="find">
        <input
          v-model="search"
          aria-label="OSM ID"
          placeholder="Название улицы или OSM ID"
        />
        <button type="submit" aria-label="Найти объект">
          <AppIcon name="search" />
        </button>
      </form>
      <div
        v-if="matches.length"
        class="search-results"
        aria-label="Найденные дороги"
      >
        <button
          v-for="result in matches"
          :key="result.id"
          @click="pickResult(result.id)"
        >
          <strong>{{ result.tags.name }}</strong
          ><small>Дорога № {{ result.id }}</small>
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
    <div class="project-card">
      <span class="section-label">НА КАРТЕ</span>
      <strong
        >{{ store.stats.roads.toLocaleString("ru") }}
        <small>дорог</small></strong
      >
      <div>
        {{ store.stats.nodes.toLocaleString("ru") }} узлов ·
        {{ store.stats.signals }} светофоров · {{ store.stats.stops }} остановок
      </div>
    </div>
  </aside>
</template>
