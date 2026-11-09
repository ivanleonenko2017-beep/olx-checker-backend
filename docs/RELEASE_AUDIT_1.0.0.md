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
