# Сборка и публикация Docker-образа для GPU воркеров

## Зачем

Кастомный образ сокращает холодный старт инстанса с **~20 мин** до **~5-7 мин**.

| Шаг | Старый bootstrap | Кастомный образ |
|-----|-----------------|-----------------|
| apt-get + системные пакеты | ~2 мин | ✅ в образе |
| PyTorch nightly cu128 (2 ГБ) | ~5 мин | ✅ в образе |
| git clone ComfyUI + deps | ~3 мин | ✅ в образе |
| ComfyUI-LTXVideo + deps | ~2 мин | ✅ в образе |
| VideoHelperSuite + deps | ~1 мин | ✅ в образе |
| Скачивание LTX-2.3 (46 ГБ) из R2 | ~5 мин | ~5 мин |
| Скачивание Gemma FP4 (8.8 ГБ) из R2 | ~1 мин | ~1 мин |
| Pull образа | ~1 мин | ~3 мин |
| **Итого** | **~20 мин** | **~9 мин** |

После того как R2 полностью засеян (LTX + Gemma), общее время — ~9 мин,
из которых ~6 мин — неустранимая загрузка моделей по сети.

## Требования к сборке

- Машина с Docker и интернетом (GPU не нужен)
- Аккаунт на Docker Hub
- Достаточно места на диске (~15 ГБ для сборки)

## Сборка образа

```bash
cd "/Users/newzeland/Documents/New project"

# Замените YOUR_DOCKERHUB на ваш логин Docker Hub
DOCKERHUB_USER="YOUR_DOCKERHUB"
IMAGE="${DOCKERHUB_USER}/comfyui-ltx:cu128"

docker build -t "$IMAGE" .
docker push "$IMAGE"

echo "Image: $IMAGE"
```

Сборка занимает ~15-20 мин (PyTorch nightly + pip installs).
Образ весит ~4.3 ГБ compressed (публикуется на Docker Hub).

## После публикации — обновить WORKER_IMAGE

В файле `src/queues/stream-consumer.ts` замените строку:

```typescript
const WORKER_IMAGE = 'pytorch/pytorch:2.6.0-cuda12.6-cudnn9-runtime'; // TODO: replace with pre-built image after push
```

На:

```typescript
const WORKER_IMAGE = 'YOUR_DOCKERHUB/comfyui-ltx:cu128';
```

И также обновите `bootstrapUrl` чтобы новые инстансы использовали слимовый bootstrap:

```typescript
const bootstrapUrl = `${controlPlaneUrl}/worker/bootstrap-models.sh`;
```

Затем задеплоить:

```bash
bash deploy.sh
```

## Обновление образа

При изменениях в ComfyUI-LTXVideo или других зависимостях:

```bash
docker build --no-cache -t "${DOCKERHUB_USER}/comfyui-ltx:cu128" .
docker push "${DOCKERHUB_USER}/comfyui-ltx:cu128"
bash deploy.sh  # обновить CF Worker
```

## Что НЕ входит в образ

- Модели (LTX-2.3 checkpoint, Gemma FP4) — скачиваются из R2 при каждом старте
- `worker.py`, `workflow.json` — скачиваются с CF Worker при каждом старте
  (это позволяет обновлять логику без пересборки образа)
