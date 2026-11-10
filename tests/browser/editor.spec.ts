import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** Экранная точка для мировых координат сцены (метры: x — восток, z — север). */
async function scenePoint(page: Page, x: number, z: number) {
  return page.evaluate(
    async ({ x, z }) => {
      const path = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/@babylonjs_core.js?"))!.name;
      const { EngineStore, Vector3, Matrix } = await import(path);
      const engine = EngineStore.Instances[0];
      const scene = engine.scenes[0];
      const canvas = engine.getRenderingCanvas().getBoundingClientRect();
      const projected = Vector3.Project(
        new Vector3(x, 0, z),
        Matrix.Identity(),
        scene.getTransformMatrix(),
        scene.activeCamera.viewport.toGlobal(
          engine.getRenderWidth(),
          engine.getRenderHeight(),
        ),
      );
      return {
        x: canvas.left + (projected.x * canvas.width) / engine.getRenderWidth(),
        y:
          canvas.top + (projected.y * canvas.height) / engine.getRenderHeight(),
      };
    },
    { x, z },
  );
}

async function state(page: Page) {
  return page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const selection = store.selection;
    const element = selection
      ? (selection.type === "way"
          ? store.document!.ways
          : store.document!.nodes
        ).get(selection.id)
      : null;
    return {
      roads: store.stats.roads,
      nodes: store.stats.nodes,
      selection,
      tags: element
        ? Object.fromEntries(
            Array.from(element.querySelectorAll("tag")).map((tag: any) => [
              tag.getAttribute("k"),
              tag.getAttribute("v"),
            ]),
          )
        : {},
      dirty: store.dirty,
      draft: store.draft.length,
      problems: store.problems.length,
      redRoads: store.graphIssues.filter((i: any) => i.elementType === "way")
        .length,
    };
  });
}

/** Дождаться загрузки файла (панель свойств может быть скрыта панелью проверки). */
async function loaded(page: Page, name: string) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const store = (await import("/src/stores/editor.ts")).useEditorStore();
        return store.document ? store.fileName : "";
      }),
    )
    .toBe(name);
}

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 90000,
  });
}

/** Маленькая карта: дорога 10 на восток (1→2) и дорога 11 на север (2→3). */
const junction = `<osm version="0.6">
  <bounds minlat="51.998" minlon="103.996" maxlat="52.003" maxlon="104.003"/>
  <node id="1" lat="52" lon="103.998"/>
  <node id="2" lat="52" lon="104"/>
  <node id="3" lat="52.0015" lon="104"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/></way>
</osm>`;

/** Загрузить карту и приблизить камеру к точке (метры от узла 2). */
async function loadJunction(page: Page, east = 0, north = 0) {
  return page.evaluate(
    async ({ source, east, north }) => {
      const store = (await import("/src/stores/editor.ts")).useEditorStore();
      store.load(source, "junction.osm");
      const { createProjection, documentOrigin } = await import(
        "/src/core/geo/projection.ts"
      );
      const projection = createProjection(documentOrigin(store.document!));
      const node = projection.project({ lat: 52, lon: 104 });
      store.focusCoordinate = projection.unproject({
        x: node.x + east,
        z: node.z + north,
      });
      store.focusRequest++;
      return node;
    },
    { source: junction, east, north },
  );
}

