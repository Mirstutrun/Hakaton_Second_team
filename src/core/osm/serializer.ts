import type { OsmDocument } from "./model";
import { validateOsm } from "./validation";

export function serializeOsm(document: OsmDocument): string {
  const errors = validateOsm(document).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length)
    throw new Error(`Экспорт заблокирован: ${errors[0].message}`);
  const body = new XMLSerializer().serializeToString(document.xml);
  // Сохраняем декларацию исходного файла (кодировка UTF-8 для серверных адаптеров).
  // Chromium выводит её сам; jsdom и некоторые браузеры — нет. Формат одинаковый.
  return document.declaration && !body.startsWith("<?xml")
    ? document.declaration + body
    : body;
}
