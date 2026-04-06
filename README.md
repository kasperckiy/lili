# LiLi

LiLi is a Chrome extension for LinkedIn that improves group member pages by replacing the default action with a smarter `Connect` or `Pending` state, while keeping LinkedIn's native behavior where it should stay untouched.

На русском: LiLi это Chrome extension для LinkedIn, которое делает страницы участников групп полезнее: вместо слепого стандартного действия оно показывает более точный `Connect` или `Pending`, при этом не ломая нативное поведение LinkedIn там, где его нужно сохранить.

## Preview

![LiLi extension preview](docs/preview.svg)

## English

### What LiLi Does

LiLi focuses on LinkedIn group member pages and tries to answer one practical question as early as possible: should this card still show `Connect`, or is there already a pending invite behind the scenes?

Main capabilities:

- Leaves the native `Message` action untouched for `1st` degree connections.
- Replaces the action for non-`1st` members with `Connect`, `Pending`, or a loading state.
- Sends invitations without navigating away from the current group members page.
- Uses LinkedIn's own invitation API instead of opening a hidden invite iframe.
- Reuses LinkedIn page data and network responses when the page already exposes invitation state.
- Falls back to fetching the profile document only when the group page does not expose enough information.
- Caches both `Connect` and `Pending` results for 24 hours to avoid repeating the same work.
- Syncs `Pending` state from LinkedIn's sent invitations page.
- Syncs explicit `Connect` or `Pending` state from an opened concrete profile page.
- Shares cached status across supported LinkedIn pages through extension storage.
- Throttles fallback profile checks with a queue, independent workers, rolling budget, cooldowns, and cross-tab leases.

### Supported LinkedIn Pages

LiLi currently works with three LinkedIn page types:

1. Group members pages such as `https://www.linkedin.com/groups/123/members/`.
2. Concrete profile pages such as `https://www.linkedin.com/in/{slug}/`.
3. Sent invitations page at `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### How Status Resolution Works

On group member pages, LiLi resolves the action in layers, from the cheapest source to the most expensive one:

1. If the member is `1st` degree, LiLi keeps the native `Message` action.
2. If a fresh cached result already exists, LiLi immediately shows `Connect` or `Pending`.
3. If LinkedIn page data or live Voyager responses already expose invitation state, LiLi upgrades the card from that signal.
4. If the page still does not prove the state, LiLi queues a fallback profile fetch.
5. The fallback fetch opens the profile HTML document in the background, parses LinkedIn's explicit invitation markers, then caches the result.
6. Clicking `Connect` uses LinkedIn's own invite API, and on success or known pending-like responses LiLi stores `Pending` immediately.

This layered design matters because LinkedIn often exposes enough relationship state without needing a profile fetch, and LiLi tries to avoid unnecessary traffic.

### Popup Guide

The popup has two roles:

1. It is a settings panel for the fallback scheduler.
2. It is a live runtime dashboard for the scheduler and cache.

Important interpretation rule:

- The top summary counters are aggregated across all active LinkedIn group-member tabs that are currently reporting runtime stats.
- The detailed debug cards below are based on the most recently updated reporting tab.
- The cache count is shared across supported LinkedIn pages because the cache lives in extension storage.

### Popup Summary Counters

- `Queued`: how many fallback profile jobs are still waiting in queue across reporting group-member tabs.
- `Active`: how many tracked runtime requests are currently in flight across reporting tabs.
- `Tabs`: how many active group-member tabs are currently publishing runtime stats.
- `Checks OK`: how many fallback checks completed successfully.
- `Cache entries`: how many valid cached `Connect` or `Pending` records currently exist.

### Wait Gates

These fields explain why the next queued job is not starting yet.

- `Queue gate`: the dominant reason the queue is currently blocked for the primary reporting tab.
- `Earliest worker gap`: how long until the earliest idle worker finishes its own per-worker gap and jitter delay.
- `Cooldown remaining`: how long the shared protection cooldown still blocks starts.
- `Idle remaining`: how long until the page satisfies the shared scroll-idle requirement.
- `Budget remaining`: how long until the shared rolling budget allows another start.
- `Next drain`: when the scheduler plans to wake up and reevaluate the queue.

`Queue gate` values are best understood like this:

- `idle`: there is no queued work for the primary tab.
- `workers`: all workers are busy.
- `gap`: a worker exists, but its personal gap and jitter window has not elapsed yet.
- `cooldown`: LinkedIn protection-like failures triggered a shared backoff.
- `budget`: the rolling request budget is exhausted for now.
- `idle + draining` or similar: a blocking gate exists while the scheduler is already in the middle of a reevaluation cycle.

### Scheduler State

- `Busy workers`: number of currently occupied workers versus configured workers for the primary reporting tab.
- `Oldest queued`: age of the oldest queued job in that tab.
- `Recent starts`: number of recent fetch starts versus the configured rolling-budget maximum.
- `Failure streak`: current shared backoff streak used to expand cooldown after repeated failures.
- `Failed total`: total number of failed fallback checks.
- `Leases`: number of cross-tab slug leases currently held in shared storage.
- `Last failure`: latest failure code with age.
- `Last check OK`: age of the most recent successful fallback check.

### Failure Breakdown

This block shows which failure classes the scheduler has seen most often:

- `Challenge`: LinkedIn served a protection or verification page.
- `Rate limit`: LinkedIn signaled throttling behavior.
- `Timeout`: the fallback fetch timed out.
- `Forbidden`: LinkedIn returned a forbidden-like response.
- `Server`: LinkedIn returned a server-side failure.
- `Parse`: the response arrived, but LiLi could not confidently interpret it.
- `Other`: uncategorized failures.

If `Challenge` or `Rate limit` keeps growing, the correct response is usually to slow the scheduler down rather than increasing workers.

### Effective Settings

This card shows the actual normalized settings currently used by the primary reporting tab.

- `Workers`: number of independent workers that pull jobs from one shared queue inside the tab.
- `Per-worker gap`: mandatory wait after a worker starts a job before the same worker may start another one.
- `Per-worker jitter`: random delay range added on top of the per-worker gap.
- `Shared scroll idle`: page-level quiet period required before fallback fetches may start.
- `Shared rolling budget`: maximum number of starts allowed inside the rolling window across all workers.
- `Shared backoff cap`: maximum shared protection cooldown after repeated protection-like failures.

### Scheduler Settings Explained

#### `Workers`

This is the number of independent workers inside one tab. The queue is shared, but each worker has its own personal gap and jitter gate.

Practical meaning:

- `1` means fully sequential fallback fetching.
- `2` or `3` allows multiple in-flight fetches, but still respects shared cooldown, shared rolling budget, and shared scroll-idle.
- Higher values increase throughput, but they also increase the chance of LinkedIn protection responses.

#### `Per-worker gap, ms`

Minimum delay between two starts by the same worker. This does not delay another worker that is already ready.

#### `Per-worker jitter min, ms` and `Per-worker jitter max, ms`

Random delay range added on top of the worker gap. This spreads starts over time and avoids a too-regular request pattern.

#### `Shared scroll idle, ms`

Fallback fetches are low-priority. LiLi waits until the page has been still for this amount of time before starting them.

#### `Shared rolling budget, fetches`

Maximum number of fallback fetch starts allowed inside the rolling window, across all workers in the tab.

#### `Rolling window, minutes`

The length of the moving time window used by the rolling budget.

#### `Shared backoff cap, minutes`

Upper limit for the shared cooldown after repeated protection-like failures such as challenge pages or rate limits.

### How To Tune The Scheduler

Safe starting point:

- `Workers`: `2`
- `Per-worker gap`: around `3000` ms
- `Per-worker jitter`: something like `100-10000` ms
- `Shared scroll idle`: around `1000` ms
- `Shared rolling budget`: around `15` starts per `2` minutes

What to do if the queue feels too slow:

1. Increase `Workers` carefully.
2. Reduce `Per-worker gap` carefully.
3. Reduce jitter range only if necessary.

What to do if `Challenge`, `Rate limit`, or cooldown values rise:

1. Lower `Workers`.
2. Increase `Per-worker gap`.
3. Increase jitter range.
4. Lower the rolling budget.

### Install Locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project root folder, the one that contains [manifest.json](manifest.json).

### Permissions And Privacy

- `storage`: used to persist the scheduler settings, runtime stats, and the 24-hour profile-status cache.
- `tabs`: used by the extension lifecycle logic to reload LinkedIn tabs after extension updates.
- `https://www.linkedin.com/*`: required so the content script can run on supported LinkedIn pages.

