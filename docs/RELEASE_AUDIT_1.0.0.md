# Знайдено — аудит готовності до релізу 1.0.0
Дата перевірки: 2026-11-09

## Вердикт

**НІ — публічний запуск поки не рекомендований.** PR #35 і PR #36 увійшли до production branch, але deploy PR #36 не стартував через відсутній runtime-модуль. Це виправлено PR #37; останній Render deploy досяг Live і startup logs підтверджують запуск сервера, Supabase та Telegram webhook. Пошук на живій OLX видачі після цих змін не перевірений. Render Free може засинати, а безпечна пропускна здатність worker для великої кількості користувачів не встановлена. Юридичні реквізити, правова перевірка, реальний платіж, backup/PITR і адміністраторські аварійні сповіщення лишаються непідтвердженими.

## Фаза A — середовище та production

- Render service srv-dbcbps3rjlhs73bfunog, регіон Frankfurt, Node runtime.
- Production branch pre-release/1.0.0-hardening; auto deploy on commit.
- Render plan: Free, один інстанс. Сервіс зараз не suspended, але Free plan має ризик автоматичного suspension після простою; це блокер для надійних webhook і регулярного worker.
- Останній deploy: dep-dbp3atvavr4c73e6vhd0, commit 29cd0c4f8785c64cd8dc71b14c6134eee1b60ee6, status Live.
- Попередній deploy PR #35: dep-dbp2bkfb9u1s73f6am80, commit 96ca8fc91532ef772855b3482a268b42db9cee1b, status Live.
- Deploy PR #36 dep-dbp3592vcj2c73cl221g завершився update_failed. Render log: Cannot find module './telegram-delivery-utils'. Попередній робочий інстанс залишився доступним; PR #37 додав модуль і тести.
- PR #37 merged; GitHub Actions Smart Search tests succeeded, Vercel preview Ready. Render build successful; app стартував, Supabase admin client налаштовано, worker увімкнено, Telegram webhook зареєстровано.
- /health існує в коді, але прямий HTTP smoke test через доступні інструменти не виконано.
- Telegram getWebhookInfo не перевірено: потрібен виклик Bot API з токеном; токен не читався й не розкривався.
- Render Free/один інстанс підтверджено через service metadata. Billing plan не змінювався.

## Supabase — стан даних і доступ

Проєкт ovblyievvseuugpbmxjy, регіон eu-central-1, ACTIVE_HEALTHY, PostgreSQL 17.11.

| Таблиця | Рядків |
|---|---:|
| users | 5 |
| filters | 0 |
| seen_ads | 0 |
| ad_price_history | 3 |
| referrals | 0 |
| referral_logs | 0 |
| payments | 0 |
| star_payments | 0 |
| monobank_payments | 0 |
| sponsor_donations | 0 |
| mono_jar_sync_state | 0 |
| user_daily_usage | 1 |
| filter_processing_locks | 0 |

Основні counts узгоджуються з попереднім зафіксованим станом; нова lock-таблиця порожня.

- Усі 13 таблиць public мають RLS увімкнений.
- SQL-перевірка показала, що anon і authenticated не мають SELECT privilege на цих таблицях; service_role має server-side доступ.
- Supabase advisor повідомляє INFO rls_enabled_no_policy для 13 таблиць. Це узгоджується з моделлю без прямого клієнтського доступу, але grants треба повторно перевіряти після змін.
- Acquire/release lock і grant referral reward мають SECURITY DEFINER; міграція обмежує EXECUTE для service_role.
- Backup/PITR на поточному Supabase тарифі не підтверджений. Власник має перевірити в Supabase Dashboard.

## Пошук OLX

PR #35 включає строгіший match моделі iPhone, обмежену пагінацію (2 сторінки за замовчуванням, максимум 3), межу 200 карток на сторінку, перевірку OLX URL, canonical deduplication, перевірку міста за location label та позначення непідтвердженої пам'яті.

**Live OLX пошук не підтверджений.** GitHub runner раніше отримував HTTP 403 від OLX/AWS edge; це не доводить блокування Render. Після останнього deploy не було контрольного запиту з Mini App, тому page 2, кількість відповідних карток і production funnel невідомі.

### Теоретичне навантаження

Access policy: Free — 1 фільтр / 15 хв; Trial — 3 фільтри / 5 хв; Premium — 20 фільтрів / 2 хв. Пагінація — 2 сторінки за замовчуванням, до 3. Нижче — верхній розрахунок для двох сторінок на фільтр, якщо всі фільтри постійно активні:

| Тариф | 10 користувачів | 100 користувачів | 1000 користувачів |
|---|---:|---:|---:|
| Free | 1.33 req/min (80/hour) | 13.33 req/min (800/hour) | 133.33 req/min (8000/hour) |
| Trial | 12 req/min (720/hour) | 120 req/min (7200/hour) | 1200 req/min (72000/hour) |
| Premium | 200 req/min (12000/hour) | 2000 req/min (120000/hour) | 20000 req/min (1200000/hour) |

