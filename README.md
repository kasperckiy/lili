# LiLi

LiLi is a Chrome extension for LinkedIn that simplifies group member pages: it keeps LinkedIn's native `Message` for `1st` degree members, shows `Pending` when an invite is confirmed, and otherwise defaults to `Connect`.

На русском: LiLi это Chrome extension для LinkedIn, которое упрощает страницы участников групп: для `1st` degree оно сохраняет нативный `Message`, показывает `Pending`, когда приглашение уже подтверждено, и в остальных случаях оставляет `Connect`.

## Preview

![LiLi extension preview](docs/preview.svg)

## English

### What LiLi Does

LiLi now follows a deliberately simple model.

- Keeps LinkedIn's native `Message` action untouched for `1st` degree connections.
- Shows `Pending` when LinkedIn page data, the sent invitations page, the opened profile page, or the invite flow itself confirms an existing invitation.
- Leaves unresolved non-`1st` group members at `Connect` instead of running automatic background profile checks.
- Sends invites without leaving the current group members page.
- Uses LinkedIn's own invitation API instead of opening a hidden invite iframe.
- Shares a 24-hour pending-only cache across supported LinkedIn pages through extension storage.

### Supported LinkedIn Pages

LiLi currently works with three LinkedIn page types:

1. Group members pages such as `https://www.linkedin.com/groups/123/members/`.
2. Concrete profile pages such as `https://www.linkedin.com/in/{slug}/`.
3. Sent invitations page at `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### How Status Resolution Works

On group member pages, LiLi resolves actions in this order:

1. If the member is `1st` degree, LiLi keeps the native `Message` action.
2. If LinkedIn page data or live network hints prove that the relationship is already pending, LiLi shows `Pending`.
3. If the shared cache contains a fresh `Pending` entry for the slug, LiLi shows `Pending` immediately.
4. Otherwise the card stays at `Connect`.

Important change:

- LiLi no longer runs automatic background profile fetches while you browse the group members list.
- The cache now stores only `Pending` records for `24` hours.
- `Connect` is no longer a cached state. It is the implicit default when there is no pending evidence.

### Explicit Connect Flow

Clicking `Connect` still uses LinkedIn's own invitation API.

- LiLi may still resolve the profile document on demand when you explicitly click `Connect`, because the API may require a profile URN.
- This is no longer part of a background queue. It only happens in the explicit action path.
- If LinkedIn accepts the invite or reports that an invitation already exists, LiLi stores `Pending` immediately.

### Cache Sources

The shared pending cache can be updated from three places:

1. The direct invite flow after a successful or already-pending response.
2. The sent invitations page, for visible invited profiles.
3. An opened concrete profile page when LinkedIn already shows explicit pending state.

Concrete profile pages can also clear stale pending state for that slug when the opened page clearly shows `Connect` instead of `Pending`.

### Popup Guide

The popup is now a lightweight cache panel.

- `Pending entries`: number of valid cached pending records shared across supported LinkedIn pages.
- `Clear status cache`: removes the shared pending cache immediately.
- The popup also reminds you that unresolved non-`1st` group members now stay at `Connect` instead of being auto-checked in the background.

### UI and JS Navigation

LiLi is designed to refresh the shared pending cache whether supported pages are opened through normal LinkedIn UI navigation or through LinkedIn's client-side SPA navigation.

Expected behavior:

- Entering a concrete profile page should immediately resync pending state for that slug.
- Entering the sent invitations page should immediately resync pending state for the visible invitations there.
- Entering a group members page should rerender visible cards against the latest shared pending cache.

### Install Locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project root folder, the one that contains [manifest.json](manifest.json).

### Permissions And Privacy

- `storage`: used to persist the shared 24-hour pending cache.
- `tabs`: used by the extension lifecycle logic to reload LinkedIn tabs after extension updates.
- `https://www.linkedin.com/*`: required so the content script can run on supported LinkedIn pages.

Privacy notes:

- LiLi does not send data to external servers.
- All logic runs locally in the browser against the current LinkedIn page.
- Any on-demand profile request triggered by an explicit `Connect` click is a same-origin LinkedIn request.
- Cached relationship state stays in extension storage.

### Project Files

- [manifest.json](manifest.json): Chrome extension manifest.
- [content.js](content.js): main content script, cache sync, action replacement, profile parsing, invite flow.
- [popup.html](popup.html): popup UI layout.
- [popup.js](popup.js): popup cache panel logic.
- [content.css](content.css): visual tweaks for generated buttons.
- [docs/profile-status-requirement.md](docs/profile-status-requirement.md): requirement notes for pending-cache resolution.

### Limitations

- LiLi does not try to infer hidden `Pending` state for unresolved non-`1st` members unless LinkedIn already exposes that state on a supported page or during an explicit invite action.
- The sent invitations page syncs visible invitations. If LinkedIn has not rendered a profile into the current DOM yet, that slug cannot be refreshed from that page until it becomes visible.
- Existing connections are inferred from the live group-member DOM, mainly through the `1st` badge and native `Message` action, not through a separate cache source.

## Русский

### Что делает LiLi

