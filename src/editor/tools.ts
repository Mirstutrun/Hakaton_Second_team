export type EditorTool = "select" | "draw" | "move" | "insert" | "signal";

export const editorTools: {
  id: EditorTool;
  name: string;
  key: string;
  hint: string;
}[] = [
  {
    id: "select",
    name: "Выбор",
    key: "V",
    hint: "Нажмите на дорогу или светофор. Правая кнопка — панорама, колесо — масштаб.",
  },
  {
    id: "draw",
    name: "Дорога",
    key: "D",
    hint: "Ставьте точки. Рядом с узлом сработает привязка. Enter — завершить, Esc — отменить.",
  },
  {
    id: "move",
    name: "Геометрия",
    key: "M",
    hint: "Выберите дорогу, затем перетащите её вершину. Общий узел перемещается во всех дорогах.",
  },
  {
    id: "insert",
    name: "Вершина",
    key: "I",
    hint: "Нажмите на сегмент выбранной дороги, чтобы добавить вершину.",
  },
  {
    id: "signal",
    name: "Светофор",
    key: "T",
    hint: "Нажмите на дорогу, чтобы установить светофор на ближайший сегмент.",
  },
];
