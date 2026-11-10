/**
 * Воспроизводимое исправление карты организаторов командами самого редактора.
 *
 *   npx vite-node scripts/fix-example-osm.ts
 *
 * Читает public/example.osm (исходник не меняется), применяет те же команды,
 * что и кнопки панели «Проверка», и записывает maps/example-edited.osm через
 * сериализатор экспорта редактора. Описание каждой правки — в maps/README.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
Object.assign(globalThis, {
  DOMParser: window.DOMParser,
  XMLSerializer: window.XMLSerializer,
});

const { parseOsm } = await import("../src/core/osm/parser");
const { serializeOsm } = await import("../src/core/osm/serializer");
const { applyEdit } = await import("../src/core/osm/commands");
const { auditGeometry } = await import("../src/core/osm/geometryAudit");
const { validateOsm } = await import("../src/core/osm/validation");
const { networkConnectivity } = await import("../src/core/osm/connectivity");

const document = parseOsm(readFileSync("public/example.osm", "utf8"));

// 1. Лермонтова, 81/20: проезд сквозь дом был размечен только layer=-1, без
//    тоннеля. Кнопка «Проезд через арку»: участок внутри здания становится
//    tunnel=building_passage, подъезды возвращаются на уровень земли.
//    Габариты арки неизвестны, поэтому maxwidth/maxheight не записываются.
applyEdit(document, {
  type: "mark-building-passage",
  wayId: "1366216823",
  buildingId: "196084408",
});

// 2. Проезды под домами, размеченные как подземные (tunnel=yes + layer=-1).
//    Кнопка «Сделать проезд на уровне земли» для каждой находки аудита:
//    арка — tunnel=building_passage, навес (building=roof) — covered=yes.
for (const issue of auditGeometry(document)) {
  if (issue.code !== "underground-passage" || issue.fix?.kind !== "ground-passage")
    continue;
  applyEdit(document, {
    type: "set-tags",
    target: { type: "way", id: issue.fix.wayId },
    tags: issue.fix.tags,
  });
  console.log(`way ${issue.fix.wayId}: ${JSON.stringify(issue.fix.tags)}`);
}

const left = auditGeometry(document).filter((issue) => issue.code);
const errors = validateOsm(document).filter((issue) => issue.severity === "error");
const network = networkConnectivity(document);
if (left.length || errors.length || network.isolated)
  throw new Error(
    `Остались проблемы: ${JSON.stringify({ left, errors, isolated: network.isolated })}`,
  );

mkdirSync("maps", { recursive: true });
writeFileSync("maps/example-edited.osm", serializeOsm(document));
console.log(
  `maps/example-edited.osm: предупреждений аудита 0, ошибок 0, ` +
    `частей сети у границы выгрузки ${network.clipped} (не ошибка)`,
);