Privacy notes:

- LiLi does not send data to external servers.
- All logic runs locally in the browser against the current LinkedIn page.
- Background profile fetches are same-origin LinkedIn requests.
- Cached relationship state stays in extension storage.

### Project Files

- [manifest.json](manifest.json): Chrome extension manifest.
- [content.js](content.js): main content script, scheduler, action replacement, profile parsing, invite flow.
- [popup.html](popup.html): popup UI layout.
- [popup.js](popup.js): popup settings and runtime dashboard logic.
- [profile-fetch-settings.js](profile-fetch-settings.js): scheduler settings normalization and defaults.
- [content.css](content.css): visual tweaks for generated buttons.
- [docs/profile-status-requirement.md](docs/profile-status-requirement.md): requirement notes for cached profile-status resolution.

### Limitations

- LinkedIn changes DOM, CSS, and internal payload shapes frequently.
- `Pending` detection remains best-effort and depends on LinkedIn continuing to expose stable markers.
- Under cooldown or exhausted rolling budget, fallback checks may be delayed even though cache and passive signals continue to work.
- Some profiles may still require extra LinkedIn UI steps, quota checks, or email gating that cannot be bypassed reliably.

## Русский

### Что Умеет LiLi

LiLi в первую очередь решает практическую задачу на странице участников группы LinkedIn: как можно раньше понять, нужно ли на карточке показывать `Connect`, или приглашение уже существует и надо показывать `Pending`.

Основные возможности:

- Для контактов `1st` degree оставляет нативную кнопку `Message` без изменений.
- Для не-`1st` участников показывает `Connect`, `Pending` или состояние загрузки.
- Отправляет приглашение, не уводя пользователя со страницы участников группы.
- Использует собственный invite API LinkedIn, а не скрытый iframe.
- Переиспользует уже доступные данные страницы и сетевые ответы LinkedIn, если статус приглашения уже где-то есть.
- Запрашивает HTML профиля только тогда, когда сама страница группы не дает достаточно информации.
- Кэширует результаты `Connect` и `Pending` на 6 часов.
- Подтягивает `Pending` со страницы отправленных приглашений LinkedIn.
- Подтягивает явный `Connect` или `Pending` с открытой страницы конкретного профиля.
- Делится кэшем между поддерживаемыми страницами LinkedIn через storage расширения.
- Ограничивает fallback-проверки через очередь, независимых workers, rolling budget, cooldown и cross-tab leases.

### Какие Страницы Поддерживаются

Сейчас LiLi работает с тремя типами страниц:

