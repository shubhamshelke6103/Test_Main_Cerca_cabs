const fs = require('fs');
const path = require('path');

const resolveStoredDocumentPath = (documentInput) => {
  const rawValue =
    typeof documentInput === 'string'
      ? documentInput
      : documentInput?.documentUrl || documentInput?.url || '';

  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  const trimmedDocumentUrl = rawValue.trim();

  if (/^https?:\/\//i.test(trimmedDocumentUrl)) {
    try {
      const parsedUrl = new URL(trimmedDocumentUrl);
      const relativePath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, '');
      return path.resolve(process.cwd(), relativePath);
    } catch (error) {
      return null;
    }
  }

  return path.resolve(process.cwd(), trimmedDocumentUrl.replace(/^\/+/, ''));
};

const deleteDriverDocuments = (documents = []) => {
  for (const documentUrl of documents) {
    const absolutePath = resolveStoredDocumentPath(documentUrl);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      continue;
    }

    fs.unlinkSync(absolutePath);
  }
};

module.exports = {
  deleteDriverDocuments,
};
