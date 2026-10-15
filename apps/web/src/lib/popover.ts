/**
 * Одно размещение для всех всплывающих меню.
 *
 * Причина (2026-10-15): меню «Удалить рисунки ученика» было `position: fixed` с `top: 100%`, а
 * фиксированный элемент проценты считает от высоты ОКНА — список всегда рождался за нижним краем
 * экрана, и до него было нельзя дотянуться ни мышью, ни тестом. Такое же «прижми к кнопке» без
 * проверки вьюпорта написано в каждом меню по-своему (`.bar-menu` — снизу вверх, `.lang-menu` —
 * сверху вниз, `.chat-menu` — вообще у правого края сообщения), поэтому правила собраны здесь:
 *
 *  - меню целиком внутри вьюпорта: по горизонтали кламп к краям, по вертикали — переворот вверх,
 *    если снизу не помещается;
 *  - при очень низком окне меню укорачивается и прокручивается внутри, а не вылезает за экран;
 *  - закрывается по Escape и по клику/касанию снаружи (и по клику по самой кнопке — это уже
 *    делает сам компонент);
 *  - перепозиционируется при прокрутке и изменении размера окна, а не остаётся не у кнопки.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** Поле между меню и краем экрана. */
const MARGIN = 8;
/** Минимальная высота, которую ещё имеет смысл показывать вместо переворота. */
const MIN_HEIGHT = 96;

export type PopAlign = 'start' | 'center' | 'end';

export interface PopPos { top: number; left: number; maxHeight: number }

/**
 * Координаты меню по прямоугольнику кнопки и собственному размеру меню.
 *
 * Чистая функция — её можно проверить без DOM, и тест геометрии меню (zz23) сверяется с ней же.
 */
export function popPos(
  anchor: { top: number; bottom: number; left: number; width: number },
  box: { w: number; h: number },
  vw: number,
  vh: number,
  align: PopAlign = 'start',
  gap = 4,
): PopPos {
  const w = Math.min(box.w, vw - MARGIN * 2);
  const anchorX = align === 'center' ? anchor.left + anchor.width / 2 - w / 2
    : align === 'end' ? anchor.left + anchor.width - w
      : anchor.left;
  const left = Math.max(MARGIN, Math.min(anchorX, vw - w - MARGIN));

  const roomBelow = vh - anchor.bottom - gap - MARGIN;
  const roomAbove = anchor.top - gap - MARGIN;
  // Вниз, если там помещается хотя бы «разумный» кусок; иначе вверх, где больше места.
  const flip = roomBelow < Math.min(box.h, MIN_HEIGHT) && roomAbove > roomBelow;
  const room = flip ? roomAbove : roomBelow;
  const height = Math.max(MIN_HEIGHT, Math.min(box.h, room));
  const top = flip ? Math.max(MARGIN, anchor.top - gap - height) : anchor.bottom + gap;
  return { top, left, maxHeight: Math.max(MARGIN, Math.min(height, vh - top - MARGIN)) };
}

export interface UsePopover {
  ref: (node: HTMLElement | null) => void;
  style: CSSProperties;
  /** Пересчитать положение (например когда внутри меню поменялась высота). */
  place: () => void;
}

/**
 * Меню должно отрисовываться при `open === true` и получать `ref`/`style` отсюда. `anchor` —
 * кнопка, по которой оно открылось (её rect и её же клик обрабатываются наружным кликом).
 */
export function usePopover(params: {
  open: boolean;
  anchor: HTMLElement | null;
  align?: PopAlign;
  onClose: () => void;
}): UsePopover {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: -10000, left: -10000, visibility: 'hidden' });
  // Колбэки держим в ref: слушатели навешиваются один раз на открытое меню и не должны
  // устаревать между рендерами.
  const latest = useRef(params);
  latest.current = params;

  const place = useCallback(() => {
    const el = nodeRef.current;
    const a = latest.current.anchor;
    if (!el || !a) return;
    const p = popPos(a.getBoundingClientRect(), { w: el.offsetWidth, h: el.offsetHeight },
      window.innerWidth, window.innerHeight, latest.current.align ?? 'start');
    // `right`/`bottom`/`transform` сбрасываются намеренно: меню, которые раньше крепились чистым
    // CSS (`right: 0`, `bottom: calc(100% + 8px)`, `translateX(-50%)`), оставили бы эти правила
    // поверх наших координат — и вместо меню получили бы растянутую между двумя краями полосу.
    setStyle({
      position: 'fixed', right: 'auto', bottom: 'auto', transform: 'none',
      ...p, overflowY: 'auto', visibility: 'visible',
    });
  }, []);

  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    if (node && latest.current.open) place();
  }, [place]);

  useLayoutEffect(() => { if (params.open) place(); }, [params.open, place]);

  useEffect(() => {
    if (!params.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); latest.current.onClose(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (nodeRef.current?.contains(t) || latest.current.anchor?.contains(t)) return;
      latest.current.onClose();
    };
    const move = () => place();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', move);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', move, true);
      window.removeEventListener('resize', move);
    };
  }, [params.open, place]);

  return { ref, style, place };
}