Формула: users × filters per user × pages per check ÷ check interval in minutes. При 3 сторінках значення множаться на 1.5. Це теоретичний обсяг запитів, а не пропускна здатність.

Worker запускає цикл раз на 60 секунд; фільтри одного інстанса обробляються послідовно, після успішної доставки є 1.5 секунди паузи. Є міжінстансний lease на фільтр. У перевіреному worker фрагменті не знайдено глобального rate limiter для всіх OLX запитів або спільного TTL-кешу однакових пошуків. Безпечну кількість користувачів назвати не можна; масштабування до сотень/тисяч без глобального ліміту, кешу та черги не обґрунтоване.

## PR #36 і PR #37

PR #36 додав атомарний referral reward RPC, pending referral retry, filter lease locks, Telegram 429 retry / 403 blocked state, серверні filter limits Free/Trial/Premium та lockfile.
Його Render deploy не стартував через відсутній telegram-delivery-utils.js.

PR #37 додав модуль, що був відсутній, і unit tests. GitHub Actions Smart Search tests завершилися success. PR #37 merged у commit 29cd0c4f8785c64cd8dc71b14c6134eee1b60ee6. Render deploy dep-dbp3atvavr4c73e6vhd0 досяг Live; startup logs підтвердили запуск. Це усуває відомий startup crash, але не доводить повну поведінку referral/Telegram на реальних користувачах.

## Юридичні документи

Додано docs/LEGAL_OWNER_CHECKLIST.md з інвентаризацією категорій даних і плейсхолдерами для юридичного імені/ФОП, адреси, юрисдикції, контактів, строків зберігання, видалення, тарифів і повернення. Не вигадувати реквізити й не маркувати документи як затверджені. Остаточна правова перевірка — дія власника.

## Платежі

Код/схема містять Monobank і Telegram Stars payment records та функції активації Premium. Реальні платежі не проводилися. Не перевірено production payment flags, підписані події провайдера в sandbox та повний lifecycle реального платежу. Статус: логіка має наявні тести/ревью, реальний платіж не перевірений. Власнику потрібен один мінімальний реальний платіж після готовності юридичних документів; перевірити event ID, суму/валюту, Premium expiry, повтор події та безпечне скасування.

## Безпечний запуск / runbook

Додано docs/PRODUCTION_RUNBOOK.md з кроками rollback, вимкнення worker через ENABLE_BACKGROUND_WORKER=false, перевірками Supabase та OLX backoff.

Не підтверджено: автоматичні backup/PITR; Telegram alerting адміністратору; аварійний feature flag блокування нових реєстрацій; production webhook getWebhookInfo; пряма HTTP перевірка /health.

## Дизайн

Візуальну поліровку в цьому етапі не виконано. Потрібен окремий PR після перевірки пошуку та безпеки. Мобільний скриншот/візуальна перевірка не проводилися.

## Тести

- PR #35: GitHub Actions reported 66 tests passed, 0 failures.
- PR #36: CI passed before merge; Render runtime startup failure не був виявлений до production.
- PR #37: GitHub Actions Smart Search tests completed successfully; додано чотири тести retry delay та 403 classification.
- Render deploy PR #37: build successful, server process started, Supabase admin client configured, worker enabled, Telegram webhook set.
- Live OLX pagination, повний payment flow, реальне referral reward і mobile visual QA не тестувалися.

## Прийняті рішення

1. Не відкотувати production на PR #35 після того, як PR #37 відновив startup і досяг Live.
2. Не створювати RLS policies для anon/authenticated, оскільки прямий клієнтський доступ закритий grants, backend використовує service_role; advisor INFO зафіксовано як defense-in-depth observation.
3. Не змінювати тариф Render і Supabase без власника.
4. Не змінювати платіжну логіку й не проводити реальні платежі.
5. Не послаблювати фільтри міста, моделі, пам'яті або стану.
6. Не виконувати дизайн-редизайн до стабілізації пошуку та security review.

## Що залишається власнику

1. Після підтвердження Live виконати контрольний запит Mini App: «куплю айфон 15 на 256 в чернигове»; записати час і кількість релевантних оголошень на OLX.
2. Перевірити Supabase backups/PITR у Dashboard.
3. Вирішити перехід Render Free на платний план.
4. Надати юридичні реквізити, контакт і умови повернення; передати документи юристу.
5. Після готовності провести один реальний мінімальний платіж і перевірити Premium.
6. Перевірити Telegram webhook details через Bot API без публікації токена.

## Інструкція для контрольного пошуку

1. Відкрий Render Dashboard і переконайся, що deploy dep-dbp3atvavr4c73e6vhd0 показує Live.
2. Запиши поточний час до хвилини.
3. Відкрий Mini App «Знайдено» і введи рівно: «куплю айфон 15 на 256 в чернигове».
4. Запиши кількість і посилання результатів. Якщо створив тестовий фільтр — видали його після перевірки.
5. Відкрий OLX у браузері, вибери Чернігів і той самий запит; порівнюй лише оголошення, що відповідають місту, моделі та пам'яті.
6. Повернись у чат і надішли час запиту та кількість відповідних оголошень на OLX. За часом знайду production log trace.

