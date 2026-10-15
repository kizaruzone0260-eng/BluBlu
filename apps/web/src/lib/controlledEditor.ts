/**
 * Один контролируемый редактор текста (tiptap/ProseMirror) для формы материала, ленты и заметок.
 *
 * Причина (2026-10-15, красный zz10 в CI): значение печатающего редактора делает круг
 * «onUpdate → setState родителя → рендер → обратный setContent». Пока пользователь печатает,
 * родитель возвращает в поле ТО ЖЕ значение, но позже, чем документ ушёл вперёд, и обратная
 * запись возвращает документ назад — набранные символы теряются или встают не в том порядке.
 * На слабой машине (телефон, загруженный CPU) окно между нажатием и эхом больше, поэтому
 * потеря данных реальна не только в тесте. Правила здесь:
 *
 *  1. в документ пишем только когда сменился идентификатор документа (другая заметка/материал,
 *     первая инициализация) либо когда редактор НЕ в фокусе и содержимое правда отличается от
 *     значения; пока в редакторе печатают — обратная запись запрещена;
 *  2. родителю отдаём значение не каждым символом, а пачкой (дебаунс), но немедленно — по blur,
 *     при размонтировании, при смене документа и по требованию страницы (`handle.flush()`), так
 *     что последние символы не теряются ни при отправке формы, ни при закрытии вкладки.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useEditor, type Editor } from '@tiptap/react';
import { editorIsAlive } from './tiptapSafe';

/** Как долго копить изменения, прежде чем отдать их родителю (мс). */
const EMIT_DEBOUNCE_MS = 200;

/** Опции `useEditor` — берём из самого хука: прямого импорта @tiptap/core в этом пакете нет. */
type EditorOptions = NonNullable<Parameters<typeof useEditor>[0]>;

/** То, что может потребовать страница: отдать накопленное сейчас и вернуть его. */
export interface EditorHandle {
  flush: () => string;
}

export function useControlledEditor(p: {
  /** Значение из состояния страницы. */
  value: string;
  /** Идентикатор редактируемого документа: смена разрешает обратную запись. */
  docId: string;
  extensions: EditorOptions['extensions'];
  editorProps: EditorOptions['editorProps'];
  onChange: (html: string) => void;
  /** Опционально: страница вызывает flush перед отправкой, сменой документа и при закрытии. */
  handle?: { current: EditorHandle | null };
}): Editor | null {
  const onChangeRef = useRef(p.onChange);
  onChangeRef.current = p.onChange;
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Что редактор сам отдал родителю в последний раз: если значение из props совпадает с ним,
  // это эхо нашей же печати, а не внешний сигнал.
  const lastEmit = useRef<string | null>(null);
  const docRef = useRef(p.docId);

  const flush = useCallback((): string => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const html = pending.current;
    pending.current = null;
    if (html === null) return '';
    lastEmit.current = html;
    onChangeRef.current(html);
    return html;
  }, []);

  const onUpdate = useCallback(({ editor }: { editor: Editor }) => {
    if (!editorIsAlive(editor)) return;
    pending.current = editor.getHTML();
    if (!timer.current) timer.current = setTimeout(() => { flush(); }, EMIT_DEBOUNCE_MS);
  }, [flush]);

  const editor = useEditor({
    extensions: p.extensions,
    content: p.value || '<p></p>',
    editorProps: p.editorProps,
    onUpdate,
  });

  // любой уход фокуса = пользователь закончил ввод (клик по «Опубликовать», по другой заметке,
  // по полю заголовка): значение должно успеть в состояние ДО обработчика этого клика
  useEffect(() => {
    if (!editorIsAlive(editor)) return;
    const onBlur = () => { flush(); };
    editor.on('blur', onBlur);
    return () => { editor.off('blur', onBlur); };
  }, [editor, flush]);

  // адресат для страницы и гарантированная отдача при размонтировании
  useEffect(() => {
    if (p.handle) p.handle.current = { flush };
    return () => { flush(); if (p.handle && p.handle.current) p.handle.current = null; };
  }, [flush, p.handle]);

  useEffect(() => {
    if (!editorIsAlive(editor)) return;
    const html = editor.getHTML();
    if (p.docId !== docRef.current) {
      // сменился документ: страница обязана отдать накопленное ДО переключения (handle.flush),
      // поэтому здесь только принимаем новое значение и выбрасываем чужой остаток
      docRef.current = p.docId;
      lastEmit.current = null;
      pending.current = null;
      if (valueDiffers(p.value, html)) editor.commands.setContent(p.value || '<p></p>', { emitUpdate: false });
      return;
    }
    // Документ отстаёт от того, что редактор уже набрал: смена экземпляра после уничтожения
    // (окно, ради которого написан zz10) собирается из `value`, а дебаунс ещё не успел его
    // отдать. Догоняем СВОИМ значением — оно свежее, и это не внешняя правка.
    if (pending.current !== null && pending.current !== html) {
      const next = pending.current;
      pending.current = null;
      editor.commands.setContent(next, { emitUpdate: false });
      return;
    }
    if (valueDiffers(p.value, html)) {
      // В фокусе печатают — что бы ни принёс родитель, документ трогать нельзя: он впереди.
      if (editor.isFocused) return;
      // Значение, которое редактор сам отдал, — это эхо, а не внешняя правка.
      if (lastEmit.current !== null && p.value === lastEmit.current) return;
      editor.commands.setContent(p.value || '<p></p>', { emitUpdate: false });
    }
  }, [p.value, p.docId, editor]);

  return editor;
}

/** Отличается ли значение от документа (пустое поле редактора — это `<p></p>`). */
function valueDiffers(value: string, html: string): boolean {
  const v = value || '<p></p>';
  return v !== html;
}