1. Страницы участников группы, например `https://www.linkedin.com/groups/123/members/`.
2. Страницы конкретного профиля, например `https://www.linkedin.com/in/{slug}/`.
3. Страница отправленных приглашений `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.

### Как Определяется Статус

На странице участников группы LiLi идет от самых дешевых источников к самым дорогим:

1. Если участник `1st` degree, остается штатная кнопка `Message`.
2. Если в кэше уже есть свежий результат, сразу показывается `Connect` или `Pending`.
3. Если нужное состояние уже видно в данных самой страницы или в live Voyager-ответах LinkedIn, карточка обновляется по этому сигналу.
4. Если данных все еще не хватает, профиль ставится в очередь на fallback-проверку.
5. Fallback-проверка загружает HTML профиля в фоне, ищет явные маркеры invitation state и записывает результат в кэш.
6. При клике `Connect` используется тот же invite API LinkedIn, а при успехе или известном pending-подобном ответе в кэш сразу пишется `Pending`.

Такой порядок важен: LinkedIn часто уже содержит нужный статус прямо на странице, и LiLi старается не делать лишние запросы к профилям.

### Как Понять Popup

Popup выполняет две задачи:

1. Это панель настроек fallback scheduler.
2. Это live dashboard для очереди, workers и кэша.

Главное правило интерпретации:

- Верхние summary-показатели агрегируются по всем активным tabs со страницами участников групп, которые сейчас публикуют runtime stats.
- Подробные debug-карточки ниже показывают состояние только для той вкладки, которая обновлялась последней.
- `Cache entries` общий для всех поддерживаемых страниц, потому что кэш хранится в extension storage.

### Верхние Показатели Popup

- `Queued`: сколько fallback jobs сейчас ждут в очереди по всем reporting tabs.
- `Active`: сколько отслеживаемых runtime requests сейчас выполняется по всем reporting tabs.
- `Tabs`: сколько активных group-members tabs сейчас публикуют runtime stats.
- `Checks OK`: сколько fallback-проверок успешно завершилось.
- `Cache entries`: сколько валидных кэш-записей `Connect` или `Pending` сейчас существует.

### Блок Wait Gates

Этот блок объясняет, почему следующая job из очереди пока не стартует.

- `Queue gate`: главная причина, по которой очередь сейчас заблокирована для основной reporting tab.
- `Earliest worker gap`: сколько осталось ждать до ближайшего idle worker, у которого закончится его личный gap и jitter.
- `Cooldown remaining`: сколько еще действует общий protection cooldown.
- `Idle remaining`: сколько осталось до выполнения общего scroll-idle условия.
- `Budget remaining`: сколько осталось до следующего разрешенного старта по rolling budget.
- `Next drain`: когда scheduler снова проснется и пересчитает очередь.

Как понимать `Queue gate`:

- `idle`: в основной вкладке сейчас нет queued jobs.
- `workers`: все workers заняты.
- `gap`: свободный worker есть, но его личное окно gap/jitter еще не закончилось.
- `cooldown`: действует общий backoff после protection-like failures.
- `budget`: временно исчерпан rolling budget.
- `idle + draining` и похожие значения: блокирующий gate есть, и при этом scheduler уже находится в цикле пересчета.

### Блок Scheduler State

- `Busy workers`: сколько workers занято сейчас из общего числа workers в основной вкладке.
- `Oldest queued`: возраст самой старой queued job в этой вкладке.
- `Recent starts`: сколько стартов уже было внутри rolling window по отношению к лимиту.
- `Failure streak`: текущая общая серия ошибок, которая влияет на рост cooldown.
- `Failed total`: общее число неуспешных fallback checks.
- `Leases`: сколько cross-tab leases сейчас занято в общем storage.
- `Last failure`: последний код ошибки и его возраст.
- `Last check OK`: сколько времени прошло с последней успешной fallback-проверки.

### Блок Failure Breakdown

Здесь видно, какие типы ошибок встречались чаще всего:

- `Challenge`: LinkedIn вернул protection или verification page.
- `Rate limit`: LinkedIn показал признаки троттлинга.
- `Timeout`: fallback-запрос не успел завершиться.
- `Forbidden`: LinkedIn вернул ответ, похожий на запрет доступа.
- `Server`: серверная ошибка со стороны LinkedIn.
- `Parse`: ответ пришел, но LiLi не смог уверенно его интерпретировать.
- `Other`: все прочие ошибки.

Если растут `Challenge` или `Rate limit`, правильнее обычно не увеличивать workers, а наоборот замедлять scheduler.

### Блок Effective Settings

Этот блок показывает фактически нормализованные настройки, которые сейчас использует основная reporting tab.

- `Workers`: число независимых workers, которые берут jobs из одной общей очереди внутри вкладки.
- `Per-worker gap`: обязательная пауза после старта job, прежде чем тот же worker сможет начать следующую.
- `Per-worker jitter`: случайная задержка, добавляемая сверху к per-worker gap.
- `Shared scroll idle`: общее требование тишины на странице перед стартом fallback-запросов.
- `Shared rolling budget`: максимум стартов внутри rolling window сразу для всех workers.
- `Shared backoff cap`: верхний предел общего cooldown после repeated protection-like failures.

### Как Правильно Понимать Настройки

#### Поле `Workers`

Это число независимых обработчиков внутри одной вкладки. Очередь при этом одна общая, но у каждого worker свой личный gate по gap и jitter.

Практический смысл:

- `1` означает полностью последовательную fallback-проверку.
- `2` или `3` разрешает несколько одновременных запросов, но общий cooldown, общий rolling budget и общее scroll-idle все равно остаются общими.
- Слишком большие значения повышают throughput, но также повышают риск protection-ответов LinkedIn.

#### Поле `Per-worker gap, ms`

Минимальная пауза между двумя стартами одного и того же worker. Другой worker при этом может стартовать раньше, если он уже готов.

#### Поля `Per-worker jitter min, ms` и `Per-worker jitter max, ms`

Диапазон случайной задержки, который добавляется к gap конкретного worker. Это делает pattern запросов менее регулярным.

#### Поле `Shared scroll idle, ms`

Fallback-запросы считаются низкоприоритетными. LiLi ждет, пока страница не станет неподвижной на заданное время, и только потом стартует такие запросы.

#### Поле `Shared rolling budget, fetches`

Максимум стартов fallback-запросов в пределах rolling window сразу для всех workers внутри вкладки.

#### Поле `Rolling window, minutes`

Длина скользящего временного окна, которое используется для rolling budget.

#### Поле `Shared backoff cap, minutes`

Максимальный общий cooldown после repeated protection-like failures, например challenge page или rate limit.

### Как Настраивать Scheduler На Практике

Безопасная стартовая точка:

- `Workers`: `2`
- `Per-worker gap`: около `3000` ms
- `Per-worker jitter`: например `100-10000` ms
- `Shared scroll idle`: около `1000` ms
- `Shared rolling budget`: около `15` стартов за `2` минуты

Если очередь кажется слишком медленной:

1. Осторожно увеличивай `Workers`.
2. Осторожно уменьшай `Per-worker gap`.
3. Уменьшай jitter range только если это действительно нужно.

Если растут `Challenge`, `Rate limit` или cooldown:

1. Уменьшай `Workers`.
2. Увеличивай `Per-worker gap`.
3. Увеличивай jitter range.
4. Уменьшай rolling budget.

### Локальная Установка

1. Открой Chrome и перейди на `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери корневую папку проекта, ту, в которой лежит [manifest.json](manifest.json).