## Наступний крок

Після контрольного пошуку: додати request-id і повну воронку відсіву, якщо production logs не дають per-ad причин; потім додати глобальний rate limit/TTL-кеш. Дизайн — окремим PR після стабілізації.


## Додаткова актуалізація після PR #38

- PR #38 (документація) merged у commit dfaaea2ad0793639816d42fed2f0fdec957c4d35.
- Render deploy dep-dbp3bv142hec73d0vu40 завершився статусом Live; deployed SHA збігається з commit PR #38.
- Startup logs після цього deploy підтвердили підключення Supabase, налаштований admin client, увімкнений worker, запуск сервера на port 10000 та реєстрацію Telegram webhook.
- GitHub Actions для PR #38: 70 тестів пройшли, 0 впало, 0 пропущено; node --check server.js пройшов.
- Прямий HTTP запит до /health та контрольний OLX search із Mini App досі не виконані. Статус пошуку залишається ⚠️ не вдалося перевірити в live сценарії.


## Додаткова актуалізація: перевірка Render trace та контрольного пошуку (2026-11-09)

### Результат пошуку прогону

Контрольний запит, заявлений у повідомленні власника як «куплю айфон 15 на 256 в чернигове», **не вдалося однозначно зіставити з конкретним production-прогоном**: час/дата та кількість оголошень OLX у повідомленні залишені незаповненими шаблонами. Не можна надійно визначити request-id або користувача лише за текстом запиту.

У логах Render після останнього Live deploy о 2026-11-09 21:09:08 UTC немає запису API search для iPhone 15/256. Найпізніший знайдений пошуковий запис за 2026-11-09 19:00:16 UTC стосується іншого запиту — iPhone 14/256 у Чернігові: parsed=30, cityMatched=4, detailsEnriched=0, returned=4. Його не можна вважати контрольним прогоном iPhone 15.

### Найближчий доступний діагностичний запис (не контрольний прогін)

2026-11-04 19:33:01 UTC: [OLX city diagnostics] для iPhone 15/256:
- parsed=30;
- cityMatched=5;
- detailsEnriched=3;
- returned=4;
- завершення API search: 2026-11-04 19:33:12 UTC, durationMs=22630;
- URL запиту містив /uk/chernigov/q-айфон 15 256/.

У city diagnostics записані 30 назв та локацій. П'ять карток мали локацію Чернігів; 25 інших карток мали інші міста/населені пункти та не пройшли міський фільтр. Це відповідає суворому фільтру міста, а не доводить втрату локальних оголошень. Серед п'яти чернігівських карток:
1. «Продам Антон 15 про макс на запчасти» — не містить підтвердження 256 GB; відсів через missing_required_term є обґрунтованим для запиту з обов'язковою пам'яттю 256 GB, але конкретний етап моделі/стану/ціни в цьому лог-записі не деталізовано.
2. «Айфон 15 про макс, 256» — Чернігів, у картці вказано 256.
3. «продаю айфон 15+» — Чернігів, пам'ять у картці не вказана; у попередньому результаті могла бути показана лише як непідтверджена, якщо спрацював storage fallback.
4. «Продам iPhone 15 PRO MAX / 256 gb» — Чернігів, 256 вказано.
5. «Продам телефон IPhone 15 pro Max 256G» — Чернігів, 256 вказано.

Ці назви не є повним звітом про втрати в контрольному прогоні. Лог показує лише загальне parsed/cityMatched/detailsEnriched/returned та агрегований rejected={"missing_required_term":1}; він не містить per-card trace для всіх наступних критеріїв.

### Обмеження доказів у поточній телеметрії

- У знайденому production trace немає кореляційного request-id, за яким можна зв'язати запит, сторінки та окремі картки.
- Не записані окремі кількості карток на сторінці 1/2/3, кількість після дедуплікації та послідовні лічильники після моделі, пам'яті, стану й ціни.
- Немає per-ad причини відсіву для кожної картки; є лише агрегована причина missing_required_term.
- Не можна встановити, чи була запитана друга/третя сторінка в заявленому контрольному прогоні.
- Не можна підтвердити, скільки результатів було позначено «не підтверджено» саме в контрольному прогоні.
- У найближчих логах немає прив'язаних до цього контрольного прогону 429, timeout або HTTP error. Це не є доказом відсутності таких подій у невідомому часовому вікні.
- Окремо: 2026-11-04 о 19:15–19:16 UTC є ECONNABORTED під час отримання контексту деталей OLX. Це інший прогін; його не можна приписувати контрольному запиту 2026-11-09.

### Render deploy та rollback

