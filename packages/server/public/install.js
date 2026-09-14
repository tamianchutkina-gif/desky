/*
 * One button. The command is the only thing on the install page a
 * client can get wrong by retyping it, so copying it must be the
 * easiest thing on the page.
 */
const button = document.getElementById('copy');
const command = document.getElementById('command');

button.addEventListener('click', async () => {
  const text = command.textContent.trim();

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Safari refuses the clipboard API outside a secure context and in
    // some privacy configurations. Selecting the text leaves the client
    // one ⌘C away rather than stranded with a button that did nothing.
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = 'Press ⌘C';
    button.dataset.copied = 'true';
    return;
  }

  button.textContent = 'Copied';
  button.dataset.copied = 'true';
  setTimeout(() => {
    button.textContent = 'Copy';
    button.dataset.copied = 'false';
  }, 2000);
});