### Разрешения И Приватность

- `storage`: нужно для хранения настроек scheduler, runtime stats и 24-часового profile-status cache.
- `tabs`: нужно для lifecycle-логики расширения, которая может перезагружать LinkedIn tabs после обновления расширения.
- `https://www.linkedin.com/*`: нужно, чтобы content script работал на поддерживаемых страницах LinkedIn.

Про приватность:

- LiLi не отправляет данные на внешние серверы.
- Вся логика работает локально в браузере на текущей странице LinkedIn.
- Фоновые profile-fetch запросы идут только в same-origin LinkedIn.
- Кэш relationship state остается в extension storage.

### Файлы Проекта

- [manifest.json](manifest.json): manifest Chrome extension.
- [content.js](content.js): основной content script, scheduler, подмена действий, разбор профилей, invite flow.
- [popup.html](popup.html): layout popup-интерфейса.
- [popup.js](popup.js): логика popup-настроек и runtime dashboard.
- [profile-fetch-settings.js](profile-fetch-settings.js): нормализация настроек scheduler и default values.
- [content.css](content.css): визуальные стили для сгенерированных кнопок.
- [docs/profile-status-requirement.md](docs/profile-status-requirement.md): требования и заметки по cached profile-status resolution.

### Ограничения

- LinkedIn часто меняет DOM, CSS и внутренние payload shapes.
- Определение `Pending` остается best-effort и зависит от того, продолжит ли LinkedIn отдавать стабильные маркеры.
- Во время cooldown или при исчерпанном rolling budget fallback-проверки могут заметно задерживаться, даже если кэш и пассивные сигналы продолжают работать сразу.
- Некоторые профили все еще могут требовать дополнительных UI steps, quota checks или email gating, которые расширение не может надежно обойти.