- PR #39, commit 13cef7fb6aaed1de51c8d3a4df86212c9b8f3e2d, Render deploy dep-dbp3cjbbc2fs73b2h2lg завершився status=live о 2026-11-09 21:09:08 UTC.
- Startup logs цього deploy показують запуск сервера, Supabase admin client, background worker та реєстрацію Telegram webhook.
- Rollback anchor на момент цієї актуалізації: deploy dep-dbp3cjbbc2fs73b2h2lg / commit 13cef7fb6aaed1de51c8d3a4df86212c9b8f3e2d. Попередній працездатний application deploy після відновлення runtime-модуля: dep-dbp3atvavr4c73e6vhd0 / commit 29cd0c4f8785c64cd8dc71b14c6134eee1b60ee6. Перед будь-яким rollback повторно перевірити Render events і поточний Live SHA.

### Рішення щодо виправлення пошуку

За наявними логами немає доказу втрати релевантної чернігівської картки саме через помилку коду в заявленому контрольному прогоні. Тому не змінювали фільтри міста, моделі, пам'яті, стану або ціни та не створювали ризикований patch на підставі неповних даних. Також не можна стверджувати, що OLX блокував Render у цьому прогоні: немає прив'язаного HTTP status/response trace.

Наступна необхідна технічна робота — додати безпечний структурований trace на один пошуковий request: випадковий request-id; номер сторінки та HTTP status/duration; counts до/після dedup; окремі counts після кожного критерію; per-card pseudonymous listing key та одна чітка причина першого відсіву. Не логувати повні Telegram ID, токени, initData або приватні дані. Після цього повторити контрольний запит і тільки за доказом дефекту робити мінімальний функціональний PR з fixture-регресіями.

### Актуальний висновок

**Вердикт: ТІЛЬКИ М'ЯКИЙ ЗАПУСК не обґрунтований до підтвердження пошуку.** Попередній загальний висновок «НІ — публічний запуск не рекомендований» залишається чинним. Live deploy та startup не замінюють перевірку реального OLX funnel. Чотири блокери:
- Пошук: НЕ ПІДТВЕРДЖЕНО на заявленому контрольному запиті; потрібен trace.
- Юридичні документи: шаблон/чекліст створений, але власницькі реквізити та юридичне затвердження не надані.
- Дизайн: окремий UI/UX та мобільний QA не виконані.
- Платежі: реальний платіжний цикл у production не перевірений.

### Дії власника, що залишаються

1. Надати фактичний час/дату контрольного запиту та кількість релевантних OLX оголошень; у попередньому повідомленні ці поля залишилися шаблонами.
2. Після отримання trace повторити один і той самий контрольний пошук та звірити конкретні URL оголошень.
3. Надати юридичне ім'я/статус, адресу для юридичних повідомлень, контакт, умови тарифів/скасування/повернення та отримати юридичну перевірку.
4. Вирішити Render Free vs платний план і перевірити Supabase backup/PITR у Dashboard.
5. Після юридичної готовності провести мінімальний реальний платіж і перевірити Premium activation/expiry/refund.
6. Надати фінальне погодження на дизайн-поліровку після стабілізації пошуку.


## Актуалізація після PR #40–#42: телеметрія, OLX sequence, Vercel/Render (2026-11-09)

### PR, CI, production deploy та rollback

- PR #40 «Document missing control-search trace in release audit» merged у production branch; merge SHA `06375508d6985ed3127a56f35333efa9d8206826`. Vercel Preview Comments — success. PR змінив тільки документацію.
- PR #41 «Add structured OLX search telemetry and admin dry-run» merged у SHA `75de01ddeb2ee10229a8a119b74ab536d73f05b5`. GitHub Actions: 76 tests passed, 0 failed, 0 skipped; `node --check server.js` виконаний. Render build succeeded, deploy `dep-dbp3kr95efls73ao94dg` досяг Live. Startup: Supabase admin client, worker, server port 10000, Telegram webhook registration.
- PR #42 «Clarify search funnel telemetry and test admin gate» merged у SHA `43ca8c573d34a721cb88b26dd16f410d5d5ac722`. GitHub Actions: 77 tests passed, 0 failed, 0 skipped; `node --check server.js` виконаний. Render deploy `dep-dbp3m0tg1s2s73btv320` досяг Live о 2026-11-09 21:29:07 UTC. Startup logs: server port 10000, Supabase admin client, background worker enabled, Telegram webhook registration.
- Поточний rollback anchor: deploy `dep-dbp3m0tg1s2s73btv320` / SHA `43ca8c573d34a721cb88b26dd16f410d5d5ac722`. Попередній робочий deploy до PR #42: `dep-dbp3kr95efls73ao94dg` / SHA `75de01ddeb2ee10229a8a119b74ab536d73f05b5`. Перед rollback повторно перевірити Render events і фактичний Live SHA.
- Нічого не змінювали в Supabase schema/data, Render тарифі, Telegram credentials, платежах або фільтрах.

### Нова телеметрія

Код у production записує структуровані `[SEARCH_TRACE]` події для:
- `manual` — ручний пошук з Mini App;
- `background` — фоновий пошук фільтра;
- `filter_warmup` — перевірка при створенні фільтра;
- `diagnostic` — адмінський dry-run.

