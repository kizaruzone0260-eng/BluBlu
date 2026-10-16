/**
 * Один НЕконтролируемый редактор текста (tiptap/ProseMirror) — форма материала, лента и заметки.
 *
 * Причина (часть E, 2026-10-16). Контролируемая схема («значение из состояния страницы →
 * `setContent` обратно») делает круг «печать → setState родителя → рендер → обратная запись»,
 * и пока человек печатает, обратная запись возвращает документ назад: последние символы
 * теряются или встают не в том порядке. На слабой машине (телефон, загруженный CPU) окно между
 * нажатием и эхом больше — этим и был красный `zz24` под CPU ×4. Прежняя правка только сужала
 * окно запрета (не писать, пока в фокусе), но сам класс оставался: путь «родитель догоняет
 * документ» продолжал существовать. Здесь его нет вовсе.
 *
 * Правила:
 *  1. в документ пишем РОВНО в двух случаях: первое монтирование и смена идентификатора
 *     документа, плюс явное нажатие «вернуть локальный черновик». Значение от родителя больше
 *     не догоняет открытый документ никогда;
 *  2. каждый набранный символ немедленно уходит в локальный черновик (`localStorage`, ключ на
 *     документ) — это единственное место, где живут символы, ещё не попавшие на сервер;
 *  3. на сервер значение уходит с дебаунсом, и ПРИНУДИТЕЛЬНО по blur, при смене документа, при
 *     размонтировании, при уходе вкладки в скрытое состояние и по `pagehide` (закрытие,
 *     переход, убийство процесса телефоном);
 *  4. при открытии черновик сверяется с серверной версией (`decideOnOpen` из `@klass/shared`):
 *     локальный текст побеждает, если сервер не доказал, что новее; если доказал — показываем
 *     сервер, а локальный текст сохраняем и предлагаем его вернуть. Молча затереть абзацы
 *     человека — худшее, что может сделать редактор;
 *  5. если победил черновик, его содержимое обязано попасть и к родителю: страница публикует
 *     то, что лежит в её состоянии, а не то, что человек видит в редакторе;
 *  6. черновик убирает только страница и только после успешного сохранения (`clearDraft`,
 *     `clearDraftIfSaved`) — «значение == документ» ничего не значит: у новой записи равенство
 *     наступает раньше, чем первый POST.
 *
 * `useEditor` получает стабильные опции (модульный массив расширений, мемоизированные
 * `editorProps`, `onUpdate` без пересоздания): свежий литерал на каждый рендер заставляет
 * `@tiptap/react` пересобирать экземпляр, а это то самое окно разрушенного инстанса
 * (см. lib/tiptapSafe).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, type Editor } from '@tiptap/react';
import { editorIsAlive } from './tiptapSafe';
import {
  draftKey, parseDraft, serializeDraft, decideOnOpen, shouldSend, EMPTY_DOC,
} from '@klass/shared';

/** Как долго копить изменения, прежде чем отдать их наружу (мс). */
const SEND_DEBOUNCE_MS = 400;

/**
 * Сколько живёт сообщение «текст вернулся из черновика» (мс). Тридцать секунд, не двенадцать:
 * человек мог открыть вкладку и уйти читать, а на слабом телефоне сама загрузка страницы
 * съедает половину окна.
 *
 * Второе сообщение — «сервер оказался новее, локальный текст сохранён» — НЕ прячется вовсе:
 * у него есть кнопка, и исчезнуть она должна только после того, как человек ею воспользовался
 * (или после `applyKept`). Прятать подсказку с действием, чтобы человек не успел её прочитать,
 * — тот же класс потери текста, только вежливый.
 */
const NOTICE_MS = 30_000;

/** То, что может потребовать страница: отдать накопленное сейчас и вернуть его. */
export interface EditorHandle {
  flush: () => string;
}

export interface DraftNotice {
  /** набранное здесь вернулось из локального черновика */
  restored: boolean;
  /** сервер оказался новее; локальный текст не потерян, его можно вернуть одной кнопкой */
  keptHtml: string | null;
}

/** Опции `useEditor` — берём из самого хука: прямого импорта @tiptap/core в этом пакете нет. */
type EditorOptions = NonNullable<Parameters<typeof useEditor>[0]>;

/*
 * Черновик — удобство, а не источник истины во время печати: сам документ живёт в ProseMirror.
 * Поэтому хранилище, которое отказывает (приватный режим Safari, переполненная квота), не должно
 * ломать редактор: ошибки чтения и записи глушатся, а не долетают до обработчика ввода.
 */
