/**
 * Часть D (2026-10-17): нижняя панель урока центрируется по КОНТЕЙНЕРУ СЦЕНЫ, а не по окну.
 *
 * Полоса прижата к нижнему краю экрана (`position: fixed`) и раньше имела `left: 0; right: 0`,
 * то есть её центр был центром ОКНА. Сцена сдвинута вправо боковой панелью приложения и правой
 * панелью урока (участники, комментарии), поэтому полоса висела левее видео и доски. Хук пишет на
 * `:root` одну величину — координату центра контейнера сцены, — а CSS ставит полосу в этот центр
 * (`left: var(--scene-center); transform: translateX(-50%)`).
 *
 * Пересчёт — по ResizeObserver самой сцены: раскрытие и сворачивание любой панели меняет её
 * ширину, значит центр пересчитывается сам, без опроса по таймеру. В полноэкранном режиме сцена
 * занимает всё окно, поэтому центр совпадает с центром окна.
 *
 * Хук отдаёт КОЛБЭК-реф, а не принимает чужой: `.lesson-main` появляется не сразу (сначала
 * загрузка урока и экран входа в комнату), и effect, прочитавший ref один раз, на пустом месте
 * просто ничего бы не наблюдал.
 */
import { useCallback, useEffect, useState } from 'react';

const CENTER = '--scene-center';

export function useSceneBand(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!el) return;
    const root = document.documentElement;
    let raf = 0;

    const write = () => {
      raf = 0;
      if (document.fullscreenElement) {
        root.style.setProperty(CENTER, `${Math.round(window.innerWidth / 2)}px`);
        return;
      }
      const r = el.getBoundingClientRect();
      root.style.setProperty(CENTER, `${Math.round(r.left + r.width / 2)}px`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(write); };

    write();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);
    document.addEventListener('fullscreenchange', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('fullscreenchange', schedule);
      root.style.removeProperty(CENTER);
    };
  }, [el]);

  return useCallback((node: HTMLElement | null) => setEl(node), []);
}