Поля:
- request-id (12 hex), UTC timestamp, source, HMAC user hash (без Telegram ID), query hash (без сирого тексту), нормалізовані модель/пам'ять/стан/місто/ціни та кількість include/exclude термінів;
- на кожну сторінку: requested/final URL з редагованим вільним пошуковим сегментом, HTTP status, duration, response bytes, anti-bot indicator, card container counts, parsed card count, нові після dedup, cumulative unique, parser counters, stop reason;
- funnel: parsed, afterDedup, afterCardParse, city, критерії моделі/пам'яті/виключень/ціни/стану, returned, capacityUnverified та cityUnverified;
- до 25 per-listing відмов з псевдонімним listing key, посиланням, етапом, кодом причини й коротким значенням; решта згортається в omitted count;
- окремі page errors з HTTP 429/5xx, timeout/error code.

Raw Telegram ID, initData, bot token та raw query text у нових trace не записуються. URL очищаються від credentials та секретних query-параметрів. Пошуковий сегмент `/q-...` маскується.

Важливе обмеження: OLX parser поки не класифікує recommendation/promoted sections окремо. Тому поле `recommendationClassification` дорівнює `not_instrumented`; `afterCardParse` означає картки, які парсер витягнув з ad links, а не доведене виключення рекомендацій. `declaredTotal` поки null, бо загальна кількість з HTML/JSON не витягується. Не інтерпретувати ці поля як доведений відсутній блок у відповіді OLX.

### Адмінська dry-run діагностика

Доданий endpoint `POST /api/admin/search-diagnostics`.
- Вхід: JSON `{"query":"куплю айфон 15 на 256 в чернигове"}`.
- Авторизація: Telegram initData з заголовка `x-telegram-init-data`, перевірка підпису та існуючий серверний `adminAuthMiddleware`/admin lookup.
- Частота: не частіше одного запуску на хвилину на admin key.
- Повертає requestId, page traces, stop reason, funnel, bounded rejected cards і результати.
- Не створює фільтр, не споживає user quota, не пише в user tables і не надсилає Telegram-повідомлення.
- Unit test перевіряє, що відсутній користувач і звичайний користувач відхиляються authorization gate; окремий static test перевіряє, що endpoint підключений через adminAuthMiddleware. Це не замінює окремий live HTTP negative test з реальним Telegram initData.

### Факти зі старого production OLX trace — 4 листопада

Відновлений повний лог `[OLX city diagnostics]` від `2026-11-04T19:33:01.716Z` для пошуку iPhone 15/256 у Чернігові:
- URL: `https://www.olx.ua/uk/chernigov/q-%D0%B0%D0%B9%D1%84%D0%BE%D0%BD%2015%20256/`;
- parsed=30, cityMatched=5;
- API search completed 19:33:12.416 UTC: detailsEnriched=3, returned=4, rejected=`{"missing_required_term":1}`, durationMs=22630.
- Послідовність 30 parsed cards у логах: перші п'ять — Чернігів; позиції 6–30 — інші населені пункти. Місцеві та чужі міста в цьому конкретному витягнутому списку не перемішані.

| № | Назва (скорочено) | Місце з картки | Міський фільтр |
|---:|---|---|---|
| 1 | Продам Антон 15 Pro Max на запчастини | Чернігів | пройшов |
| 2 | Айфон 15 Pro Max, 256 | Чернігів | пройшов |
| 3 | продаю айфон 15+ | Чернігів | пройшов |
| 4 | Продам iPhone 15 Pro Max / 256 GB | Чернігів | пройшов |
| 5 | Продам телефон iPhone 15 Pro Max 256G | Чернігів | пройшов |
| 6 | Продам Айфон 15 256 GB | Велика Багачка | відсів |
| 7 | Айфон 15 Pro 256, АКБ 96 | Суми | відсів |
| 8 | iPhone 15 256 GB Neverlock | Київ, Святошинський | відсів |
| 9 | iPhone 15 Pro 256 GB | Солонка | відсів |
| 10 | iPhone 15 Pro Max 256 GB | Львів, Шевченківський | відсів |
| 11 | iPhone 15 Pro Max 256 GB E-sim | Кропивницький, Фортечний | відсів |
| 12 | Айфон 15 Pro Max 256, АКБ 95 | Суми | відсів |
| 13 | iPhone 15 Pro 256 GB | Умань | відсів |
| 14 | Айфон 15 Pro 256 GB | Київ, Оболонський | відсів |
| 15 | iPhone 15 256 GB | Київ, Святошинський | відсів |
| 16 | Apple iPhone 15 Pro Max 256 GB | Львів, Шевченківський | відсів |
| 17 | Айфон 15 Pro 256 GB | Миколаїв, Центральний | відсів |
| 18 | Айфон 15 Pro Max 256 GB | Одеса, Приморський | відсів |
| 19 | Apple iPhone 15 Pro Max 256 GB | Хмельницький | відсів |
| 20 | iPhone 15 256 GB, магазин | Умань | відсів |
| 21 | iPhone 15 Pro 256 GB | Кривий Ріг, Центрально-Міський | відсів |
| 22 | Айфон 15 Pro Max б/у | Харків, Салтівський | відсів |
| 23 | iPhone 15 Pro 128/256 | Київ, Голосіївський | відсів |
| 24 | Айфон 15 Pro Max | Київ, Деснянський | відсів |
| 25 | Айфон 15 Pro Max 256 | Суми | відсів |
| 26 | Айфон 15 Pro 256 GB E-sim | Вінниця | відсів |
| 27 | Продам айфон 15 256 | Лохвиця | відсів |
| 28 | iPhone 15 Pro 256 GB | Хмельницький | відсів |
| 29 | iPhone 15 Pro 256 GB | Умань | відсів |
| 30 | Apple iPhone 15 Pro Max 256 GB | Львів, Шевченківський | відсів |

