<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  building:"M4 21V4h16v17M2 21h20M8 8h2m4 0h2M8 12h2m4 0h2M10 21v-5h4v5",
  courtyard:"M3 3h18v18H3zM8 8h8v8H8z",
  block:"M4 8l8-5 8 5v10l-8 4-8-4zM4 8l8 5 8-5M12 13v9",
  select: "M5 3l14 9-7 1-3 7z",
  lane: "M3 19L8 4M21 19L16 4M12 6v3m0 4v3m0 3v1",
  car: "M5 16H3v-5l2-2 2-5h10l2 5 2 2v5h-2M5 16h14M5 16v3m14-3v3M5 9h14M7 13h2m6 0h2",
  draw: "M4 18l5-12 6 12 5-12M4 18h.01M9 6h.01M15 18h.01M20 6h.01",
  join: "M4 4v7h8M20 20v-7h-8M12 11l4-4M12 13l-4 4",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  insert: "M12 7v10M7 12h10M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  signal: "M8 2h8v16H8zM12 18v4M11 6h2M11 10h2M11 14h2",
  "bus-stop": "M5 5h14v11H5zM8 16v3m8-3v3M7 9h10M8 12h2m4 0h2",
  "bus-route": "M4 18c5 0 3-12 9-12s2 12 7 12M4 18h.01M13 6h.01M20 18h.01",
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
