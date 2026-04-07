# LiLi

LiLi is a Chrome extension for LinkedIn group member pages. It keeps LinkedIn's native `Message` action for `1st` degree connections, shows `Pending` when LinkedIn already confirms an invitation, and leaves the rest at `Connect`.

На русском: LiLi это Chrome extension для страниц участников групп в LinkedIn. Оно сохраняет нативный `Message` для `1st` degree connections, показывает `Pending`, когда LinkedIn уже подтвердил приглашение, и оставляет остальные карточки в состоянии `Connect`.

## Preview

![LiLi extension preview](docs/preview.svg)

## English

### Overview

LiLi helps you review LinkedIn group member lists faster and send connect requests from the same flow.

- Keeps LinkedIn's native `Message` action for `1st` degree connections.
- Shows `Pending` when LinkedIn already exposes invitation state.
- Leaves other visible members at `Connect`.
- Lets you send an invite from the group members page.
- Reuses a shared pending-only cache across supported LinkedIn pages.

### Supported Pages

LiLi works on these LinkedIn pages:

1. Group members pages such as `https://www.linkedin.com/groups/123/members/`.
2. Profile pages such as `https://www.linkedin.com/in/{slug}/`.
3. Sent invitations page at `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### Recommended Start

For the best first run, open the sent invitations page first:

`https://www.linkedin.com/mynetwork/invitation-manager/sent/`

That lets LiLi populate the shared pending cache from visible sent invitations. After that, open the members page of the group you want to review.

### What You See On Member Cards

LiLi resolves member cards in this order:

1. `1st` degree members keep LinkedIn's native `Message` action.
2. Members with confirmed pending evidence show `Pending`.
3. Members found in the shared pending cache show `Pending`.
4. All other unresolved members stay at `Connect`.

### Pending Cache

LiLi stores only confirmed `Pending` entries in its shared cache.

The cache can be refreshed from:

1. The sent invitations page.
2. A profile page that already shows pending state.
3. The explicit invite flow when LinkedIn accepts the invite or reports that an invite already exists.

LiLi also removes stale cached entries when:

1. A group member is already `1st` degree.
2. An opened profile page clearly shows `Connect` instead of `Pending`.

### Connect Flow

When you click `Connect`, LiLi uses LinkedIn's own invitation flow.

- LiLi may fetch profile data on demand if LinkedIn requires a profile URN.
- The request stays same-origin to LinkedIn.
- If LinkedIn confirms the invite, LiLi stores `Pending` immediately.

### Popup Panel

The popup shows a small cache panel with:

- `Pending entries`: current number of cached pending profiles.
- `Clear status cache`: removes the shared pending cache.

### Navigation Behavior

LiLi refreshes its state on supported pages during both regular LinkedIn navigation and LinkedIn SPA navigation.

In practice:

1. Opening a profile page refreshes pending state for that slug.
2. Opening the sent invitations page refreshes pending state for visible invitations.
3. Opening a group members page rerenders visible cards against the current shared pending cache.

### Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project root folder that contains [manifest.json](manifest.json).

### Privacy And Scope

- LiLi does not send data to external servers.
- LiLi does not collect, store, or upload personal information outside the browser or LinkedIn itself.
- LiLi does not automate outreach, messaging, invitations, or any other LinkedIn workflow on your behalf.
- LiLi improves UX by surfacing already available LinkedIn state and reducing manual page switching.
- All extension logic runs locally in the browser.
- Cached relationship state stays in extension storage.

### Project Files

- [manifest.json](manifest.json): Chrome extension manifest.
- [content.js](content.js): main content script and LinkedIn page integration.
- [content.css](content.css): styles for generated actions.
- [popup.html](popup.html): popup layout.
- [popup.js](popup.js): popup cache panel logic.

### Limits

- LiLi shows `Pending` only when LinkedIn already exposes that state on a supported page or during an explicit invite action.
- The sent invitations page refreshes only profiles that are visible in the current DOM.
- Existing connections are derived from the live group-member page, mainly through `1st` degree and LinkedIn's native `Message` action.

## Русский

### Обзор