Для позицій 6–30 причина відсіву — невідповідність строгому місту Чернігів, за locationDate і cardText diagnostics. Це не «втрачені чернігівські» оголошення в межах strict-city фільтра. У позиції 1 місто/модель підходили, але картка не підтверджувала 256 GB; єдина агрегована причина відмови в API log — missing_required_term. Позиції 2, 4, 5 містили 256 у заголовку. Позиція 3 не містила пам'ять у заголовку; старий log не записав окремий capacityUnverified count, тому не можна підтвердити, що вона мала саме цей прапорець, хоча вона входить у чотири повернуті результати.

Цей запис був до production пагінації, тому він не показує, чи тоді запитувалася сторінка 2: тодішній код працював з однією сторінкою. Він доводить лише послідовність першої витягнутої сторінки: 5 локальних на позиціях 1–5, потім 25 інших міст. Не доводить, що решта OLX сторінок не містить інших локальних оголошень.

### Чому в старих логах parsed=30

- В коді парсер обмежує rawItems значенням до 200 на сторінку; hard cap=30 у parser code не знайдено.
- Старі 30 — кількість карток, які були витягнуті з того HTML/DOM у конкретному прогоні, а не доведений application hard limit.
- Оскільки сирий HTML/JSON OLX не був збережений, а репозиторій не містить OLX HTML fixtures, неможливо встановити, чи це рівно 30 основних результатів OLX, чи основні результати разом з рекомендаціями/іншими секціями. Немає загальної кількості OLX, отриманої з HTML.
- У repository test directory є smart-search tests, але немає OLX HTML fixture. Створювати синтетичний HTML і називати його реальною відповіддю OLX не можна.

### URL і пагінація за поточним кодом

Для natural-language smart search з містом Чернігів:
- city slug: `chernigov`;
- path: `/uk/chernigov/q-<encoded search terms>/`;
- пам'ять (наприклад, 256) додається до upstream query;
- мін/макс ціна, якщо задані, додаються як `search[filter_float_price:from]` та `search[filter_float_price:to]`;
- сортування і радіус у цьому builder не додаються;
- `buildOlxPageUrl` ставить `?page=2` / `?page=3`, зберігаючи інші параметри;
- для city-scoped natural query за замовчуванням запитуються 2 сторінки, env limit може бути 1–3; зупинка — порожня сторінка, відсутність нових unique cards, page limit або upstream error/429.
- Для query, який сам є повним URL, `parseOlx` вимикає city-scoped pagination і обмежується однією сторінкою. Це окрема поведінка direct-URL режиму.

Шлях `/uk/chernigov/` є city-scoped URL, але старий production trace показав у витягнутих DOM-картках 25 інших міст. Тому сам URL не гарантує, що всі card nodes у HTML — місцеві; strict city filter окремо прибирає їх.

Власник не надав посилання OLX і число релевантних оголошень (обидва поля залишилися шаблонами). Одноразовий зовнішній перегляд OLX через доступний web fetch завершився inaccessible. Порівняти браузерний URL параметр-за-параметром, підтвердити 10–16 карток, або довести порядок секцій у вихідному HTML неможливо. Старий trace показує 25 міст, включно з Києвом, Львовом, Одесою, але без HTML заголовків секцій не можна визначити, чи OLX показав блок рекомендацій, змішану видачу або іншу структуру.

Потенційний edge case в коді: cardText fallback для міста виконується тільки коли `locationDate` порожній. Якщо `locationDate` заповнений не-міським текстом/датою, а cardText при цьому містить місцевий location label, картка не пройде. У старому trace всі п'ять місцевих карток мали коректний Чернігів у locationDate, а 25 чужих карток мали інші міста; отже, цей edge case не пояснює зафіксований результат і без HTML fixture не є доведеною причиною втрати. Логіку фільтрів не змінювали.

### Admin dry-run і поточна перевірка після deploy

