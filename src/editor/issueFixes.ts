import { refsOf } from "../core/osm/model";
import type { ValidationIssue } from "../core/osm/validation";
import type { useEditorStore } from "../stores/editor";

type Store = ReturnType<typeof useEditorStore>;

/** Название кнопки исправления для предупреждения проверки (null — исправления нет). */
export function fixLabel(issue: ValidationIssue): string | null {
  if (issue.code === "road-building-overlap" && issue.id && issue.buildingId)
    return "Проезд через арку";
  if (!issue.fix) return null;
  return issue.fix.kind === "attach-endpoint"
    ? "Замкнуть разрыв"
    : issue.fix.kind === "ground-passage"
      ? "Сделать проезд на уровне земли"
      : "Соединить узлом";
}

/**
 * Исправить предупреждение проверки. Правка меняет OSM, поэтому сначала
 * спрашивает подтверждение: проверки эвристические, решает человек.
 */
export function applyFix(store: Store, issue: ValidationIssue): boolean {
  if (issue.code === "road-building-overlap" && issue.id && issue.buildingId) {
    // Арка: участок дороги внутри здания становится tunnel=building_passage.
    // Габариты не задаются — в OSM попадает только сам проезд на уровне земли.
    if (
      !window.confirm(
        `Здесь проезд через арку? Участок дороги ${issue.id} внутри здания станет аркой (tunnel=building_passage), подъезды останутся на уровне земли.`,
      )
    )
      return false;
    if (
      !store.execute({
        type: "mark-building-passage",
        wayId: issue.id,
        buildingId: issue.buildingId,
      })
    )
      return false;
    store.message =
      "Проезд через арку выделен отдельным участком. Проверка пересчитана.";
    return true;
  }
  const fix = issue.fix;
  if (!fix) return false;
  const confirmation =
    fix.kind === "connect-crossing"
      ? `Соединить дороги ${fix.wayA} и ${fix.wayB} общим узлом? Убедитесь, что это наземный перекрёсток.`
      : fix.kind === "ground-passage"
        ? `Перенести проезд ${fix.wayId} на уровень земли (${fix.tags.tunnel ? "арка: tunnel=building_passage" : "навес: covered=yes"}, без отрицательного layer)? Геометрия и связи не меняются.`
        : `Переместить свободный конец ${fix.nodeId} к дороге ${fix.targetWayId} и вставить общий узел? Проверьте по карте, что соединение существует.`;
  if (!window.confirm(confirmation)) return false;
  const patch =
    fix.kind === "connect-crossing"
      ? store.execute({ type: "connect-crossing", ...fix })
      : fix.kind === "ground-passage"
        ? store.execute({
            type: "set-tags",
            target: { type: "way", id: fix.wayId },
            tags: fix.tags,
          })
        : store.execute({ type: "attach-endpoint", ...fix });
  if (!patch) return false;
  store.message =
    fix.kind === "ground-passage"
      ? "Проезд под зданием перенесён на уровень земли. Проверка пересчитана."
      : "Связь добавлена. Проверка пересчитана.";
  return true;
}

/** Предупреждения проверки, относящиеся к выбранному объекту (дороге или узлу). */
export function issuesOfSelection(store: Store): ValidationIssue[] {
  const selection = store.selection;
  const element = store.selected;
  if (!selection || !element) return [];
  const nodes = selection.type === "way" ? new Set(refsOf(element)) : null;
  return store.problems.filter(
    (issue) =>
      (issue.elementType === selection.type && issue.id === selection.id) ||
      (nodes !== null && issue.elementType === "node" && nodes.has(issue.id!)),
  );
}
