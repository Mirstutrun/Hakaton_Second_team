<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useEditorStore } from "../stores/editor";
import { buildingOwner } from "../core/osm/buildingShapes";
import { tagsOf } from "../core/osm/model";

// Редактор занимается дорогами: здание можно только удалить (например, если его
// контур в данных неверен и перекрывает дорогу).
const store = useEditorStore();
const confirmDelete = ref(false);
const tags = computed(() => {
  store.revision;
  if (store.selection?.type !== "way" || !store.document) return {};
  const owner = buildingOwner(store.document, store.selection.id);
  return owner.element ? tagsOf(owner.element) : {};
});
const height = computed(
  () =>
    Number.parseFloat(tags.value.height) ||
    Number(tags.value["building:levels"]) * 3.2 ||
    0,
);
const address = computed(() =>
  [tags.value["addr:street"], tags.value["addr:housenumber"]]
    .filter(Boolean)
    .join(", "),
);
watch(
  () => store.selection,
  () => (confirmDelete.value = false),
);
function remove() {
  if (store.selection?.type !== "way") return;
  if (store.execute({ type: "delete-building", wayId: store.selection.id }))
    store.selectOsmElement(null);
}
</script>

<template>
  <h2>{{ tags.name || "Здание" }}</h2>
  <p class="object-id">Здание № {{ store.selection?.id }}</p>
  <div class="coordinate-card">
    <span v-if="address">{{ address }}<br /></span>
    <span v-if="height">Высота ≈ {{ height.toFixed(1) }} м</span>
    <span v-else>Высота не указана</span>
  </div>
  <p class="field-hint">
    Здания в редакторе не создаются и не изменяются. Здание можно только
    удалить — например, если его контур в данных ошибочно перекрывает дорогу.
  </p>
  <button
    v-if="!confirmDelete"
    class="danger full-width"
    @click="confirmDelete = true"
  >
    Удалить здание
  </button>
  <div v-else class="confirm-delete">
    <p>Удалить здание? Действие можно отменить.</p>
    <button class="danger" @click="remove">Подтвердить удаление</button
    ><button @click="confirmDelete = false">Отмена</button>
  </div>
</template>
