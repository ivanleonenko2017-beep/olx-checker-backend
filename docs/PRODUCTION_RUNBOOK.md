# Знайдено — production runbook

Не зберігайте тут токени, паролі або значення секретних змінних.

## Production ресурси

- Render service: srv-dbcbps3rjlhs73bfunog
- URL: https://olx-checker-backend.onrender.com
- Production branch: pre-release/1.0.0-hardening
- Supabase project: ovblyievvseuugpbmxjy (eu-central-1)
- Render: Free plan, один інстанс, автодеплой із production branch.

## Перед кожним релізом

1. Перевірити GitHub Actions і diff PR.
2. Переконатися, що немає секретів, випадкових видалень чи необґрунтованих змін платіжної логіки.
3. Зафіксувати поточний Live deploy ID і commit SHA.
4. Перевірити Supabase migrations, RLS і grants.
5. Після merge дочекатися автоматичного Render deploy.
6. Звірити deployed SHA з merge commit.
7. Перевірити startup logs, /health, Supabase, worker і Telegram webhook.
8. Виконати контрольний сценарій Mini App.

## Rollback Render

1. Відкрити Render Dashboard → сервіс olx-checker-backend.
2. Відкрити Events / Deploys і знайти попередній deploy зі статусом Live.
3. Звірити його commit SHA з останнім відомим робочим SHA.
4. Запустити rollback на цей deploy через Render Dashboard.
5. Перевірити новий статус Live і startup logs.
6. Перевірити /health, Mini App та webhook.
7. Виправляти причину в окремій гілці. Не переписувати Git history.

Зафіксовані точки:
- До PR #36: deploy dep-dbp2bkfb9u1s73f6am80, commit 96ca8fc91532ef772855b3482a268b42db9cee1b.
- Після PR #37: deploy dep-dbp3atvavr4c73e6vhd0, commit 29cd0c4f8785c64cd8dc71b14c6134eee1b60ee6.
Перед rollback завжди перевіряти актуальний стан у Render.

## Аварійне вимкнення worker

Код підтримує змінну ENABLE_BACKGROUND_WORKER=false.

1. Render → Environment.
2. Додати/змінити ENABLE_BACKGROUND_WORKER на false.
3. Зберегти зміни та дочекатися redeploy/restart.
4. Перевірити startup logs: worker має бути вимкнений.
5. Після усунення причини повернути значення true.

Це вимикає фонові перевірки, але не вимикає webhook або всі API-запити.

## Режим без нових реєстрацій

Окремий перевірений feature flag для блокування нових користувачів у поточному коді не підтверджено. Не створювати довільну env-змінну й не вважати, що вона працює. Тимчасове обмеження публічного доступу можливе через перевірений maintenance mode Render або окрему протестовану зміну коду; врахувати, що maintenance mode може зупинити webhook Telegram.

## Моніторинг

- Перевіряти Render Events на deploy failures, restarts та suspension.
- Перевіряти application logs на помилки worker, OLX 403/429/timeouts, Supabase errors і Telegram API failures.
- Автоматичні Telegram-сповіщення адміністратору про всі критичні категорії помилок не підтверджені.
- Не надсилати токени, initData, повні Telegram ID або платіжні секрети у логах/сповіщеннях.

## OLX

1. Не використовувати проксі-ротацію, CAPTCHA bypass або агресивні повтори.
2. Перевіряти HTTP status, response size, час відповіді та лічильники сторінок.
3. При 429/403/timeout застосовувати backoff і обмежувати повтори.
4. Не показувати недоступність джерела як гарантовану відсутність оголошень.
5. Не послаблювати критерії міста, моделі, пам'яті або стану.

## Supabase і відновлення даних

- Перед schema/data операціями перевірити backup/PITR у Supabase Dashboard.
- Наявність автоматичних backup/PITR на поточному тарифі не підтверджена доступними даними.
- Не виконувати destructive SQL, TRUNCATE, DROP або reset у production.
- Перед міграцією перевірити SQL diff, grants, RLS та повторюваність.
- Після additive migration звірити кількість рядків ключових таблиць.

## Поточні обмеження

- Render Free може призупиняти сервіс після простою; webhook і worker можуть затримуватися. Для надійного публічного запуску це блокер, що потребує рішення власника.
- Render має один інстанс. Табличні leases захищають від параллельной обработки одного фильтра, но не заменяют полноценное масштабирование.
- Аварійний перемикач для блокування нових реєстрацій не підтверджений.