Теперь LiLi работает по упрощенной и более предсказуемой модели.

- Сохраняет нативный `Message` для `1st` degree connections.
- Показывает `Pending`, когда LinkedIn уже подтвердил существующее приглашение через данные страницы, sent invitations, открытую profile page или сам invite flow.
- Оставляет unresolved non-`1st` участников группы в состоянии `Connect`, не запуская автоматические фоновые profile checks.
- Отправляет invite, не уводя пользователя со страницы участников группы.
- Использует собственный LinkedIn invitation API вместо hidden invite iframe.
- Делит один общий pending-only cache на `24` часа между поддерживаемыми страницами LinkedIn.

### Поддерживаемые страницы LinkedIn

Сейчас LiLi работает с тремя типами страниц:

1. Страницы участников групп, например `https://www.linkedin.com/groups/123/members/`.
2. Конкретные страницы профиля, например `https://www.linkedin.com/in/{slug}/`.
3. Страница отправленных приглашений `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### Как теперь определяется статус

На странице участников группы порядок такой:

1. Если участник имеет `1st` degree, LiLi не трогает нативный `Message`.
2. Если LinkedIn page data или live network hints явно доказывают `Pending`, LiLi показывает `Pending`.
3. Если в общем кеше есть свежая запись `Pending` для этого slug, LiLi сразу показывает `Pending`.
4. Во всех остальных случаях карточка остается в состоянии `Connect`.

Важное изменение:

- LiLi больше не запускает автоматические фоновые profile fetches во время просмотра списка участников группы.
- Кеш теперь хранит только записи `Pending` на `24` часа.
- `Connect` больше не кешируется как отдельное состояние. Это значение по умолчанию, когда нет доказательств `Pending`.

### Явный клик по Connect

Клик по `Connect` по-прежнему использует LinkedIn invitation API.

- LiLi все еще может один раз запросить профиль именно в момент явного клика по `Connect`, если для invite API нужен profile URN.
- Это больше не часть фоновой очереди и не происходит автоматически во время скролла списка.
- Если LinkedIn принимает invite или сообщает, что приглашение уже существует, LiLi сразу пишет `Pending` в кеш.

### Источники кеша

Общий pending cache может обновляться из трех источников:

1. Прямой invite flow после успешного ответа или already-pending ответа.
2. Страница sent invitations для видимых профилей.
3. Открытая profile page, если LinkedIn уже явно показывает pending state.

Concrete profile page также может очистить устаревший pending для данного slug, если открытый профиль явно показывает `Connect`, а не `Pending`.

### Popup

Popup теперь стал легкой панелью кеша.

- `Pending entries`: сколько валидных pending-records сейчас хранится в общем кеше.
- `Clear status cache`: мгновенно очищает общий pending cache.
- Popup также напоминает, что unresolved non-`1st` участники теперь остаются в `Connect` без фоновых auto-checks.

### UI и JS navigation

LiLi должен одинаково обновлять общий pending cache как при обычной LinkedIn UI navigation, так и при client-side SPA navigation.

Ожидаемое поведение:

- При входе на concrete profile page pending-state для этого slug должен сразу пересинхронизироваться.
- При входе на sent invitations pending-state для видимых приглашений должен сразу пересинхронизироваться.
- При входе на group members page видимые карточки должны перерисоваться по текущему общему pending cache.

### Локальная установка

1. Открой Chrome и перейди на `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери корневую папку проекта, ту, где лежит [manifest.json](manifest.json).

### Permissions и privacy

- `storage`: используется для хранения общего 24-часового pending cache.
- `tabs`: используется lifecycle-логикой расширения, чтобы перезагружать LinkedIn tabs после обновления расширения.
- `https://www.linkedin.com/*`: нужно, чтобы content script работал на поддерживаемых LinkedIn pages.

Privacy notes:

- LiLi не отправляет данные на внешние серверы.
- Вся логика работает локально в браузере поверх текущей LinkedIn page.
- Любой on-demand profile request, который выполняется после явного клика по `Connect`, остается same-origin запросом к LinkedIn.
- Кеш состояния отношений хранится только в extension storage.

### Файлы проекта

- [manifest.json](manifest.json): manifest Chrome extension.
- [content.js](content.js): основной content script, синхронизация кеша, замена action, profile parsing, invite flow.
- [popup.html](popup.html): layout popup.
- [popup.js](popup.js): логика popup-панели pending cache.
- [content.css](content.css): визуальные правки для создаваемых кнопок.
- [docs/profile-status-requirement.md](docs/profile-status-requirement.md): requirement notes для pending-cache resolution.

### Ограничения

- LiLi больше не пытается автоматически угадывать скрытый `Pending` для unresolved non-`1st`, если LinkedIn не показал это состояние на поддерживаемой странице или в момент явного invite action.
- Страница sent invitations синхронизирует только видимые приглашения. Если LinkedIn еще не отрендерил профиль в текущий DOM, этот slug не может быть обновлен с этой страницы до тех пор, пока не станет видимым.
- Existing connections определяются по live DOM страницы участников группы, в первую очередь по `1st` badge и нативному `Message`, а не через отдельный cache source.