test("real map: lanes, draw, move, delete, undo, export and reimport", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "2D", exact: true }).click();
  const road = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const id = (Array.from(store.document!.ways.values()) as Element[])
      .find(
        (way) =>
          way.querySelector('tag[k="lanes"][v="2"]') &&
          way.querySelector('tag[k="highway"]') &&
          !way.querySelector('tag[k="oneway"]'),
      )!
      .getAttribute("id")!;
    store.selectOsmElement({ type: "way", id });
    store.focusRequest++;
    return id;
  });
  // Только число полос и направления: прочих свойств дороги в панели нет.
  await expect(page.getByRole("textbox", { name: "Название дороги" })).toHaveCount(0);
  await expect(page.getByText("Дополнительные свойства дороги")).toHaveCount(0);
  await expect(page.getByText("Знаки и запреты поворотов")).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Полосы", exact: true }).fill("4");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  expect((await state(page)).tags).toMatchObject({
    lanes: "4",
    "lanes:forward": "2",
    "lanes:backward": "2",
  });
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("2");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("4");
  await page.locator("canvas").click({ position: { x: 500, y: 100 } });
  await page.getByRole("button", { name: "Центрировать", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая дорога D", exact: false })
    .click();
  // Свободная трасса: концы привязываются к соседним дорогам, середина — нет.
  for (const point of [
    { x: -60, z: -10 },
    { x: 0, z: -10 },
    { x: 60, z: -10 },
  ]) {
    const position = await scenePoint(page, point.x, point.z);
    await page.mouse.click(position.x, position.y);
  }
  expect((await state(page)).draft).toBe(3);
  await page.getByRole("button", { name: "Завершить" }).click();
  const newRoad = (await state(page)).selection!.id;
  expect((await state(page)).roads).toBe(862);
  await page.getByRole("button", { name: "Центрировать", exact: true }).click();
  await page
    .getByRole("button", { name: "Переместить узел M", exact: false })
    .click();
  const start = await scenePoint(page, 0, -10);
  const end = await scenePoint(page, 0, 40);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const { createProjection, documentOrigin } = await import(
      "/src/core/geo/projection.ts"
    );
    const node = store.document!.nodes.get(store.selectedVertex!)!;
    return createProjection(documentOrigin(store.document!)).project({
      lat: Number(node.getAttribute("lat")),
      lon: Number(node.getAttribute("lon")),
    });
  });
  expect(moved.z).toBeCloseTo(40, 0);
  await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.tool = "select";
    store.selectOsmElement({ type: "way", id });
  }, newRoad);
  await page.getByRole("button", { name: "Удалить дорогу", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить удаление" }).click();
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await state(page)).roads).toBe(862);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  // На исходной карте остаются реальные проблемы: доступен только черновик.
  await page.getByRole("button", { name: "Сохранить карту" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Сохранить рабочий черновик с предупреждениями" })
    .click();
  const download = await downloadEvent;
  const path = testInfo.outputPath("edited.osm");
  await download.saveAs(path);
  // Черновик не снимает отметку несохранённых правок: импорт просит подтверждение.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("file-input").setInputFiles(path);
  await loaded(page, "edited.osm");
  expect((await state(page)).roads).toBe(862);
  await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.selectOsmElement({ type: "way", id });
  }, road);
  expect((await state(page)).tags.lanes).toBe("4");
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("editor.png") });
  expect(errors).toEqual([]);
});

test("review: every highlighted problem is fixed from the panel and the map saves clean", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await ready(page);
  // Ложных срабатываний нет: подсвечены 7 реальных проблем карты организаторов.
  expect(await state(page)).toMatchObject({ problems: 7, redRoads: 7 });
  await page.getByRole("button", { name: "Проверка · 7" }).click();
  await expect(page.getByRole("button", { name: /Скачать отчёт/ })).toHaveCount(0);
  await expect(page.getByText("Ширина проезда")).toHaveCount(0);
  await expect(page.getByText("Высота арки")).toHaveCount(0);
  await expect(page.getByText("Открытый двор внутри здания")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("review-before.png") });
  await page.getByRole("button", { name: "Проезд через арку" }).click();
  await expect(page.getByRole("button", { name: "Проверка · 6" })).toBeVisible();
  for (let left = 6; left > 0; left--) {
    await page.getByRole("button", { name: "Сделать проезд на уровне земли" }).first().click();
    await expect(page.getByRole("button", { name: `Проверка · ${left - 1}` })).toBeVisible();
  }
  expect(await state(page)).toMatchObject({ problems: 0, redRoads: 0 });
  await page.screenshot({ path: testInfo.outputPath("review-after.png") });
  await page.getByRole("button", { name: "Сохранить карту" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Направления проверены — сохранить OSM" })
    .click();
  const download = await downloadEvent;
  const path = testInfo.outputPath("example-edited.osm");
  await download.saveAs(path);
  // Редактор записал ровно ту карту, что лежит в maps/example-edited.osm.
  const saved = readFileSync(path, "utf8");
  expect(saved.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(saved === readFileSync("maps/example-edited.osm", "utf8")).toBe(true);
  await page.getByTestId("file-input").setInputFiles(path);
  await loaded(page, "example-edited.osm");
  expect(await state(page)).toMatchObject({ problems: 0, redRoads: 0 });
  const tunnels = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return ["806941626", "816684053", "816684054", "1494549628", "1494549683"].map(
      (id) => store.document!.ways.get(id)!.querySelector('tag[k="tunnel"]')?.getAttribute("v"),
    );
  });
  expect(tunnels).toEqual(Array(5).fill("building_passage"));
  expect(errors).toEqual([]);
});

