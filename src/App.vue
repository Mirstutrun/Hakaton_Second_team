<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  nextTick,
} from "vue";
import AppIcon from "./components/AppIcon.vue";
import EditorToolbar from "./components/EditorToolbar.vue";
import MapViewport from "./components/MapViewport.vue";
import QualityDock from "./components/QualityDock.vue";
import PropertiesPanel from "./components/PropertiesPanel.vue";
import { useEditorStore } from "./stores/editor";
import { editorTools } from "./editor/tools";

const store = useEditorStore();
const input = ref<HTMLInputElement>();
let helpTrigger: HTMLElement | null = null;
watch(
  () => store.helpOpen,
  async (open) => {
    if (open) {
      helpTrigger = document.activeElement as HTMLElement;
      await nextTick();
      document.querySelector<HTMLButtonElement>(".close-help")?.focus();
    } else helpTrigger?.focus();
  },
);
const modes = [
  {
    id: "edit",
    title: "Редактирование",
    step: "01",
    detail: "Дороги и свойства",
  },
  {
    id: "traffic",
    title: "Транспорт",
    step: "02",
    detail: "Машины и маршруты",
  },
  { id: "review", title: "Проверка", step: "03", detail: "Ошибки и экспорт" },
] as const;
watch(
  () => store.tool,
  (tool) => {
    if (["car", "bus-stop", "bus-route"].includes(tool))
      store.workspaceMode = "traffic";
  },
);
watch(
  () => store.workspaceMode,
  (mode) => {
    store.trafficRunning = mode === "traffic";
  },
);
function switchMode(mode: "edit" | "traffic" | "review") {
  store.tool = "select";
  store.draft = [];
  store.routeDraft = [];
  store.joinSource = null;
  store.selectedLane = null;
  store.workspaceMode = mode;
  store.inspectorOpen = mode === "review";
}
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
  if (store.helpOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      store.helpOpen = false;
    }
    if (event.key === "Tab") {
      const controls = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".help-dialog button"),
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    return;
  }
  if (
    (event.target as HTMLElement).closest(
      "input,select,textarea,[contenteditable]",
    )
  )
    return;
  const key = event.code.startsWith("Key")
    ? event.code.slice(3).toLowerCase()
    : event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z") {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
    }
    if (key === "y") {
      event.preventDefault();
      store.redo();
    }
    if (key === "o") {
      event.preventDefault();
      input.value?.click();
    }
    if (key === "s") {
      event.preventDefault();
      store.exportOsm();
    }
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (store.selectedVehicle) {
      event.preventDefault();
      store.vehicleDeleteRequest++;
    }
    return;
  }
  if (event.key === " " && store.document) {
    event.preventDefault();
    store.trafficRunning = !store.trafficRunning;
    return;
  }
  if (key === "c" && store.document && event.shiftKey) {
    event.preventDefault();
    store.vehicleAddBatchRequest++;
    return;
  }
  if (event.key === "Escape") {
    store.selectedVehicle = null;
    store.selectedLane = null;
    store.draft = [];
    store.routeDraft = [];
    store.joinSource = null;
    store.tool = "select";
  }
  if (event.key === "Enter" && store.tool === "draw") store.finishRoad();
  if (key === "f") store.focusRequest++;
  const tool = editorTools.find((tool) => tool.key.toLowerCase() === key);
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
          >Дороги<span class="brand-3d">Иркутск</span
          ><small>РЕДАКТОР ДОРОЖНОЙ СЕТИ</small></span
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
          <AppIcon name="import" /> Открыть карту</button
        ><button
          class="primary"
          :disabled="!store.document"
          @click="store.exportOsm()"
        >
          Сохранить карту <AppIcon name="export" /></button
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
    <nav class="modebar" aria-label="Режим работы">
      <div class="mode-tabs">
        <button
          v-for="mode in modes"
          :key="mode.id"
          :class="{ active: store.workspaceMode === mode.id }"
          :aria-label="mode.title"
          :aria-pressed="store.workspaceMode === mode.id"
          @click="switchMode(mode.id)"
        >
          <span class="mode-number">{{ mode.step }}</span
          ><span
            >{{ mode.title }}<small>{{ mode.detail }}</small></span
          >
        </button>
      </div>
      <button
        class="help-button"
        @click="store.helpOpen = !store.helpOpen"
        :aria-expanded="store.helpOpen"
      >
        ? Как работать
      </button>
    </nav>
    <div
      :class="[
        'workspace',
        {
          'inspector-open': store.inspectorOpen,
          'tools-open': store.toolsOpen,
        },
      ]"
    >
      <EditorToolbar /><MapViewport />
      <aside v-if="store.workspaceMode === 'review'" class="review-sidebar">
        <span class="section-label">ПЕРЕД СОХРАНЕНИЕМ</span>
        <h2>Проверка сети</h2>
        <p>
          Начните с разрывов и пересечений. Каждую правку сверяйте с реальной
          картой.
        </p>
        <QualityDock />
        <button
          class="primary full-width"
          :disabled="!store.document"
          @click="store.exportOsm()"
        >
          Сохранить проверяемый OSM
        </button>
      </aside>
      <PropertiesPanel v-else />
    </div>
    <div
      v-if="store.helpOpen"
      class="help-backdrop"
      @click.self="store.helpOpen = false"
    >
      <section
        class="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Как работать"
        @keydown.esc="store.helpOpen = false"
      >
        <button
          class="close-help"
          aria-label="Закрыть подсказки"
          @click="store.helpOpen = false"
        >
          ×
        </button>
        <span class="section-label">БЫСТРЫЙ СТАРТ</span>
        <h2>От карты до готового файла</h2>
        <ol class="help-steps">
          <li>
            <b>Откройте карту</b>
            <p>Загрузите свой .osm или начните с примера Иркутска.</p>
          </li>
          <li>
            <b>Выберите дорогу</b>
            <p>
              Нажмите на неё. Справа измените полосы, направление или скорость и
              нажмите «Применить изменения».
            </p>
          </li>
          <li>
            <b>Проверьте результат</b>
            <p>
              В «Транспорте» добавьте машины. В «Проверке» найдите разрывы и
              сохраните отчёт до/после.
            </p>
          </li>
          <li>
            <b>Сохраните OSM</b>
            <p>
              Скачайте карту и отправьте её на сервер организатора для проверки
              в трёх симуляторах.
            </p>
          </li>
        </ol>
        <div class="shortcut-grid">
          <span><kbd>V</kbd> Выбор</span><span><kbd>F</kbd> К объекту</span
          ><span><kbd>Esc</kbd> Отмена инструмента</span
          ><span><kbd>Ctrl Z</kbd> Отменить правку</span>
        </div>
        <p>
          Правая кнопка мыши — перемещение карты. Колесо — масштаб. В 3D левая
          кнопка на свободном месте — поворот.
        </p>
        <button class="primary full-width" @click="store.helpOpen = false">
          Понятно, начать работу
        </button>
      </section>
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