function readRaw(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* приватный режим — просто нет черновика */ }
}
function dropRaw(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* см. выше */ }
}

/** Убирает черновик после успешного сохранения. Вызывает страница, не редактор. */
export function clearDraft(scope: string, docId: string): void {
  dropRaw(draftKey(scope, docId));
}

/**
 * Отбрасывает черновик, ТОЛЬКО если на сервер легло ровно то, что в нём лежит.
 * Иначе человек печатал, пока шёл запрос, и стирать нечего: это тот самый случай, ради
 * которого черновик и существует.
 */
export function clearDraftIfSaved(scope: string, docId: string, savedHtml: string): void {
  const key = draftKey(scope, docId);
  const draft = parseDraft(readRaw(key));
  if (!draft || draft.html === savedHtml) dropRaw(key);
}

/**
 * Переносит черновик на другой ключ. Нужен ровно для одного момента: ещё не созданная запись
 * (ключ `__draft__`) стала реальной заметкой, а последние нажатия могли уйти в черновик под
 * СТАРЫМ ключом, пока шёл POST. Стереть их было бы потерей, оставить — потом второй копией
 * в новой заметке.
 */
export function moveDraft(scope: string, fromId: string, toId: string): void {
  const raw = readRaw(draftKey(scope, fromId));
  if (raw === null) return;
  writeRaw(draftKey(scope, toId), raw);
  dropRaw(draftKey(scope, fromId));
}

export interface DraftEditor {
  editor: Editor | null;
  notice: DraftNotice;
  /** применить черновик, который оказался новее серверной копии (по кнопке подсказки) */
  applyKept: () => void;
}