test("per-lane directions and connecting a lane to another road with J", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const node = await loadJunction(page);
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.selectOsmElement({ type: "way", id: "10" });
  });
  const lanes = page.locator(".lane-directions button");
  await expect(lanes).toHaveCount(2);
  await expect(lanes.nth(0)).toHaveText(/↓/);
  await expect(lanes.nth(1)).toHaveText(/↑/);
  await lanes.nth(0).click(); // левая полоса: навстречу → по направлению
  await expect(lanes.nth(0)).toHaveText(/↑/);
  await page.getByRole("button", { name: "Применить изменения" }).click();
  expect((await state(page)).tags).toMatchObject({ lanes: "2", oneway: "yes" });
  // Выбрать правую полосу, нажать J и указать полосу дороги 11 у перекрёстка.
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.selectedLane = 0;
  });
  await page.locator("canvas").focus();
  await page.keyboard.press("j");
  await expect(page.locator(".map-instruction")).toContainText("свяжутся полосы");
  const target = await scenePoint(page, node.x + 1.7, node.z + 12);
  await page.mouse.click(target.x, target.y);
  const links = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const { laneConnections } = await import("/src/core/osm/laneConnectivity.ts");
    return laneConnections(store.document!).map((c) => [c.fromWay, c.toWay, c.via]);
  });
  expect(links).toEqual([["10", "11", "2"]]);
  // Правая из двух попутных полос — вторая по ходу движения (нумерация OSM).
  await expect(page.getByText("Полоса 2 → полоса 1")).toBeVisible();
  expect(errors).toEqual([]);
});

