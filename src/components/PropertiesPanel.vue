<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { coordinateOf, refsOf, tagsOf } from "../core/osm/model";
import { roadStyle } from "../engine/geometry/roads";
import { useEditorStore } from "../stores/editor";

const store = useEditorStore();
const form = reactive<Record<string, string>>({});
const confirmDelete = ref(false);
const tags = computed(() => {
  store.revision;
  return store.selected ? tagsOf(store.selected) : {};
});
const isRoad = computed(() => store.selection?.type === "way");
const isSignal = computed(() => tags.value.highway === "traffic_signals");
const nodeRefs = computed(() =>
  store.selected && isRoad.value ? refsOf(store.selected) : [],
);
const visualLanes = computed(() => roadStyle(tags.value).lanes);
const laneForm = reactive({ turn: "", change: "", maxspeed: "" });
const laneInfo = computed(() => {
  if (!isRoad.value || store.selectedLane === null || !store.selected) return null;
  const tag = tags.value;
  const count = roadStyle(tag).lanes;
  const lane = store.selectedLane;
  if (lane < 0 || lane >= count || roadStyle(tag).pedestrian) return null;
  const oneway = tag.oneway === "yes" || tag.oneway === "-1" ||
    tag.junction === "roundabout";
  const backwards = tag.oneway === "-1";
  if (oneway) {
    return { index: backwards ? count - lane - 1 : lane, count,
      suffix: backwards ? ":backward" : "",
      direction: backwards ? "Против направления way" : "По направлению way" };
  }
  const backwardCount = Math.max(1, Number(tag["lanes:backward"]) ||
    Math.floor(count / 2));
  const backward = lane < backwardCount;
  return backward
    ? { index: backwardCount - lane - 1, count: backwardCount,
        suffix: ":backward", direction: "Обратное направление" }
    : { index: lane - backwardCount, count: Math.max(1, count - backwardCount),
        suffix: ":forward", direction: "Прямое направление" };
});
function laneTagKey(kind: string): string {
  return `${kind}:lanes${laneInfo.value?.suffix || ""}`;
}
function laneValue(kind: string): string {
  const info = laneInfo.value;
  if (!info) return "";
  return (tags.value[laneTagKey(kind)] ?? "").split("|")[info.index] ?? "";
}
watch(() => [store.selectedLane, store.selection, store.revision], () => {
  laneForm.turn = laneValue("turn");
  laneForm.change = laneValue("change");
  laneForm.maxspeed = laneValue("maxspeed");
}, { immediate: true, deep: true });
function applyLane() {
  const info = laneInfo.value;
  if (!info || !store.selection) return;
  const updates: Record<string, string | null> = {};
  for (const field of ["turn", "change", "maxspeed"] as const) {
    if (laneForm[field] === laneValue(field)) continue;
    const key = laneTagKey(field);
    const values = (tags.value[key] ?? "").split("|");
    while (values.length < info.count) values.push("");
    values[info.index] = laneForm[field].trim();
    const next = values.join("|");
    updates[key] = values.every((value) => value === "") ? null : next;
  }
  if (Object.keys(updates).length) store.execute({
    type: "set-tags", target: store.selection, tags: updates,
  });
}
const extraKey = ref("");
const extraValue = ref("");
function putCustomTag() {
  if (!store.selection) return;
  const key = extraKey.value.trim();
  if (!key || !/^[a-zA-Z0-9_:.-]+$/.test(key)) {
    store.error = "Введите допустимый ключ OSM-тега без пробелов";
    return;
  }
  if (store.execute({ type: "set-tags", target: store.selection,
    tags: { [key]: extraValue.value || null } })) {
    extraKey.value = "";
    extraValue.value = "";
  }
}
function deleteCustomTag(key: string) {
  if (!store.selection) return;
  store.execute({ type: "set-tags", target: store.selection, tags: { [key]: null } });
}
const fields = [
  "name",
  "highway",
  "width",
  "surface",
  "access",
  "junction",
  "tunnel",
  "sidewalk",
  "cycleway",
  "turn:lanes",
  "lanes",
  "lanes:forward",
  "lanes:backward",
  "oneway",
  "maxspeed",
  "bridge",
  "layer",
  "traffic_signals:direction",
];
watch(
  () => [store.selection, store.revision],
  () => {
    for (const key of fields) form[key] = tags.value[key] ?? "";
    confirmDelete.value = false;
  },
  { immediate: true, deep: true },
);
function apply() {
  if (!store.selection) return;
  const updates = Object.fromEntries(
    fields
      .filter((key) => form[key] !== (tags.value[key] ?? ""))
      .map((key) => [key, form[key] || null]),
  );
  if (Object.keys(updates).length)
    store.execute({ type: "set-tags", target: store.selection, tags: updates });
}
function remove() {
  if (!store.selection) return;
  const patch = store.execute(
    isRoad.value
      ? { type: "delete-way", id: store.selection.id }
      : { type: "remove-signal", id: store.selection.id },
  );
  if (patch) store.selectOsmElement(null);
  confirmDelete.value = false;
}
function removeVertex() {
  if (!store.selection || !store.selectedVertex) return;
  if (
    store.execute({
      type: "remove-vertex",
      wayId: store.selection.id,
      index: nodeRefs.value.indexOf(store.selectedVertex),
    })
  )
    store.selectedVertex = null;
}
</script>

