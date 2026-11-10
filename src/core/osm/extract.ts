import type { createProjection, LocalPoint } from "../geo/projection";
import type { OsmDocument } from "./model";

/**
 * Выгрузка OSM API (/map) содержит дороги целиком: если дорога продолжается
 * за прямоугольником <bounds>, часть её узлов лежит снаружи. Поэтому кусок
 * сети, дошедший до края выгрузки, может быть связан с городом за её пределами —
 * это артефакт обрезки, а не доказанный разрыв.
 *
 * Возвращает проверку «точка за границей выгрузки или ближе margin метров к ней».
 * Без <bounds> граница неизвестна, и ни одна точка не считается обрезанной.
 */
export function extractEdgeTest(
  document: OsmDocument,
  projection: ReturnType<typeof createProjection>,
  margin = 10,
): (point: LocalPoint) => boolean {
  const bounds = document.xml.documentElement.querySelector("bounds");
  const values = bounds
    ? ["minlat", "minlon", "maxlat", "maxlon"].map((key) =>
        Number(bounds.getAttribute(key)),
      )
    : [];
  if (values.length !== 4 || !values.every(Number.isFinite))
    return () => false;
  const min = projection.project({ lat: values[0], lon: values[1] });
  const max = projection.project({ lat: values[2], lon: values[3] });
  return (point) =>
    point.x < min.x + margin ||
    point.x > max.x - margin ||
    point.z < min.z + margin ||
    point.z > max.z - margin;
}
