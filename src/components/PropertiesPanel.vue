<script setup lang="ts">
import TurnRestrictionsPanel from "./TurnRestrictionsPanel.vue";
import { computed, reactive, ref, watch } from "vue";
import { coordinateOf, refsOf, tagsOf } from "../core/osm/model";
import { laneTagInfo } from "../engine/trafficRules";
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
const isStop = computed(
  () =>
    tags.value.public_transport === "stop_position" && tags.value.bus === "yes",
);
const nodeRefs = computed(() =>
  store.selected && isRoad.value ? refsOf(store.selected) : [],
);
const visualLanes = computed(() => roadStyle(tags.value).lanes);
const roadLabels: Record<string, string> = {
  motorway: "Автомагистраль",
  trunk: "Скоростная дорога",
  primary: "Главная дорога",
  secondary: "Городская магистраль",
  tertiary: "Районная дорога",
  residential: "Жилая улица",
  unclassified: "Обычная дорога",
  service: "Проезд / парковка",
  living_street: "Жилая зона",
  footway: "Пешеходная дорожка",
  path: "Тропа",
  cycleway: "Велодорожка",
  steps: "Лестница",
  pedestrian: "Пешеходная улица",
};
const laneForm = reactive({ turn: "", change: "", maxspeed: "" });
const laneInfo = computed(() => {
  if (!isRoad.value || store.selectedLane === null || !store.selected)
    return null;
  const tag = tags.value;
  const count = roadStyle(tag).lanes;
  const lane = store.selectedLane;
  if (lane < 0 || lane >= count || roadStyle(tag).pedestrian) return null;
  return laneTagInfo(tag, count, lane, store.drivingSide);
});
function laneTagKey(kind: string): string {
  return `${kind}:lanes${laneInfo.value?.suffix || ""}`;
}
function laneValue(kind: string): string {
  const info = laneInfo.value;
  if (!info) return "";
  return (tags.value[laneTagKey(kind)] ?? "").split("|")[info.index] ?? "";
}
watch(
  () => [
    store.selectedLane,
    store.selection,
    store.revision,
    store.drivingSide,
  ],
  () => {
    laneForm.turn = laneValue("turn");
    laneForm.change = laneValue("change");
    laneForm.maxspeed = laneValue("maxspeed");
  },
  { immediate: true, deep: true },
);
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
  if (Object.keys(updates).length)
    store.execute({
      type: "set-tags",
      target: store.selection,
      tags: updates,
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
  if (
    store.execute({
      type: "set-tags",
      target: store.selection,
      tags: { [key]: extraValue.value || null },
    })
  ) {
    extraKey.value = "";
    extraValue.value = "";
  }
}
function deleteCustomTag(key: string) {
  if (!store.selection) return;
  store.execute({
    type: "set-tags",
    target: store.selection,
    tags: { [key]: null },
  });
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
  () => [store.selection, store.revision, store.drivingSide],
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
      : {
          type: isStop.value ? "remove-bus-stop" : "remove-signal",
          id: store.selection.id,
        },
  );
  if (patch) store.selectOsmElement(null);
  confirmDelete.value = false;
}
function smoothSelectedRoad() {
  if (store.selection?.type !== "way") return;
  if (
    !window.confirm(
      "Сгладить внутренние повороты OSM-дороги? Общие перекрёстки и светофоры сохранятся. Действие можно отменить Ctrl+Z.",
    )
  )
    return;
  store.execute({ type: "smooth-road", wayId: store.selection.id, radius: 8 });
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
      <span class="section-label">СВОЙСТВА ОБЪЕКТА</span
      ><button
        v-if="store.selected"
        class="clear-selection"
        @click="store.selectOsmElement(null)"
        aria-label="Снять выделение"
      >
        ×
      </button>
    </div>
    <template v-if="store.selected">
      <h2>
        {{
          isRoad
            ? tags.name || "Дорога без названия"
            : isSignal
              ? "Светофор"
              : isStop
                ? tags.name || "Автобусная остановка"
                : "Узел сети"
        }}
      </h2>
      <div class="object-id">
        {{ store.selection?.type === "way" ? "Дорога" : "Узел" }} №
        {{ store.selection?.id }}
      </div>
      <details
        v-if="isRoad"
        class="lane-section"
        :open="store.tool === 'lane' || store.selectedLane !== null"
      >
        <summary>Настроить отдельную полосу</summary>
        <div class="section-label">ПОЛОСЫ ДВИЖЕНИЯ</div>
        <p class="field-hint">
          Выберите полосу на карте или нажмите её номер. Повороты и ограничения
          сохраняются отдельно для каждой полосы.
        </p>
        <button
          class="choose-lane-button"
          type="button"
          @click="store.tool = 'lane'"
        >
          Выбрать полосу на карте <kbd>L</kbd>
        </button>
        <div class="lane-picker">
          <button
            v-for="i in visualLanes"
            :key="i"
            type="button"
            :title="'Полоса ' + i"
            :class="{ 'lane-active': store.selectedLane === i - 1 }"
            @click="store.selectedLane = i - 1"
          >
            {{ i }}
          </button>
        </div>
        <form v-if="laneInfo" class="lane-settings" @submit.prevent="applyLane">
          <p class="field-hint">
            Полоса {{ store.selectedLane! + 1 }} · {{ laneInfo.direction }}
          </p>
          <label
            >Разрешённые повороты
            <select
              v-model="laneForm.turn"
              aria-label="Повороты выбранной полосы"
            >
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
          <label
            >Перестроение
            <select
              v-model="laneForm.change"
              aria-label="Перестроение с полосы"
            >
              <option value="">Не указано</option>
              <option value="yes">Разрешено</option>
              <option value="no">Запрещено</option>
              <option value="not_left">Нельзя влево</option>
              <option value="not_right">Нельзя вправо</option>
              <option value="only_left">Только влево</option>
              <option value="only_right">Только вправо</option>
            </select>
          </label>
          <label
            >Ограничение скорости полосы (км/ч)
            <input
              v-model="laneForm.maxspeed"
              aria-label="Скорость выбранной полосы"
              placeholder="Например, 40"
            />
          </label>
          <button class="primary full-width">Применить к полосе</button>
        </form>
      </details>
      <TurnRestrictionsPanel v-if="isRoad" />
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
                :value="value"
              >
                {{ roadLabels[value] ?? value }}
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
                placeholder="Например, 60"
            /></label>
          </div>
          <label
            >Направление движения<select
              v-model="form.oneway"
              aria-label="Направление"
            >
              <option value="">По данным карты</option>
              <option value="no">В обе стороны</option>
              <option value="yes">По стрелке дороги →</option>
              <option value="-1">Против стрелки дороги ←</option>
              <option value="reversible">Реверсивное</option>
              <option value="alternating">Попеременное</option>
            </select></label
          >
          <p class="field-hint">
            Изменения применятся к выделенной дороге целиком.
          </p>
          <details class="road-details">
            <summary>Покрытие, перекрёстки и ограничения</summary>
            <div class="field-row">
              <label
                >Ширина, м<input
                  v-model="form.width"
                  aria-label="Ширина дороги"
                  placeholder="Напр. 7.2"
              /></label>
              <label
                >Покрытие<select v-model="form.surface" aria-label="Покрытие">
                  <option value="">Не указано</option>
                  <option value="asphalt">Асфальт</option>
                  <option value="concrete">Бетон</option>
                  <option value="paving_stones">Плитка</option>
                  <option value="gravel">Щебень</option>
                  <option value="dirt">Грунт</option>
                  <option value="ground">Земля</option>
                  <option value="sand">Песок</option>
                </select></label
              >
            </div>
            <div class="field-row">
              <label
                >Проезд транспорта<select
                  v-model="form.access"
                  aria-label="Доступ"
                >
                  <option value="">Не указано</option>
                  <option value="yes">Разрешён</option>
                  <option value="private">Частный проезд</option>
                  <option value="no">Запрещён</option>
                  <option value="destination">Только к месту назначения</option>
                  <option value="delivery">Только доставка</option>
                </select></label
              >
              <label
                >Тип перекрёстка<select
                  v-model="form.junction"
                  aria-label="Тип перекрёстка"
                >
                  <option value="">Обычный</option>
                  <option value="roundabout">Круговое движение</option>
                  <option value="circular">Круговая развязка</option>
                </select></label
              >
            </div>
            <div class="field-row">
              <label
                >Тоннель<select v-model="form.tunnel" aria-label="Тоннель">
                  <option value="">Не указан</option>
                  <option value="yes">Да</option>
                  <option value="no">Нет</option>
                </select></label
              >
              <label
                >Тротуар<select v-model="form.sidewalk" aria-label="Тротуар">
                  <option value="">Не указано</option>
                  <option value="both">С обеих сторон</option>
                  <option value="left">Слева</option>
                  <option value="right">Справа</option>
                  <option value="no">Нет</option>
                </select></label
              >
            </div>
            <div class="field-row">
              <label
                >Велодорожка<select
                  v-model="form.cycleway"
                  aria-label="Велодорожка"
                >
                  <option value="">Не указано</option>
                  <option value="lane">Полоса на дороге</option>
                  <option value="track">Отдельная дорожка</option>
                  <option value="no">Нет</option>
                </select></label
              >
              <label
                >Полосы поворотов<input
                  v-model="form['turn:lanes']"
                  aria-label="Повороты по полосам"
                  placeholder="Налево / прямо / направо"
              /></label>
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
            <div class="field-row">
              <label
                >Мост<select v-model="form.bridge" aria-label="Мост">
                  <option value="">Не указан</option>
                  <option value="yes">Да</option>
                  <option value="no">Нет</option>
                </select></label
              ><label
                >Уровень<input
                  v-model="form.layer"
                  aria-label="Уровень"
                  type="number"
                  placeholder="0"
              /></label>
            </div>
          </details>
        </template>
        <template v-else>
          <label v-if="isStop"
            >Название остановки
            <input
              v-model="form.name"
              aria-label="Название остановки"
              placeholder="Например, Центральная"
            />
          </label>
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
            Для переноса включите «Переместить узел» и перетащите маркер. Если
            узел общий, изменятся все связанные дороги.
          </p>
        </template>
        <button
          v-if="isRoad || isSignal || isStop"
          class="primary full-width"
          type="submit"
        >
          Применить изменения
        </button>
      </form>
      <details v-if="isRoad" class="geometry-details">
        <summary>Геометрия дороги</summary>
        <div class="divider"></div>
        <div class="section-label">
          ГЕОМЕТРИЯ · {{ nodeRefs.length }} ВЕРШИН
        </div>
        <button class="full-width" @click="smoothSelectedRoad">
          Скруглить повороты (OSM)
        </button>
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
      </details>
      <div v-if="isRoad || isSignal || isStop" class="delete-section">
        <button
          v-if="!confirmDelete"
          class="danger full-width"
          @click="confirmDelete = true"
        >
          {{
            isRoad
              ? "Удалить дорогу"
              : isStop
                ? "Убрать остановку"
                : "Удалить светофор"
          }}
        </button>
        <div v-else class="confirm-delete">
          <p>
            {{
              isRoad
                ? "Удалить эту дорогу? Общие узлы останутся на карте."
                : isStop
                  ? "Убрать остановку? Узел дороги останется."
                  : "Убрать светофор? Узел дороги останется."
            }}
          </p>
          <button class="danger" @click="remove">Подтвердить удаление</button
          ><button @click="confirmDelete = false">Отмена</button>
        </div>
      </div>
      <details class="advanced-tags">
        <summary>
          Дополнительные свойства дороги · {{ Object.keys(tags).length }}
        </summary>
        <p class="field-hint">
          Для опытных пользователей. Можно изменять дополнительные свойства
          карты.
        </p>
        <div class="advanced-tag-entry">
          <input
            v-model="extraKey"
            aria-label="Ключ OSM-тега"
            placeholder="ключ (например, maxheight)"
          />
          <input
            v-model="extraValue"
            aria-label="Значение OSM-тега"
            placeholder="значение"
          />
          <button type="button" @click="putCustomTag">Сохранить</button>
        </div>
        <div v-for="(value, key) in tags" :key="key" class="advanced-tag-row">
          <code>{{ key }}</code>
          <span>{{ value }}</span>
          <button
            type="button"
            :aria-label="'Изменить тег ' + key"
            @click="
              extraKey = String(key);
              extraValue = String(value);
            "
          >
            ✎
          </button>
          <button
            type="button"
            :aria-label="'Удалить тег ' + key"
            @click="deleteCustomTag(String(key))"
          >
            ×
          </button>
        </div>
      </details>
    </template>
    <div v-else class="empty-inspector">
      <div class="empty-icon">⌖</div>
      <h2>Выберите дорогу на карте</h2>
      <p>Её полосы, скорость и направление появятся здесь.</p>
      <ol class="inspector-steps">
        <li>Нажмите на дорогу</li>
        <li>Измените нужное поле</li>
        <li>Нажмите «Применить изменения»</li>
      </ol>
      <button class="full-width" @click="store.helpOpen = true">
        Показать быстрый старт
      </button>
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
    </div>
  </aside>
</template>