- Live deploy PR #42: `dep-dbp3m0tg1s2s73btv320`, SHA `43ca8c573d34a721cb88b26dd16f410d5d5ac722`, status=live.
- Після deploy startup logs показали Supabase admin, worker enabled, server port 10000 та webhook registration.
- У доступному часовому вікні після deploy не знайдено `[SEARCH_TRACE]`, `API search` або `Worker Diagnostics` подій. Фонових фільтрів у Supabase було 0 за попереднім audit; manual/diagnostic контрольний запит після нового deploy не виконаний.
- `GET /health` через web fetch не вдалося перевірити. Render service metadata має порожній `healthCheckPath`; отже Render не запускає health-check probe за налаштованим шляхом.
- Telegram webhook registration видно в startup logs, але Bot API `getWebhookInfo` і фактичні pending updates/last_error не перевірені.

### Vercel

- GitHub PR comments показують Vercel project `olx-checker-backend`, project ID `prj_71cAWnDiVzwQ8LHAcDcwfcej4tu4`, пов'язаний з цим repository. Для PR #41 Vercel створив Preview deployment і позначив його Ready; PR #40 і #42 також мали Vercel Preview Comments check success.
- Це доводить наявність Vercel GitHub integration та PR Preview deployments, але не доводить, що production alias `olx-checker-backend.vercel.app` активний або що він містить працездатну копію бекенда.
- Перевірка `https://olx-checker-backend.vercel.app` через web fetch завершилася Cache miss; live HTTP статус і вміст не підтверджені.
- У `index.html` `BACKEND_URL = window.location.origin`. Тому якщо ця сторінка відкрита з Vercel, її API calls адресуються на Vercel origin. У repository root немає `vercel.json`; dashboard-level rewrites/domain settings не доступні для перевірки. Це ризик дублюючого/непрацюючого frontend origin, але не доказ доступу до Supabase.
- Vercel environment variable settings недоступні через наявні GitHub/Render connectors. Фактичні імена змінних у Vercel, чи вони однакові з Render, чи там є `SUPABASE_SERVICE_ROLE_KEY`/Telegram production secrets, і чи Vercel вказує на той самий Supabase — **не підтверджено**. Не стверджувати, що production secrets присутні або відсутні.
- Vercel Preview Comments check — integration/deployment feedback check; GitHub Actions `smart-search-tests` — окрема code-test workflow. PR #40–#42 успішно merged після успішного Vercel status. Доступу до branch protection settings немає, тому чи Vercel check є обов'язковим ruleset не підтверджено.
- Код сервера читає env names: `ADMIN_IDS`, `ALLOWED_ORIGINS`, `ENABLE_BACKGROUND_WORKER`, `ENABLE_TEST_PREMIUM_BYPASS`, `MONOBANK_JAR_LINK`, `MONOBANK_JAR_URL`, `OLX_SEARCH_MAX_PAGES`, `PAYMENTS_ENABLED`, `REGISTER_TELEGRAM_WEBHOOK`, `SERVER_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_STARS_PREMIUM_PRICE`, `TELEGRAM_WEBHOOK_SECRET`. Це лише env names, які читає код; це не перелік реально заданих Vercel variables.

### Render — план і вплив простою

- Service metadata: plan=Free, numInstances=1, region=Frankfurt, suspended=not_suspended, autoDeploy=commit, healthCheckPath порожній.
- Render Free web service зупиняється після 15 хвилин без inbound traffic і прокидається приблизно за одну хвилину після нового HTTP request. Free не підтримує scale beyond one instance. Офіційно Render не рекомендує Free для production: https://render.com/docs/free
- Внутрішній setInterval worker сам по собі не є inbound traffic і не гарантує, що Free instance залишиться активним. Коли service засинає, фонові перевірки припиняються; перший webhook/API request може затриматися на wake-up.
- Telegram Bot API повідомляє, що при неуспішному webhook response Telegram повторює доставку та зрештою припиняє після «reasonable number of attempts»; точна кількість не фіксується в нашому audit. https://core.telegram.org/bots/api
- Рекомендація: для стабільних webhook/background scans перевести Render на платний always-on compute після рішення власника. Тариф не змінювали.

### Висновок після PR #42

**Вердикт залишається: НЕТ для публічного запуску.** Телеметрія та адмінська діагностика вже в production; це інструменти для доказової перевірки, а не доказ того, що OLX search дає повну коректну видачу. Контрольний запит на новому deploy ще не виконаний.

- Пошук: 🛠 телеметрія/endpoint у Live; ⚠️ фактична сторінкова воронка після нового deploy не перевірена.
- Юридичні документи: ⚠️ checklist є; owner identity/contact/terms і legal review відсутні.
- Дизайн: ⚠️ окремий UI/UX і mobile QA не зроблені.
- Платежі: ⚠️ production payment flow не тестувався.

### Що лишається власнику

1. Запустити admin dry-run і ручний Mini App пошук з однаковим текстом; надіслати requestId dry-run, час ручного запиту та кількість/посилання оголошень OLX.
2. Надати фактичний URL OLX для порівняння параметрів; вирішити окремо, чи потрібен лише strict Чернігів, чи окремий явний режим «Чернігів + радіус/сусідні населені пункти».
3. Перевірити Vercel project settings: production domain, rewrites, environment variable names/targets; переконатися, що service-role key і Telegram bot token не дублюються у непотрібному Vercel environment.
4. Перевірити Supabase backup/PITR і вирішити Render Free vs paid.
5. Надати юридичні реквізити/умови та отримати правову перевірку.
6. Після юридичної готовності — реальний мінімальний платіж і Premium lifecycle QA.
7. Погодити окрему дизайн-поліровку після перевірки пошуку.


