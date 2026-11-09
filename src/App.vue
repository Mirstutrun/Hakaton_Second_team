<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AppIcon from "./components/AppIcon.vue";
import EditorToolbar from "./components/EditorToolbar.vue";
import MapViewport from "./components/MapViewport.vue";
import PropertiesPanel from "./components/PropertiesPanel.vue";
import { useEditorStore } from "./stores/editor";
import { editorTools } from "./editor/tools";

const store = useEditorStore();
const input = ref<HTMLInputElement>();
const hint = computed(
  () => editorTools.find((tool) => tool.id === store.tool)?.hint,
);
function mayReplace() {
  return (
    !store.dirty || window.confirm("Есть несохранённые правки. Заменить карту?")
  );
}
async function loadExample() {
  if (!mayReplace()) return;
  store.loading = true;
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}example.osm`);
    if (!response.ok) throw new Error("Пример карты недоступен");
    store.load(await response.text(), "example.osm");
  } catch (error) {
    store.error = (error as Error).message;
  } finally {
    store.loading = false;
  }
}
async function importFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !mayReplace()) {
    target.value = "";
    return;
  }
  store.loading = true;
  try {
    store.load(await file.text(), file.name);
  } catch (error) {
    store.error = (error as Error).message;
  } finally {
    store.loading = false;
    target.value = "";
  }
}
function keyboard(event: KeyboardEvent) {
  if (
    (event.target as HTMLElement).closest(
      "input,select,textarea,[contenteditable]",
    )
  )
    return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
    }
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      store.exportOsm();
    }
    return;
  }
  if (event.key === "Escape") {
    store.draft = [];
    store.tool = "select";
  }
  if (event.key === "Enter" && store.tool === "draw") store.finishRoad();
  if (event.key.toLowerCase() === "f") store.focusRequest++;
  const tool = editorTools.find(
    (tool) => tool.key.toLowerCase() === event.key.toLowerCase(),
  );
  if (tool) {
    store.tool = tool.id;
    store.draft = [];
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (store.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => {
  window.addEventListener("keydown", keyboard);
  window.addEventListener("beforeunload", beforeUnload);
  void loadExample();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", keyboard);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="RoadForge"
        ><span class="brand-mark">R</span
        ><span
          >roadforge<span class="brand-3d">3D</span
          ><small>ДОРОЖНАЯ СЕТЬ. ПОД ВАШИМ КОНТРОЛЕМ.</small></span
        ></a
      >
      <div class="document-name">
        <span class="file-icon">◇</span>{{ store.fileName
        }}<span :class="['save-status', { dirty: store.dirty }]">{{
          store.dirty ? "Есть изменения" : "Без изменений"
        }}</span>
      </div>
      <div class="top-actions">
        <button
          title="Отменить · Ctrl+Z"
          aria-label="Отменить"
          :disabled="!store.canUndo"
          @click="store.undo()"
        >
          ↶</button
        ><button
          title="Повторить · Ctrl+Shift+Z"
          aria-label="Повторить"
          :disabled="!store.canRedo"
          @click="store.redo()"
        >
          ↷</button
        ><span class="action-divider"></span
        ><button @click="loadExample">Пример</button
        ><button @click="input?.click()">
          <AppIcon name="import" /> Импорт</button
        ><button
          class="primary"
          :disabled="!store.document"
          @click="store.exportOsm()"
        >
          Экспорт OSM <AppIcon name="export" /></button
        ><input
          ref="input"
          data-testid="file-input"
          type="file"
          accept=".osm,.xml"
          hidden
          @change="importFile"
        />
      </div>
    </header>
    <div class="workspace">
      <EditorToolbar /><MapViewport /><PropertiesPanel />
    </div>
    <div v-if="store.error" class="error-toast" role="alert">
      <span>{{ store.error }}</span
      ><button aria-label="Закрыть ошибку" @click="store.error = ''">×</button>
    </div>
    <footer>
      <span class="status-mode"
        ><span class="live-dot"></span
        >{{ editorTools.find((tool) => tool.id === store.tool)?.name }}</span
      ><span class="footer-hint">{{ hint }}</span
      ><span class="footer-state" role="status">{{ store.message }}</span>
    </footer>
  </div>
</template>
