import { useMemo } from 'react';
import { EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useTranslation } from 'react-i18next';
import { editorIsAlive } from '../lib/tiptapSafe';
import { keepFocus } from '../lib/keepFocus';
import { useDraftEditor, type DraftNotice, type EditorHandle } from '../lib/uncontrolledEditor';

/**
 * Shared rich-text block (extracted from the notes editor for the material
 * form). StarterKit v3 already ships bold/italic/underline/lists/undo. The
 * toolbar is a fixed superset: material and notes use the same buttons.
 *
 * The option objects handed to `useEditor` are STABLE on purpose (module-level array,
 * memoised props): a fresh literal per render makes `@tiptap/react`'s
 * `EditorInstanceManager.compareOptions` fail, and it then reconfigures the editor on every
 * render — churn around the destroyed-instance window below. Every read of the instance goes
 * through `editorIsAlive` (see lib/tiptapSafe). Схема «редактор сам себе хозяин, а значение к
 * нему возвращается только со сменой документа» — в lib/uncontrolledEditor; здесь только
 * разметка и подсказка о локальном черновике.
 */
const EXTENSIONS = [StarterKit];

export default function RichText({ value, docId, scope, serverRev, onChange, minHeight = 140, handle }: {
  value: string; docId: string; scope: string; serverRev?: number;
  onChange: (html: string) => void; minHeight?: number;
  handle?: { current: EditorHandle | null };
}) {
  const { t } = useTranslation();
  const editorProps = useMemo(
    () => ({ attributes: { class: 'tiptap', 'aria-label': t('material.descriptionAria') } }),
    [t],
  );
  const { editor, notice, applyKept } = useDraftEditor({
    value, docId, scope, serverRev, extensions: EXTENSIONS, editorProps, onChange, handle,
  });

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
      <MenuBar editor={editor} />
      <div style={{ minHeight }}>
        <EditorContent editor={editor} />
      </div>
      <DraftBar notice={notice} onApply={applyKept} />
    </div>
  );
}

/** Подсказка о том, что редактор открыл не то, что лежит на сервере. */
export function DraftBar({ notice, onApply }: { notice: DraftNotice; onApply: () => void }) {
  const { t } = useTranslation();
  if (!notice.restored && notice.keptHtml === null) return null;
  return (
    <div className="draft-bar" data-testid="draft-bar"
      style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      {notice.restored && <span data-testid="draft-restored">{t('editor.draftRestored')}</span>}
      {notice.keptHtml !== null && (
        <>
          <span data-testid="draft-kept">{t('editor.draftKept')}</span>{' '}
          <button type="button" className="ghost" data-testid="draft-apply" style={{ marginTop: 0, minHeight: 36 }}
            onMouseDown={keepFocus} onClick={onApply}>{t('editor.draftApply')}</button>
        </>
      )}
    </div>
  );
}

function MenuBar({ editor }: { editor: Editor | null }) {
  const { t } = useTranslation();
  // `EditorContent` is what mounts the view, so an unmounted instance is normal here and
  // must still render the toolbar; only a destroyed one is refused (its commands are gone).
  if (!editorIsAlive(editor)) return null;
  const btn = (label: string, title: string, fn: () => void, active = false, testid?: string) => (
    <button
      key={label} type="button" className="secondary" title={title}
      data-testid={testid} aria-label={title} aria-pressed={active}
      style={{ margin: 2, padding: '4px 8px', minWidth: 36, minHeight: 36, fontWeight: active ? 700 : 400, marginTop: 4 }}
      onMouseDown={keepFocus}
      onClick={fn}
    >{label}</button>
  );
  return (
    <div style={{ padding: 4, borderBottom: '1px solid var(--border)' }}>
      {btn('B', t('material.bold'), () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'), 'rt-bold')}
      {btn('I', t('material.italic'), () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'), 'rt-italic')}
      {btn('U', t('material.underline'), () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'), 'rt-underline')}
      {btn('•', t('material.bullet'), () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'), 'rt-ul')}
      {btn('1.', t('material.ordered'), () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'), 'rt-ol')}
      {btn('⌫A', t('material.clearFormat'), () => editor.chain().focus().unsetAllMarks().clearNodes().run(), false, 'rt-clear')}
      {btn('↩', t('material.undo'), () => editor.chain().focus().undo().run())}
      {btn('↪', t('material.redo'), () => editor.chain().focus().redo().run())}
    </div>
  );
}