test("transport: no select tool, stops beside the road, bus route and vehicles", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const node = await loadJunction(page, -60, 0);
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await page.getByRole("button", { name: "⏸ Пауза", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Очистить", exact: true }).click();
  await expect(
    page.locator(".tools-panel").getByRole("button", { name: /Выбрать объект/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Сторона движения" })).toHaveCount(0);
  // Раздела «Здания» и инструмента создания зданий нет; в подвале — раздел, а не «Выбрать объект».
  await expect(page.getByRole("button", { name: /Новое здание/ })).toHaveCount(0);
  await expect(page.locator(".status-mode")).toHaveText("Транспорт");
  await page.getByRole("button", { name: "Остановка B" }).click();
  // Дорога 10 идёт на восток: южный край — справа, северный — слева.
  // Клик рядом с дорогой (в 8 м от оси): остановка встаёт с этой стороны.
  for (const [east, north] of [[-40, -8], [-90, 8]]) {
    const point = await scenePoint(page, node.x + east, node.z + north);
    await page.mouse.click(point.x, point.y);
  }
  const platforms = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const { createProjection, documentOrigin } = await import(
      "/src/core/geo/projection.ts"
    );
    const projection = createProjection(documentOrigin(store.document!));
    const road = projection.project({ lat: 52, lon: 104 });
    return Array.from(store.document!.nodes.values())
      .filter((n) => n.querySelector('tag[k="public_transport"][v="platform"]'))
      .map((n) => projection.project({
        lat: Number(n.getAttribute("lat")),
        lon: Number(n.getAttribute("lon")),
      }).z - road.z);
  });
  expect(platforms).toHaveLength(2);
  expect(platforms[0]).toBeLessThan(-3); // справа, за краем проезжей части
  expect(platforms[1]).toBeGreaterThan(3); // слева
  await page.getByRole("button", { name: "Маршрут автобуса R" }).click();
  await page.getByText("Автобусы и маршруты · 0").click();
  const stops = page.locator(".bus-stop-list button");
  await stops.nth(0).click();
  await stops.nth(1).click();
  await page.getByRole("textbox", { name: "Название маршрута" }).fill("Автобус 1");
  await page.getByRole("button", { name: "Сохранить маршрут" }).click();
  await expect(page.getByText("Автобусы и маршруты · 1")).toBeVisible();
  await page.getByRole("button", { name: "+ Автобус" }).click();
  const store = () =>
    page.evaluate(async () => {
      const s = (await import("/src/stores/editor.ts")).useEditorStore();
      return { buses: s.busCount, vehicles: s.vehicleCount, running: s.trafficRunning, error: s.error };
    });
  expect((await store()).buses).toBe(1);
  await page.getByRole("button", { name: "+ Автобус" }).click();
  expect((await store()).buses).toBe(1);
  await expect(page.getByRole("alert")).toContainText("Начало маршрута занято");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Очистить", exact: true }).click();
  await page.getByRole("button", { name: "+ Автобус" }).click();
  expect((await store()).buses).toBe(1);
  expect((await store()).error).toBe("");
  await page.getByRole("button", { name: "▶ Продолжить", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Очистить" }).click();
  await page.keyboard.press("Space");
  expect((await store()).running).toBe(false);
  await page.getByRole("button", { name: "+ 10 машин" }).click();
  expect((await store()).vehicles).toBeGreaterThan(0);
  await page.keyboard.press("Space");
  expect((await store()).running).toBe(true);
  expect(errors).toEqual([]);
});

test("workspace modes, review button, help and narrow-screen inspector", async ({
  page,
}, testInfo) => {
  await ready(page);
  await expect(page.locator(".mode-tabs button")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Редактирование", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "+ 10 машин" })).toBeHidden();
  await page.getByRole("button", { name: "? Как работать" }).click();
  await expect(page.getByRole("dialog", { name: "Как работать" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ 10 машин" })).toBeVisible();
  // Проверка открывается кнопкой в любом разделе, без отдельного режима.
  await page.getByRole("button", { name: /Проверка ·/ }).click();
  await expect(page.getByRole("combobox", { name: "Тип проблемы" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ 10 машин" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-traffic.png") });
  await page.getByRole("button", { name: "Скрыть панель проверки" }).click();
  await page.getByRole("button", { name: "Редактирование", exact: true }).click();
  await page.getByRole("button", { name: /Проверка ·/ }).click();
  await expect(page.getByRole("combobox", { name: "Тип проблемы" })).toBeVisible();
  await page.getByRole("button", { name: /Проверка ·/ }).click();
  await page.screenshot({ path: testInfo.outputPath("editor-desktop.png") });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.getByRole("button", { name: "Вся карта", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("editor-3d.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Свойства объекта", exact: true }).click();
  await expect(
    page.getByText("Выберите дорогу", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Закрыть свойства", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png") });
});

test("search finds a street by name only, without OSM IDs", async ({ page }) => {
  await ready(page);
  const name = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(store.document!.ways.values())
      .find(
        (w) =>
          w.querySelector('tag[k="highway"]') &&
          w.querySelector('tag[k="name"]'),
      )!
      .querySelector('tag[k="name"]')!
      .getAttribute("v")!;
  });
  const search = page.getByRole("textbox", { name: "Название улицы" });
  await search.fill(name);
  await expect(page.locator(".search-results button").first()).toHaveText(name);
  await expect(page.locator(".search-results")).not.toContainText("№");
  await page.locator(".search-results button").first().click();
  await expect(page.locator(".properties-panel h2")).toContainText(name);
  expect((await state(page)).dirty).toBe(false);
  await search.fill("26298751");
  await page.getByRole("button", { name: "Найти улицу" }).click();
  await expect(page.getByRole("alert")).toContainText("не найдена");
});


test("buildings stay visible but cannot be selected or changed", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "2D", exact: true }).click();
  const source = junction.replace('</osm>', `
    <node id="21" lat="52.0006" lon="103.999"/>
    <node id="22" lat="52.0006" lon="103.9993"/>
    <node id="23" lat="52.0008" lon="103.9993"/>
    <node id="24" lat="52.0008" lon="103.999"/>
    <way id="20"><nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="24"/><nd ref="21"/><tag k="building" v="yes"/><tag k="height" v="12"/></way>
    </osm>`);
  const building = await page.evaluate(async source => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const { createProjection, documentOrigin } = await import("/src/core/geo/projection.ts");
    store.load(source, "buildings.osm");
    store.focusCoordinate = { lat: 52.0007, lon: 103.99915 };
    store.focusRequest++;
    store.selectOsmElement({ type: "way", id: "20" });
    return createProjection(documentOrigin(store.document!)).project(store.focusCoordinate);
  }, source);
  expect((await state(page)).selection).toBeNull();
  const point = await scenePoint(page, building.x, building.z);
  await page.mouse.click(point.x, point.y);
  expect((await state(page)).selection).toBeNull();
  expect((await state(page)).dirty).toBe(false);
  await expect(page.getByRole("button", { name: /Удалить здание|Новое здание/ })).toHaveCount(0);
  for (const mode of ["2D", "3D"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const meshes = await page.evaluate(async () => {
      const path = performance.getEntriesByType("resource")
        .find(entry => entry.name.includes("/@babylonjs_core.js?"))!.name;
      const { EngineStore } = await import(path);
      return EngineStore.Instances[0].scenes[0].meshes
        .filter((mesh: any) => mesh.metadata?.role === "building")
        .map((mesh: any) => ({ visible: mesh.isEnabled() && mesh.isVisible, pickable: mesh.isPickable }));
    });
    expect(meshes).toEqual([{ visible: true, pickable: false }]);
  }
});
