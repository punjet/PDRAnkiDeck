# ПДР України — колода Anki (категорія B)

Колода Anki з усіма питаннями теоретичного іспиту ГСЦ МВС для категорії B: 1762 картки
(розділи 1–39 і 44–47), 1056 малюнків. Питання й відповіді взяті з офіційної бази,
**наказ № 225 від 29.10.2025** (чинна редакція), відповіді категорії B перевірені трьома
незалежними способами.

## Як користуватися

1. Зберіть колоду (`python build_deck.py`, див. нижче) або візьміть готовий
   `PDR_UA_category_B.apkg` і імпортуйте в Anki: *Файл → Імпорт*.
2. У налаштуваннях колоди: *Порядок нових карток → Порядок збирання: «Колода»*,
   інакше Anki перемішає пріоритети.
3. Темп: за 2 тижні — ~175 нових карток на день (2–2,5 год), за 1 тиждень —
   ~350 на день протягом 5 днів і 2 дні повторення (4–5 год). Для тижневого режиму:
   максимальний інтервал 3 дні, кроки навчання `10m 1h`, бажана утримуваність FSRS 0.92.
4. Готовність до іспиту: 5 пробних білетів поспіль з ≤1 помилкою
   (іспит — 20 питань за 20 хв, допускається ≤2 помилки).

Повторний імпорт оновленої колоди зберігає прогрес: GUID нотаток стабільні.

## Порядок карток

Білет складається з 10 питань ПДР, 4 — основ безпечного водіння, 4 — додаткових
питань категорії та 2 — домедичної допомоги (hsc.gov.ua, 16.09.2025). Чим менший
пул і більше місць у білеті, тим вища ймовірність, що конкретне питання трапиться,
тому колода поділена на яруси й іде від найвигіднішого:

| # | Підколода | Карток | Ймовірність питання в білеті |
|---|---|---|---|
| 1 | Додаткові питання кат. B (розд. 44–47) | 65 | ~6 % |
| 2 | Домедична допомога (розд. 37) | 60 | ~3,3 % |
| 3 | Основи безпечного водіння (розд. 35) | 171 | ~2,3 % |
| 4 | Топ помилок ГСЦ: регулювальник, нерегульовані перехрестя, круговий рух, розмітка | 302 | ~0,7 % |
| 5 | Решта ПДР — ситуації з малюнком | 684 | ~0,7 % |
| 6 | Решта ПДР — текстові питання | 480 | ~0,7 % |

Ярус 4 — теми з п'ятірки найчастіших помилок за даними ГСЦ (18.12.2025). Усередині
ярусу першими йдуть складніші питання: більше варіантів, є малюнок, довший текст
(публічної статистики помилок по окремих питаннях немає). Припущення: блок
«4 питання за категорією» — це розділи 44–47.

## Дані

```
data/official_pdf/   офіційні PDF ГСЦ — у репозиторії їх немає, див. нижче
data/questions.json  усі 2332 питання (усі категорії): текст, варіанти, відповідь, статус перевірки
data/images/         малюнки до питань
answer_overrides.json  відповіді, звірені вручну зі сканом
```

Поле `verified` у `questions.json`:

| значення | що означає | кат. B |
|---|---|---|
| `ocr+template+brut` | tesseract, власний класифікатор цифр і незалежний датасет [Brut322/pdr-test](https://github.com/Brut322/pdr-test) збігаються | 1646 |
| `template+brut` | tesseract не впевнений, класифікатор і Brut322 збігаються | 111 |
| `manual` | розбіжність, звірено очима зі сканом | 5 |
| `brut-only` / `brut-unconfirmed` | відповідь лише з Brut322 (бляклий 11-й аркуш скану, розділи 53–63) | 0 (поза кат. B: 125) |

Відповіді поза категорією B (`brut-only`, `brut-unconfirmed`) вручну не перевірялися.

## Перезбірка, коли ГСЦ оновить базу

Потрібні Python 3.11+ і [tesseract](https://github.com/tesseract-ocr/tesseract)
(`brew install tesseract`).

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

Офіційні PDF у репозиторій не входять. Їх треба скачати зі сторінки ГСЦ
[«Питання та іспит з ПДР»](https://hsc.gov.ua/index/poslugi/vidacha-posvidchennya-vodiya/pitannya-ta-ispit-z-pdr/)
і покласти в `data/official_pdf/` як `questions.pdf` (питання) та `answers.pdf`
(таблиця відповідей) — для бази за наказом № 225 від 29.10.2025.

hsc.gov.ua стоїть за Akamai:
з неукраїнського IP — «Access Denied», а з українського звичайний `curl` отримує 403.
Качати через `curl_cffi`:

```python
from curl_cffi import requests
s = requests.Session(impersonate="chrome")
open("questions.pdf", "wb").write(s.get(URL).content)
```

Далі:

```bash
mkdir -p work/ans
python parse_official.py data/official_pdf/questions.pdf work/          # питання + малюнки
python -c "import pymupdf,sys; [p.get_pixmap(dpi=300).save(f'work/ans/a{i+1:02d}.png') for i,p in enumerate(pymupdf.open(sys.argv[1]))]" data/official_pdf/answers.pdf
python ocr_answers.py work/ans work/ans_ocr.json                        # OCR таблиці відповідей
python build_dataset.py work/questions_official.json work/ans_ocr.json work/glyphs work/dataset.json answer_overrides.json
git clone https://github.com/Brut322/pdr-test work/pdr-test             # незалежна звірка
python finalize_dataset.py work/dataset.json work/pdr-test/data/questions.json answer_overrides.json data/questions.json
rm -rf data/images && cp -r work/images data/images
python build_deck.py data PDR_UA_category_B.apkg
```

`build_dataset.py` друкує розбіжності OCR і аномалії таблиці; `finalize_dataset.py`
завершується з помилкою, якщо хоч одна відповідь категорії B розходиться з Brut322 і
не звірена вручну. Такі питання звірте зі сканом і внесіть у `answer_overrides.json`
(`{"<розділ>-<номер>": відповідь}`).

Якщо в новій редакції зміниться нумерація, Brut322 теж має бути оновлений, інакше
звірка не зійдеться.

## Ліцензія та джерела

Код — [MIT](LICENSE). Тексти питань, відповіді й малюнки належать ГСЦ МВС України
(hsc.gov.ua) і під MIT не підпадають — див. розділ *Third-party content* у `LICENSE`.
Незалежна звірка — [Brut322/pdr-test](https://github.com/Brut322/pdr-test) (MIT).
