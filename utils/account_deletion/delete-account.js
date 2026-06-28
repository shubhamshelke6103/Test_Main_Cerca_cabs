document.addEventListener('DOMContentLoaded', () => {
  const deleteButton = document.getElementById('delete-button');
  const cancelButton = document.getElementById('cancel-button');
  const deleteMessage = document.getElementById('delete-message');

  if (!deleteButton || !cancelButton || !deleteMessage) {
    return;
  }

  cancelButton.addEventListener('click', (event) => {
    event.preventDefault();
    window.history.back();
  });

  deleteButton.addEventListener('click', async (event) => {
    event.preventDefault();
    deleteMessage.textContent = 'Deleting account...';
    deleteButton.disabled = true;
    cancelButton.disabled = true;

    try {
      const response = await fetch('/request/delete-account.html', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirm: true }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Server error: ${response.status}`);
      }

      const result = await response.json();

      deleteMessage.textContent = result.message || 'Your account has been deleted successfully.';
      deleteMessage.classList.add('success');

      setTimeout(() => {
        window.location.href = '/';
      }, 2500);
    } catch (error) {
      deleteMessage.textContent = error.message || 'Failed to delete account. Please try again.';
      deleteMessage.classList.add('error');
      deleteButton.disabled = false;
      cancelButton.disabled = false;
    }
  });
});