LiLi помогает быстрее просматривать списки участников групп в LinkedIn и отправлять запросы на коннект из того же сценария.

- Сохраняет нативный `Message` для `1st` degree connections.
- Показывает `Pending`, когда LinkedIn уже отдает подтвержденный invitation state.
- Оставляет остальные карточки в состоянии `Connect`.
- Позволяет отправлять invite прямо со страницы участников группы.
- Использует один общий pending-only cache на поддерживаемых страницах LinkedIn.

### Поддерживаемые страницы

LiLi работает на следующих страницах LinkedIn:

1. Страницы участников групп, например `https://www.linkedin.com/groups/123/members/`.
2. Страницы профиля, например `https://www.linkedin.com/in/{slug}/`.
3. Страница отправленных приглашений `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### Рекомендуемый старт

Для лучшего первого запуска сначала открой страницу отправленных приглашений:

`https://www.linkedin.com/mynetwork/invitation-manager/sent/`

Так LiLi заполнит общий pending cache по видимым отправленным приглашениям. После этого можно открывать страницу участников нужной группы.

### Что видно на карточках участников

LiLi определяет состояние карточек в таком порядке:

1. Для `1st` degree сохраняется нативный `Message`.
2. Для карточек с подтвержденным pending-state показывается `Pending`.
3. Для карточек, найденных в общем pending cache, показывается `Pending`.
4. Для остальных карточек остается `Connect`.

### Pending cache

LiLi хранит в кеше только подтвержденные записи `Pending`.

Кеш может обновляться из трех источников:

1. Страница отправленных приглашений.
2. Страница профиля, где LinkedIn уже показывает pending state.
3. Явный invite flow, когда LinkedIn принимает приглашение или сообщает, что оно уже существует.

LiLi также очищает устаревшие cache entries, когда:

1. Участник группы уже является `1st` degree.
2. Открытая profile page явно показывает `Connect`, а не `Pending`.

### Connect flow

При клике по `Connect` LiLi использует собственный flow LinkedIn.

- LiLi может точечно запросить profile data, если LinkedIn требует profile URN.
- Запрос остается same-origin к LinkedIn.
- Если LinkedIn подтверждает invite, LiLi сразу пишет `Pending` в кеш.

### Popup-панель

Popup показывает компактную панель кеша:

- `Pending entries`: текущее количество pending-профилей в кеше.
- `Clear status cache`: очистка общего pending cache.

### Навигация

LiLi обновляет состояние на поддерживаемых страницах как при обычной навигации LinkedIn, так и при SPA navigation.

На практике это значит:

1. При открытии profile page обновляется pending state для этого slug.
2. При открытии sent invitations обновляется pending state для видимых приглашений.
3. При открытии group members page видимые карточки перерисовываются по текущему общему pending cache.

### Установка

1. Открой Chrome и перейди на `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери корневую папку проекта, где находится [manifest.json](manifest.json).

### Privacy и scope

- LiLi не отправляет данные на внешние серверы.
- LiLi не собирает, не сохраняет и не выгружает персональную информацию за пределы браузера или самого LinkedIn.
- LiLi не автоматизирует outreach, messaging, invitations и другие процессы в LinkedIn от имени пользователя.
- LiLi улучшает UX: показывает уже доступный статус LinkedIn и уменьшает количество ручных переходов между страницами.
- Вся логика расширения выполняется локально в браузере.
- Кеш состояния отношений хранится только в extension storage.

### Файлы проекта

- [manifest.json](manifest.json): manifest Chrome extension.
- [content.js](content.js): основной content script и интеграция со страницами LinkedIn.
- [content.css](content.css): стили для создаваемых action-кнопок.
- [popup.html](popup.html): layout popup.
- [popup.js](popup.js): логика popup-панели кеша.

### Ограничения

- LiLi показывает `Pending` только когда LinkedIn уже отдает это состояние на поддерживаемой странице или в момент явного invite action.
- Страница sent invitations обновляет только те профили, которые уже видны в текущем DOM.
- Existing connections определяются по live DOM страницы участников группы, в первую очередь по `1st` degree и нативному `Message`.
