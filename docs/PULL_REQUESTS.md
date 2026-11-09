# Последовательность PR

Репозиторий изначально пустой: `main` не существует. Начальный README находится в `chore/repository-base`; прямой push в `main` не выполнялся. На эту базу подготовлены два зависимых набора изменений:

1. `feat/foundation-core` → `chore/repository-base`: OSM-ядро, команды, проекция, пример карты, тесты и архитектура.
2. `feat/foundation-3d` → `feat/foundation-core`: Vue/Babylon-приложение, сквозная проверка и передача команде.

Из среды Git чтение и push доступны, но `api.github.com` получает HTTP 403 от сетевого прокси. Автоматическое создание PR требует разрешить этот домен в настройках сети и проверить доступ GitHub API. Токены в чат и Git не помещать. Если разрешение домена не устраняет ошибку, использовать GitHub CLI с собственной штатной авторизацией на локальной машине.

Команды из каталога полного проекта после восстановления API:

```bash
gh pr create --repo Mirstutrun/Hakaton_Second_team --base chore/repository-base --head feat/foundation-core --title 'Основа: OSM-ядро, безопасные правки и сохранность данных' --body-file docs/pr/01-core.md
gh pr create --repo Mirstutrun/Hakaton_Second_team --base feat/foundation-core --head feat/foundation-3d --title 'Редактор: 3D/2D, дорожные инструменты и передача команде' --body-file docs/pr/02-editor.md
```

Можно открыть формы сравнения в GitHub:

- https://github.com/Mirstutrun/Hakaton_Second_team/compare/chore/repository-base...feat/foundation-core?expand=1
- https://github.com/Mirstutrun/Hakaton_Second_team/compare/feat/foundation-core...feat/foundation-3d?expand=1

Это формы создания PR, не ссылки на уже открытые PR. Перед отправкой вставьте соответствующие описания из `docs/pr`.

После первого merge переключите базу второго PR на общую основную ветку. Если команда выбирает `main`, переименуйте начальную ветку средствами GitHub и скорректируйте базу PR. Не начинайте работу других участников от пустой базы: им нужна объединённая `feat/foundation-3d`. Автоматическое слияние и переименование основной ветки в этой задаче не выполняются.
