import type { Editor } from '@tiptap/react';

/**
 * Is this editor instance still usable? (hardening follow-up, 2026-10-07)
 *
 * `@tiptap/react` creates the editor inside a `useState` initialiser — during RENDER — and
 * arms a 1 ms `setTimeout` that destroys it unless the component is mounted by then
 * (`EditorInstanceManager.scheduleDestroy`). Mounting happens in a React PASSIVE effect,
 * flushed in a task that is delivered over a MessagePort. When that task lands later than
 * the timer (a loaded machine, a long task, a second API process eating CPU on a small dev
 * box), the instance the current render holds is already destroyed, and
 * `@tiptap/core`'s `destroy()` has nulled its schema:
 *
 *     this.extensionManager = null; this.schema = null;
 *
 * The first read after that throws out of ProseMirror:
 *
 *     TypeError: Cannot read properties of null (reading 'cached')
 *         at DOMSerializer/DOMParser.fromSchema  ←  editor.getHTML()
 *
 * Because the read lives in a `useEffect`, the throw is caught by `ErrorBoundary`, which
 * shows the 500 screen for a page that is otherwise perfectly fine — the crash the material
 * form and the notes editor could hit for a real teacher.
 *
 * `schema` is the right signal: it is created in the constructor (so an editor that simply
 * has not mounted yet still passes), and `destroy()` sets it to null. `editor.isDestroyed`
 * is NOT usable here — it is `editorView?.isDestroyed ?? true`, so it also reports true for
 * a healthy editor whose view has not been attached yet, and guarding with it would keep the
 * toolbar from ever appearing.
 */
export function editorIsAlive(editor: Editor | null | undefined): editor is Editor {
  return !!editor && !!editor.schema;
}
