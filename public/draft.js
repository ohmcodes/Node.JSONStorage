const editorDraftKey = 'jsonstorage.editorDraft';

export function createDraftController({ sessionStorage, editor, draftState }) {
  let restoredDraft = null;
  try {
    restoredDraft = JSON.parse(sessionStorage.getItem(editorDraftKey));
    if (!restoredDraft || typeof restoredDraft.value !== 'string') restoredDraft = null;
  } catch {
    restoredDraft = null;
  }

  if (restoredDraft) editor.value = restoredDraft.value;
  let savedEditorValue = restoredDraft
    ? restoredDraft.saved ? restoredDraft.value : restoredDraft.value ? null : ''
    : editor.value;

  if (restoredDraft && restoredDraft.value) {
    draftState.textContent = restoredDraft.saved
      ? 'Saved editor content restored from this tab.'
      : 'Unsaved draft restored from this tab.';
  }

  function store(saved = false) {
    try {
      sessionStorage.setItem(editorDraftKey, JSON.stringify({ value: editor.value, saved }));
      draftState.textContent = saved
        ? 'Saved editor content is kept in this tab.'
        : 'Draft saved in this tab. Refresh to restore it; closing the tab clears it.';
    } catch {
      draftState.textContent = 'This browser could not store a draft. Save the bin or download the JSON before refreshing.';
    }
    if (saved) savedEditorValue = editor.value;
    return savedEditorValue;
  }

  return {
    restoredDraft,
    store,
    hasUnsavedEditorContent: () => editor.value !== savedEditorValue,
    getSavedEditorValue: () => savedEditorValue
  };
}