export function useDraftEditor(p: {
  /** серверное значение; читается только при первом монтировании и при смене `docId` */
  value: string;
  /** идентификатор редактируемого документа — единственное, что разрешает запись в документ */
  docId: string;
  /** область черновика: 'note' | 'material' | 'post' — чтобы одна заметка не открывала чужой текст */
  scope: string;
  /**
   * Ключ черновика; по умолчанию = `docId`. Нужен отдельно от `docId` для ещё не созданной
   * записи: `docId` меняется при каждом открытии, а черновик новой заметки обязан лежать под
   * одним и тем же ключом, иначе после перезагрузки вкладки его нечем прочитать.
   */
  draftId?: string;
  /** версия серверной копии (мс от `updatedAt`); 0 = версия неизвестна ⇒ черновик важнее */
  serverRev?: number;
  extensions: EditorOptions['extensions'];
  editorProps: EditorOptions['editorProps'];
  onChange: (html: string) => void;
  /** чем страница платит за flush перед отправкой формы и за подсказку о черновике */
  handle?: { current: EditorHandle | null };
}): DraftEditor {
  const onChangeRef = useRef(p.onChange);
  onChangeRef.current = p.onChange;
  /*
   * Ключ черновика и версия серверной копии — в ref. Их смена (черновик превращается в
   * реальную заметку, список заметок принёс новый `updatedAt`) не должна пересоздавать
   * `onUpdate`: свежая ссылка на каждый рендер ломает стабильность опций, из-за которой
   * редактор уже пересобирали (см. lib/tiptapSafe).
   */
  const keyRef = useRef(draftKey(p.scope, p.draftId ?? p.docId));
  keyRef.current = draftKey(p.scope, p.draftId ?? p.docId);
  const revRef = useRef(p.serverRev ?? 0);
  revRef.current = p.serverRev ?? 0;

  // Решение «чем открывать документ» снимается один раз на документ: черновик не должен
  // всплывать посреди печати, а localStorage не читается каждым символом.
  const openedRef = useRef<{ docId: string; html: string; notice: DraftNotice; emit: boolean } | null>(null);
  if (!openedRef.current || openedRef.current.docId !== p.docId) {
    const draft = parseDraft(readRaw(keyRef.current));
    const dec = decideOnOpen({ serverHtml: p.value, serverRev: revRef.current, draft });
    if (dec.drop) dropRaw(keyRef.current);
    openedRef.current = {
      docId: p.docId,
      html: dec.html,
      notice: { restored: dec.usedDraft, keptHtml: dec.kept ? dec.kept.html : null },
      // победил черновик ⇒ родитель про него ещё не знает: обязаны отдать (правило 5)
      emit: dec.usedDraft,
    };
  }
  const [notice, setNotice] = useState<DraftNotice>(openedRef.current.notice);

  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // что уже отдано наружу (и, значит, уже ушло на сервер этой же версией)
  const lastSent = useRef<string | null>(openedRef.current.html);
  const docRef = useRef(p.docId);
  const keptRef = useRef<string | null>(openedRef.current.notice.keptHtml);

  // страница вызывает flush() ДО переключения на другой документ, поэтому черновик всегда свежий
  const flush = useCallback((): string => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const html = pending.current;
    pending.current = null;
    if (html === null) return '';
    if (!shouldSend(html, lastSent.current)) return html;
    lastSent.current = html;
    onChangeRef.current(html);
    return html;
  }, []);

  const onUpdate = useCallback(({ editor }: { editor: Editor }) => {
    if (!editorIsAlive(editor)) return;
    const html = editor.getHTML();
    pending.current = html;
    writeRaw(keyRef.current, serializeDraft({ html, at: Date.now(), rev: revRef.current }));
    if (!timer.current) timer.current = setTimeout(() => { flush(); }, SEND_DEBOUNCE_MS);
  }, [flush]);

  const editor = useEditor({
    extensions: p.extensions,
    content: openedRef.current.html || EMPTY_DOC,
    editorProps: p.editorProps,
    onUpdate,
  });

  // единственный разрешённый путь записи значения, пришедшего «снаружи»: СМЕНИЛСЯ документ
  useEffect(() => {
    if (!editorIsAlive(editor) || p.docId === docRef.current) return;
    docRef.current = p.docId;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    const opened = openedRef.current;
    if (!opened) return;
    keptRef.current = opened.notice.keptHtml;
    setNotice(opened.notice);
    editor.commands.setContent(opened.html || EMPTY_DOC, { emitUpdate: false });
    lastSent.current = opened.html;
    if (opened.emit) {
      openedRef.current = { ...opened, emit: false };
      onChangeRef.current(opened.html);
    }
  }, [editor, p.docId]);

  // отдача восстановленного черновика родителю при первом монтировании: без неё страница
  // опубликует пустое поле, хотя человек видит восстановленный текст (эффект, а не рендер —
  // onChange ведёт в setState родителя)
  useEffect(() => {
    const opened = openedRef.current;
    if (!opened || !opened.emit) return;
    openedRef.current = { ...opened, emit: false };
    lastSent.current = opened.html;
    onChangeRef.current(opened.html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «вернулось из черновика» через NOTICE_MS уходит, «сервер новее, локальный текст вот тут» —
  // остаётся, пока им не воспользуются: убирать подсказку с кнопкой было бы второй потеряй
  useEffect(() => {
    const opened = openedRef.current;
    if (!opened || !opened.notice.restored) return undefined;
    const hide = setTimeout(() => {
      setNotice((n) => ({ restored: false, keptHtml: n.keptHtml }));
    }, NOTICE_MS);
    return () => clearTimeout(hide);
  }, [p.docId]);

  const applyKept = useCallback(() => {
    const html = keptRef.current;
    if (html === null || !editorIsAlive(editor)) return;
    keptRef.current = null;
    setNotice((n) => ({ ...n, keptHtml: null }));
    editor.commands.setContent(html, { emitUpdate: false });
    pending.current = html;
    writeRaw(keyRef.current, serializeDraft({ html, at: Date.now(), rev: revRef.current }));
    flush();
  }, [editor, flush]);

  // любой уход фокуса = человек закончил ввод: значение обязано успеть в состояние ДО
  // обработчика клика по «Опубликовать» или по другой заметке
  useEffect(() => {
    if (!editorIsAlive(editor)) return;
    const onBlur = () => { flush(); };
    editor.on('blur', onBlur);
    return () => { editor.off('blur', onBlur); };
  }, [editor, flush]);

  // адресат для страницы + гарантированная отдача при размонтировании
  useEffect(() => {
    if (p.handle) p.handle.current = { flush };
    return () => {
      flush();
      if (p.handle && p.handle.current) p.handle.current = null;
    };
  }, [flush, p.handle]);

  /*
   * Закрытие вкладки, переход по ссылке, «свайп вверх» на телефоне и убийство процесса:
   * `pagehide` — единственное событие, которое стабильно приходит во всех этих сценариях
   * (beforeunload на мобильных не гарантирует). `visibilitychange` в hidden добавлен потому,
   * что iOS иногда отдаёт только его.
   */
  useEffect(() => {
    const onHide = () => { flush(); };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [flush]);

  return { editor, notice, applyKept };
}
