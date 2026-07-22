# Max-Quality Open-Source T2V Pipeline — Research Report (July 2026)

(Условия: open-weights, self-host на Vast.ai, бюджет ≤5× flex, GPU до RTX PRO 6000 96GB / H100.)

## Ключевые выводы

### Модели, которые НЕ кандидаты (проверено)
- Wan 2.5/2.6/2.7 — API-only; открытые веса остановились на Wan 2.2. Страницы про "Wan 2.7 Apache 2.0" — SEO-фейки.
- HappyHorse-1.0/1.1 — заявлен как топ-1 open, по факту веса закрыты (HF 401, репо-плейсхолдер). Не планировать.
- SkyReels V4 — API-only; V3 открыл только control-варианты, не базовый T2V.
- Наследников Mochi/CogVideoX не существует.

### Реальные кандидаты (top-5 по качеству для cinematic)
1. **Wan 2.2 T2V-A14B** (Apache 2.0, 27B MoE, 2 эксперта) — лучший "кинематографичный" лук в open;
   fp8 влезает в 32GB 5090; с lightx2v distill LoRA ~1.5-4 мин/5s@720p на 5090; ComfyUI-экосистема огромная.
   Минусы: 720p потолок, нет звука, 5s-native (>7s дрейф), slow-motion артефакт дистилляции
   (фикс: гибрид — high-noise эксперт без/с ослабленной LoRA при CFG 2-3.5, low-noise с LoRA 1.0 CFG 1).
2. **LTX-2.3 22B dev** (не-дистилл) — топ измеренной open-арены; единственный open с нативным
   синхронным аудио одним проходом; нативно до 4K@50fps до 20s; bf16 ~42GB → нужен 96GB (RTX PRO 6000 WS);
   ~20-30 шагов CFG 3.5; ~4× медленнее дистилла → оценка 3-6 мин/клип на 6000 Pro (НЕ ПРОВЕРЕНО — бенчить).
3. HunyuanVideo 1.5 — хорош по текстурам, но 720p, без звука, медленный без дистилла (284s/5s@480p на 5090).
4. Kandinsky 5.0 Video Pro — слабый prompt following (0.44) → плох для 1000 разнообразных промптов.
5. Cosmos 3 Super — топ open I2V арены, но physical-AI модель, ComfyUI-графа нет. Наблюдать.

### Стадии улучшения качества (стоят ли компьюта)
- **SeedVR2** (3B/7B, Apache 2.0, зрелая нода numz) — ОБЯЗАТЕЛЬНО для Wan-пути: 720p→1080p+ с синтезом
  деталей; ~1-3 мин/клип. Это главный "шоукейс"-дельта.
- **FlashVSR 1.1** — 10× быстрее SeedVR2 (~10-30s/клип); ВНИМАНИЕ: часть ComfyUI-обёрток теряет
  LCSA-модуль → падение качества. Валидировать конкретную обёртку.
- **RIFE 4.9+** интерполяция — дёшево (10-30s), высокая воспринимаемая ценность. После SR.
- **Второй проход low-noise эксперта** (denoise 0.2-0.35) — да, при использовании distill LoRA.
- **LUT + плёночное зерно** (ffmpeg, CPU, ~секунды) — почти бесплатно, непропорционально большой эффект.

### Промпт-инжиниринг (для Gemini-генератора)
- Wan: Subject+Scene → Motion → Camera → Lighting → Mood → Quality tags, 80-120 слов, один абзац.
- LTX-2.3 (офиц. гайд): Subject → Action → Camera → Lighting → Lens → Constraints → Negatives,
  4-8 предложений, один абзац; тест: "реальный оператор смог бы снять без уточнений".
- РОВНО ОДНО движение камеры на клип (dolly-in, tracking, crane, orbital, handheld follow, rack focus...).
- Свет согласован с энергией движения; словарь: golden hour rim light, chiaroscuro, volumetric shafts...
- Плёнка/оптика: shot on 35mm, anamorphic flare, shallow DOF, 85mm, fine grain, halation.
- Генерировать структурный JSON {subject, action, setting, camera_move, lighting, palette, lens, mood} →
  рендер в абзац шаблоном; style bible на батч; линт: одно движение камеры, без текста в кадре,
  без счётных объектов; негативный промпт — серверная константа (не LLM).

### Звук
- LTX-2.3: нативный AV — бесплатно, как в flex.
- Для Wan: HunyuanVideo-Foley (топ open V2A, нода phazei, fp8 < 8GB VRAM, ~20-60s/клип). MMAudio — запасной.

### Рекомендация ресерча
- Primary: Wan 2.2 Cinematic Stack на 5090 ($27-53/1000) — лучший лук, но 5 компонентов и не кроет >7s/звук сам.
- Fallback: LTX-2.3 dev на RTX PRO 6000 WS ($50-100/1000) — конфиг-изменение от flex, кроет весь продукт.
- (Архитектурное решение проекта: строим LTX-dev ПЕРВЫМ как базу max — покрытие продукта, минимальный риск;
  Wan-стек — челленджер после; см. max-mode-architecture.md.)

### План верификации
1. Бенчмарк-матрица: 20 golden-промптов × пайплайн × {3/5/10s}; тайминги по стадиям, VRAM, $/видео.
2. Слепое сравнение с flex: бар ≥80% предпочтений max.
3. Канарейка 5% на первом батче 1000; телеметрия $/видео с алармом на 1.5× бенчмарка.
4. Моушен-регрессия: 5 fixed-seed промптов на каждое изменение LoRA/steps/CFG.

(Полный список источников — в отчёте ресерч-агента; ключевые: artificialanalysis.ai leaderboard,
Wan-Video/Wan2.2 GH, lightx2v/Wan2.2-Distill-Loras, ltx.io/blog/ltx-2-3-prompt-guide,
numz/ComfyUI-SeedVR2, OpenImagingLab/FlashVSR, Tencent-Hunyuan/HunyuanVideo-Foley,
civitai Wan2.2 workflow favorites.)
