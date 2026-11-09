import type { OsmDocument } from "./model";
import { validateOsm } from "./validation";

export function serializeOsm(document: OsmDocument): string {
  const errors = validateOsm(document).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length)
    throw new Error(`Экспорт заблокирован: ${errors[0].message}`);
  return new XMLSerializer().serializeToString(document.xml);
}
