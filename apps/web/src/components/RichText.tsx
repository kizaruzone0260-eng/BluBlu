import { useCallback, useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useTranslation } from 'react-i18next';
import { editorIsAlive } from '../lib/tiptapSafe';

/**
 * Shared rich-text block (extracted from the notes editor for the material
 * form). StarterKit v3 already ships bold/italic/underline/lists/undo. The
 * toolbar is a fixed superset: material and notes use the same buttons.
 *
 * The option objects handed to `useEditor` are STABLE on purpose (module-level array,
 * memoised props, one `useCallback`): a fresh literal per render makes
 * `@tiptap/react`'s `EditorInstanceManager.compareOptions` fail, and it then reconfigures
 * the editor on every render — churn around the destroyed-instance window below.
 * Every read of the instance goes through `editorIsAlive` (see lib/tiptapSafe).
 */
const EXTENSIONS = [StarterKit];

export default function RichText({ value, onChange, minHeight = 140 }: {
  value: string; onChange: (html: string) => void; minHeight?: number;
}) {
  const { t } = useTranslation();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editorProps = useMemo(
    () => ({ attributes: { class: 'tiptap', 'aria-label': t('material.descriptionAria') } }),
    [t],
  );
  const onUpdate = useCallback(({ editor }: { editor: Editor }) => {
    if (editorIsAlive(editor)) onChangeRef.current(editor.getHTML());
  }, []);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value || '<p></p>',
    editorProps,
    onUpdate,
  });

  // controlled-content sync (same contract as the notes editor): external
  // value changes are pushed in without emitting an update loop. A destroyed instance is
  // skipped, and the store re-renders with its replacement — same deps, so this runs again.
  useEffect(() => {
    if (!editorIsAlive(editor)) return;
    if (value !== editor.getHTML()) editor.commands.setContent(value || '<p></p>', { emitUpdate: false });
  }, [value, editor]);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
      <MenuBar editor={editor} />
      <div style={{ minHeight }}>
        <EditorContent editor={editor} />
      </div>
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
