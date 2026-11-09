<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  select: "M5 3l14 9-7 1-3 7z",
  draw: "M4 18l5-12 6 12 5-12M4 18h.01M9 6h.01M15 18h.01M20 6h.01",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  insert: "M12 7v10M7 12h10M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  signal: "M8 2h8v16H8zM12 18v4M11 6h2M11 10h2M11 14h2",
  import: "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5",
  export: "M5 19L19 5M8 5h11v11",
  search: "M14 14l6 6M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
};
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]"></path>
  </svg>
</template>
