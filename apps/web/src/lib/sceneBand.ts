/**
 * Часть D (2026-10-17): нижняя панель урока центрируется по КОНТЕЙНЕРУ СЦЕНЫ, а не по окну.
 *
 * Полоса прижата к нижнему краю экрана (`position: fixed`) и раньше имела `left: 0; right: 0`,
 * то есть её центр был центром ОКНА. Сцена сдвинута вправо боковой панелью приложения и правой
 * панелью урока (участники, комментарии), поэтому полоса висела левее видео и доски. Хук пишет на
 * `:root` две величины — расстояния от краёв окна до краёв контейнера сцены, — а CSS ставит полосу
 * в центр этого пояса (`left: var(--scene-left); right: var(--scene-right); margin-inline: auto`).
 *
 * Пояс задан краями, а не центром (`--scene-center` + `translateX(-50%)`) намеренно: `transform`
 * на полосе делает её содержащим блоком для её же `position: fixed` меню, и меню «Ещё»/устройств
 * уезжают за экран (проверено на красных zz18/zz19/zz2 прогона 38997323161).
 *
 * Пересчёт — по ResizeObserver самой сцены: раскрытие и сворачивание любой панели меняет её
 * ширину, значит пояс пересчитывается сам, без опроса по таймеру. В полноэкранном режиме сцена
 * занимает всё окно, поэтому пояс — нулевой, то есть полоса снова по центру окна.
 *
 * Хук отдаёт КОЛБЭК-реф, а не принимает чужой: `.lesson-main` появляется не сразу (сначала
 * загрузка урока и экран входа в комнату), и effect, прочитавший ref один раз, на пустом месте
 * просто ничего бы не наблюдал.
 */
import { useCallback, useEffect, useState } from 'react';

const LEFT = '--scene-left';
const RIGHT = '--scene-right';

export function useSceneBand(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!el) return;
    const root = document.documentElement;
    let raf = 0;

    const write = () => {
      raf = 0;
      if (document.fullscreenElement) {
        root.style.setProperty(LEFT, '0px');
        root.style.setProperty(RIGHT, '0px');
        return;
      }
      const r = el.getBoundingClientRect();
      root.style.setProperty(LEFT, `${Math.max(0, Math.round(r.left))}px`);
      root.style.setProperty(RIGHT, `${Math.max(0, Math.round(window.innerWidth - r.right))}px`);
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
      root.style.removeProperty(LEFT);
      root.style.removeProperty(RIGHT);
    };
  }, [el]);

  return useCallback((node: HTMLElement | null) => setEl(node), []);
}