---

## Дополнение — аудит после запроса владельца от 11 ноября 2026

### Контрольный поиск

В сообщении владельца все поля ручного прогона оставлены шаблонами: ответ /status, ответ /diag, ссылка OLX, оба количества и описание замечаний не предоставлены. Решение по моделям также не выбрано. Поэтому фактическую воронку, HTTP-статусы, страницы 2/3, 429, таймауты и разницу браузерной/серверной выдачи по этому прогону установить нельзя. Старый trace от 4 ноября не заменяет новый контрольный запуск.

### Read-only команды подписок и рефералов

Добавлены Telegram-команды администратора:
- /sub <telegram_id> — read-only чтение тарифа, Trial/Premium дат, лимитов, дневного использования, количества фильтров, фильтров за лимитом, а также платежных/реферальных записей как свидетельств источника выдачи.
- /ref <telegram_id> — read-only чтение пригласившего, приглашённых, canonical referrals, legacy referral_logs, начисленных 3-дневных бонусов и расхождений статистики.

Обе команды используют серверную проверку администратора, общий лимит один запрос в минуту на администратора, экранирование HTML и маскирование Telegram ID. Обработчик команд не выполняет INSERT/UPDATE/UPSERT/DELETE. Команды не меняют данные.

Ограничение схемы: таблица users не хранит отдельное поле source для текущего Premium. Поэтому команда может показать наличие подтверждающих записей Stars, Monobank, legacy payments и referral rewards, но не может всегда однозначно установить, какой именно источник сформировал текущий срок Premium.

### Проверка текущих правил доступа по коду

Функция deriveAccess(user, isAdmin, now) рассчитывает план на переданном времени:
- Trial действует 4 дня с trial_started_at: 3 фильтра, 30 поисков в день, интервал 5 минут.
- После окончания Trial автоматически применяется Free: 1 фильтр, 5 поисков в день, интервал 15 минут.
- Premium действует, только если tariff='premium' и premium_until > now: 20 фильтров, 100 поисков в день, интервал 2 минуты.
- После истечения Premium расчёт также возвращает Free. Отдельное фоновое удаление или очистка фильтров для этого не требуется.

Worker сортирует фильтры по created_at и не обрабатывает фильтры за лимитом тарифа; он не удаляет их. В этом дополнении также согласован административный лимит воркера с ADMIN_IDS, чтобы администратор, разрешённый серверной проверкой, не получал случайный пользовательский лимит фонового worker.

### Проверки рефералов по SQL и схеме

Read-only просмотр определения grant_referral_reward показал:
- самоприглашение не может получить вознаграждение: обработка требует двух существующих пользователей и совпадения сохранённого pending referrer с переданным inviter; код первого /start также не сохраняет собственный ID как пригласившего;
- повторное начисление блокируется referral_attributed_at и уникальностью referrals.invitee_telegram_id, а вставка использует ON CONFLICT DO NOTHING;
- одно приглашение даёт пригласившему 3 дня Premium.

Это подтверждение структуры/кода БД, а не тест с реальными двумя Telegram-аккаунтами. Фактическую доставку реферальной ссылки, attribution и Premium начисление на реальных людях не выполняли.

### Снимок агрегированных production-данных

Read-only SQL-запрос без вывода Telegram ID на момент аудита вернул:
- users: 5;
- активный Premium: 0;
- активный Trial: 0;
- истёкший Trial: 3;
- referrals: 0;
- referral_logs: 0;
- filters: 0.

Это подтверждает, что в текущей базе нет реальных реферальных начислений для проверки end-to-end. Наличие трёх истёкших Trial согласуется с правилом четырёх дней, но без просмотра отдельных записей нельзя утверждать, что все пользовательские экраны/ограничения были проверены на реальных аккаунтах.

### Дизайн и юридические страницы

Визуальный редизайн не выполнен в этом PR. Скриншоты мобильного размера не получены; визуально не проверено.

Юридические API-страницы содержат draft-предупреждения и незаполненные обязательные сведения о владельце. Бот-команда /terms прямо сообщает, что полные данные поставщика и окончательные условия ещё должны быть опубликованы. Нельзя считать юридические документы завершёнными или утверждёнными. Проверка кликабельной доступности каждого юридического экрана в Mini App не выполнена.

### Вердикт после этого этапа

ТОЛЬКО МЯГКИЙ ЗАПУСК. Команды диагностики подписок/рефералов добавлены, access-policy имеет тестируемую временную модель, SQL referral reward и текущие агрегаты прочитаны. Но ручной контрольный прогон поиска отсутствует; реальная referral attribution, платежный lifecycle, юридические реквизиты, mobile visual QA и поведение после сна Render остаются непроверенными.
