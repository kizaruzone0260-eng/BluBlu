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
 * Пересчёт — по ResizeObserver и сцены, и рейки, плюс rAF после смены класса рейки и её
 * `transitionend` по ширине: раскрытие и сворачивание любой панели меняет ширину сцены, а
 * сворачивание рейки на широком окне ЕЁ МЕНЯЕТ ТОЛЬКО ПОЛОЖЕНИЕ сцены (колонка капирована и
 * отцентрована), о чем ResizeObserver молчит. В полноэкранном режиме сцена занимает всё окно,
 * поэтому пояс — нулевой, то есть полоса снова по центру окна.
 *
 * Хук отдаёт КОЛБЭК-реф, а не принимает чужой: `.lesson-main` появляется не сразу (сначала
 * загрузка урока и экран входа в комнату), и effect, прочитавший ref один раз, на пустом месте
 * просто ничего бы не наблюдал.
 */
import { useCallback, useEffect, useState } from 'react';

const LEFT = '--scene-left';
const RIGHT = '--scene-right';
/**
 * Рейка приложения. Она обязана быть под наблюдением, потому что её сворачивание умеет ДВИГАТЬ
 * сцену, не меняя её размера: колонка урока капирована `.container { max-width: 960px;
 * margin: 0 auto }`, и на широком окне (1920 px) между рейкой 232 px и рейкой 64 px содержимое
 * просто переезжает на 84 px. `ResizeObserver` сообщает только про размеры, поэтому пояс
 * оставался от предыдущего состояния — прогон 39089955091: `--scene-left` отстал от сцены на
 * 4 px при 1920 px и свёрнутой рейке.
 */
const RAIL = '[data-testid=sidebar]';

export function useSceneBand(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!el) return;
    const root = document.documentElement;
    const rail = document.querySelector<HTMLElement>(RAIL);
    let raf = 0;

    /** Запись идемпотентна: то же значение не трогает стиль и не порождает лишних мутаций. */
    const set = (name: string, value: string) => {
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    };
    const write = () => {
      if (document.fullscreenElement) {
        set(LEFT, '0px');
        set(RIGHT, '0px');
        return;
      }
      const r = el.getBoundingClientRect();
      set(LEFT, `${Math.max(0, Math.round(r.left))}px`);
      set(RIGHT, `${Math.max(0, Math.round(window.innerWidth - r.right))}px`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; write(); }); };

    write();
    /*
     * По поясу — ПРЯМОЙ вызов, без `schedule()`. Доставка ResizeObserver происходит уже после
     * расчёта раскладки этого кадра, то есть `getBoundingClientRect()` внутри неё даёт финальные
     * края сцены; отложенный же на следующий кадр запись даёт пояс, всегда на один кадр отстающий
     * от сцены, и если после последней доставки ничего не меняется, пояс так и остаётся
     * рассинхронизированным. Прогон 39085847851: `zz27` измерил расхождение центра полосы с
     * центром сцены в 4 px при одном и том же CSS — пояс догнал сцену с опозданием, а замер
     * (два подряд одинаковых кадра) этого не видит, потому что полоса к тому моменту уже
     * стоит на СТАРОМ поясе неподвижно.
     *
     * Рейка наблюдается ТЕМ ЖЕ наблюдателем: её ширина — это и причина, и единственный сигнал о
     * том, что сцена уехала. Размер самой сцены при этом не меняется.
     */
    const ro = new ResizeObserver(write);
    ro.observe(el);
    if (rail) ro.observe(rail);
    window.addEventListener('resize', schedule);
    document.addEventListener('fullscreenchange', schedule);

    /*
     * Два страховочных пути для случая, когда RO по рейке нет или он молчит: смена класса
     * (`collapsed`) пересчитывает пояс на следующем кадре, а `transitionend` по её ширине —
     * после конца анимации. Второй нужен не всегда: при `prefers-reduced-motion: reduce`
     * transition выключена (`styles.css:556`) и события о её конце не бывает — тогда работает
     * первый.
     */
    let mo: MutationObserver | null = null;
    const onRailSettled = (e: TransitionEvent) => {
      if (e.propertyName === 'width') schedule();
    };
    if (rail) {
      mo = new MutationObserver(schedule);
      mo.observe(rail, { attributes: true, attributeFilter: ['class'] });
      rail.addEventListener('transitionend', onRailSettled);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo?.disconnect();
      rail?.removeEventListener('transitionend', onRailSettled);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('fullscreenchange', schedule);
      root.style.removeProperty(LEFT);
      root.style.removeProperty(RIGHT);
    };
  }, [el]);

  return useCallback((node: HTMLElement | null) => setEl(node), []);
}
