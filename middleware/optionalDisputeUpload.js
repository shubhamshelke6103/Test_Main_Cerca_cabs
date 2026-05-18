/**
 * Apply multer only for multipart dispute evidence uploads.
 * JSON bodies are already parsed by express.json() globally.
 */
const createOptionalDisputeUpload = (disputeUpload) => (req, res, next) => {
  const contentType = req.get('content-type') || ''
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    return disputeUpload.single('file')(req, res, next)
  }
  return next()
}

module.exports = { createOptionalDisputeUpload }
