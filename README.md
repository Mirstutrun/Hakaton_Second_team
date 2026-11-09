# RoadForge 3D

Локальный редактор дорожной сети OpenStreetMap для хакатона «Редактор карт».

Стек команды: Vue 3, TypeScript, Vite, Pinia, Babylon.js. Исходные требования организаторов: https://github.com/B216-lab/hack_task.

Основа разрабатывается последовательно: OSM-ядро и контракты, затем интерактивное приложение и передача команде. Данные OpenStreetMap распространяются по ODbL; авторство исходной карты сохранено внутри файла.

## Ядро и контракты

Нужен Node.js 22+ (проверено на 24). Установка: `npm ci`. Тесты: `npm run test`. Проверка TypeScript: `npm run build`.

Ветка `feat/foundation-core` содержит независимое OSM-ядро, локальную проекцию и тестовый файл организаторов. Приложение Vue/Babylon добавляется следующим PR в `feat/foundation-3d`.

Контракты и правила расширения: [docs/architecture.md](docs/architecture.md).
