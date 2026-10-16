import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Часть A (2026-10-16): SPA обязана узнать включатель ДО монтирования урока, поэтому значения
 * приходят с сервера (`GET /api/features`), а не из сборки: владелец отключает поведение
 * переменной `LESSON_PERSIST` в Render без пересборки образа.
 */
export interface Features { lessonPersist: boolean }

/** Значение по умолчанию — ВКЛ, как и на сервере: нет ответа ≠ «выключено». */
const DEFAULTS: Features = { lessonPersist: true };

let cached: Features = DEFAULTS;
const listeners = new Set<(f: Features) => void>();

/** Один запрос на всё время жизни вкладки: включатели не меняются посреди урока. */
let started = false;
export function loadFeatures(): void {
  if (started) return;
  started = true;
  void api<Features>('/api/features')
    .then((f) => {
      cached = { lessonPersist: f?.lessonPersist !== false };
      for (const l of listeners) l(cached);
    })
    .catch(() => { /* отказ — остаёмся на умолчанию; урок не должен ломаться из-за смука */ });
}

/** Хук читающих: подписка на приход значения, старт с дефолта. */
export function useFeatures(): Features {
  const [f, setF] = useState<Features>(cached);
  useEffect(() => {
    loadFeatures();
    setF(cached);
    listeners.add(setF);
    return () => { listeners.delete(setF); };
  }, []);
  return f;
}