<template>
  <aside class="properties-panel">
    <div class="inspector-heading">
      <span class="section-label">ИНСПЕКТОР</span><span class="tag">OSM</span>
    </div>
    <template v-if="store.selected">
      <h2>
        {{
          isRoad
            ? tags.name || "Дорога без названия"
            : isSignal
              ? "Светофор"
              : "Узел сети"
        }}
      </h2>
      <div class="object-id">
        {{ store.selection?.type }} / {{ store.selection?.id }}
      </div>
      <form class="properties-form" @submit.prevent="apply">
        <template v-if="isRoad">
          <label
            >Название<input
              v-model="form.name"
              aria-label="Название дороги"
              placeholder="Без названия"
          /></label>
          <label
            >Класс дороги<select
              v-model="form.highway"
              aria-label="Класс дороги"
            >
              <option
                v-if="
                  form.highway &&
                  ![
                    'motorway',
                    'trunk',
                    'primary',
                    'secondary',
                    'tertiary',
                    'residential',
                    'unclassified',
                    'service',
                    'living_street',
                    'footway',
                    'path',
                    'cycleway',
                    'steps',
                    'pedestrian',
                  ].includes(form.highway)
                "
                :value="form.highway"
              >
                {{ form.highway }}
              </option>
              <option
                v-for="value in [
                  'motorway',
                  'trunk',
                  'primary',
                  'secondary',
                  'tertiary',
                  'residential',
                  'unclassified',
                  'service',
                  'living_street',
                  'footway',
                  'path',
                  'cycleway',
                  'steps',
                  'pedestrian',
                ]"
                :key="value"
              >
                {{ value }}
              </option>
            </select></label
          >
          <div class="field-row">
            <label
              >Полосы<input
                v-model="form.lanes"
                aria-label="Полосы"
                type="number"
                min="1"
                max="20"
                :placeholder="String(visualLanes)" /></label
            ><label
              >Скорость, км/ч<input
                v-model="form.maxspeed"
                aria-label="Скорость"
                placeholder="Не указана"
            /></label>
          </div>
          <div class="field-row">
            <label>Ширина, м<input v-model="form.width" aria-label="Ширина дороги" placeholder="Напр. 7.2"/></label>
            <label>Покрытие<input v-model="form.surface" aria-label="Покрытие" placeholder="asphalt / gravel"/></label>
          </div>
          <div class="field-row">
            <label>Доступ<input v-model="form.access" aria-label="Доступ" placeholder="yes / private / no"/></label>
            <label>Тип перекрёстка<input v-model="form.junction" aria-label="Тип перекрёстка" placeholder="roundabout"/></label>
          </div>
          <div class="field-row">
            <label>Тоннель<input v-model="form.tunnel" aria-label="Тоннель" placeholder="yes / no"/></label>
            <label>Тротуар<input v-model="form.sidewalk" aria-label="Тротуар" placeholder="both / left / right"/></label>
          </div>
          <div class="field-row">
            <label>Велодорожка<input v-model="form.cycleway" aria-label="Велодорожка" placeholder="lane / track"/></label>
            <label>Полосы поворотов<input v-model="form['turn:lanes']" aria-label="Повороты по полосам" placeholder="left|through|right"/></label>
          </div>
          <p v-if="tags.width" class="field-hint">
            Ширина задана тегом width={{ tags.width }} м и имеет приоритет над
            числом полос.
          </p>
          <p v-if="!tags.lanes" class="field-hint">
            На сцене {{ visualLanes }} полосы по умолчанию. Тег в OSM не
            добавлен.
          </p>
          <div class="field-row">
            <label
              >Вперёд<input
                v-model="form['lanes:forward']"
                aria-label="Полосы вперёд"
                type="number"
                min="1"
                max="20"
                placeholder="—" /></label
            ><label
              >Назад<input
                v-model="form['lanes:backward']"
                aria-label="Полосы назад"
                type="number"
                min="1"
                max="20"
                placeholder="—"
            /></label>
          </div>
          <label
            >Направление<select v-model="form.oneway" aria-label="Направление">
              <option value="">Не задано</option>
              <option value="no">Двустороннее</option>
              <option value="yes">По ходу way →</option>
              <option value="-1">Против хода way ←</option>
              <option value="reversible">Реверсивное</option>
              <option value="alternating">Попеременное</option>
            </select></label
          >
          <div class="field-row">
            <label
              >Мост<input
                v-model="form.bridge"
                aria-label="Мост"
                placeholder="yes / no" /></label
            ><label
              >Уровень<input
                v-model="form.layer"
                aria-label="Уровень"
                type="number"
                placeholder="0"
            /></label>
          </div>
          <p class="field-hint">
            Атрибуты применяются ко всему way. Разделение на участки — следующий
            этап.
          </p>
        </template>
        <template v-else>
          <label v-if="isSignal"
            >Направление светофора<select
              v-model="form['traffic_signals:direction']"
              aria-label="Направление светофора"
            >
              <option value="">Не задано</option>
              <option value="forward">Вперёд</option>
              <option value="backward">Назад</option>
            </select></label
          >
          <div class="coordinate-card">
            {{ coordinateOf(store.selected).lat.toFixed(7) }}° N<br />{{
              coordinateOf(store.selected).lon.toFixed(7)
            }}° E
          </div>
          <p class="field-hint">
            Для переноса включите «Геометрия» и перетащите маркер. Если узел
            общий, изменятся все связанные дороги.
          </p>
        </template>
        <button
          v-if="isRoad || isSignal"
          class="primary full-width"
          type="submit"
        >
          Применить изменения
        </button>
      </form>
      <template v-if="isRoad">
        <div class="divider"></div>
        <div class="section-label">ВЫБОР ПОЛОСЫ</div>
        <p class="field-hint">Нажмите на полосу на карте или выберите ниже.</p>
        <div class="lane-picker">
          <button v-for="i in visualLanes" :key="i"
            :class="{ 'lane-active': store.selectedLane === i - 1 }"
            @click="store.selectedLane = i - 1">
            {{ i }}
          </button>
        </div>
        <form v-if="laneInfo" class="lane-settings" @submit.prevent="applyLane">
          <p class="field-hint">Полоса {{ store.selectedLane! + 1 }} · {{ laneInfo.direction }}</p>
          <label>Разрешённые повороты
            <select v-model="laneForm.turn" aria-label="Повороты выбранной полосы">
              <option value="">Не указано</option>
              <option value="left">Налево</option>
              <option value="through">Прямо</option>
              <option value="right">Направо</option>
              <option value="left;through">Налево / прямо</option>
              <option value="through;right">Прямо / направо</option>
              <option value="reverse">Разворот</option>
              <option value="none">Без поворотов</option>
            </select>
          </label>
          <label>Перестроение
            <select v-model="laneForm.change" aria-label="Перестроение с полосы">
              <option value="">Не указано</option>
              <option value="yes">Разрешено</option>
              <option value="no">Запрещено</option>
              <option value="not_left">Нельзя влево</option>
              <option value="not_right">Нельзя вправо</option>
              <option value="only_left">Только влево</option>
              <option value="only_right">Только вправо</option>
            </select>
          </label>
          <label>Ограничение скорости полосы (км/ч)
            <input v-model="laneForm.maxspeed" aria-label="Скорость выбранной полосы"
              placeholder="Например, 40" />
          </label>
          <button class="primary full-width">Сохранить полосу</button>
        </form>
        <div class="divider"></div>
        <div class="section-label">
          ГЕОМЕТРИЯ · {{ nodeRefs.length }} ВЕРШИН
        </div>
        <label class="vertex-label"
          >Активный узел<select
            v-model="store.selectedVertex"
            aria-label="Активный узел"
          >
            <option :value="null">Выберите на сцене</option>
            <option v-for="(id, index) in nodeRefs" :key="index" :value="id">
              {{ index + 1 }} · {{ id }}
            </option>
          </select></label
        >
        <button
          class="full-width"
          :disabled="!store.selectedVertex"
          @click="removeVertex"
        >
          Удалить вершину из дороги
        </button>
      </template>
      <div v-if="isRoad || isSignal" class="delete-section">
        <button
          v-if="!confirmDelete"
          class="danger full-width"
          @click="confirmDelete = true"
        >
          {{ isRoad ? "Удалить дорогу" : "Удалить светофор" }}
        </button>
        <div v-else class="confirm-delete">
          <p>
            {{
              isRoad
                ? "Удалить выбранный way? Общие узлы останутся."
                : "Убрать светофор? Узел дороги останется."
            }}
          </p>
          <button class="danger" @click="remove">Подтвердить удаление</button
          ><button @click="confirmDelete = false">Отмена</button>
        </div>
      </div>
      <details class="advanced-tags">
        <summary>Расширенный редактор OSM-тегов · {{ Object.keys(tags).length }}</summary>
        <p class="field-hint">Любые допустимые ключи OSM. Пустое значение удаляет тег. Оригинальные метаданные и отношения сохраняются.</p>
        <div class="advanced-tag-entry">
          <input v-model="extraKey" aria-label="Ключ OSM-тега" placeholder="ключ (например, maxheight)" />
          <input v-model="extraValue" aria-label="Значение OSM-тега" placeholder="значение" />
          <button type="button" @click="putCustomTag">Сохранить</button>
        </div>
        <div v-for="(value, key) in tags" :key="key" class="advanced-tag-row">
          <code>{{ key }}</code>
          <span>{{ value }}</span>
          <button type="button" :aria-label="'Изменить тег ' + key"
            @click="extraKey = String(key); extraValue = String(value)">✎</button>
          <button type="button" :aria-label="'Удалить тег ' + key"
            @click="deleteCustomTag(String(key))">×</button>
        </div>
      </details>
    </template>
    <div v-else class="empty-inspector">
      <div class="empty-icon">⌖</div>
      <h2>Всё начинается<br />с одной дороги</h2>
      <p>
        Выберите объект на карте,<br />чтобы изменить его свойства<br />и
        геометрию.
      </p>
      <span class="key-hint"><kbd>V</kbd> Выбор объекта</span>
    </div>
    <div class="validation">
      <div class="section-label">ПРОВЕРКА ДОКУМЕНТА</div>
      <div v-if="store.document" class="validation-state">
        <span class="live-dot"></span
        >{{
          store.issues.some((issue) => issue.severity === "error")
            ? "Есть ошибки"
            : "Ссылки дорог корректны"
        }}
      </div>
      <details v-if="store.issues.length">
        <summary>{{ store.issues.length }} предупреждений / ошибок</summary>
        <p
          v-for="(issue, index) in store.issues.slice(0, 20)"
          :key="index"
          class="field-hint"
        >
          {{ issue.message }}
        </p>
      </details>
      <p class="field-hint">
        Серверная проверка MATSim / SUMO / Webots выполняется отдельно.
      </p>
    </div>
  </aside>
</template>
