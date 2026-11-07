import wa from './__sdk.mjs';

const input = document.querySelector('#max-notes'), output = document.querySelector('#value');
const show = () => { output.textContent = input.value; };
input.addEventListener('input', show);

try {
  const { values } = await wa.settings.get();
  input.value = values.maxNotes ?? 20;
  show();
} catch (error) {
  document.querySelector('#error').textContent = error.message;
}

// Called when the user presses the host's save button. Throwing blocks saving.
wa.onCollect(() => {
  const maxNotes = Number(input.value);
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 50) throw new Error('便签数量需在 1–50 之间。');
  return { maxNotes };
});
