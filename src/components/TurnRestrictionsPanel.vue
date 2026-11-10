<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { refsOf, tagsOf, coordinateOf } from "../core/osm/model";
import {
  restrictionNames,
  turnRestrictions,
} from "../core/osm/turnRestrictions";
import { oneWayDirection } from "../engine/trafficRules";
import { useEditorStore } from "../stores/editor";
const store = useEditorStore();
const via = ref(""),
  approach = ref(""),
  exit = ref(""),
  restriction = ref("no_left_turn");
const selectedWay = computed(() =>
  store.selection?.type === "way" ? store.selection.id : "",
);
const junctions = computed(() => {
  store.revision;
  const doc = store.document,
    way = doc?.ways.get(selectedWay.value);
  if (!doc || !way) return [];
  return [...new Set(refsOf(way))].filter((id) =>
    [...doc.ways].some(
      ([other, w]) =>
        other !== selectedWay.value &&
        tagsOf(w).highway &&
        refsOf(w).includes(id),
    ),
  );
});
function approachName(id: string) {
  const doc = store.document,
    a = doc?.nodes.get(id),
    b = doc?.nodes.get(via.value);
  if (!a || !b) return id;
  const p = coordinateOf(a),
    q = coordinateOf(b),
    dx = (p.lon - q.lon) * Math.cos((q.lat * Math.PI) / 180),
    dz = p.lat - q.lat;
  const direction =
    Math.abs(dx) > Math.abs(dz) * 1.5
      ? dx > 0
        ? "с востока"
        : "с запада"
      : Math.abs(dz) > Math.abs(dx) * 1.5
        ? dz > 0
          ? "с севера"
          : "с юга"
        : dz > 0
          ? dx > 0
            ? "с северо-востока"
            : "с северо-запада"
          : dx > 0
            ? "с юго-востока"
            : "с юго-запада";
  return `${direction} · узел ${id}`;
}
function junctionName(id: string) {
  const names = [
    ...new Set(
      [...store.document!.ways.values()]
        .filter((w) => tagsOf(w).highway && refsOf(w).includes(id))
        .map((w) => tagsOf(w).name)
        .filter(Boolean),
    ),
  ];
  return names.length ? `${names.join(" × ")} · ${id}` : `Перекрёсток ${id}`;
}
function neighbors(wayId: string) {
  const way = store.document?.ways.get(wayId);
  if (!way) return [];
  const refs = refsOf(way),
    at = refs.indexOf(via.value);
  if (at < 0) return [];
  return [
    ...new Set([refs[at - 1], refs[at + 1]].filter((id): id is string => !!id)),
  ];
}
const approaches = computed(() =>
  neighbors(selectedWay.value).filter((id) => {
    const w = store.document!.ways.get(selectedWay.value)!,
      refs = refsOf(w),
      direction = oneWayDirection(tagsOf(w));
    return (
      direction === 0 ||
      (direction === 1 && refs.indexOf(id) < refs.indexOf(via.value)) ||
      (direction === -1 && refs.indexOf(id) > refs.indexOf(via.value))
    );
  }),
);
const exits = computed(() => {
  store.revision;
  const doc = store.document;
  if (!doc || !via.value || !approach.value) return [];
  const origin = coordinateOf(doc.nodes.get(via.value)!),
    a = coordinateOf(doc.nodes.get(approach.value)!);
  const ax = (origin.lon - a.lon) * Math.cos((origin.lat * Math.PI) / 180),
    az = origin.lat - a.lat;
  return [...doc.ways].flatMap(([wayId, w]) => {
    if (!tagsOf(w).highway) return [];
    const refs = refsOf(w),
      direction = oneWayDirection(tagsOf(w));
    return neighbors(wayId)
      .filter(
        (id) =>
          direction === 0 ||
          (direction === 1 && refs.indexOf(id) > refs.indexOf(via.value)) ||
          (direction === -1 && refs.indexOf(id) < refs.indexOf(via.value)),
      )
      .map((node) => {
        const b = coordinateOf(doc.nodes.get(node)!),
          bx = (b.lon - origin.lon) * Math.cos((origin.lat * Math.PI) / 180),
          bz = b.lat - origin.lat;
        const angle =
          (Math.atan2(ax * bz - az * bx, ax * bx + az * bz) * 180) / Math.PI;
        const move =
          Math.abs(angle) > 150
            ? "u_turn"
            : Math.abs(angle) < 35
              ? "straight_on"
              : angle > 0
                ? "left_turn"
                : "right_turn";
        const label =
          move === "u_turn"
            ? "Разворот"
            : move === "straight_on"
              ? "Прямо"
              : move === "left_turn"
                ? "Налево"
                : "Направо";
        return {
          key: JSON.stringify([wayId, node]),
          wayId,
          node,
          move,
          label: `${label} · ${tagsOf(w).name || "дорога " + wayId}`,
        };
      });
  });
});
const eligible = computed(() =>
  exits.value.filter((e) => restriction.value.endsWith(e.move)),
);
const current = computed(() =>
  store.document
    ? turnRestrictions(store.document).filter(
        (r) =>
          r.from.includes(selectedWay.value) ||
          r.to.includes(selectedWay.value),
      )
    : [],
);
watch(
  () => [store.selection, store.revision],
  () => {
    if (!junctions.value.includes(via.value))
      via.value = junctions.value[0] || "";
  },
  { deep: true, immediate: true },
);
watch(
  () => [via.value, selectedWay.value],
  () => {
    approach.value = approaches.value[0] || "";
  },
  { immediate: true },
);
watch(
  eligible,
  () => {
    if (!eligible.value.some((e) => e.key === exit.value))
      exit.value = eligible.value[0]?.key || "";
  },
  { immediate: true },
);
function save() {
  const e = eligible.value.find((e) => e.key === exit.value);
  if (!e) return;
  store.execute({
    type: "set-turn-restriction",
    fromWay: selectedWay.value,
    fromNode: approach.value,
    via: via.value,
    toWay: e.wayId,
    toNode: e.node,
    restriction: restriction.value,
  });
}
function locate() {
  const node = store.document?.nodes.get(via.value);
  if (node) {
    store.focusCoordinate = coordinateOf(node);
    store.focusRequest++;
  }
}
</script>
<template>
  <details class="turn-panel">
    <summary>
      Знаки и запреты поворотов
      <span v-if="current.length">· {{ current.length }}</span>
    </summary>
    <p class="field-hint">
      Выберите перекрёсток, подъезд и выезд. Машины и автобусы будут учитывать
      знак; ограничение сохранится в OSM.
    </p>
    <template v-if="junctions.length">
      <label
        >Перекрёсток<select v-model="via" aria-label="Узел ограничения">
          <option v-for="id in junctions" :key="id" :value="id">
            {{ junctionName(id) }}
          </option>
        </select></label
      >
      <button class="full-width" @click="locate">Показать перекрёсток</button>
      <label
        >Подъезд со стороны<select
          v-model="approach"
          aria-label="Подъезд ограничения"
        >
          <option v-for="id in approaches" :key="id" :value="id">
            {{ approachName(id) }}
          </option>
        </select></label
      >
      <label
        >Дорожный знак<select
          v-model="restriction"
          aria-label="Тип ограничения"
        >
          <option
            v-for="(name, key) in restrictionNames"
            :key="key"
            :value="key"
          >
            {{ name }}
          </option>
        </select></label
      >
      <div
        class="sign-preview"
        :class="{ mandatory: restriction.startsWith('only_') }"
      >
        <span class="sign-symbol">{{
          restriction.includes("u_turn")
            ? "↶"
            : restriction.includes("left")
              ? "↰"
              : restriction.includes("right")
                ? "↱"
                : "↑"
        }}</span
        ><i v-if="restriction.startsWith('no_')"></i>
      </div>
      <label
        >На какую дорогу<select v-model="exit" aria-label="Выезд ограничения">
          <option v-for="e in eligible" :key="e.key" :value="e.key">
            {{ e.label }}
          </option>
        </select></label
      >
      <p v-if="!eligible.length" class="field-hint">
        Для этого знака нет подходящего выезда. Выберите другой подъезд или
        знак.
      </p>
      <button
        class="primary full-width"
        :disabled="!exit || !approach"
        @click="save"
      >
        Установить знак
      </button>
      <p class="field-hint">
        При необходимости дорога разделится в узле перекрёстка. Это действие
        можно отменить.
      </p>
    </template>
    <p v-else class="field-hint">
      У выбранной дороги пока нет общего перекрёстка с другой дорогой. Сначала
      соедините дороги.
    </p>
    <article v-for="rule in current" :key="rule.id" class="restriction-row">
      <span
        >{{
          restrictionNames[rule.tags.restriction] ||
          rule.tags.restriction ||
          "Ограничение"
        }}<small
          >Узел {{ rule.via || "через дорогу" }} · OSM {{ rule.id }}</small
        ></span
      ><button
        @click="store.execute({ type: 'delete-turn-restriction', id: rule.id })"
      >
        Убрать
      </button>
    </article>
  </details>
</template>
