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
import { editorTools, toolInstruction } from "./editor/tools";

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
] as const;
watch(
  () => store.tool,
  (tool) => {
    if (["car", "bus-stop", "bus-route"].includes(tool))
      store.workspaceMode = "traffic";
    else if (tool !== "select") store.workspaceMode = "edit";
  },
);
watch(
  () => store.workspaceMode,
  (mode) => {
    store.trafficRunning = mode === "traffic";
  },
);
function switchMode(mode: "edit" | "traffic") {
  store.tool = "select";
  store.draft = [];
  store.routeDraft = [];
  store.laneLinkSource = null;
  store.selectedLane = null;
  // В «Транспорте» объекты карты не выбираются: инструменты — машины, остановки, маршруты.
  if (mode === "traffic") store.selectOsmElement(null);
  store.workspaceMode = mode;
  store.inspectorOpen = store.reviewOpen;
}
const instruction = computed(() =>
  toolInstruction(store.tool, store.workspaceMode),
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
  if (store.preflightOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      store.preflightOpen = false;
    }
    return;
  }
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
    store.laneLinkSource = null;
    store.tool = "select";
  }
  if (event.key === "Enter" && ["draw", "bridge"].includes(store.tool)) store.finishRoad();
  if (key === "f") store.focusRequest++;
  // J — ручное соединение выбранной дороги/полосы с другой дорогой.
  if (key === "j") {
    if (store.workspaceMode === "edit") store.startLaneLink();
    return;
  }
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
        :class="['issue-toggle', { active: store.reviewOpen }]"
        :aria-pressed="store.reviewOpen"
        @click="store.toggleReview()"
      >
        Проверка · {{ store.problems.length }}
      </button>
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
      <aside v-if="store.reviewOpen" class="review-sidebar">
        <div class="inspector-heading">
          <span class="section-label">ПРОВЕРКА СЕТИ</span
          ><button
            class="clear-selection"
            aria-label="Скрыть панель проверки"
            @click="store.toggleReview()"
          >
            ×
          </button>
        </div>
        <h2>Ошибки дорожной сети</h2>
        <p>
          «Показать» приближает место, кнопка исправления меняет OSM. Каждую
          правку сверяйте с реальной картой.
        </p>
        <QualityDock />
      </aside>
      <PropertiesPanel v-else />
    </div>
    <div
      v-if="store.preflightOpen"
      class="help-backdrop"
      @click.self="store.preflightOpen = false"
    >
      <section
        class="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Проверка перед сохранением"
      >
        <button
          class="close-help"
          aria-label="Закрыть проверку сохранения"
          @click="store.preflightOpen = false"
        >
          ×
        </button>
        <span class="section-label">ПРОВЕРКА ПЕРЕД СОХРАНЕНИЕМ</span>
        <h2>
          {{
            store.canExportChecked
              ? "Проверьте направления проезда"
              : "В графе есть проблемы"
          }}
        </h2>
        <div class="preflight-metrics">
          <span
            ><b>{{ store.preflight.isolated }}</b> отдельных частей сети</span
          ><span
            ><b>{{ store.preflight.conflicts.length }}</b> конфликтов
            геометрии</span
          ><span
            ><b>{{ store.preflight.errors.length }}</b> ошибок файла</span
          >
        </div>
        <p v-if="store.preflight.isolated > 0">
          Дорожная сеть состоит из отдельных частей. Между ними нет общего
          дорожного узла. Соедините нужные участки или сохраните рабочий
          черновик.
        </p>
        <p v-if="store.preflight.clipped > 0">
          Частей сети у границы выгрузки: {{ store.preflight.clipped }}. Они
          продолжаются за краем карты и соединяются с городом там. Это не
          ошибка.
        </p>
        <p v-if="store.preflight.directedComponents > 1">
          С учётом односторонних дорог обнаружено
          {{ store.preflight.directedComponents }} групп взаимной достижимости.
          На границах выгрузки это возможно, но направления нужно проверить.
        </p>
        <ul class="preflight-list">
          <li
            v-for="(issue, index) in [
              ...store.preflight.errors,
              ...store.preflight.conflicts,
            ].slice(0, 8)"
            :key="index"
          >
            {{ issue.message }}
          </li>
        </ul>
        <p>
          Проверка относится к данным OSM. Она не заменяет сверку с реальной
          картой и прогон серверных симуляторов.
        </p>
        <button
          class="primary full-width"
          @click="
            store.preflightOpen = false;
            store.reviewOpen = true;
            store.showGraphIssues = true;
            store.inspectorOpen = true;
          "
        >
          Показать проблемы на карте
        </button>
        <button
          v-if="store.canExportChecked"
          class="full-width"
          @click="store.exportOsm('confirm')"
        >
          Направления проверены — сохранить OSM
        </button>
        <button
          class="full-width"
          :disabled="!!store.preflight.errors.length"
          @click="store.exportOsm('draft')"
        >
          Сохранить рабочий черновик с предупреждениями
        </button>
      </section>
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
              Нажмите на неё. Справа задайте число полос и направление каждой
              полосы и нажмите «Применить изменения». J — соединить выбранную
              полосу с другой дорогой.
            </p>
          </li>
          <li>
            <b>Проверьте результат</b>
            <p>
              Кнопка «Проверка» открывает список ошибок сети: «Показать»
              приближает место, кнопка исправления меняет OSM. В «Транспорте»
              добавьте машины и автобусы.
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
          ><span><kbd>J</kbd> Соединить полосу</span
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
        >{{ instruction.name }}</span
      ><span class="footer-hint">{{ instruction.hint }}</span
      ><span class="footer-state" role="status">{{ store.message }}</span>
    </footer>
  </div>
</template>
